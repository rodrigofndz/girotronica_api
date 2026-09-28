import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { FieldValue, getFirestore } from "firebase-admin/firestore";

import { audit, auditedAs } from "../audit/audit";
import { requireStaff, type Env } from "../auth";
import { bearerAuth } from "../schemas";
import { TICKET_STATUSES, type Ticket } from "../types";

export const checkin = new OpenAPIHono<Env>();

const EVENT_TIMEZONE = "Europe/Madrid";

function today(): string {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", { timeZone: EVENT_TIMEZONE }).format(
    new Date(),
  );
}

const CheckinResultSchema = z.discriminatedUnion("result", [
  z.object({ result: z.literal("valid"), holderName: z.string(), typeId: z.string() }),
  z.object({
    result: z.literal("already_used"),
    checkedInAt: z.string(),
    checkedInBy: z.string(),
  }),
  z.object({ result: z.literal("wrong_day"), days: z.array(z.string()) }),
  z.object({ result: z.literal("invalid"), status: z.enum(TICKET_STATUSES) }),
  z.object({ result: z.literal("not_found") }),
]);

const checkinRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Tickets"],
  summary: "Check in a ticket at the door",
  description:
    "Staff or admin. Uses the server's current event day (Europe/Madrid). " +
    "Always returns 200; the outcome is in `result`, so a retried scan never looks like a failure.",
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
      details: { day, reason: "not_found", code },
    });
    await batch.commit();

    return c.json({ result: "not_found" as const }, 200);
  }

  const ref = snap.docs[0].ref;

  const result = await db.runTransaction(async (tx) => {
    const doc = await tx.get(ref);
    const t = doc.data() as Ticket;
    const target = { id: doc.id, label: t.holderName };

    const reject = <R extends { result: "invalid" | "wrong_day" | "already_used" }>(outcome: R) => {
      audit(tx, { actor: staff, action: "ticket.scanRejected", target, details: { day, reason: outcome.result } });
      return outcome;
    };

    if (t.status !== "active") {
      return reject({ result: "invalid" as const, status: t.status });
    }

    if (!t.days.includes(day)) {
      return reject({ result: "wrong_day" as const, days: t.days });
    }

    const existing = t.checkins?.[day];
    if (existing) {
      return reject({
        result: "already_used" as const,
        checkedInAt: existing.at.toDate().toISOString(),
        checkedInBy: existing.by,
      });
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
