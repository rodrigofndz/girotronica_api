import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  apiFetch, attendee, auditEntries, buyerDetails, createUser, orderDoc, resetEmulators, seedExtra,
  seedTicketType, sendStripeEvent, soldCount, startApi, stopApi, type TestUser,
} from "./helpers";

vi.mock("../src/features", () => ({ ONLINE_SALES: true, ONLINE_SALES_MODE: "public" }));

// Only checkout and the promotion codes are faked; the real Stripe class (and its webhook signing) stays
const createSession = vi.hoisted(() => vi.fn());
const stripeCodes = vi.hoisted(() => ({ list: [] as Record<string, unknown>[], fail: false }));

vi.mock("stripe", async (importOriginal) => {
  const Real = ((await importOriginal()) as { default: new (key: string) => object }).default;
  class FakeStripe extends Real {
    checkout = { sessions: { create: createSession } };
    promotionCodes = {
      // Like Stripe: the code filter ignores case, and the list is also a pager
      list: (params: { code?: string }) => {
        const data = stripeCodes.list.filter((p) =>
          !params.code || (p.code as string).toLowerCase() === params.code.toLowerCase());
        const page = stripeCodes.fail ? Promise.reject(new Error("Stripe is down")) : Promise.resolve({ data });
        page.catch(() => {});
        return Object.assign(page, { autoPagingToArray: async () => (await page).data });
      },
    };
  }
  return { default: FakeStripe };
});

/** A promotion code as Stripe returns it, with its coupon expanded. */
const promo = (
  code: string,
  coupon: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) => ({
  id: `promo_${code}`, object: "promotion_code", active: true, code, created: 1_790_000_000,
  customer: null, customer_account: null, expires_at: null, livemode: false, max_redemptions: null,
  metadata: {}, times_redeemed: 0,
  restrictions: { first_time_transaction: false, minimum_amount: null, minimum_amount_currency: null },
  ...overrides,
  promotion: {
    type: "coupon",
    coupon: {
      id: `coupon_${code}`, object: "coupon", amount_off: null, currency: null, percent_off: null,
      duration: "once", max_redemptions: null, redeem_by: null, times_redeemed: 0, valid: true, ...coupon,
    },
  },
});

const givenCodes = (...codes: ReturnType<typeof promo>[]) => { stripeCodes.list = codes; };

const quote = (attendees: Record<string, unknown>[], promotionCode?: string) =>
  apiFetch("POST", "/tickets/quote", { body: { attendees, promotionCode } });

const buy = (attendees: Record<string, unknown>[], promotionCode?: string) =>
  apiFetch("POST", "/tickets", { body: { buyer: buyerDetails, attendees, promotionCode } });

const lan = () => attendee({ typeId: "lan", phone: "600000001" });
const hourAgo = () => Math.floor(Date.now() / 1000) - 3600;

let admin: TestUser;

beforeAll(startApi);
afterAll(stopApi);

beforeEach(async () => {
  await resetEmulators();
  createSession.mockReset();
  createSession.mockResolvedValue({ id: "cs_test_1", url: "https://checkout.stripe.test/cs_test_1" });
  stripeCodes.list = [];
  stripeCodes.fail = false;
  admin = await createUser("admin@example.com", "admin");
  await seedTicketType("general", { price: 900, stripeProductId: "prod_general", stripePriceId: "price_general" });
  await seedTicketType("lan", {
    price: 3500, extrasFrom: "lan", stripeProductId: "prod_lan", stripePriceId: "price_lan",
  });
  await seedTicketType("kids", { price: 0 });
  await seedExtra("samarreta", { price: 1500 });
});

