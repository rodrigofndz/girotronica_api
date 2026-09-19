import { getFirestore } from "firebase-admin/firestore";
import { defineSecret } from "firebase-functions/params";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import Stripe from "stripe";

import { queueTicketEmails } from "./mail";
import { cancelInTransaction } from "./tickets/cancel";
import type { Ticket, TicketWrite } from "./types";

export const stripeSecretKey = defineSecret("STRIPE_SECRET_KEY");
export const stripeWebhookSecret = defineSecret("STRIPE_WEBHOOK_SECRET");

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
  const stripe = new Stripe(stripeSecretKey.value());

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, signature, stripeWebhookSecret.value());
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

    // Partial refunds can't say which ticket was refunded, so they're left to an admin
    if (charge.amount_refunded < charge.amount) {
      console.warn(`partial refund on ${charge.id}; cancel the tickets by hand if needed`);
    } else {
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
          await db.runTransaction(async (tx) => {
            const docs = await tx.getAll(...snap.docs.map((d) => d.ref));
            cancelInTransaction(tx, docs);
          });
        }
      }
    }
  }

  return c.json({ received: true });
});
