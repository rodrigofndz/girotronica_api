import { getFirestore } from "firebase-admin/firestore";
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  apiFetch, attendee, auditEntries, buyOnline, createUser, orderDoc, resetEmulators, seedTicketType,
  sendStripeEvent, soldCount, startApi, stopApi, ticketStatus, type TestUser,
} from "./helpers";

// Online sales ship switched off; these tests cover the code for when it is turned on
vi.mock("../src/features", () => ({ ONLINE_SALES: true, ONLINE_SALES_MODE: "public", COMPANIONS_ADMIN_ONLY: false }));

// Only the checkout call is faked; the real Stripe class (and its webhook signing) stays
const createSession = vi.hoisted(() => vi.fn());

vi.mock("stripe", async (importOriginal) => {
  const Real = ((await importOriginal()) as { default: new (key: string) => object }).default;
  class FakeCheckoutStripe extends Real {
    checkout = { sessions: { create: createSession } };
  }
  return { default: FakeCheckoutStripe };
});

let admin: TestUser;
let staff: TestUser;
let member: TestUser;

const player = (overrides: Record<string, unknown> = {}) =>
  attendee({ typeId: "lan", phone: "600000001", ...overrides });
const companion = (overrides: Record<string, unknown> = {}) =>
  attendee({ typeId: "companion", name: "Parent", ...overrides });

const ticket = async (id: string) => (await getFirestore().doc(`tickets/${id}`).get()).data()!;
const ticketIdsOf = async (orderId: string) => (await orderDoc(orderId))!.ticketIds as string[];

const pay = (orderId: string, paymentIntent = "pi_1") =>
  sendStripeEvent("checkout.session.completed", {
    id: "cs_test_1", object: "checkout.session", metadata: { orderId },
    payment_status: "paid", payment_intent: paymentIntent,
  });

/** An active LAN ticket linked to `user`'s account, given by an admin. */
const ownLanTicket = async (user = member) =>
  (await apiFetch("POST", `/users/${user.uid}/tickets`, { token: admin.token, body: { typeId: "lan" } })).body.id as string;

const doorSale = (items: Record<string, unknown>[]) =>
  apiFetch("POST", "/tickets/door", {
    token: staff.token,
    body: {
      paymentMethod: "cash",
      items: items.map((item) => ({ holderName: "Someone", holderEmail: "someone@example.com", ...item })),
    },
  });

const cancel = (id: string, token = staff.token) => apiFetch("POST", `/tickets/${id}/cancel`, { token });

beforeAll(startApi);
afterAll(stopApi);

beforeEach(async () => {
  await resetEmulators();
  createSession.mockReset();
  createSession.mockResolvedValue({ id: "cs_test_1", url: "https://checkout.stripe.test/cs_test_1" });
  admin = await createUser("admin@example.com", "admin");
  staff = await createUser("staff@example.com", "staff");
  member = await createUser("member@example.com", "user", "Member");
  await seedTicketType("lan", { price: 3500, capacity: 10, extrasFrom: "lan", allowsCompanion: true, stripePriceId: "price_lan" });
  await seedTicketType("lan-pack", { price: 3000, capacity: 5, extrasFrom: "lan", packSize: 2, allowsCompanion: true });
  await seedTicketType("companion", { price: 1000, capacity: 10, isCompanion: true, stripePriceId: "price_companion" });
  await seedTicketType("general", { price: 900, capacity: 10 });
});