describe("pricing an order", () => {
  it("lists what it charges, and the total, with no code", async () => {
    const res = await quote([attendee(), attendee({ extras: [{ extraId: "samarreta" }] }), attendee({ typeId: "kids" })]);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      lines: [
        { kind: "ticketType", id: "general", name: "general", unitPrice: 900, quantity: 2, amount: 1800 },
        { kind: "ticketType", id: "kids", name: "kids", unitPrice: 0, quantity: 1, amount: 0 },
        { kind: "extra", id: "samarreta", name: "samarreta", unitPrice: 1500, quantity: 1, amount: 1500 },
      ],
      subtotal: 3300, discount: 0, total: 3300, promotionCode: null,
    });
  });

  it("takes a percentage off the whole order, whatever case the code is typed in", async () => {
    givenCodes(promo("AMICS20", { percent_off: 20 }));

    const res = await quote([attendee(), attendee({ extras: [{ extraId: "samarreta" }] })], "amics20");

    expect(res.body).toMatchObject({ subtotal: 3300, discount: 660, total: 2640 });
    expect(res.body.promotionCode).toEqual({
      code: "AMICS20", applied: true, problem: null,
      percentOff: 20, amountOff: null, minimumAmount: null, appliesTo: null,
    });
  });

  it("takes a fixed amount off, never more than the order", async () => {
    givenCodes(promo("CINC", { amount_off: 500, currency: "eur" }), promo("GRAN", { amount_off: 10_000, currency: "eur" }));

    expect((await quote([attendee()], "CINC")).body).toMatchObject({ discount: 500, total: 400 });
    expect((await quote([attendee()], "GRAN")).body).toMatchObject({ discount: 900, total: 0 });
  });

  it("only takes off the products a code is limited to, and says which", async () => {
    givenCodes(promo("LAN10", { percent_off: 10, applies_to: { products: ["prod_lan"] } }));

    const res = await quote([lan(), attendee()], "LAN10");

    expect(res.body).toMatchObject({ subtotal: 4400, discount: 350, total: 4050 });
    expect(res.body.promotionCode.appliesTo).toEqual(["lan"]);
  });

  it("says why a code can't be used, and charges the full price", async () => {
    const lanOnly = { percent_off: 10, applies_to: { products: ["prod_lan"] } };
    givenCodes(
      promo("OLD", { percent_off: 10 }, { expires_at: hourAgo() }),
      promo("GONE", { percent_off: 10 }, { max_redemptions: 5, times_redeemed: 5 }),
      promo("OFF", { percent_off: 10 }, { active: false }),
      promo("FIRST", { percent_off: 10 }, { restrictions: { first_time_transaction: true, minimum_amount: null, minimum_amount_currency: null } }),
      promo("DOLLARS", { amount_off: 500, currency: "usd" }),
      promo("LANONLY", lanOnly),
      promo("BIG", { percent_off: 10 }, { restrictions: { first_time_transaction: false, minimum_amount: 2000, minimum_amount_currency: "eur" } }),
    );
    const problem = async (code: string) => {
      const res = await quote([attendee()], code);
      expect(res.body).toMatchObject({ discount: 0, total: 900, promotionCode: { applied: false } });
      return res.body.promotionCode.problem;
    };

    expect(await problem("NOPE")).toEqual({ reason: "not_found", message: "NOPE doesn't exist" });
    expect((await problem("OLD")).reason).toBe("expired");
    expect((await problem("GONE")).reason).toBe("used_up");
    expect((await problem("OFF")).reason).toBe("inactive");
    expect((await problem("FIRST")).reason).toBe("restricted");
    expect((await problem("DOLLARS")).reason).toBe("restricted");
    expect((await problem("LANONLY")).reason).toBe("not_applicable");
    expect(await problem("BIG")).toEqual({ reason: "below_minimum", message: "BIG needs an order of at least 20,00 €" });
  });

  it("follows the coupon's own expiry and uses too", async () => {
    givenCodes(
      promo("LATE", { percent_off: 10, redeem_by: hourAgo(), valid: false }),
      promo("SPENT", { percent_off: 10, max_redemptions: 1, times_redeemed: 1, valid: false }),
    );

    expect((await quote([attendee()], "LATE")).body.promotionCode.problem.reason).toBe("expired");
    expect((await quote([attendee()], "SPENT")).body.promotionCode.problem.reason).toBe("used_up");
  });

  it("refuses unknown items or types not on sale, and reserves nothing", async () => {
    await seedTicketType("closed", { salesStart: "2099-01-01T00:00:00Z" });

    expect((await quote([attendee({ typeId: "nope" })])).status).toBe(400);
    expect((await quote([attendee({ extras: [{ extraId: "nope" }] })])).status).toBe(400);
    expect((await quote([attendee({ typeId: "closed" })])).status).toBe(409);
    await quote([attendee()]);
    expect(await soldCount("general")).toBe(0);
  });

  it("reports Stripe being unreachable rather than a bad code", async () => {
    stripeCodes.fail = true;

    expect((await quote([attendee()], "AMICS20")).status).toBe(502);
  });
});

