import { getFirestore } from "firebase-admin/firestore";
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  apiFetch, auditEntries, createUser, resetEmulators, seedTicketType, startApi, stopApi, type TestUser,
} from "./helpers";

// Only the product listing is faked; everything else about the Stripe class stays real
const listProducts = vi.hoisted(() => vi.fn());
const retrieveProduct = vi.hoisted(() => vi.fn());
const listPrices = vi.hoisted(() => vi.fn());

vi.mock("stripe", async (importOriginal) => {
  const Real = ((await importOriginal()) as { default: new (key: string) => object }).default;
  class FakeCatalogueStripe extends Real {
    products = { list: listProducts, retrieve: retrieveProduct };
    prices = { list: listPrices };
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

/** Sets what Stripe's catalogue returns, filling in what a real product always has. */
const catalogue = (products: FakeProduct[]) =>
  listProducts.mockReturnValue({
    autoPagingToArray: async () =>
      products.map((p) => ({ active: true, metadata: {}, default_price: null, ...p })),
  });

/** Sets the active prices Stripe lists, besides each product's default one. */
const prices = (list: Record<string, unknown>[]) =>
  listPrices.mockReturnValue({
    autoPagingToArray: async () => list.map((p) => ({ active: true, metadata: {}, ...p })),
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
  listPrices.mockReset();
  prices([]);
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
      stripeProductId: "prod_pack", stripePriceId: "price_pack", priceChanges: [],
      category: "general", packSize: 1, entries: "once", extrasFrom: "general",
      description: null, features: [], disclaimer: null,
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

describe("shop card texts", () => {
  it("fill the description from Stripe only while it's empty, and never the rest", async () => {
    catalogue([{ id: "prod_pack", name: "Pack", description: "From Stripe", default_price: eur("price_pack", 1300) }]);
    await sync();
    expect(await stored("pack")).toMatchObject({ description: "From Stripe", features: [], disclaimer: null });

    await apiFetch("PATCH", "/ticket-types/pack", {
      token: admin.token, body: { description: "Edited", features: ["A"], disclaimer: "Small print" },
    });
    catalogue([{ id: "prod_pack", name: "Pack", description: "Changed in Stripe", default_price: eur("price_pack", 1300) }]);
    await sync();

    expect(await stored("pack")).toMatchObject({ description: "Edited", features: ["A"], disclaimer: "Small print" });
  });
});

describe("pack sizes", () => {
  it("are the admin's: a new type is a single ticket, and metadata.packSize is ignored", async () => {
    catalogue([{ id: "prod_pack", name: "Pack", metadata: { packSize: "10" }, default_price: eur("price_pack", 3000) }]);

    await sync();

    expect((await stored("pack"))!.packSize).toBe(1);
  });

});

describe("prices that change on a date", () => {
  const DAY = 24 * 3600_000;
  const product = { id: "prod_lan", name: "Entrada LAN", default_price: eur("price_early", 2500) };
  const later = (id: string, amount: number, from: string, extra: Record<string, unknown> = {}) =>
    ({ ...eur(id, amount), product: "prod_lan", metadata: { from }, ...extra });
  const listedType = async () => (await apiFetch("GET", "/ticket-types")).body[0];

  beforeEach(() => catalogue([product]));

  it("uses the default price while no price has a date", async () => {
    prices([{ ...eur("price_plain", 100), product: "prod_lan" }]);

    await sync();

    expect(await listedType()).toMatchObject({ price: 2500, nextPrice: null });
  });

  it("before any date passes, uses the earliest dated price, not the default, and says what's next", async () => {
    const soon = new Date(Date.now() + DAY).toISOString();
    prices([later("price_late", 3500, "2099-01-15"), later("price_regular", 3000, soon)]);

    await sync();

    expect(await stored("entrada-lan")).toMatchObject({
      price: 2500, stripePriceId: "price_early",
      priceChanges: [
        { from: soon, price: 3000, stripePriceId: "price_regular" },
        { from: "2099-01-14T23:00:00.000Z", price: 3500, stripePriceId: "price_late" },
      ],
    });
    expect(await listedType()).toMatchObject({
      price: 3000, nextPrice: { price: 3500, from: "2099-01-14T23:00:00.000Z" },
    });
  });

  it("counts a date on the default price like any other", async () => {
    const at = (hours: number) => new Date(Date.now() + hours * 3600_000).toISOString();
    // A 7 € first phase and the default 9 € from an hour later; Stripe lists the default too
    const setUp = (first: string, second: string) => {
      const regular = { ...eur("price_9", 900), active: true, product: "prod_lan", metadata: { from: second } };
      catalogue([{ ...product, default_price: regular }]);
      prices([later("price_7", 700, first), regular]);
    };

    setUp(at(1), at(2));
    await sync();
    expect(await listedType()).toMatchObject({ price: 700, nextPrice: { price: 900 } });

    setUp(at(-2), at(-1));
    await sync();
    expect(await listedType()).toMatchObject({ price: 900, nextPrice: null });
    expect((await stored("entrada-lan"))!.priceChanges.map((c: { price: number }) => c.price)).toEqual([700, 900]);
  });

  it("switches by itself once the date passes, with no sync needed", async () => {
    prices([
      later("price_regular", 3000, new Date(Date.now() - DAY).toISOString()),
      later("price_late", 3500, "2099-07-01"),
    ]);
    await sync();

    expect(await listedType()).toMatchObject({
      price: 3000, nextPrice: { price: 3500, from: "2099-06-30T22:00:00.000Z" },
    });
  });

  it("charges the started price at the door and online", async () => {
    prices([later("price_regular", 3000, "2020-01-01")]);
    await sync();
    await apiFetch("PATCH", "/ticket-types/entrada-lan", {
      token: admin.token, body: { days: ["2026-11-20"], capacity: 10 },
    });

    await apiFetch("POST", "/tickets/door", {
      token: staff.token,
      body: { paymentMethod: "cash", items: [{ typeId: "entrada-lan", holderName: "A", holderEmail: "a@example.com" }] },
    });

    expect((await auditEntries("ticket.doorSale"))[0].details.price).toBe(3000);
    expect(await listedType()).toMatchObject({ price: 3000, nextPrice: null });
  });

  it("reads a date as midnight at the event, in winter and in summer time", async () => {
    prices([later("price_winter", 3000, "2099-11-01"), later("price_summer", 3500, "2099-07-01T12:00:00+02:00")]);

    await sync();

    expect((await stored("entrada-lan"))!.priceChanges.map((c: { from: string }) => c.from)).toEqual([
      "2099-07-01T10:00:00.000Z", "2099-10-31T23:00:00.000Z",
    ]);
  });

  it("ignores other products' prices, inactive prices, and prices without a date", async () => {
    prices([
      later("price_other", 100, "2099-01-01", { product: "prod_other" }),
      later("price_off", 100, "2099-01-01", { active: false }),
      { ...eur("price_plain", 100), product: "prod_lan" },
    ]);

    const res = await sync();

    expect(res.body.results[0]).toMatchObject({ result: "created", reason: null });
    expect((await stored("entrada-lan"))!.priceChanges).toEqual([]);
  });

  it.each([
    ["a date it can't read", later("price_bad", 3000, "1 de novembre"),
      'price price_bad is left out: metadata.from must be a date like 2026-11-01, got "1 de novembre"'],
    ["a date that doesn't exist", later("price_bad", 3000, "2099-02-30"),
      'price price_bad is left out: metadata.from must be a date like 2026-11-01, got "2099-02-30"'],
    ["a price in dollars", later("price_bad", 3000, "2099-11-01", { currency: "usd" }),
      "price price_bad is left out: it must be a one-time price in EUR"],
  ])("leaves out %s and says so", async (_label, price, reason) => {
    prices([price]);

    const res = await sync();

    expect(res.body.results[0]).toMatchObject({ result: "created", reason });
    expect((await stored("entrada-lan"))!.priceChanges).toEqual([]);
  });

  it("skips the product when two prices start at the same moment", async () => {
    prices([later("price_a", 3000, "2099-11-01"), later("price_b", 3100, "2099-10-31T23:00:00Z")]);

    const res = await sync();

    expect(res.body.results[0]).toMatchObject({
      result: "skipped",
      reason: "two prices start at 2099-10-31T23:00:00.000Z; give them different metadata.from dates",
    });
  });

  it("records a change to the dates in the log, and nothing when they're the same", async () => {
    await sync();
    prices([later("price_regular", 3000, "2099-11-01")]);

    const res = await sync();
    await sync();

    expect(res.body.results[0]).toMatchObject({
      result: "updated",
      changes: {
        priceChanges: {
          from: [], to: [{ from: "2099-10-31T23:00:00.000Z", price: 3000, stripePriceId: "price_regular" }],
        },
      },
    });
    expect(await auditEntries("ticketType.stripeSync")).toHaveLength(2);
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
