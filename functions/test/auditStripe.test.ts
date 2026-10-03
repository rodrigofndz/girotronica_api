import { getFirestore } from "firebase-admin/firestore";
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  attendee, auditEntries, buyOnline, checkoutSession, createUser, resetEmulators, seedTicketType, sendStripeEvent,
  startApi, stopApi, type TestUser,
} from "./helpers";

// Online sales ship switched off; these tests cover the code for when it is turned back on
vi.mock("../src/features", () => ({ ONLINE_SALES: true, ONLINE_SALES_MODE: "public" }));

// Only the checkout call is faked; the real Stripe class (and its webhook signing) stays
const createSession = vi.hoisted(() => vi.fn());

vi.mock("stripe", async (importOriginal) => {
  const Real = ((await importOriginal()) as { default: new (key: string) => object }).default;
  class FakeCheckoutStripe extends Real {
    checkout = { sessions: { create: createSession } };
  }
  return { default: FakeCheckoutStripe };
});

let buyer: TestUser;

const buy = (names: string[], as: "member" | "guest" = "member") =>
  buyOnline(names.map((name) => attendee({ name })), { token: as === "member" ? buyer.token : undefined });

const pendingTicketIds = async () =>
  (await getFirestore().collection("tickets").where("status", "==", "pending").get()).docs.map((d) => d.id);

/** Buys online and has Stripe confirm the payment, as a real purchase would. */
async function paidTickets(holders: string[]): Promise<string[]> {
  await buy(holders);
  const ids = await pendingTicketIds();
  await sendStripeEvent(
    "checkout.session.completed",
    checkoutSession(ids, { payment_status: "paid", payment_intent: "pi_1" }),
  );
  return ids;
}

const charge = (amountRefunded: number) => ({
  id: "ch_1", object: "charge", payment_intent: "pi_1", amount: 1800, amount_refunded: amountRefunded,
});

beforeAll(startApi);
afterAll(stopApi);

beforeEach(async () => {
  await resetEmulators();
  createSession.mockReset();
  createSession.mockResolvedValue({ id: "cs_test_1", url: "https://checkout.stripe.test/cs_test_1" });
  buyer = await createUser("buyer@example.com");
  await seedTicketType("general", { capacity: 10, price: 900 });
});

describe("the online purchase", () => {
  it("records each ticket the buyer started paying for", async () => {
    await buy(["Anna", "Biel"]);

    const entries = await auditEntries("ticket.purchase");

    expect(entries.map((e) => e.targetLabel).sort()).toEqual(["Anna Puig", "Biel Puig"]);
    expect(entries[0]).toMatchObject({
      actorUid: buyer.uid, actorRole: "user",
      details: { typeId: "general", price: 900, orderId: expect.any(String), extras: [] },
    });
  });

  it("records a guest purchase under the buyer's email", async () => {
    await buy(["Anna"], "guest");

    expect((await auditEntries("ticket.purchase"))[0]).toMatchObject({
      actorUid: null, actorEmail: "buyer@example.com", actorRole: "guest",
    });
  });

  it("records the tickets dropped when Stripe checkout can't start", async () => {
    createSession.mockRejectedValue(new Error("stripe is down"));

    await buy(["Anna"]);

    const [purchase] = await auditEntries("ticket.purchase");
    const [dropped] = await auditEntries("ticket.checkoutFailed");
    expect(dropped).toMatchObject({ targetId: purchase.targetId, actorUid: buyer.uid });
  });
});

describe("what Stripe does", () => {
  it("records the payment against each ticket, as Stripe, with the event", async () => {
    const ids = await paidTickets(["Anna", "Biel"]);

    const entries = await auditEntries("ticket.paid");

    expect(entries.map((e) => e.targetId).sort()).toEqual(ids.sort());
    expect(entries[0]).toMatchObject({
      actorUid: null, actorEmail: null, actorRole: "stripe",
      details: { paymentIntentId: "pi_1", stripeEventId: expect.stringMatching(/^evt_/) },
    });
  });

  it("records a payment once even when Stripe redelivers it", async () => {
    await buy(["Anna"]);
    const session = checkoutSession(await pendingTicketIds(), { payment_status: "paid", payment_intent: "pi_1" });

    const { id } = await sendStripeEvent("checkout.session.completed", session);
    await sendStripeEvent("checkout.session.completed", session, id);

    expect(await auditEntries("ticket.paid")).toHaveLength(1);
  });

  it("records an expired checkout", async () => {
    await buy(["Anna"]);
    const ids = await pendingTicketIds();

    const { id } = await sendStripeEvent("checkout.session.expired", checkoutSession(ids));

    expect(await auditEntries("ticket.expired")).toEqual([
      expect.objectContaining({ targetId: ids[0], actorRole: "stripe", details: { stripeEventId: id } }),
    ]);
  });

  it("records a full refund against each ticket it cancelled", async () => {
    const ids = await paidTickets(["Anna", "Biel"]);

    await sendStripeEvent("charge.refunded", charge(1800));

    const entries = await auditEntries("ticket.refunded");
    expect(entries.map((e) => e.targetId).sort()).toEqual(ids.sort());
    expect(entries[0].details).toMatchObject({ chargeId: "ch_1", previousStatus: "active" });
  });

  it("records a partial refund for an admin to see, once per ticket even if redelivered", async () => {
    const ids = await paidTickets(["Anna", "Biel"]);

    const { id } = await sendStripeEvent("charge.refunded", charge(900));
    const retry = await sendStripeEvent("charge.refunded", charge(900), id);

    // Anything but 2xx makes Stripe keep retrying for days
    expect(retry.status).toBe(200);
    const entries = await auditEntries("ticket.partiallyRefunded");
    expect(entries.map((e) => e.targetId).sort()).toEqual(ids.sort());
    expect(entries[0].details).toEqual({ stripeEventId: id, chargeId: "ch_1", amount: 1800, amountRefunded: 900 });
  });
});