describe("buying with a code", () => {
  it("records the discount on the order and has Stripe apply the same code", async () => {
    givenCodes(promo("AMICS20", { percent_off: 20 }));

    const res = await buy([attendee(), attendee({ name: "Biel Puig" })], "Amics20");

    expect(res.status).toBe(200);
    expect(createSession.mock.calls[0][0].discounts).toEqual([{ promotion_code: "promo_AMICS20" }]);
    expect(await orderDoc(res.body.orderId)).toMatchObject({
      subtotal: 1800, discount: 360, total: 1440, amountPaid: null,
      promotionCode: { id: "promo_AMICS20", code: "AMICS20" },
    });
    expect((await auditEntries("ticket.purchase"))[0].details).toMatchObject({ promotionCode: "AMICS20" });
    expect((await apiFetch("GET", `/orders/${res.body.orderId}`)).body).toMatchObject({
      subtotal: 1800, discount: 360, total: 1440, promotionCode: "AMICS20",
    });
  });

  it("refuses a code that can't be used, reserving nothing", async () => {
    givenCodes(promo("GONE", { percent_off: 10 }, { max_redemptions: 1, times_redeemed: 1 }));

    const gone = await buy([attendee()], "GONE");
    const unknown = await buy([attendee()], "NOPE");

    expect(gone.status).toBe(409);
    expect(gone.body).toBe("GONE has been used up");
    expect(unknown.status).toBe(409);
    expect(await soldCount("general")).toBe(0);
    expect(createSession).not.toHaveBeenCalled();
  });

  it("asks Stripe for no discount without a code", async () => {
    const res = await buy([attendee()]);

    expect(createSession.mock.calls[0][0].discounts).toBeUndefined();
    expect(await orderDoc(res.body.orderId)).toMatchObject({ subtotal: 900, discount: 0, total: 900, promotionCode: null });
  });

  it("records what Stripe actually charged once paid", async () => {
    givenCodes(promo("AMICS20", { percent_off: 20 }));
    const res = await buy([attendee()], "AMICS20");

    await sendStripeEvent("checkout.session.completed", {
      id: "cs_test_1", object: "checkout.session", metadata: { orderId: res.body.orderId },
      payment_status: "paid", payment_intent: "pi_1", amount_total: 720,
    });

    expect(await orderDoc(res.body.orderId)).toMatchObject({ status: "paid", total: 720, amountPaid: 720 });
  });
});

describe("the admin's list of codes", () => {
  it("shows each code, what it takes off and from which of our products, and whether it works", async () => {
    givenCodes(
      promo("LAN10", { percent_off: 10, applies_to: { products: ["prod_lan", "prod_samarreta", "prod_other"] } }, {
        max_redemptions: 50, times_redeemed: 3, expires_at: 1_800_000_000,
      }),
      promo("OLD", { amount_off: 500, currency: "eur" }, { expires_at: hourAgo() }),
    );

    const res = await apiFetch("GET", "/promotion-codes", { token: admin.token });

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      {
        id: "promo_LAN10", code: "LAN10", usable: true, problem: null,
        percentOff: 10, amountOff: null, minimumAmount: null,
        appliesTo: [
          { kind: "ticketType", id: "lan", name: "lan" },
          { kind: "extra", id: "samarreta", name: "samarreta" },
          { kind: null, id: "prod_other", name: null },
        ],
        expiresAt: new Date(1_800_000_000_000).toISOString(), maxRedemptions: 50, timesRedeemed: 3,
        createdAt: new Date(1_790_000_000_000).toISOString(),
      },
      expect.objectContaining({ code: "OLD", usable: false, problem: "expired", amountOff: 500, appliesTo: null }),
    ]);
  });

  it("is for admins only", async () => {
    const staff = await createUser("staff@example.com", "staff");

    expect((await apiFetch("GET", "/promotion-codes", { token: staff.token })).status).toBe(403);
    expect((await apiFetch("GET", "/promotion-codes")).status).toBe(401);
  });
});
