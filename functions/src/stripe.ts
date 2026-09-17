import { getFirestore } from "firebase-admin/firestore";
import { defineSecret, defineString } from "firebase-functions/params";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import Stripe from "stripe";

export const stripeSecretKey = defineSecret("STRIPE_SECRET_KEY");
export const stripeWebhookSecret = defineSecret("STRIPE_WEBHOOK_SECRET");
export const frontendUrl = defineString("FRONTEND_URL", {
  default: "http://localhost:8080",
});

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
        await db.runTransaction(async (tx) => {
          const refs = ticketIds.map((id) => db.doc(`tickets/${id}`));
          const docs = await tx.getAll(...refs);

          for (const doc of docs) {
            if (doc.exists && doc.data()?.status === "pending") {
              tx.update(doc.ref, { status: "active" });
            }
          }
        });
      }
    }
  }

  return c.json({ received: true });
});
