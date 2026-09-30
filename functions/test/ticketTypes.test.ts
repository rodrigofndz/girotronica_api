import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  apiFetch, createUser, resetEmulators, seedTicketType, startApi, stopApi, type TestUser,
} from "./helpers";

let admin: TestUser;
let staff: TestUser;

const valid = {
  id: "general", name: "General", price: 900, capacity: 2,
  isLanParty: false, days: ["2026-11-20"],
};

beforeAll(startApi);
afterAll(stopApi);

beforeEach(async () => {
  await resetEmulators();
  admin = await createUser("admin@example.com", "admin");
  staff = await createUser("staff@example.com", "staff");
});

describe("the public catalog", () => {
  it("is readable without signing in", async () => {
    await seedTicketType("general", { capacity: 5, sold: 2 });

    const res = await apiFetch("GET", "/ticket-types");

    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({ id: "general", sold: 2, remaining: 3 });
  });

  it("reports unlimited types as having no remaining count", async () => {
    await seedTicketType("open", { capacity: null });

    const res = await apiFetch("GET", "/ticket-types");

    expect(res.body[0].remaining).toBeNull();
  });

  it("never reports a negative remaining count", async () => {
    await seedTicketType("oops", { capacity: 1, sold: 3 });

    const res = await apiFetch("GET", "/ticket-types");

    expect(res.body[0].remaining).toBe(0);
  });
});

describe("what the web may change", () => {
  beforeEach(async () => {
    await seedTicketType("general", { capacity: 5, sold: 2 });
  });

  // Types come from the Stripe sync, which is the only place a price is set
  it("can't create a type", async () => {
    const res = await apiFetch("POST", "/ticket-types", { token: admin.token, body: valid });

    expect(res.status).toBe(404);
  });

  it.each([
    ["the price, which only changes in Stripe", { price: 1500 }],
    ["the sold counter", { sold: 99 }],
    ["the Stripe link", { stripeProductId: "prod_other" }],
    ["a day that is not an ISO date", { days: ["20-11-2026"] }],
    ["no days at all", { days: [] }],
  ])("refuses %s", async (_label, body) => {
    const res = await apiFetch("PATCH", "/ticket-types/general", { token: admin.token, body });

    expect(res.status).toBe(400);
  });

  it("is closed to staff", async () => {
    const res = await apiFetch("PATCH", "/ticket-types/general", { token: staff.token, body: { name: "X" } });

    expect(res.status).toBe(403);
  });
});

describe("updating a type", () => {
  beforeEach(async () => {
    await seedTicketType("general", { capacity: 5, sold: 2 });
  });

  it("changes the name shown on the web without touching the counter", async () => {
    const res = await apiFetch("PATCH", "/ticket-types/general", {
      token: admin.token,
      body: { name: "Entrada general" },
    });

    expect(res.body).toMatchObject({ name: "Entrada general", price: 900, sold: 2 });
  });

  it("refuses a capacity below what is already sold", async () => {
    const res = await apiFetch("PATCH", "/ticket-types/general", {
      token: admin.token,
      body: { capacity: 1 },
    });

    expect(res.status).toBe(409);
  });

  it("allows capacity equal to sold, which stops further sales", async () => {
    const res = await apiFetch("PATCH", "/ticket-types/general", {
      token: admin.token,
      body: { capacity: 2 },
    });
    const sale = await apiFetch("POST", "/tickets/door", {
      token: staff.token,
      body: {
        paymentMethod: "cash",
        items: [{ typeId: "general", holderName: "A", holderEmail: "a@example.com" }],
      },
    });

    expect(res.body.remaining).toBe(0);
    expect(sale.status).toBe(409);
  });

  it("reports an unknown type", async () => {
    const res = await apiFetch("PATCH", "/ticket-types/ghost", { token: admin.token, body: { name: "X" } });

    expect(res.status).toBe(404);
  });
});

describe("deleting a type", () => {
  it("refuses once tickets exist for it", async () => {
    await seedTicketType("general", { capacity: 5, sold: 1 });

    const res = await apiFetch("DELETE", "/ticket-types/general", { token: admin.token });

    expect(res.status).toBe(409);
  });

  it("removes an unused type", async () => {
    await seedTicketType("unused");

    const res = await apiFetch("DELETE", "/ticket-types/unused", { token: admin.token });

    expect(res.status).toBe(200);
    expect((await apiFetch("GET", "/ticket-types")).body).toEqual([]);
  });

  it("reports an unknown type", async () => {
    expect((await apiFetch("DELETE", "/ticket-types/ghost", { token: admin.token })).status).toBe(404);
  });
});
