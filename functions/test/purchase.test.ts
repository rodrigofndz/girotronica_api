import { getFirestore } from "firebase-admin/firestore";
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  apiFetch, attendee, buyOnline, createUser, extraSold, mailDocs, orderDoc, resetEmulators, seedExtra,
  seedTicketType, sendStripeEvent, soldCount, startApi, stopApi, type TestUser,
} from "./helpers";

// Online sales ship switched off; these tests cover the code for when it is turned on
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

const lan = (overrides: Record<string, unknown> = {}) =>
  attendee({ typeId: "entrada-lan-party", phone: "600000001", discord: "player", ...overrides });

const ticketsOf = async (orderId: string) => {
  const order = await orderDoc(orderId);
  return Promise.all(order!.ticketIds.map(async (id: string) => ({
    id, ...(await getFirestore().doc(`tickets/${id}`).get()).data(),
  }))) as Promise<any[]>;
};

const lastSession = () => createSession.mock.calls.at(-1)![0];

let member: TestUser;

beforeAll(startApi);
afterAll(stopApi);

beforeEach(async () => {
  await resetEmulators();
  createSession.mockReset();
  createSession.mockResolvedValue({ id: "cs_test_1", url: "https://checkout.stripe.test/cs_test_1" });
  member = await createUser("member@example.com");
  await seedTicketType("general", { capacity: 10, price: 900, stripePriceId: "price_general" });
  await seedTicketType("entrada-lan-party", { capacity: 10, price: 3500, extrasFrom: "lan", stripePriceId: "price_lan" });
});

describe("buying without an account", () => {
  it("creates a pending order and returns Stripe's checkout url", async () => {
    const res = await buyOnline([attendee(), attendee({ name: "Biel" })]);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ orderId: expect.any(String), checkoutUrl: "https://checkout.stripe.test/cs_test_1" });
    expect(await orderDoc(res.body.orderId)).toMatchObject({
      status: "pending", uid: null, total: 1800, stripeSessionId: "cs_test_1",
      buyer: { name: "Buyer Person", email: "buyer@example.com", newsletter: false },
    });
    const tickets = await ticketsOf(res.body.orderId);
    expect(tickets.map((t) => [t.status, t.holderName, t.uid])).toEqual([
      ["pending", "Anna Puig", null], ["pending", "Biel Puig", null],
    ]);
    expect(await soldCount("general")).toBe(2);
  });

  it("stores each attendee's details on their ticket", async () => {
    const res = await buyOnline([lan({ email: "  Anna@Example.com " })]);

    const [ticket] = await ticketsOf(res.body.orderId);
    expect(ticket).toMatchObject({
      holderEmail: "anna@example.com", orderId: res.body.orderId,
      holder: { name: "Anna", surname: "Puig", birthDate: "1990-05-10", phone: "600000001", discord: "player" },
    });
  });

  it("asks Stripe for a 30-minute checkout, in the buyer's language, with their email", async () => {
    const before = Math.floor(Date.now() / 1000);
    const res = await buyOnline([attendee()]);

    const session = lastSession();
    expect(session).toMatchObject({
      mode: "payment", customer_email: "buyer@example.com", locale: "auto",
      metadata: { orderId: res.body.orderId }, payment_intent_data: { metadata: { orderId: res.body.orderId } },
    });
    expect(session.expires_at - before).toBeGreaterThanOrEqual(30 * 60);
    expect(session.expires_at - before).toBeLessThan(35 * 60);
  });

  it("returns the buyer to the confirmation page with the order id", async () => {
    const res = await buyOnline([attendee()]);

    expect(lastSession().success_url).toBe(`http://localhost:8080/tickets/success?order=${res.body.orderId}`);
    expect(lastSession().cancel_url).toBe("http://localhost:8080/tickets");
  });
});

describe("buying while signed in", () => {
  it("also links the order and its tickets to the account", async () => {
    const res = await buyOnline([attendee()], { token: member.token });

    expect((await orderDoc(res.body.orderId))!.uid).toBe(member.uid);
    expect((await ticketsOf(res.body.orderId))[0].uid).toBe(member.uid);
  });

  it("refuses a bad token rather than buying as a guest", async () => {
    expect((await buyOnline([attendee()], { token: "not-a-token" })).status).toBe(401);
    expect(await soldCount("general")).toBe(0);
  });
});