describe("buying a companion online", () => {
  it("goes with someone in the same order, linked both ways", async () => {
    const res = await buyOnline([player(), companion({ with: 0 })]);

    expect(res.status).toBe(200);
    const [host, guest] = await ticketIdsOf(res.body.orderId);
    expect(await ticket(guest)).toMatchObject({ typeId: "companion", companionOf: host });
    expect(await ticket(host)).toMatchObject({ companionId: guest });
    const logged = await auditEntries("ticket.purchase");
    expect(logged.find((e) => e.targetId === guest).details.companionOf).toBe(host);
    expect(logged.find((e) => e.targetId === host).details.companionOf).toBeUndefined();
    expect(lastLineItems()).toEqual([{ price: "price_lan", quantity: 1 }, { price: "price_companion", quantity: 1 }]);
  });

  it("can go with each person of a pack, one each", async () => {
    const res = await buyOnline([
      player({ typeId: "lan-pack" }), player({ typeId: "lan-pack" }), companion({ with: 0 }), companion({ with: 1 }),
    ]);

    expect(res.status).toBe(200);
    const [first, second, , ] = await ticketIdsOf(res.body.orderId);
    expect((await ticket(first)).companionId).toBeTruthy();
    expect((await ticket(second)).companionId).toBeTruthy();
  });

  it.each([
    ["a companion that goes with no one", [player(), companion()], "companion is a companion ticket: say who it goes with"],
    ["a companion on its own", [companion({ with: 0 })], "person 0 goes with person 0, who isn't in this sale"],
    ["someone who isn't in the order", [player(), companion({ with: 5 })], "person 1 goes with person 5, who isn't in this sale"],
    ["a type that doesn't take companions", [attendee(), companion({ with: 0 })], "general doesn't take companions"],
    ["another companion", [player(), companion({ with: 0 }), companion({ with: 1 })], "companion doesn't take companions"],
    ["two companions for one person", [player(), companion({ with: 0 }), companion({ with: 0 })], "only one companion per ticket; two go with person 0"],
    ["`with` on a ticket that isn't a companion", [player(), attendee({ with: 0 })], "general isn't a companion ticket, so it goes with no one"],
  ])("refuses %s, reserving nothing", async (_label, attendees, message) => {
    const res = await buyOnline(attendees);

    expect(res.status).toBe(400);
    expect(res.body).toBe(message);
    expect(await soldCount("companion")).toBe(0);
    expect(await soldCount("lan")).toBe(0);
  });
});

describe("a companion for a ticket bought before", () => {
  it("goes with one of the buyer's own tickets", async () => {
    const host = await ownLanTicket();

    const res = await buyOnline([companion({ with: host })], { token: member.token });

    expect(res.status).toBe(200);
    const [guest] = await ticketIdsOf(res.body.orderId);
    expect(await ticket(guest)).toMatchObject({ companionOf: host, status: "pending" });
    expect((await ticket(host)).companionId).toBe(guest);
  });

  it("needs the buyer signed in, and the ticket theirs", async () => {
    const host = await ownLanTicket();
    const other = await createUser("other@example.com");

    expect((await buyOnline([companion({ with: host })])).body).toBe("sign in to bring a companion for a ticket you already have");
    expect((await buyOnline([companion({ with: host })], { token: other.token })).body).toBe(`unknown ticket: ${host}`);
    expect((await buyOnline([companion({ with: "nope" })], { token: member.token })).body).toBe("unknown ticket: nope");
    expect(await soldCount("companion")).toBe(0);
  });

  it("refuses a ticket that has a companion, isn't active, or whose type stopped taking them", async () => {
    const taken = await ownLanTicket();
    await buyOnline([companion({ with: taken })], { token: member.token });
    const cancelled = await ownLanTicket();
    await cancel(cancelled);
    const closed = await ownLanTicket();
    await apiFetch("PATCH", "/ticket-types/lan", { token: admin.token, body: { allowsCompanion: false } });

    for (const [host, message] of [
      [taken, `ticket ${taken} already has a companion`],
      [cancelled, `ticket ${cancelled} isn't active, so it can't take a companion`],
      [closed, `ticket ${closed} is a lan, which doesn't take companions`],
    ]) {
      const res = await buyOnline([companion({ with: host })], { token: member.token });
      expect(res.status).toBe(409);
      expect(res.body).toBe(message);
    }
    expect(await soldCount("companion")).toBe(1);
  });

  it("frees the ticket again when the checkout can't start", async () => {
    const host = await ownLanTicket();
    createSession.mockRejectedValueOnce(new Error("Stripe is down"));

    expect((await buyOnline([companion({ with: host })], { token: member.token })).status).toBe(502);
    expect((await ticket(host)).companionId).toBeNull();
  });

  it("frees the ticket again when the checkout expires unpaid", async () => {
    const host = await ownLanTicket();
    const res = await buyOnline([companion({ with: host })], { token: member.token });

    await sendStripeEvent("checkout.session.expired", {
      id: "cs_test_1", object: "checkout.session", metadata: { orderId: res.body.orderId },
    });

    expect((await ticket(host)).companionId).toBeNull();
    expect((await buyOnline([companion({ with: host })], { token: member.token })).status).toBe(200);
  });

  it("shows in the buyer's tickets which have a companion", async () => {
    const host = await ownLanTicket();
    const res = await buyOnline([companion({ with: host })], { token: member.token });
    await pay(res.body.orderId);
    const [guest] = await ticketIdsOf(res.body.orderId);

    const own = (await apiFetch("GET", "/tickets", { token: member.token })).body;

    expect(own.find((t: { id: string }) => t.id === host)).toMatchObject({
      companionOf: null, companionId: guest, allowsCompanion: true, isCompanion: false,
    });
    expect(own.find((t: { id: string }) => t.id === guest)).toMatchObject({
      companionOf: host, companionId: null, allowsCompanion: false, isCompanion: true,
    });
  });

  // The public list drops a type once its sale closes; the ticket still says what its type allows
  it("says whether a ticket takes a companion after its type's sale has closed", async () => {
    const host = await ownLanTicket();
    await apiFetch("PATCH", "/ticket-types/lan", { token: admin.token, body: { salesEnd: "2020-01-01T00:00:00Z" } });

    const own = (await apiFetch("GET", "/tickets", { token: member.token })).body;

    expect(own.find((t: { id: string }) => t.id === host)).toMatchObject({ typeName: "lan", allowsCompanion: true });
  });
});

