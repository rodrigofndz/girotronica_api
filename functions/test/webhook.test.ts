import { getFirestore } from "firebase-admin/firestore";
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  apiFetch, checkoutSession, mailDocs, resetEmulators, seedTicketType, sendStripeEvent,
  soldCount, startApi, stopApi, ticketStatus,
} from "./helpers";

// Online sales ship switched off; these tests cover the code for when it is turned back on
vi.mock("../src/features", () => ({ ONLINE_SALES: true, ONLINE_SALES_MODE: "public" }));

const newTicket = (status: string, extra: Record<string, unknown> = {}) =>
  getFirestore().collection("tickets").add({
    uid: null, typeId: "general", status, code: `code-${Math.random()}`,
    holderName: "Holder", holderEmail: "holder@example.com", paymentMethod: "stripe",
    soldBy: null, purchasedAt: new Date(), days: ["2026-11-20"], isLanParty: false,
    checkins: {}, ...extra,
  });

beforeAll(startApi);
afterAll(stopApi);

beforeEach(async () => {
  await resetEmulators();
  await seedTicketType("general", { capacity: 10, sold: 1 });
});

describe("stripe webhook security", () => {
  it("rejects a request with no signature", async () => {
    const res = await apiFetch("POST", "/stripe/webhook", {
      body: { type: "checkout.session.completed" },
    });

    expect(res.status).toBe(400);
  });

  it("rejects a forged signature", async () => {
    const res = await apiFetch("POST", "/stripe/webhook", {
      body: { type: "checkout.session.completed" },
      headers: { "stripe-signature": "t=1,v1=deadbeef" },
    });

    expect(res.status).toBe(400);
  });

  it("does not act on an unsigned payload", async () => {
    const ticket = await newTicket("pending");

    await apiFetch("POST", "/stripe/webhook", {
      body: { type: "checkout.session.completed", data: { object: checkoutSession([ticket.id]) } },
    });

    expect(await ticketStatus(ticket.id)).toBe("pending");
  });
});

describe("payment confirmation", () => {
  it("activates the tickets and records the payment intent", async () => {
    const ticket = await newTicket("pending");

    const res = await sendStripeEvent(
      "checkout.session.completed",
      checkoutSession([ticket.id], { payment_status: "paid", payment_intent: "pi_1" }),
    );

    expect(res.status).toBe(200);
    const stored = (await ticket.get()).data()!;
    expect(stored.status).toBe("active");
    expect(stored.paymentIntentId).toBe("pi_1");
  });

  it("emails the ticket once, even when Stripe retries", async () => {
    const ticket = await newTicket("pending");
    const session = checkoutSession([ticket.id], { payment_status: "paid", payment_intent: "pi_1" });

    await sendStripeEvent("checkout.session.completed", session);
    await sendStripeEvent("checkout.session.completed", session);

    expect(await mailDocs()).toHaveLength(1);
  });

  it("also fulfils a delayed payment", async () => {
    const ticket = await newTicket("pending");

    await sendStripeEvent(
      "checkout.session.async_payment_succeeded",
      checkoutSession([ticket.id], { payment_status: "paid", payment_intent: "pi_1" }),
    );

    expect(await ticketStatus(ticket.id)).toBe("active");
  });

  it("activates a free order, which has no payment intent", async () => {
    const ticket = await newTicket("pending");

    await sendStripeEvent(
      "checkout.session.completed",
      checkoutSession([ticket.id], { payment_status: "no_payment_required", payment_intent: null }),
    );

    const stored = (await ticket.get()).data()!;
    expect(stored.status).toBe("active");
    expect(stored.paymentIntentId).toBeNull();
    expect(await mailDocs()).toHaveLength(1);
  });

  it("ignores a session that is still unpaid", async () => {
    const ticket = await newTicket("pending");

    await sendStripeEvent(
      "checkout.session.completed",
      checkoutSession([ticket.id], { payment_status: "unpaid" }),
    );

    expect(await ticketStatus(ticket.id)).toBe("pending");
    expect(await mailDocs()).toHaveLength(0);
  });
});

describe("refunds", () => {
  const paidTickets = async (count: number) => {
    const refs = await Promise.all(
      Array.from({ length: count }, () => newTicket("active", { paymentIntentId: "pi_1" })),
    );
    await getFirestore().doc("ticketTypes/general").update({ sold: count });
    return refs;
  };

  it("cancels every ticket of a fully refunded payment and frees the slots", async () => {
    const refs = await paidTickets(2);

    await sendStripeEvent("charge.refunded", {
      id: "ch_1", object: "charge", payment_intent: "pi_1", amount: 1800, amount_refunded: 1800,
    });

    for (const ref of refs) expect(await ticketStatus(ref.id)).toBe("cancelled");
    expect(await soldCount("general")).toBe(0);
  });

  it("leaves tickets alone on a partial refund", async () => {
    const refs = await paidTickets(2);

    await sendStripeEvent("charge.refunded", {
      id: "ch_1", object: "charge", payment_intent: "pi_1", amount: 1800, amount_refunded: 900,
    });

    for (const ref of refs) expect(await ticketStatus(ref.id)).toBe("active");
    expect(await soldCount("general")).toBe(2);
  });

  it("frees the slots only once when the refund is redelivered", async () => {
    await paidTickets(2);
    const refund = {
      id: "ch_1", object: "charge", payment_intent: "pi_1", amount: 1800, amount_refunded: 1800,
    };

    await sendStripeEvent("charge.refunded", refund);
    await sendStripeEvent("charge.refunded", refund);

    expect(await soldCount("general")).toBe(0);
  });
});

describe("abandoned checkouts", () => {
  it("cancels the unpaid tickets and frees their slots", async () => {
    const ticket = await newTicket("pending");

    await sendStripeEvent("checkout.session.expired", checkoutSession([ticket.id]));

    expect(await ticketStatus(ticket.id)).toBe("cancelled");
    expect(await soldCount("general")).toBe(0);
  });

  it("never voids a ticket that was already paid for", async () => {
    const ticket = await newTicket("active", { paymentIntentId: "pi_1" });

    await sendStripeEvent("checkout.session.expired", checkoutSession([ticket.id]));

    expect(await ticketStatus(ticket.id)).toBe("active");
    expect(await soldCount("general")).toBe(1);
  });

  it("does nothing when payment landed before the expiry arrived", async () => {
    const ticket = await newTicket("pending");
    await sendStripeEvent(
      "checkout.session.completed",
      checkoutSession([ticket.id], { payment_status: "paid", payment_intent: "pi_1" }),
    );

    await sendStripeEvent("checkout.session.expired", checkoutSession([ticket.id]));

    expect(await ticketStatus(ticket.id)).toBe("active");
  });

  it("accepts an event naming tickets that do not exist", async () => {
    const res = await sendStripeEvent("checkout.session.expired", checkoutSession(["ghost"]));

    expect(res.status).toBe(200);
  });
});