describe("what gets charged", () => {
  it("charges the server's prices, one Stripe line per type and per extra", async () => {
    await seedExtra("samarreta", { price: 1500, options: ["S", "M"] });
    await seedExtra("gymsack", { price: 800 });

    const res = await buyOnline([
      attendee({ extras: [{ extraId: "samarreta", option: "M" }, { extraId: "gymsack" }], price: 1 }),
      attendee({ extras: [{ extraId: "samarreta", option: "S" }] }),
    ]);

    expect(lastSession().line_items).toEqual([
      { price: "price_general", quantity: 2 },
      { price: "price_samarreta", quantity: 2 },
      { price: "price_gymsack", quantity: 1 },
    ]);
    expect((await orderDoc(res.body.orderId))!.total).toBe(900 * 2 + 1500 * 2 + 800);
  });

  it("charges a pack once per unit, not once per person", async () => {
    await seedTicketType("pack-10", { capacity: 5, price: 35000, packSize: 2, stripePriceId: "price_pack10" });

    await buyOnline([attendee({ typeId: "pack-10" }), attendee({ typeId: "pack-10" })]);

    expect(lastSession().line_items).toEqual([{ price: "price_pack10", quantity: 1 }]);
  });

  it("uses an inline price for a type not synced from Stripe", async () => {
    await seedTicketType("manual", { price: 400 });

    await buyOnline([attendee({ typeId: "manual" })]);

    expect(lastSession().line_items[0]).toMatchObject({ quantity: 1, price_data: { currency: "eur", unit_amount: 400 } });
  });

  it("leaves free tickets and extras out of Stripe, keeping them in the order", async () => {
    await seedTicketType("entrada-infants", { price: 0 });
    await seedExtra("welcome-pack", { price: 0, groups: ["lan"] });

    const res = await buyOnline([attendee({ typeId: "entrada-infants" }), lan({ extras: [{ extraId: "welcome-pack" }] })]);

    expect(lastSession().line_items).toEqual([{ price: "price_lan", quantity: 1 }]);
    expect((await ticketsOf(res.body.orderId)).map((t) => t.typeId).sort()).toEqual(["entrada-infants", "entrada-lan-party"]);
  });
});

describe("free tickets (children)", () => {
  beforeEach(async () => {
    await seedTicketType("entrada-infants", { price: 0, capacity: 5 });
    await seedExtra("gymsack", { price: 800 });
  });

  it("can't be bought alone, even with paid extras, and reserve nothing", async () => {
    for (const attendees of [
      [attendee({ typeId: "entrada-infants" }), attendee({ typeId: "entrada-infants", name: "Biel" })],
      [attendee({ typeId: "entrada-infants", extras: [{ extraId: "gymsack" }] })],
    ]) {
      const res = await buyOnline(attendees);

      expect(res.status).toBe(400);
      expect(res.body).toBe("an order needs at least one paid ticket; children can't come alone");
    }
    expect(await soldCount("entrada-infants")).toBe(0);
    expect(await extraSold("gymsack")).toBe(0);
    expect(createSession).not.toHaveBeenCalled();
  });

  it("wait with the paid tickets and are activated together once Stripe confirms payment", async () => {
    const res = await buyOnline([
      attendee({ email: "parent@example.com" }),
      attendee({ typeId: "entrada-infants", name: "Kid", email: "parent@example.com" }),
    ]);
    expect((await ticketsOf(res.body.orderId)).map((t) => t.status)).toEqual(["pending", "pending"]);

    await sendStripeEvent("checkout.session.completed", {
      id: "cs_test_1", object: "checkout.session", metadata: { orderId: res.body.orderId },
      payment_status: "paid", payment_intent: "pi_1",
    });

    expect((await ticketsOf(res.body.orderId)).map((t) => [t.typeId, t.status])).toEqual([
      ["general", "active"], ["entrada-infants", "active"],
    ]);
  });

  it("are given back with the rest when the checkout expires", async () => {
    const res = await buyOnline([attendee(), attendee({ typeId: "entrada-infants" })]);

    await sendStripeEvent("checkout.session.expired", {
      id: "cs_test_1", object: "checkout.session", metadata: { orderId: res.body.orderId },
    });

    expect(await soldCount("entrada-infants")).toBe(0);
    expect((await ticketsOf(res.body.orderId)).map((t) => t.status)).toEqual(["cancelled", "cancelled"]);
  });
});

