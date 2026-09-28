import { randomUUID } from "node:crypto";

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { HTTPException } from "hono/http-exception";
import Stripe from "stripe";

import { audit, auditedAs } from "../audit/audit";
import type { Env } from "../auth";
import { bearerAuth, CheckinsSchema, checkinTimes, EmailSchema } from "../schemas";
import { frontendUrl } from "../config";
import { stripeSecretKey } from "../stripe";
import type { Ticket, TicketWrite } from "../types";
import { releaseCapacity, reserveCapacity } from "./capacity";

export const tickets = new OpenAPIHono<Env>();

/** Online purchase; mounted only while online sales are on. */
export const ticketPurchase = new OpenAPIHono<Env>();

const OwnTicketSchema = z.object({
  id: z.string(),
  typeId: z.string(),
  code: z.string(),
  holderName: z.string(),
  days: z.array(z.string()),
  checkins: CheckinsSchema,
});

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Tickets"],
  summary: "List the caller's active tickets",
  security: bearerAuth,
  responses: {
    200: {
      description: "Active tickets owned by the caller",
      content: { "application/json": { schema: z.array(OwnTicketSchema) } },
    },
  },
});

tickets.openapi(listRoute, async (c) => {
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
      checkins: checkinTimes(t.checkins),
    };
  });

  return c.json(result, 200);
});

const PurchaseSchema = z.object({
  items: z
    .array(
      z.object({
        typeId: z.string().min(1),
        holderName: z.string().min(1),
        holderEmail: EmailSchema,
      }),
    )
    .min(1)
    .max(20),
});

const purchaseRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Tickets"],
  summary: "Buy tickets online",
  description:
    "Creates the tickets as pending and returns a Stripe Checkout URL. " +
    "The tickets become active when Stripe confirms payment through the webhook.",
  security: bearerAuth,
  ...auditedAs("ticket.purchase", "ticket.checkoutFailed"),
  request: {
    body: { required: true, content: { "application/json": { schema: PurchaseSchema } } },
  },
  responses: {
    200: {
      description: "Checkout session created",
      content: {
        "application/json": { schema: z.object({ checkoutUrl: z.string().nullable() }) },
      },
    },
    400: { description: "Invalid body or unknown ticket type" },
    409: { description: "A requested ticket type is sold out" },
  },
});

ticketPurchase.openapi(purchaseRoute, async (c) => {
  const { items } = c.req.valid("json");
  const buyer = c.get("user");
  const { uid } = buyer;
  const db = getFirestore();

  const ticketRefs = items.map(() => db.collection("tickets").doc());

  // One transaction so the capacity check and the tickets that consume it can't interleave
  const types = await db.runTransaction(async (tx) => {
    const reserved = await reserveCapacity(tx, items);

    items.forEach((item, i) => {
      const type = reserved.get(item.typeId)!;
      tx.set(ticketRefs[i], {
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
      } satisfies TicketWrite);
      audit(tx, {
        actor: buyer,
        action: "ticket.purchase",
        target: { id: ticketRefs[i].id, label: item.holderName },
        details: { typeId: item.typeId, price: type.price },
      });
    });

    return reserved;
  });

  const stripe = new Stripe(stripeSecretKey());

  let session: Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.create({
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
  } catch (err) {
    // No checkout means nobody can ever pay for these, so don't let them hold slots
    await db.runTransaction(async (tx) => {
      releaseCapacity(tx, items.map((item) => item.typeId));
      ticketRefs.forEach((ref, i) => {
        tx.delete(ref);
        audit(tx, {
          actor: buyer,
          action: "ticket.checkoutFailed",
          target: { id: ref.id, label: items[i].holderName },
          details: {},
        });
      });
    });
    console.error("failed to create checkout session", err);
    throw new HTTPException(502, { message: "could not start checkout" });
  }

  return c.json({ checkoutUrl: session.url }, 200);
});
