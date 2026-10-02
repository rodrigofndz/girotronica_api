import { getFirestore } from "firebase-admin/firestore";
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  apiFetch, auditEntries, createUser, resetEmulators, seedTicketType, startApi, stopApi, type TestUser,
} from "./helpers";

// Only the product listing is faked; everything else about the Stripe class stays real
const listProducts = vi.hoisted(() => vi.fn());
const retrieveProduct = vi.hoisted(() => vi.fn());

vi.mock("stripe", async (importOriginal) => {
  const Real = ((await importOriginal()) as { default: new (key: string) => object }).default;
  class FakeCatalogueStripe extends Real {
    products = { list: listProducts, retrieve: retrieveProduct };
  }
  return { default: FakeCatalogueStripe };
});

type FakeProduct = {
  id: string;
  name: string;
  active?: boolean;
  metadata?: Record<string, string>;
  default_price?: Record<string, unknown> | null;
};

const eur = (id: string, amount: number) => ({ id, type: "one_time", currency: "eur", unit_amount: amount });

/** Sets what Stripe's catalogue returns, filling in what a real product always has. */
const catalogue = (products: FakeProduct[]) =>
  listProducts.mockReturnValue({
    autoPagingToArray: async () =>
      products.map((p) => ({ active: true, metadata: {}, default_price: null, ...p })),
  });

let admin: TestUser;
let staff: TestUser;

const sync = (token = admin.token) => apiFetch("POST", "/ticket-types/sync", { token });

const stored = async (id: string) => (await getFirestore().doc(`ticketTypes/${id}`).get()).data();

beforeAll(startApi);
afterAll(stopApi);

beforeEach(async () => {
  await resetEmulators();
  listProducts.mockReset();
  retrieveProduct.mockReset();
  admin = await createUser("admin@example.com", "admin");
  staff = await createUser("staff@example.com", "staff");
});

describe("a new Stripe product", () => {
  it("becomes a ticket type that isn't for sale until an admin completes it", async () => {
    catalogue([{ id: "prod_pack", name: "Pack de tres dies", default_price: eur("price_pack", 1300) }]);

    const res = await sync();

    expect(res.body.results).toEqual([expect.objectContaining({ result: "created", typeId: "pack-de-tres-dies" })]);
    expect(await stored("pack-de-tres-dies")).toEqual({
      name: "Pack de tres dies", price: 1300, capacity: 0, isLanParty: false, days: [], sold: 0,
      stripeProductId: "prod_pack", stripePriceId: "price_pack",
      category: "general", packSize: 1, entries: "once", extrasFrom: "general",
    });
    const [listed] = (await apiFetch("GET", "/ticket-types")).body;
    expect(listed).toMatchObject({ onSale: false, stripeProductId: "prod_pack" });
  });

  it("takes its id from the name without accents or symbols, or from metadata.typeId", async () => {
    catalogue([
      { id: "prod_tc", name: "Trònic-con (dissabte 21)", default_price: eur("price_tc", 700) },
      { id: "prod_lan", name: "LAN Party", metadata: { typeId: "lan-party-early" }, default_price: eur("price_lan", 3500) },
    ]);

    const res = await sync();

    expect(res.body.results.map((r: { typeId: string }) => r.typeId)).toEqual(["tronic-con-dissabte-21", "lan-party-early"]);
  });

  it("is recorded in the activity log as the admin's sync", async () => {
    catalogue([{ id: "prod_pack", name: "Pack", default_price: eur("price_pack", 1300) }]);

    await sync();

    const [entry] = await auditEntries("ticketType.stripeSync");
    expect(entry).toMatchObject({
      targetId: "pack", actorUid: admin.uid,
      details: { stripeProductId: "prod_pack", created: true, changes: { price: { from: null, to: 1300 } } },
    });
  });

  it("sells at the synced price once an admin sets its days and capacity", async () => {
    catalogue([{ id: "prod_pack", name: "Pack", default_price: eur("price_pack", 1300) }]);
    await sync();
    const sell = () => apiFetch("POST", "/tickets/door", {
      token: staff.token,
      body: { paymentMethod: "cash", items: [{ typeId: "pack", holderName: "A", holderEmail: "a@example.com" }] },
    });

    expect((await sell()).status).toBe(409);

    await apiFetch("PATCH", "/ticket-types/pack", {
      token: admin.token, body: { days: ["2026-11-20"], capacity: 10 },
    });

    expect((await sell()).status).toBe(200);
    expect((await auditEntries("ticket.doorSale"))[0].details.price).toBe(1300);
  });
});