describe("the price quote", () => {
  const quote = (attendees: Record<string, unknown>[]) =>
    apiFetch("POST", "/tickets/quote", { body: { attendees } });

  it("prices a companion with its host", async () => {
    const res = await quote([{ typeId: "lan" }, { typeId: "companion", with: 0 }]);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(4500);
  });

  it("refuses a companion without a host in the order before buying", async () => {
    expect((await quote([{ typeId: "companion" }])).status).toBe(400);
    expect((await quote([{ typeId: "general" }, { typeId: "companion", with: 0 }])).body).toBe("general doesn't take companions");
  });

  // Whose ticket it is can only be checked when buying, signed in
  it("leaves a ticket bought before to the purchase", async () => {
    expect((await quote([{ typeId: "companion", with: "some-ticket" }])).status).toBe(200);
  });
});

describe("selling a companion at the door", () => {
  it("goes with someone in the same sale", async () => {
    const res = await doorSale([{ typeId: "lan" }, { typeId: "companion", with: 0 }]);

    expect(res.status).toBe(200);
    const [host, guest] = res.body.map((t: { id: string }) => t.id);
    expect(await ticket(guest)).toMatchObject({ companionOf: host, status: "active" });
    expect((await ticket(host)).companionId).toBe(guest);
    expect((await auditEntries("ticket.doorSale")).find((e) => e.targetId === guest).details.companionOf).toBe(host);
  });

  it("goes with anyone's active ticket, but only one", async () => {
    const host = await ownLanTicket();

    expect((await doorSale([{ typeId: "companion", with: host }])).status).toBe(200);
    expect((await doorSale([{ typeId: "companion", with: host }])).status).toBe(409);
  });

  it("needs a host", async () => {
    expect((await doorSale([{ typeId: "companion" }])).status).toBe(400);
    expect(await soldCount("companion")).toBe(0);
  });
});

describe("finding a host at the door by email", () => {
  it("shows which tickets can take a companion and which already have one", async () => {
    const [host, guest] = (await doorSale([
      { typeId: "lan", holderEmail: "family@example.com" },
      { typeId: "companion", with: 0, holderEmail: "family@example.com" },
    ])).body.map((t: { id: string }) => t.id);
    const [{ id: free }] = (await doorSale([{ typeId: "lan", holderEmail: "family@example.com" }])).body;

    const res = await apiFetch("GET", "/tickets/by-email?email=family@example.com", { token: staff.token });

    const byId = new Map(res.body.map((t: { id: string }) => [t.id, t]));
    expect(byId.get(host)).toMatchObject({ companionOf: null, companionId: guest, allowsCompanion: true, isCompanion: false });
    expect(byId.get(guest)).toMatchObject({ companionOf: host, companionId: null, allowsCompanion: false, isCompanion: true });
    expect(byId.get(free)).toMatchObject({ companionId: null, allowsCompanion: true });
  });
});

