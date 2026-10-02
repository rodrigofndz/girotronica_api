import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { FieldValue, getFirestore } from "firebase-admin/firestore";

import { audit, auditedAs } from "../audit/audit";
import { requireStaff, type Env } from "../auth";
import { bearerAuth } from "../schemas";
import { TICKET_STATUSES, type Ticket, type UserProfile } from "../types";

export const checkin = new OpenAPIHono<Env>();

const EVENT_TIMEZONE = "Europe/Madrid";

function today(): string {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", { timeZone: EVENT_TIMEZONE }).format(
    new Date(),
  );
}

// Every problem that applies is listed, not just the first, so the door sees the whole story
const ProblemSchema = z.discriminatedUnion("reason", [
  z.object({ reason: z.literal("not_found") }).openapi({ description: "No ticket has this code; always alone" }),
  z.object({ reason: z.literal("invalid"), status: z.enum(TICKET_STATUSES) })
    .openapi({ description: "Not paid yet (pending) or cancelled" }),
  z.object({ reason: z.literal("wrong_day"), days: z.array(z.string()) })
    .openapi({ description: "Today isn't one of its days" }),
  z.object({
    reason: z.literal("already_used"),
    checkedInAt: z.string(),
    checkedInBy: z.string().openapi({ description: "Uid of the staff member who let them in" }),
    checkedInByEmail: z.string().nullable().openapi({ description: "Their email, if their profile has one" }),
    checkedInByName: z.string().nullable().openapi({ description: "Their display name, if their profile has one" }),
  })
    .openapi({ description: "Already got in: today, or on any day for a ticket that gets in once" }),
]);
type Problem = z.infer<typeof ProblemSchema>;

const CheckinResultSchema = z.discriminatedUnion("result", [
  z.object({ result: z.literal("valid"), holderName: z.string(), typeId: z.string() }),
  z.object({
    result: z.literal("rejected"),
    holderName: z.string().nullable().openapi({ description: "Null when the code matched no ticket" }),
    typeId: z.string().nullable(),
    problems: z.array(ProblemSchema).min(1),
  }),
]);

const checkinRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Tickets"],
  summary: "Check in a ticket at the door",
  description:
    "Staff or admin. Uses the server's current event day (Europe/Madrid). A ticket gets in once " +
    "in total, on any day it covers, or once per day if its type's entries are daily. " +
    "Always returns 200; the outcome is in `result`, so a retried scan never looks like a failure. " +
    "A rejection lists every problem that applies, e.g. both cancelled and not for today.",
  security: bearerAuth,
  ...auditedAs("ticket.checkin", "ticket.scanRejected"),
  middleware: [requireStaff] as const,
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: z.object({ code: z.string().min(1) }) } },
    },
  },
  responses: {
    200: {
      description: "Check-in outcome",
      content: { "application/json": { schema: CheckinResultSchema } },
    },
    400: { description: "Invalid body" },
    403: { description: "Caller is not staff or admin" },
  },
});

checkin.openapi(checkinRoute, async (c) => {
  const { code } = c.req.valid("json");
  const staff = c.get("user");
  const { uid } = staff;
  const db = getFirestore();
  const day = today();

  const snap = await db
    .collection("tickets")
    .where("code", "==", code)
    .limit(1)
    .get();

  if (snap.empty) {
    // No ticket to hang it on, so the scanned code itself is what's worth keeping
    const batch = db.batch();
    audit(batch, {
      actor: staff,
      action: "ticket.scanRejected",
      target: { id: null, label: null },
      details: { day, reasons: ["not_found"], code },
    });
    await batch.commit();

    return c.json({ result: "rejected" as const, holderName: null, typeId: null, problems: [{ reason: "not_found" as const }] }, 200);
  }

  const ref = snap.docs[0].ref;

  const result = await db.runTransaction(async (tx) => {
    const doc = await tx.get(ref);
    const t = doc.data() as Ticket;
    const target = { id: doc.id, label: t.holderName };

    const problems: Problem[] = [];

    if (t.status !== "active") {
      problems.push({ reason: "invalid", status: t.status });
    }

    if (!t.days.includes(day)) {
      problems.push({ reason: "wrong_day", days: t.days });
    }

    // "once" (the default) lets its holder in a single time, on any of its days; "daily"
    // once on each day it covers
    const existing = t.entries === "daily"
      ? t.checkins?.[day]
      : Object.values(t.checkins ?? {}).sort((a, b) => a.at.toMillis() - b.at.toMillis())[0];
    if (existing) {
      const scanner = (await tx.get(db.doc(`users/${existing.by}`))).data() as UserProfile | undefined;
      problems.push({
        reason: "already_used",
        checkedInAt: existing.at.toDate().toISOString(),
        checkedInBy: existing.by,
        checkedInByEmail: scanner?.email ?? null,
        checkedInByName: scanner?.displayName ?? null,
      });
    }

    if (problems.length > 0) {
      audit(tx, {
        actor: staff,
        action: "ticket.scanRejected",
        target,
        details: { day, reasons: problems.map((p) => p.reason) },
      });
      return { result: "rejected" as const, holderName: t.holderName, typeId: t.typeId, problems };
    }

    tx.update(ref, {
      [`checkins.${day}`]: { at: FieldValue.serverTimestamp(), by: uid },
    });
    audit(tx, { actor: staff, action: "ticket.checkin", target, details: { day } });

    return {
      result: "valid" as const,
      holderName: t.holderName,
      typeId: t.typeId,
    };
  });

  return c.json(result, 200);
});
