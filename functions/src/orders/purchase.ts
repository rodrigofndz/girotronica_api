import { randomUUID } from "node:crypto";

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { HTTPException } from "hono/http-exception";
import Stripe from "stripe";

import { audit, auditedAs, guestActor } from "../audit/audit";
import { optionalAuth, type GuestEnv } from "../auth";
import { frontendUrl } from "../config";
import { isAllowed } from "../cors";
import { loadExtras, releaseExtras, reserveExtras } from "../extras/stock";
import { ONLINE_SALES_MODE } from "../features";
import { EmailSchema } from "../schemas";
import { stripeSecretKey } from "../stripe";
import { packIds, releaseCapacity, reserveCapacity } from "../tickets/capacity";
import {
  type Extra, type OrderWrite, type Ticket, type TicketExtra, type TicketType, type TicketWrite, typeSettings,
} from "../types";

export const purchase = new OpenAPIHono<GuestEnv>();

/** Stripe's shortest allowed checkout lifetime is 30 minutes; a little over avoids clock skew. */
const CHECKOUT_LIFETIME_SECONDS = 31 * 60;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be an ISO date (YYYY-MM-DD)")
  .refine((d) => !Number.isNaN(Date.parse(d)) && d <= new Date().toISOString().slice(0, 10), "must be a past date");

const AttendeeSchema = z.object({
  typeId: z.string().min(1),
  name: z.string().trim().min(1).max(200).openapi({ description: "Full name (nom i cognoms)" }),
  email: EmailSchema,
  birthDate: isoDate,
  phone: z.string().trim().min(6).max(20).optional().openapi({ description: "Required for LAN-group tickets" }),
  discord: z.string().trim().max(50).optional(),
  extras: z.array(z.object({ extraId: z.string().min(1), option: z.string().optional() })).max(10).default([]),
});

const PurchaseSchema = z.object({
  buyer: z.object({
    name: z.string().trim().min(1).max(100),
    email: EmailSchema,
    newsletter: z.boolean().default(false),
  }),
  attendees: z.array(AttendeeSchema).min(1).max(20).openapi({
    description: "One per person; a pack type needs a whole number of packs of people",
  }),
});
type Attendee = z.infer<typeof AttendeeSchema>;

/** LAN and Fighting tickets (and their packs) are the ones whose type offers the LAN extras. */
const isLanGroup = (type: TicketType) => typeSettings(type).extrasFrom === "lan";

/** Units of each type an order takes: one per person, or one per pack of packSize people. */
function unitsByType(attendees: { typeId: string }[], types: Map<string, TicketType>): string[] {
  const units: string[] = [];
  for (const type of types.values()) {
    const people = attendees.filter((a) => a.typeId === type.id).length;
    for (let i = 0; i < people / typeSettings(type).packSize; i++) units.push(type.id);
  }
  return units;
}