describe("assigning a companion", () => {
  const assign = (body: Record<string, unknown>) =>
    apiFetch("POST", `/users/${member.uid}/tickets`, { token: admin.token, body });

  it("links it to the ticket it goes with", async () => {
    const host = await ownLanTicket();

    const res = await assign({ typeId: "companion", with: host });

    expect(res.status).toBe(200);
    expect(await ticket(res.body.id)).toMatchObject({ companionOf: host });
    expect((await ticket(host)).companionId).toBe(res.body.id);
    expect((await auditEntries("ticket.assign"))[1].details.companionOf).toBe(host);
  });

  it("refuses a companion without a host, and a host for another type", async () => {
    const host = await ownLanTicket();

    expect((await assign({ typeId: "companion" })).status).toBe(400);
    expect((await assign({ typeId: "general", with: host })).status).toBe(400);
    expect(await soldCount("companion")).toBe(0);
  });
});

describe("cancelling", () => {
  it("cancels a ticket's companion with it, logged as the canceller's", async () => {
    const [host, guest] = (await doorSale([{ typeId: "lan" }, { typeId: "companion", with: 0 }])).body.map((t: { id: string }) => t.id);

    await cancel(host);

    expect(await ticketStatus(guest)).toBe("cancelled");
    expect(await soldCount("companion")).toBe(0);
    expect(await auditEntries("ticket.cancelWithHost")).toEqual([
      expect.objectContaining({ targetId: guest, actorUid: staff.uid, details: { hostId: host, previousStatus: "active" } }),
    ]);
  });

  it("lets a ticket take another companion once its own is cancelled", async () => {
    const [host, guest] = (await doorSale([{ typeId: "lan" }, { typeId: "companion", with: 0 }])).body.map((t: { id: string }) => t.id);

    await cancel(guest);

    expect(await ticketStatus(host)).toBe("active");
    expect((await ticket(host)).companionId).toBeNull();
    expect((await doorSale([{ typeId: "companion", with: host }])).status).toBe(200);
    expect(await auditEntries("ticket.cancelWithHost")).toEqual([]);
  });

  it("cancels a companion bought apart when its ticket is refunded", async () => {
    const hostOrder = await buyOnline([player()], { token: member.token });
    await pay(hostOrder.body.orderId, "pi_host");
    const [host] = await ticketIdsOf(hostOrder.body.orderId);
    const guestOrder = await buyOnline([companion({ with: host })], { token: member.token });
    await pay(guestOrder.body.orderId, "pi_guest");
    const [guest] = await ticketIdsOf(guestOrder.body.orderId);

    await sendStripeEvent("charge.refunded", {
      id: "ch_1", object: "charge", payment_intent: "pi_host", amount: 3500, amount_refunded: 3500,
    });

    expect(await ticketStatus(guest)).toBe("cancelled");
    expect((await auditEntries("ticket.cancelWithHost"))[0]).toMatchObject({ targetId: guest, actorRole: "stripe" });
  });

  it("cancels both once when they go together", async () => {
    const res = await buyOnline([player(), companion({ with: 0 })]);

    await sendStripeEvent("checkout.session.expired", {
      id: "cs_test_1", object: "checkout.session", metadata: { orderId: res.body.orderId },
    });

    expect(await soldCount("lan")).toBe(0);
    expect(await soldCount("companion")).toBe(0);
    expect(await auditEntries("ticket.expired")).toHaveLength(2);
    expect(await auditEntries("ticket.cancelWithHost")).toEqual([]);
  });

  it("cancels the companion when its ticket's account is suspended", async () => {
    const host = await ownLanTicket();
    const [{ id: guest }] = (await doorSale([{ typeId: "companion", with: host, holderEmail: "parent@example.com" }])).body;

    await apiFetch("POST", `/users/${member.uid}/suspend`, { token: staff.token });

    expect(await ticketStatus(guest)).toBe("cancelled");
    expect((await auditEntries("ticket.cancelWithHost"))[0]).toMatchObject({ targetId: guest, actorUid: staff.uid });
  });
});

const lastLineItems = () => createSession.mock.calls.at(-1)![0].line_items;
