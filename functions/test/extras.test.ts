import { getFirestore } from "firebase-admin/firestore";
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { apiFetch, auditEntries, createUser, resetEmulators, startApi, stopApi, type TestUser } from "./helpers";

// Only the product listing is faked; everything else about the Stripe class stays real
const listProducts = vi.hoisted(() => vi.fn());

vi.mock("stripe", async (importOriginal) => {
  const Real = ((await importOriginal()) as { default: new (key: string) => object }).default;
  class FakeCatalogueStripe extends Real {
    products = { list: listProducts };
  }
  return { default: FakeCatalogueStripe };
});

type FakeProduct = {
  id: string;
  name: string;
  description?: string | null;
  active?: boolean;
  metadata?: Record<string, string>;
  default_price?: Record<string, unknown> | null;
};

const eur = (id: string, amount: number) => ({ id, type: "one_time", currency: "eur", unit_amount: amount });
const extra = (p: FakeProduct): FakeProduct => ({ ...p, metadata: { kind: "extra", ...p.metadata } });

const catalogue = (products: FakeProduct[]) =>
  listProducts.mockReturnValue({
    autoPagingToArray: async () =>
      products.map((p) => ({ active: true, metadata: {}, description: null, default_price: null, ...p })),
  });

let admin: TestUser;
let staff: TestUser;

const sync = () => apiFetch("POST", "/ticket-types/sync", { token: admin.token });
const listed = async () => (await apiFetch("GET", "/extras")).body;
const edit = (id: string, body: Record<string, unknown>, token = admin.token) =>
  apiFetch("PATCH", `/extras/${id}`, { token, body });

beforeAll(startApi);
afterAll(stopApi);

beforeEach(async () => {
  await resetEmulators();
  listProducts.mockReset();
  admin = await createUser("admin@example.com", "admin");
  staff = await createUser("staff@example.com", "staff");
});

describe("syncing extras from Stripe", () => {
  it("brings products marked as extras into the extras list, not offered yet", async () => {
    catalogue([
      extra({ id: "prod_tee", name: "Samarreta", description: "100% cotó", default_price: eur("price_tee", 1500) }),
      { id: "prod_pack", name: "Pack", default_price: eur("price_pack", 1300) },
    ]);

    const res = await sync();

    expect(res.body.results.map((r: { kind: string; extraId: string; typeId: string }) => [r.kind, r.extraId, r.typeId]))
      .toEqual([["extra", "samarreta", null], ["ticketType", null, "pack"]]);
    expect(await listed()).toEqual([{
      id: "samarreta", name: "Samarreta", description: "100% cotó", price: 1500, options: [], consent: null,
      groups: [], capacity: null, sold: 0, remaining: null, stripeProductId: "prod_tee",
    }]);
    expect((await getFirestore().collection("ticketTypes").get()).docs.map((d) => d.id)).toEqual(["pack"]);
  });

  it("takes its id from metadata.extraId when set, and accepts free extras", async () => {
    catalogue([extra({ id: "prod_dorm", name: "Plaça dormitori", metadata: { extraId: "dormitori" }, default_price: eur("p", 0) })]);

    await sync();

    expect(await listed()).toEqual([expect.objectContaining({ id: "dormitori", price: 0 })]);
  });

  it("follows Stripe's price but keeps the admin's name, description and settings", async () => {
    catalogue([extra({ id: "prod_tee", name: "Samarreta", default_price: eur("price_tee", 1500) })]);
    await sync();
    await edit("samarreta", { name: "Samarreta Girotrònica", description: "Edició 2026", options: ["S", "M"], groups: ["general"] });
    catalogue([extra({ id: "prod_tee", name: "Samarreta", description: "Stripe's text", default_price: eur("price_tee_2", 1800) })]);

    const res = await sync();

    expect(res.body.results[0].changes).toEqual({
      price: { from: 1500, to: 1800 }, stripePriceId: { from: "price_tee", to: "price_tee_2" },
    });
    expect((await listed())[0]).toMatchObject({
      name: "Samarreta Girotrònica", description: "Edició 2026", price: 1800, options: ["S", "M"], groups: ["general"],
    });
  });

  it("stops offering it once archived in Stripe, keeping what was sold", async () => {
    catalogue([extra({ id: "prod_tee", name: "Samarreta", default_price: eur("price_tee", 1500) })]);
    await sync();
    await getFirestore().doc("extras/samarreta").update({ sold: 3 });
    catalogue([extra({ id: "prod_tee", name: "Samarreta", active: false, default_price: eur("price_tee", 1500) })]);

    await sync();

    expect((await listed())[0]).toMatchObject({ capacity: 3, remaining: 0 });
  });

  it("records the sync in the activity log", async () => {
    catalogue([extra({ id: "prod_tee", name: "Samarreta", default_price: eur("price_tee", 1500) })]);

    await sync();

    expect((await auditEntries("extra.stripeSync"))[0]).toMatchObject({
      targetType: "extra", targetId: "samarreta", actorUid: admin.uid, details: { created: true },
    });
  });
});

describe("editing an extra", () => {
  beforeEach(async () => {
    catalogue([extra({ id: "prod_tee", name: "Samarreta", default_price: eur("price_tee", 1500) })]);
    await sync();
  });

  it("sets sizes, consent, groups and stock, and logs only what changed", async () => {
    const res = await edit("samarreta", {
      options: ["XS", "S", "M", "L", "XL"], consent: "Accepto el sorteig", groups: ["lan"], capacity: 50,
    });
    await edit("samarreta", { capacity: 50 });

    expect(res.body).toMatchObject({ options: ["XS", "S", "M", "L", "XL"], groups: ["lan"], capacity: 50, remaining: 50 });
    const entries = await auditEntries("extra.update");
    expect(entries).toHaveLength(1);
    expect(entries[0].details.changes.capacity).toEqual({ from: null, to: 50 });
  });

  it.each([
    ["the price, which only changes in Stripe", { price: 100 }],
    ["an unknown group", { groups: ["pack"] }],
    ["repeated sizes", { options: ["M", "M"] }],
    ["an empty size", { options: [" "] }],
    ["the Stripe link", { stripeProductId: "prod_other" }],
  ])("refuses %s", async (_label, body) => {
    expect((await edit("samarreta", body)).status).toBe(400);
  });

  it("refuses a stock below what's sold", async () => {
    await getFirestore().doc("extras/samarreta").update({ sold: 5 });

    expect((await edit("samarreta", { capacity: 4 })).status).toBe(409);
  });

  it("is for admins only, and reports an unknown extra", async () => {
    expect((await edit("samarreta", { capacity: 1 }, staff.token)).status).toBe(403);
    expect((await edit("ghost", { capacity: 1 })).status).toBe(404);
  });
});
