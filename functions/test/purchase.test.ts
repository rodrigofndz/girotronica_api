import { getFirestore } from "firebase-admin/firestore";
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  apiFetch, createUser, resetEmulators, seedTicketType, soldCount, startApi, stopApi,
  type TestUser,
} from "./helpers";

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

const buy = (items: unknown[], token = buyer.token) =>
  apiFetch("POST", "/tickets", { token, body: { items } });

const item = (overrides = {}) => ({
  typeId: "general", holderName: "Friend", holderEmail: "friend@example.com", ...overrides,
});

const ticketsFor = async (uid: string) =>
  (await getFirestore().collection("tickets").where("uid", "==", uid).get()).docs;

beforeAll(startApi);
afterAll(stopApi);

beforeEach(async () => {
  await resetEmulators();
  createSession.mockReset();
  createSession.mockResolvedValue({ id: "cs_test_1", url: "https://checkout.stripe.test/cs_test_1" });
  buyer = await createUser("buyer@example.com");
  await seedTicketType("general", { capacity: 10, price: 900 });
});

describe("buying online", () => {
  it("returns the checkout url and holds the tickets as pending", async () => {
    const res = await buy([item(), item({ holderName: "Me", holderEmail: "buyer@example.com" })]);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ checkoutUrl: "https://checkout.stripe.test/cs_test_1" });

    const tickets = await ticketsFor(buyer.uid);
    expect(tickets).toHaveLength(2);
    expect(tickets.every((t) => t.data().status === "pending")).toBe(true);
    expect(await soldCount("general")).toBe(2);
  });

  it("charges the price from the server, in cents, never the client's", async () => {
    await buy([item({ price: 1 })]);

    const [session] = createSession.mock.calls[0];
    expect(session.line_items[0].price_data).toMatchObject({ currency: "eur", unit_amount: 900 });
  });

  it("links the checkout to exactly the tickets it created", async () => {
    await buy([item(), item()]);

    const [session] = createSession.mock.calls[0];
    const created = (await ticketsFor(buyer.uid)).map((t) => t.id).sort();
    expect(JSON.parse(session.metadata.ticketIds).sort()).toEqual(created);
  });

  it("refuses when the type is sold out, without calling Stripe", async () => {
    await seedTicketType("general", { capacity: 1, sold: 1 });

    const res = await buy([item()]);

    expect(res.status).toBe(409);
    expect(createSession).not.toHaveBeenCalled();
  });

  it("rejects an unknown type or a bad holder email", async () => {
    expect((await buy([item({ typeId: "nope" })])).status).toBe(400);
    expect((await buy([item({ holderEmail: "not-an-email" })])).status).toBe(400);
  });

  it("requires signing in", async () => {
    const res = await apiFetch("POST", "/tickets", { body: { items: [item()] } });

    expect(res.status).toBe(401);
  });
});

describe("when Stripe fails", () => {
  beforeEach(() => {
    createSession.mockReset();
    createSession.mockRejectedValue(new Error("stripe is down"));
  });

  it("reports the failure", async () => {
    expect((await buy([item()])).status).toBe(502);
  });

  it("gives the slots back and leaves no pending tickets", async () => {
    await buy([item(), item()]);

    expect(await soldCount("general")).toBe(0);
    expect(await ticketsFor(buyer.uid)).toHaveLength(0);
  });
});