describe("a product synced before", () => {
  beforeEach(async () => {
    catalogue([{ id: "prod_pack", name: "Pack", default_price: eur("price_pack", 1300) }]);
    await sync();
    await apiFetch("PATCH", "/ticket-types/pack", {
      token: admin.token,
      body: { name: "Pack 3 dies (early bird)", days: ["2026-11-20"], capacity: 50, isLanParty: false },
    });
  });

  it("changes nothing when Stripe hasn't changed", async () => {
    const res = await sync();

    expect(res.body.results[0]).toMatchObject({ result: "unchanged", typeId: "pack" });
    expect(await auditEntries("ticketType.stripeSync")).toHaveLength(1);
  });

  it("takes Stripe's new price but keeps the web's name, days and capacity", async () => {
    catalogue([{ id: "prod_pack", name: "Pack", default_price: eur("price_pack_2", 1500) }]);

    const res = await sync();

    expect(res.body.results[0]).toMatchObject({
      result: "updated",
      changes: { price: { from: 1300, to: 1500 }, stripePriceId: { from: "price_pack", to: "price_pack_2" } },
    });
    expect(await stored("pack")).toMatchObject({
      price: 1500, stripePriceId: "price_pack_2", name: "Pack 3 dies (early bird)", days: ["2026-11-20"], capacity: 50,
    });
  });

  it("stops selling it once it is archived in Stripe, keeping what was sold", async () => {
    await getFirestore().doc("ticketTypes/pack").update({ sold: 4 });
    catalogue([{ id: "prod_pack", name: "Pack", active: false, default_price: eur("price_pack", 1300) }]);

    const res = await sync();

    expect(res.body.results[0].changes).toEqual({ capacity: { from: 50, to: 4 } });
    expect(await stored("pack")).toMatchObject({ capacity: 4, sold: 4 });
  });
});

describe("products it can't use", () => {
  it("skips them with the reason, and changes nothing for them", async () => {
    await seedTicketType("taken");
    catalogue([
      { id: "prod_noprice", name: "No price" },
      { id: "prod_usd", name: "Dollars", default_price: { ...eur("price_usd", 100), currency: "usd" } },
      { id: "prod_sub", name: "Monthly", default_price: { ...eur("price_sub", 100), type: "recurring" } },
      { id: "prod_taken", name: "Taken", default_price: eur("price_taken", 100) },
      { id: "prod_old", name: "Old", active: false, default_price: eur("price_old", 100) },
    ]);

    const res = await sync();

    expect(res.body.results.map((r: { result: string; reason: string }) => [r.result, r.reason])).toEqual([
      ["skipped", "the product has no default price"],
      ["skipped", "the default price must be a one-time price in EUR"],
      ["skipped", "the default price must be a one-time price in EUR"],
      ["skipped", 'the id "taken" is taken by another ticket type; set metadata.typeId in Stripe'],
      ["skipped", "archived in Stripe and never synced"],
    ]);
    expect((await getFirestore().collection("ticketTypes").get()).docs.map((d) => d.id)).toEqual(["taken"]);
  });
});

describe("the sync itself", () => {
  it("is for admins only", async () => {
    catalogue([]);

    expect((await sync(staff.token)).status).toBe(403);
    expect(listProducts).not.toHaveBeenCalled();
  });

  it("reports Stripe being unreachable and writes nothing", async () => {
    listProducts.mockReturnValue({ autoPagingToArray: async () => { throw new Error("stripe is down"); } });

    const res = await sync();

    expect(res.status).toBe(502);
    expect((await getFirestore().collection("ticketTypes").get()).empty).toBe(true);
  });
});

describe("deleting a synced type", () => {
  beforeEach(async () => {
    catalogue([{ id: "prod_pack", name: "Pack", default_price: eur("price_pack", 1300) }]);
    await sync();
  });

  const remove = () => apiFetch("DELETE", "/ticket-types/pack", { token: admin.token });

  it("is refused while its Stripe product is active, since the next sync would bring it back", async () => {
    retrieveProduct.mockResolvedValue({ id: "prod_pack", active: true });

    const res = await remove();

    expect(res.status).toBe(409);
    // The web tells this 409 apart from "tickets sold" by this wording; changing it breaks the web
    expect(res.body).toContain("Stripe product is still active");
    expect(res.body).toContain("archive it in Stripe first");
    expect(await stored("pack")).toBeDefined();
    expect(retrieveProduct).toHaveBeenCalledWith("prod_pack");
  });

  it("is allowed once the product is archived in Stripe", async () => {
    retrieveProduct.mockResolvedValue({ id: "prod_pack", active: false });

    expect((await remove()).status).toBe(200);
    expect(await stored("pack")).toBeUndefined();
    expect(await auditEntries("ticketType.delete")).toHaveLength(1);
  });

  it("is allowed when the product was deleted outright in Stripe", async () => {
    retrieveProduct.mockRejectedValue(Object.assign(new Error("No such product"), { code: "resource_missing" }));

    expect((await remove()).status).toBe(200);
  });

  it("is refused, deleting nothing, when Stripe can't be reached", async () => {
    retrieveProduct.mockRejectedValue(new Error("stripe is down"));

    expect((await remove()).status).toBe(502);
    expect(await stored("pack")).toBeDefined();
  });

  // Sales don't block deleting for now (testing), but the log keeps how many there were
  it("deletes an archived type even with sales, recording how many", async () => {
    retrieveProduct.mockResolvedValue({ id: "prod_pack", active: false });
    await getFirestore().doc("ticketTypes/pack").update({ sold: 3 });

    expect((await remove()).status).toBe(200);
    expect((await auditEntries("ticketType.delete"))[0].details).toEqual({ sold: 3 });
  });

  it("doesn't ask Stripe about a type made by hand", async () => {
    await seedTicketType("manual");

    expect((await apiFetch("DELETE", "/ticket-types/manual", { token: admin.token })).status).toBe(200);
    expect(retrieveProduct).not.toHaveBeenCalled();
  });
});
