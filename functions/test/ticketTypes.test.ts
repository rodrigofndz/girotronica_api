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

describe("creating a type", () => {
  it("starts the sold counter at zero", async () => {
    const res = await apiFetch("POST", "/ticket-types", { token: admin.token, body: valid });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: "general", sold: 0, remaining: 2 });
  });

  it("refuses a duplicate id", async () => {
    await apiFetch("POST", "/ticket-types", { token: admin.token, body: valid });

    const res = await apiFetch("POST", "/ticket-types", { token: admin.token, body: valid });

    expect(res.status).toBe(409);
  });

  it("refuses to let the sold counter be set by hand", async () => {
    const res = await apiFetch("POST", "/ticket-types", {
      token: admin.token,
      body: { ...valid, sold: 99 },
    });

    expect(res.status).toBe(400);
  });

  it.each([
    ["an id with spaces", { id: "has spaces" }],
    ["a price that is not whole cents", { price: 9.5 }],
    ["a negative price", { price: -1 }],
    ["a day that is not an ISO date", { days: ["20-11-2026"] }],
    ["no days at all", { days: [] }],
  ])("rejects %s", async (_label, override) => {
    const res = await apiFetch("POST", "/ticket-types", {
      token: admin.token,
      body: { ...valid, ...override },
    });

    expect(res.status).toBe(400);
  });

  it("is closed to staff", async () => {
    const res = await apiFetch("POST", "/ticket-types", { token: staff.token, body: valid });

    expect(res.status).toBe(403);
  });
});

describe("updating a type", () => {
  beforeEach(async () => {
    await seedTicketType("general", { capacity: 5, sold: 2 });
  });

  it("changes the price without touching the counter", async () => {
    const res = await apiFetch("PATCH", "/ticket-types/general", {
      token: admin.token,
      body: { price: 1500 },
    });

    expect(res.body).toMatchObject({ price: 1500, sold: 2 });
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
    const res = await apiFetch("PATCH", "/ticket-types/ghost", { token: admin.token, body: { price: 1 } });

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
