import { getFirestore } from "firebase-admin/firestore";
import { defineSecret } from "firebase-functions/params";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import Stripe from "stripe";

import { audit, AUDIT_COLLECTION, STRIPE_ACTOR } from "./audit/audit";
import { ONLINE_SALES } from "./features";
import { queueTicketEmails } from "./mail";
import { cancelInTransaction } from "./tickets/cancel";
import type { Ticket, TicketWrite } from "./types";

// Declared only while online sales are on: the deploy fails if a declared secret
// is missing from Secret Manager, even when no function binds it
const secrets = ONLINE_SALES
  ? { key: defineSecret("STRIPE_SECRET_KEY"), webhook: defineSecret("STRIPE_WEBHOOK_SECRET") }
  : null;

/** What the function must bind; empty while online sales are off. */
export const stripeSecrets = secrets ? [secrets.key, secrets.webhook] : [];

function secretValue(which: keyof NonNullable<typeof secrets>): string {
  if (!secrets) throw new Error("online sales are off, so Stripe is not configured");
  return secrets[which].value();
}

export const stripeSecretKey = () => secretValue("key");
export const stripeWebhookSecret = () => secretValue("webhook");

export const stripeWebhook = new Hono();

const FULFILLING_EVENTS = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
]);

function ticketIdsFromSession(session: Stripe.Checkout.Session): string[] {
  try {
    const ids = JSON.parse(session.metadata?.ticketIds ?? "[]");
    return Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

stripeWebhook.post("/", async (c) => {
  const signature = c.req.header("stripe-signature");
  if (!signature) {
    throw new HTTPException(400, { message: "missing stripe-signature header" });
  }

  const body = await c.req.text();
  const stripe = new Stripe(stripeSecretKey());

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, signature, stripeWebhookSecret());
  } catch {
    throw new HTTPException(400, { message: "invalid signature" });
  }

  if (FULFILLING_EVENTS.has(event.type)) {
    const session = event.data.object as Stripe.Checkout.Session;

    if (session.payment_status !== "unpaid") {
      const ticketIds = ticketIdsFromSession(session);
      const db = getFirestore();

      if (ticketIds.length > 0) {
        // Recorded so a later refund can find the tickets this payment bought
        const paymentIntentId =
          typeof session.payment_intent === "string"
            ? session.payment_intent
            : (session.payment_intent?.id ?? null);

        const activated = await db.runTransaction(async (tx) => {
          const refs = ticketIds.map((id) => db.doc(`tickets/${id}`));
          const docs = await tx.getAll(...refs);
          const justActivated: Ticket[] = [];

          for (const doc of docs) {
            const ticket = doc.data() as Ticket | undefined;
            if (doc.exists && ticket?.status === "pending") {
              tx.update(doc.ref, {
                status: "active",
                paymentIntentId,
              } satisfies Partial<TicketWrite>);
              audit(tx, {
                actor: STRIPE_ACTOR,
                action: "ticket.paid",
                target: { id: doc.id, label: ticket.holderName },
                details: { stripeEventId: event.id, paymentIntentId },
              });
              justActivated.push(ticket);
            }
          }

          return justActivated;
        });

        // Only the tickets this delivery activated, so a Stripe retry can't send them twice
        if (activated.length > 0) {
          try {
            await queueTicketEmails(
              activated.map((t) => ({
                code: t.code,
                holderName: t.holderName,
                holderEmail: t.holderEmail,
                days: t.days,
              })),
            );
          } catch (err) {
            console.error("failed to queue purchase ticket email", err);
          }
        }
      }
    }
  }

  if (event.type === "charge.refunded") {
    const charge = event.data.object as Stripe.Charge;

    const paymentIntentId =
      typeof charge.payment_intent === "string"
        ? charge.payment_intent
        : (charge.payment_intent?.id ?? null);

    if (paymentIntentId) {
      const db = getFirestore();
      const snap = await db
        .collection("tickets")
        .where("paymentIntentId", "==", paymentIntentId)
        .get();

      if (!snap.empty) {
        // Partial refunds can't say which ticket was refunded, so they're left to an admin
        if (charge.amount_refunded < charge.amount) {
          console.warn(`partial refund on ${charge.id}; cancel the tickets by hand if needed`);

          // Nothing on the ticket changes, so a fixed entry id is what stops a Stripe retry
          // from logging it twice
          const entryIds = snap.docs.map((doc) => `stripe-${event.id}-${doc.id}`);
          await db.runTransaction(async (tx) => {
            const existing = await tx.getAll(...entryIds.map((id) => db.doc(`${AUDIT_COLLECTION}/${id}`)));
            snap.docs.forEach((doc, i) => {
              if (existing[i].exists) return;
              audit(tx, {
                actor: STRIPE_ACTOR,
                action: "ticket.partiallyRefunded",
                target: { id: doc.id, label: (doc.data() as Ticket).holderName },
                details: {
                  stripeEventId: event.id,
                  chargeId: charge.id,
                  amount: charge.amount,
                  amountRefunded: charge.amount_refunded,
                },
                id: entryIds[i],
              });
            });
          });
        } else {
          await db.runTransaction(async (tx) => {
            const docs = await tx.getAll(...snap.docs.map((d) => d.ref));
            for (const { id, ticket } of cancelInTransaction(tx, docs)) {
              audit(tx, {
                actor: STRIPE_ACTOR,
                action: "ticket.refunded",
                target: { id, label: ticket.holderName },
                details: { stripeEventId: event.id, chargeId: charge.id, previousStatus: ticket.status },
              });
            }
          });
        }
      }
    }
  }

  if (event.type === "checkout.session.expired") {
    const ticketIds = ticketIdsFromSession(event.data.object as Stripe.Checkout.Session);

    if (ticketIds.length > 0) {
      const db = getFirestore();
      await db.runTransaction(async (tx) => {
        const docs = await tx.getAll(...ticketIds.map((id) => db.doc(`tickets/${id}`)));
        // Only slots still waiting for payment: a paid ticket must never be voided by an expiry
        const unpaid = docs.filter((doc) => (doc.data() as Ticket | undefined)?.status === "pending");
        for (const { id, ticket } of cancelInTransaction(tx, unpaid)) {
          audit(tx, {
            actor: STRIPE_ACTOR,
            action: "ticket.expired",
            target: { id, label: ticket.holderName },
            details: { stripeEventId: event.id },
          });
        }
      });
    }
  }

  return c.json({ received: true });
});