describe("extras", () => {
  beforeEach(async () => {
    await seedExtra("samarreta", { options: ["S", "M"], capacity: 2 });
    await seedExtra("dormitori", { price: 0, groups: ["lan"] });
  });

  it("are stored on the attendee's ticket, as they were bought", async () => {
    const res = await buyOnline([attendee({ extras: [{ extraId: "samarreta", option: "M" }] })]);

    expect((await ticketsOf(res.body.orderId))[0].extras).toEqual([
      { extraId: "samarreta", name: "samarreta", option: "M", price: 1500 },
    ]);
    expect(await extraSold("samarreta")).toBe(1);
  });

  it.each([
    ["an unknown extra", [{ extraId: "nope" }], "unknown extra: nope"],
    ["one not offered with the ticket", [{ extraId: "dormitori" }], "extra dormitori isn't offered with general"],
    ["a missing size", [{ extraId: "samarreta" }], "extra samarreta needs one of: S, M"],
    ["a size that doesn't exist", [{ extraId: "samarreta", option: "XXL" }], "extra samarreta needs one of: S, M"],
    ["the same extra twice", [{ extraId: "samarreta", option: "S" }, { extraId: "samarreta", option: "M" }], "extra samarreta chosen twice for one person"],
  ])("refuses %s, reserving nothing", async (_label, extras, message) => {
    const res = await buyOnline([attendee({ extras })]);

    expect(res.status).toBe(400);
    expect(res.body).toBe(message);
    expect(await soldCount("general")).toBe(0);
  });

  it("refuses an option on an extra without options", async () => {
    const res = await buyOnline([lan({ extras: [{ extraId: "dormitori", option: "M" }] })]);

    expect(res.body).toBe("extra dormitori has no options");
  });

  it("refuses more than the stock left, across the whole order", async () => {
    const res = await buyOnline([1, 2, 3].map(() => attendee({ extras: [{ extraId: "samarreta", option: "S" }] })));

    expect(res.status).toBe(409);
    expect(res.body).toBe("sold out: extra samarreta has 2 left, asked for 3");
    expect(await extraSold("samarreta")).toBe(0);
    expect(await soldCount("general")).toBe(0);
  });
});

describe("what each ticket needs", () => {
  it("needs a phone for LAN tickets, and keeps discord optional", async () => {
    expect((await buyOnline([lan({ phone: undefined })])).body).toBe("a phone is required for entrada-lan-party");
    expect((await buyOnline([lan({ discord: undefined })])).status).toBe(200);
  });

  it("doesn't keep a phone or discord for other tickets", async () => {
    const res = await buyOnline([attendee({ phone: "600000001", discord: "x" })]);

    expect((await ticketsOf(res.body.orderId))[0].holder).toMatchObject({ phone: null, discord: null });
  });

  it("needs whole packs of people", async () => {
    await seedTicketType("pack-10", { packSize: 2 });

    expect((await buyOnline([attendee({ typeId: "pack-10" })])).body).toBe("pack-10 is sold in packs of 2; got 1 tickets");
  });

  it.each([
    ["no attendees", []],
    ["more than 20 attendees", Array.from({ length: 21 }, () => attendee())],
    ["a birth date in the future", [attendee({ birthDate: "2999-01-01" })]],
    ["a birth date that isn't a date", [attendee({ birthDate: "10/05/1990" })]],
    ["an attendee without a surname", [attendee({ surname: " " })]],
    ["an invalid attendee email", [attendee({ email: "nope" })]],
  ])("refuses %s", async (_label, attendees) => {
    expect((await buyOnline(attendees)).status).toBe(400);
  });

  it("refuses a buyer without a valid email", async () => {
    expect((await buyOnline([attendee()], { buyer: { name: "X", email: "nope" } })).status).toBe(400);
  });

  it("refuses when sold out or not on sale, without calling Stripe", async () => {
    await seedTicketType("full", { capacity: 1, sold: 1 });
    await seedTicketType("closed", { salesEnd: new Date(Date.now() - 3600_000).toISOString() });

    expect((await buyOnline([attendee({ typeId: "full" })])).status).toBe(409);
    expect((await buyOnline([attendee({ typeId: "closed" })])).body).toBe("not on sale: closed");
    expect(createSession).not.toHaveBeenCalled();
  });
});

describe("when Stripe fails", () => {
  beforeEach(() => {
    createSession.mockReset();
    createSession.mockRejectedValue(new Error("stripe is down"));
  });

  it("reports it and gives back every place, pack and extra", async () => {
    await seedTicketType("pack-10", { packSize: 2, capacity: 5 });
    await seedExtra("samarreta", { capacity: 5 });

    const res = await buyOnline([
      attendee({ typeId: "pack-10", extras: [{ extraId: "samarreta" }] }), attendee({ typeId: "pack-10" }),
    ]);

    expect(res.status).toBe(502);
    expect(await soldCount("pack-10")).toBe(0);
    expect(await extraSold("samarreta")).toBe(0);
    expect((await getFirestore().collection("orders").get()).empty).toBe(true);
    expect((await getFirestore().collection("tickets").get()).empty).toBe(true);
  });
});

