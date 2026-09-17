import { getFirestore } from "firebase-admin/firestore";
import { Hono } from "hono";

import { requireRole, type Env } from "../auth";
import type { Ticket } from "../types";

export const lanParty = new Hono<Env>();

lanParty.get("/", requireRole("staff", "admin"), async (c) => {
  const snap = await getFirestore()
    .collection("tickets")
    .where("isLanParty", "==", true)
    .where("status", "==", "active")
    .get();

  const result = snap.docs.map((d) => {
    const t = d.data() as Ticket;
    return {
      id: d.id,
      holderName: t.holderName,
      holderEmail: t.holderEmail,
      checkins: Object.fromEntries(
        Object.entries(t.checkins ?? {}).map(([day, c]) => [day, c.at.toDate()]),
      ),
    };
  });

  return c.json(result);
});
