import { randomUUID } from "node:crypto";

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { HTTPException } from "hono/http-exception";
import Stripe from "stripe";

import { audit, auditedAs } from "../audit/audit";
import type { Env } from "../auth";
import { bearerAuth, CheckinsSchema, checkinTimes, EmailSchema } from "../schemas";
import { frontendUrl } from "../config";
import { isAllowed } from "../cors";
import { ONLINE_SALES_MODE } from "../features";
import { stripeSecretKey } from "../stripe";
import { type Ticket, type TicketWrite, typeSettings } from "../types";
import { packIds, releaseCapacity, reserveCapacity } from "./capacity";

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
    403: { description: "Online sales are open to staff only for now (testing)" },
    409: { description: "A requested ticket type is sold out" },
  },
});

ticketPurchase.openapi(purchaseRoute, async (c) => {
  const { items } = c.req.valid("json");
  const buyer = c.get("user");

  // While a deployed setup is tested with Stripe's test key, a fake card must not get the
  // public real tickets
  if (ONLINE_SALES_MODE === "staff" && buyer.role === "user") {
    throw new HTTPException(403, { message: "online sales are open to staff only for now" });
  }

  const { uid } = buyer;
  const db = getFirestore();

  const ticketRefs = items.map(() => db.collection("tickets").doc());

  // One transaction so the capacity check and the tickets that consume it can't interleave
  const types = await db.runTransaction(async (tx) => {
    const reserved = await reserveCapacity(tx, items);
    const packs = packIds(items, reserved);

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
        entries: typeSettings(type).entries,
        packId: packs[i],
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

  // Back to the site the purchase came from (e.g. a preview), but only one CORS already
  // trusts, so this can't be turned into a redirect to anywhere
  const origin = c.req.header("Origin");
  const returnTo = origin && isAllowed(origin) ? origin : frontendUrl.value().replace(/\/+$/, "");

  let session: Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.create({
      mode: "payment",
      // One line per type, counted in units: a pack's price covers all of its tickets
      line_items: [...types.values()].map((type) => {
        const tickets = items.filter((item) => item.typeId === type.id).length;
        const quantity = tickets / typeSettings(type).packSize;
        // A type synced from Stripe is charged at Stripe's own price, so its catalogue,
        // reports and receipts show the real product
        if (type.stripePriceId) {
          return { price: type.stripePriceId, quantity };
        }
        return {
          price_data: {
            currency: "eur",
            unit_amount: type.price,
            product_data: { name: type.name },
          },
          quantity,
        };
      }),
      success_url: `${returnTo}/tickets/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${returnTo}/tickets`,
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
