import { getFirestore } from "firebase-admin/firestore";
import { Hono } from "hono";
import type { Env } from "./auth";
import type { Ticket } from "./types";

export const tickets = new Hono<Env>();

tickets.get("/", async (c) => {
  const { uid } = c.get("user");

  const snap = await getFirestore()
    .collection("tickets")
    .where("uid", "==", uid)
    .where("status", "==", "active")
    .get();

  const result = snap.docs.map((d) => {
    const t = d.data() as Ticket;
    return {
      id: d.id,
      typeId: t.typeId,
      code: t.code,
      holderName: t.holderName,
      days: t.days,
      checkins: Object.fromEntries(
        Object.entries(t.checkins ?? {}).map(([day, c]) => [day, c.at.toDate()]),
      ),
    };
  });

  return c.json(result);
});