import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  apiFetch, auditEntries, createUser, resetEmulators, seedTicketType, startApi, stopApi, type TestUser,
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

describe("what the public catalog leaves out", () => {
  const ids = async (path: string, token?: string) =>
    (await apiFetch("GET", path, { token })).body.map((t: { id: string }) => t.id).sort();

  beforeEach(async () => {
    await seedTicketType("on-sale");
    await seedTicketType("sold-out", { capacity: 2, sold: 2 });
    await seedTicketType("not-set-up", { days: [], capacity: 0 });
  });

  it("hides types not set up yet, but keeps sold-out ones", async () => {
    expect(await ids("/ticket-types")).toEqual(["on-sale", "sold-out"]);
  });

  it("shows staff and admins every type", async () => {
    const all = ["not-set-up", "on-sale", "sold-out"];

    expect(await ids("/ticket-types/all", staff.token)).toEqual(all);
    expect(await ids("/ticket-types/all", admin.token)).toEqual(all);
  });

  it("keeps the full list from users and anonymous callers", async () => {
    const user = await createUser("user@example.com");

    expect((await apiFetch("GET", "/ticket-types/all", { token: user.token })).status).toBe(403);
    expect((await apiFetch("GET", "/ticket-types/all")).status).toBe(401);
  });
});

describe("what the web may change", () => {
  beforeEach(async () => {
    await seedTicketType("general", { capacity: 5, sold: 2 });
  });

  // A price is only ever set in Stripe; a type made here is free
  it("can't make a type with a price", async () => {
    const res = await apiFetch("POST", "/ticket-types", { token: admin.token, body: valid });

    expect(res.status).toBe(400);
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
  // Cancelling or refunding its tickets needs the type
  it("refuses a type with tickets sold, saying how to stop sales instead", async () => {
    await seedTicketType("general", { capacity: 5, sold: 2 });

    const res = await apiFetch("DELETE", "/ticket-types/general", { token: admin.token });

    expect(res.status).toBe(409);
    expect(res.body).toBe("general has 2 sold; set its capacity to 2 to stop sales instead");
    expect((await apiFetch("GET", "/ticket-types")).body).toHaveLength(1);
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

describe("free ticket types made in the admin", () => {
  const create = (body: Record<string, unknown>, token = admin.token) =>
    apiFetch("POST", "/ticket-types", { token, body });
  const kids = { id: "entrada-infants", name: "Infants", days: ["2026-11-20", "2026-11-21", "2026-11-22"], capacity: null };

  it("makes one without Stripe, free, with the settings sent, and logs it", async () => {
    const res = await create({ ...kids, disclaimer: "Sempre acompanyat d'un adult." });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: "entrada-infants", name: "Infants", price: 0, nextPrice: null, capacity: null, remaining: null,
      days: kids.days, onSale: true, stripeProductId: null, category: "general", packSize: 1, entries: "once",
      disclaimer: "Sempre acompanyat d'un adult.", poolId: null,
    });
    expect((await apiFetch("GET", "/ticket-types")).body.map((t: { id: string }) => t.id)).toEqual(["entrada-infants"]);
    expect((await auditEntries("ticketType.create"))[0]).toMatchObject({ actorUid: admin.uid, targetId: "entrada-infants" });
  });

  it("isn't for sale until it has days and a capacity", async () => {
    const res = await create({ id: "later", name: "Later" });

    expect(res.body).toMatchObject({ days: [], capacity: 0, onSale: false });
  });

  it("is sold at the door for nothing", async () => {
    await create(kids);

    const res = await apiFetch("POST", "/tickets/door", {
      token: staff.token,
      body: { paymentMethod: "cash", items: [{ typeId: "entrada-infants", holderName: "Kid", holderEmail: "kid@example.com" }] },
    });

    expect(res.status).toBe(200);
    expect((await auditEntries("ticket.doorSale"))[0].details).toMatchObject({ typeId: "entrada-infants", price: 0 });
  });

  it("refuses a taken id, a bad id, an unknown pool, a window out of order, and anyone but an admin", async () => {
    await seedTicketType("general");

    expect((await create({ ...kids, id: "general" })).status).toBe(409);
    expect((await create({ ...kids, id: "Entrada Infants" })).status).toBe(400);
    expect((await create({ ...kids, poolId: "nope" })).status).toBe(400);
    expect((await create({ ...kids, salesStart: "2026-11-02T00:00:00Z", salesEnd: "2026-11-01T00:00:00Z" })).status).toBe(400);
    expect((await create(kids, staff.token)).status).toBe(403);
    expect((await apiFetch("GET", "/ticket-types/all", { token: admin.token })).body).toHaveLength(1);
  });

  it("can be deleted while nothing is sold, with no Stripe product to archive", async () => {
    await create(kids);

    expect((await apiFetch("DELETE", "/ticket-types/entrada-infants", { token: admin.token })).status).toBe(200);
  });
});
