import { zValidator } from "@hono/zod-validator";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { Hono } from "hono";
import { z } from "zod";

import { requireRole, type Env } from "./auth";
import type { Ticket } from "./types";

export const checkin = new Hono<Env>();

const checkinSchema = z.object({ code: z.string().min(1) });

const EVENT_TIMEZONE = "Europe/Madrid";

function today(): string {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", { timeZone: EVENT_TIMEZONE }).format(
    new Date(),
  );
}

checkin.post(
  "/",
  requireRole("staff", "admin"),
  zValidator("json", checkinSchema),
  async (c) => {
    const { code } = c.req.valid("json");
    const { uid } = c.get("user");
    const db = getFirestore();
    const day = today();

    const snap = await db
      .collection("tickets")
      .where("code", "==", code)
      .limit(1)
      .get();

    if (snap.empty) {
      return c.json({ result: "not_found" as const });
    }

    const ref = snap.docs[0].ref;

    const result = await db.runTransaction(async (tx) => {
      const doc = await tx.get(ref);
      const t = doc.data() as Ticket;

      if (t.status !== "active") {
        return { result: "invalid" as const, status: t.status };
      }

      if (!t.days.includes(day)) {
        return { result: "wrong_day" as const, days: t.days };
      }

      const existing = t.checkins?.[day];
      if (existing) {
        return {
          result: "already_used" as const,
          checkedInAt: existing.at.toDate(),
          checkedInBy: existing.by,
        };
      }

      tx.update(ref, {
        [`checkins.${day}`]: { at: FieldValue.serverTimestamp(), by: uid },
      });

      return {
        result: "valid" as const,
        holderName: t.holderName,
        typeId: t.typeId,
      };
    });

    return c.json(result);
  },
);
