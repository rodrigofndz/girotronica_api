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
      checkedInAt: t.checkedInAt?.toDate() ?? null,
    };
  });

  return c.json(result);
});