purchase.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["Tickets"],
    summary: "Buy tickets online",
    description:
      "No account needed; when a token is sent the tickets are also linked to that account. " +
      "Creates an order with its tickets pending and returns the Stripe Checkout to send the " +
      "buyer to. Every ticket, free ones included, becomes active when Stripe confirms payment; " +
      "an unpaid checkout expires after 30 minutes and gives its places back. An order needs at " +
      "least one paid ticket: free tickets (children) can't be bought alone.",
    ...auditedAs("ticket.purchase", "ticket.checkoutFailed"),
    middleware: [optionalAuth] as const,
    request: {
      body: { required: true, content: { "application/json": { schema: PurchaseSchema } } },
    },
    responses: {
      200: {
        description: "Order created",
        content: {
          "application/json": {
            schema: z.object({
              orderId: z.string(),
              checkoutUrl: z.string().openapi({
                description: "Stripe Checkout",
              }),
            }),
          },
        },
      },
      400: { description: "Invalid body, unknown type or extra, a partial pack, a missing phone, or only free tickets" },
      401: { description: "A token was sent but isn't valid" },
      403: { description: "Online sales are open to staff only for now (testing), or the account is suspended" },
      409: { description: "A ticket type or extra is sold out, or not on sale" },
      502: { description: "Stripe checkout could not be started; nothing was reserved" },
    },
  }),
  async (c) => {
    const { buyer, attendees } = c.req.valid("json");
    const user = c.get("user");

    // While a deployed setup is tested with Stripe's test key, a fake card must not get the
    // public real tickets
    if (ONLINE_SALES_MODE === "staff" && (!user || user.role === "user")) {
      throw new HTTPException(403, { message: "online sales are open to staff only for now" });
    }

    const actor = user ?? guestActor(buyer.email);
    const db = getFirestore();
    const orderRef = db.collection("orders").doc();
    const ticketRefs = attendees.map(() => db.collection("tickets").doc());

    const origin = c.req.header("Origin");
    // Back to the site the purchase came from (e.g. a preview), but only one CORS already
    // trusts, so this can't be turned into a redirect to anywhere
    const returnTo = origin && isAllowed(origin) ? origin : frontendUrl.value().replace(/\/+$/, "");
    const successUrl = `${returnTo}/tickets/success?order=${orderRef.id}`;

    // One transaction so the stock checks and the tickets that take the stock can't interleave
    const { types, extras, tickets } = await db.runTransaction(async (tx) => {
      const extras = await loadExtras(tx, attendees.flatMap((a) => a.extras.map((e) => e.extraId)));
      const types = await reserveCapacity(tx, attendees);
      const packs = packIds(attendees, types);

      attendees.forEach((a) => {
        if (isLanGroup(types.get(a.typeId)!) && !a.phone) {
          throw new HTTPException(400, { message: `a phone is required for ${a.typeId}` });
        }
      });
      // Free tickets are the children's: they come with someone who has a paid ticket. In an
      // order with paid ones they're activated with the rest once Stripe confirms the payment.
      if (attendees.every((a) => types.get(a.typeId)!.price === 0)) {
        throw new HTTPException(400, {
          message: "an order needs at least one paid ticket; children can't come alone",
        });
      }
      reserveExtras(tx, extras, attendees.map((a) => ({ type: types.get(a.typeId)!, picks: a.extras })));

      const total = unitsByType(attendees, types).reduce((sum, id) => sum + types.get(id)!.price, 0)
        + attendees.reduce((sum, a) => sum + a.extras.reduce((s, e) => s + extras.get(e.extraId)!.price, 0), 0);

      const tickets = attendees.map((a, i): TicketWrite => {
        const type = types.get(a.typeId)!;
        const lan = isLanGroup(type);
        return {
          uid: user?.uid ?? null,
          typeId: a.typeId,
          status: "pending",
          code: randomUUID(),
          holderName: a.name,
          holderEmail: a.email,
          paymentMethod: "stripe",
          soldBy: null,
          purchasedAt: FieldValue.serverTimestamp(),
          days: type.days,
          isLanParty: type.isLanParty,
          entries: typeSettings(type).entries,
          packId: packs[i],
          checkins: {},
          orderId: orderRef.id,
          holder: {
            name: a.name,
            birthDate: a.birthDate,
            phone: lan ? a.phone ?? null : null,
            discord: lan ? a.discord || null : null,
          },
          extras: a.extras.map((e): TicketExtra => {
            const extra = extras.get(e.extraId)!;
            return { extraId: extra.id, name: extra.name, option: e.option ?? null, price: extra.price };
          }),
        };
      });

      tickets.forEach((ticket, i) => {
        tx.set(ticketRefs[i], ticket);
        audit(tx, {
          actor,
          action: "ticket.purchase",
          target: { id: ticketRefs[i].id, label: ticket.holderName },
          details: {
            typeId: ticket.typeId,
            price: types.get(ticket.typeId)!.price,
            orderId: orderRef.id,
            extras: ticket.extras!.map((e) => e.extraId),
          },
        });
      });

      tx.create(orderRef, {
        status: "pending",
        buyer,
        uid: user?.uid ?? null,
        ticketIds: ticketRefs.map((ref) => ref.id),
        total,
        stripeSessionId: null,
        paymentIntentId: null,
        createdAt: FieldValue.serverTimestamp(),
        paidAt: null,
      } satisfies OrderWrite);

      return { types, extras, tickets };
    });

    let session: Stripe.Checkout.Session;
    try {
      session = await new Stripe(stripeSecretKey()).checkout.sessions.create({
        mode: "payment",
        line_items: lineItems(attendees, types, extras),
        customer_email: buyer.email,
        locale: "auto",
        expires_at: Math.floor(Date.now() / 1000) + CHECKOUT_LIFETIME_SECONDS,
        success_url: successUrl,
        cancel_url: `${returnTo}/tickets`,
        metadata: { orderId: orderRef.id },
        payment_intent_data: { metadata: { orderId: orderRef.id } },
      });
    } catch (err) {
      // No checkout means nobody can ever pay for these, so they mustn't hold stock
      await db.runTransaction(async (tx) => {
        releaseCapacity(tx, unitsByType(attendees, types));
        releaseExtras(tx, tickets as unknown as Ticket[]);
        tx.delete(orderRef);
        ticketRefs.forEach((ref, i) => {
          tx.delete(ref);
          audit(tx, {
            actor,
            action: "ticket.checkoutFailed",
            target: { id: ref.id, label: tickets[i].holderName },
            details: {},
          });
        });
      });
      console.error("failed to create checkout session", err);
      throw new HTTPException(502, { message: "could not start checkout" });
    }

    await orderRef.update({ stripeSessionId: session.id } satisfies Partial<OrderWrite>);
    return c.json({ orderId: orderRef.id, checkoutUrl: session.url! }, 200);
  },
);

/**
 * What Stripe charges: one line per ticket type, counted in units (a pack's price covers all
 * its people), and one per extra. Free lines are left out; the order keeps them.
 */
function lineItems(
  attendees: Attendee[],
  types: Map<string, TicketType>,
  extras: Map<string, Extra>,
): Stripe.Checkout.SessionCreateParams.LineItem[] {
  const items: Stripe.Checkout.SessionCreateParams.LineItem[] = [];

  for (const type of types.values()) {
    if (type.price === 0) continue;
    const quantity = attendees.filter((a) => a.typeId === type.id).length / typeSettings(type).packSize;
    // A type synced from Stripe is charged at Stripe's own price, so its catalogue,
    // reports and receipts show the real product
    items.push(type.stripePriceId
      ? { price: type.stripePriceId, quantity }
      : { price_data: { currency: "eur", unit_amount: type.price, product_data: { name: type.name } }, quantity });
  }

  for (const extra of extras.values()) {
    if (extra.price === 0) continue;
    const quantity = attendees.flatMap((a) => a.extras).filter((e) => e.extraId === extra.id).length;
    items.push({ price: extra.stripePriceId, quantity });
  }

  return items;
}
