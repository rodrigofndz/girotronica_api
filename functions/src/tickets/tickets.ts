import { randomUUID } from "node:crypto";

import { zValidator } from "@hono/zod-validator";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import Stripe from "stripe";
import { z } from "zod";

import type { Env } from "../auth";
import { frontendUrl, stripeSecretKey } from "../stripe";
import type { Ticket, TicketType } from "../types";

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

const purchaseSchema = z.object({
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

tickets.post("/", zValidator("json", purchaseSchema), async (c) => {
  const { items } = c.req.valid("json");
  const { uid } = c.get("user");
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

  const batch = db.batch();
  items.forEach((item, i) => {
    const type = types.get(item.typeId)!;
    batch.set(ticketRefs[i], {
      uid,
      typeId: item.typeId,
      status: "pending",
      code: randomUUID(),
      holderName: item.holderName,
      holderEmail: item.holderEmail,
      paymentMethod: "stripe",
      soldBy: null,
      purchasedAt: FieldValue.serverTimestamp(),
      days: type.days,
      isLanParty: type.isLanParty,
      checkins: {},
    });
  });

  await batch.commit();

  const stripe = new Stripe(stripeSecretKey.value());
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: items.map((item) => {
      const type = types.get(item.typeId)!;
      return {
        price_data: {
          currency: "eur",
          unit_amount: type.price,
          product_data: { name: type.name },
        },
        quantity: 1,
      };
    }),
    success_url: `${frontendUrl.value()}/tickets/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${frontendUrl.value()}/tickets`,
    metadata: { ticketIds: JSON.stringify(ticketRefs.map((ref) => ref.id)) },
  });

  return c.json({ checkoutUrl: session.url });
});