describe("Stripe's answers about an order", () => {
  const paid = (orderId: string) => ({
    id: "cs_test_1", object: "checkout.session", metadata: { orderId }, payment_status: "paid", payment_intent: "pi_1",
  });

  it("marks the order and its tickets paid, and emails each attendee", async () => {
    const res = await buyOnline([attendee({ email: "a@example.com" }), attendee({ email: "b@example.com" })]);

    await sendStripeEvent("checkout.session.completed", paid(res.body.orderId));

    expect(await orderDoc(res.body.orderId)).toMatchObject({ status: "paid", paymentIntentId: "pi_1", paidAt: expect.anything() });
    expect((await ticketsOf(res.body.orderId)).map((t) => t.status)).toEqual(["active", "active"]);
    expect((await mailDocs()).map((m) => m.to[0]).sort()).toEqual(["a@example.com", "b@example.com"]);
  });

  it("lists each attendee's extras in their email", async () => {
    await seedExtra("samarreta", { name: "Samarreta", options: ["M"] });
    await seedExtra("gymsack", { name: "Gymsack" });
    const res = await buyOnline([
      attendee({ email: "a@example.com", extras: [{ extraId: "samarreta", option: "M" }, { extraId: "gymsack" }] }),
      attendee({ email: "b@example.com" }),
    ]);

    await sendStripeEvent("checkout.session.completed", paid(res.body.orderId));

    const mail = await mailDocs();
    const to = (email: string) => mail.find((m) => m.to[0] === email).message.html as string;
    expect(to("a@example.com")).toContain("Extres: Samarreta (M), Gymsack");
    expect(to("b@example.com")).not.toContain("Extres");
  });

  it("expires the order, giving back its places and extras", async () => {
    await seedExtra("samarreta", { capacity: 5 });
    const res = await buyOnline([attendee({ extras: [{ extraId: "samarreta" }] })]);

    await sendStripeEvent("checkout.session.expired", { id: "cs_test_1", object: "checkout.session", metadata: { orderId: res.body.orderId } });

    expect((await orderDoc(res.body.orderId))!.status).toBe("expired");
    expect((await ticketsOf(res.body.orderId))[0].status).toBe("cancelled");
    expect(await soldCount("general")).toBe(0);
    expect(await extraSold("samarreta")).toBe(0);
  });
});

describe("the confirmation page's view of an order", () => {
  it("shows status, total and tickets, but no codes, emails or personal details", async () => {
    await seedExtra("samarreta", { options: ["M"] });
    const res = await buyOnline([lan(), attendee({ extras: [{ extraId: "samarreta", option: "M" }] })]);

    const view = await apiFetch("GET", `/orders/${res.body.orderId}`);

    expect(view.status).toBe(200);
    expect(view.body).toEqual({
      id: res.body.orderId, status: "pending", total: 3500 + 900 + 1500,
      tickets: expect.arrayContaining([
        { id: expect.any(String), typeId: "general", status: "pending", holderName: "Anna Puig", days: ["2026-11-20"],
          extras: [{ extraId: "samarreta", name: "samarreta", option: "M" }] },
      ]),
    });
    const text = JSON.stringify(view.body);
    for (const secret of ["600000001", "anna@example.com", "1990-05-10", "code", "buyer@example.com"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("needs no account, and says so for an unknown order", async () => {
    expect((await apiFetch("GET", "/orders/does-not-exist")).status).toBe(404);
  });
});

describe("where Stripe sends the buyer back", () => {
  it("is the site the purchase came from, when CORS trusts it (e.g. a preview)", async () => {
    process.env.PREVIEW_PROJECTS = "girotronica-web";
    const preview = "https://girotronica-web--pr7-abc123.web.app";

    const res = await buyOnline([attendee()], { headers: { Origin: preview } });

    expect(lastSession().success_url).toBe(`${preview}/tickets/success?order=${res.body.orderId}`);
    expect(lastSession().cancel_url).toBe(`${preview}/tickets`);
    delete process.env.PREVIEW_PROJECTS;
  });

  it("falls back to FRONTEND_URL for an untrusted origin", async () => {
    await buyOnline([attendee()], { headers: { Origin: "https://evil.example" } });

    expect(lastSession().cancel_url).toBe("http://localhost:8080/tickets");
  });
});
