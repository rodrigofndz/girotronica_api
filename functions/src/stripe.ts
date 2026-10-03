import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { defineSecret } from "firebase-functions/params";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import Stripe from "stripe";

import { audit, AUDIT_COLLECTION, STRIPE_ACTOR } from "./audit/audit";
import { ONLINE_SALES } from "./features";
import { queueTicketEmails } from "./mail";
import { cancelInTransaction } from "./tickets/cancel";
import type { Order, OrderWrite, Ticket, TicketWrite } from "./types";

// The API key is always needed: the catalogue sync reads products even while online sales
// are off. The webhook secret is declared only with online sales, because the deploy fails
// if a declared secret is missing from Secret Manager, even when no function binds it.
const secretKey = defineSecret("STRIPE_SECRET_KEY");
const webhookSecret = ONLINE_SALES ? defineSecret("STRIPE_WEBHOOK_SECRET") : null;

/** What the function must bind. */
export const stripeSecrets = webhookSecret ? [secretKey, webhookSecret] : [secretKey];

export const stripeSecretKey = () => secretKey.value();

export function stripeWebhookSecret(): string {
  if (!webhookSecret) throw new Error("online sales are off, so the webhook is not configured");
  return webhookSecret.value();
}

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

/**
 * The order a checkout belongs to and its tickets. Checkouts from before orders existed
 * carry the ticket ids themselves and have no order.
 */
async function orderOfSession(
  tx: FirebaseFirestore.Transaction,
  session: Stripe.Checkout.Session,
): Promise<{ order: FirebaseFirestore.DocumentSnapshot | null; ticketIds: string[] }> {
  const orderId = session.metadata?.orderId;
  if (!orderId) return { order: null, ticketIds: ticketIdsFromSession(session) };

  const order = await tx.get(getFirestore().doc(`orders/${orderId}`));
  return { order, ticketIds: order.exists ? (order.data() as Order).ticketIds : [] };
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
      const db = getFirestore();
      // Recorded so a later refund can find the tickets this payment bought
      const paymentIntentId =
        typeof session.payment_intent === "string"
          ? session.payment_intent
          : (session.payment_intent?.id ?? null);

      const activated = await db.runTransaction(async (tx) => {
        const { order, ticketIds } = await orderOfSession(tx, session);
        const docs = ticketIds.length > 0
          ? await tx.getAll(...ticketIds.map((id) => db.doc(`tickets/${id}`)))
          : [];
        const justActivated: Ticket[] = [];

        if (order?.exists && (order.data() as Order).status !== "paid") {
          tx.update(order.ref, {
            status: "paid", paymentIntentId, paidAt: FieldValue.serverTimestamp(),
          } satisfies Partial<OrderWrite>);
        }

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
              extras: (t.extras ?? []).map((e) => ({ name: e.name, option: e.option })),
            })),
          );
        } catch (err) {
          console.error("failed to queue purchase ticket email", err);
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
            for (const { id, ticket } of await cancelInTransaction(tx, docs)) {
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
    const session = event.data.object as Stripe.Checkout.Session;
    const db = getFirestore();

    await db.runTransaction(async (tx) => {
      const { order, ticketIds } = await orderOfSession(tx, session);
      const docs = ticketIds.length > 0
        ? await tx.getAll(...ticketIds.map((id) => db.doc(`tickets/${id}`)))
        : [];
      // Only slots still waiting for payment: a paid ticket must never be voided by an expiry
      const unpaid = docs.filter((doc) => (doc.data() as Ticket | undefined)?.status === "pending");
      const cancelled = await cancelInTransaction(tx, unpaid);
      if (order?.exists && (order.data() as Order).status === "pending") {
        tx.update(order.ref, { status: "expired" } satisfies Partial<OrderWrite>);
      }
      for (const { id, ticket } of cancelled) {
        audit(tx, {
          actor: STRIPE_ACTOR,
          action: "ticket.expired",
          target: { id, label: ticket.holderName },
          details: { stripeEventId: event.id },
        });
      }
    });
  }

  return c.json({ received: true });
});
