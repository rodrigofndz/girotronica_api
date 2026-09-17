import { randomUUID } from "node:crypto";

import { zValidator } from "@hono/zod-validator";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import { requireRole, type Env } from "../auth";
import type { TicketType } from "../types";

export const doorSale = new Hono<Env>();

const doorSaleSchema = z.object({
  paymentMethod: z.enum(["cash", "card_terminal"]),
  items: z
    .array(
      z.object({
        typeId: z.string().min(1),
        holderName: z.string().min(1),
        holderEmail: z.email(),
      }),
    )
    .min(1)
    .max(20),
});

doorSale.post(
  "/",
  requireRole("staff", "admin"),
  zValidator("json", doorSaleSchema),
  async (c) => {
    const { paymentMethod, items } = c.req.valid("json");
    const { uid: soldBy } = c.get("user");
    const db = getFirestore();

    const typeIds = [...new Set(items.map((item) => item.typeId))];
    const typeDocs = await db.getAll(
      ...typeIds.map((id) => db.doc(`ticketTypes/${id}`)),
    );

    const types = new Map<string, TicketType>();
    for (const doc of typeDocs) {
      if (!doc.exists) {
        throw new HTTPException(400, { message: `unknown ticket type: ${doc.id}` });
      }
      types.set(doc.id, { id: doc.id, ...(doc.data() as Omit<TicketType, "id">) });
    }

    const ticketRefs = items.map(() => db.collection("tickets").doc());
    const codes = items.map(() => randomUUID());

    const batch = db.batch();
    items.forEach((item, i) => {
      const type = types.get(item.typeId)!;
      batch.set(ticketRefs[i], {
        uid: null,
        typeId: item.typeId,
        status: "active",
        code: codes[i],
        holderName: item.holderName,
        holderEmail: item.holderEmail,
        paymentMethod,
        soldBy,
        purchasedAt: FieldValue.serverTimestamp(),
        days: type.days,
        isLanParty: type.isLanParty,
        checkins: {},
      });
    });

    await batch.commit();

    return c.json(
      items.map((item, i) => ({
        id: ticketRefs[i].id,
        code: codes[i],
        typeId: item.typeId,
        holderName: item.holderName,
      })),
    );
  },
);
