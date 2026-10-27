import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  apiFetch, attendee, buyOnline, createUser, resetEmulators, seedTicketType, soldCount, startApi, stopApi,
  type TestUser,
} from "./helpers";

// As deployed while admins try companions out
vi.mock("../src/features", () => ({ ONLINE_SALES: true, ONLINE_SALES_MODE: "public", COMPANIONS_ADMIN_ONLY: true }));

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

const order = [attendee({ typeId: "lan", phone: "600000001" }), attendee({ typeId: "companion", with: 0 })];

const publicTypeIds = async (token?: string) =>
  ((await apiFetch("GET", "/ticket-types", { token })).body as { id: string }[]).map((t) => t.id).sort();

beforeAll(startApi);
afterAll(stopApi);

beforeEach(async () => {
  await resetEmulators();
  createSession.mockReset();
  createSession.mockResolvedValue({ id: "cs_test_1", url: "https://checkout.stripe.test/cs_test_1" });
  admin = await createUser("admin@example.com", "admin");
  staff = await createUser("staff@example.com", "staff");
  member = await createUser("member@example.com");
  await seedTicketType("lan", { price: 3500, capacity: 10, allowsCompanion: true, stripePriceId: "price_lan" });
  await seedTicketType("companion", { price: 1000, capacity: 10, isCompanion: true, stripePriceId: "price_companion" });
});

describe("companion types while only admins get them", () => {
  it("are listed only to an admin", async () => {
    expect(await publicTypeIds()).toEqual(["lan"]);
    expect(await publicTypeIds(member.token)).toEqual(["lan"]);
    expect(await publicTypeIds(staff.token)).toEqual(["lan"]);
    expect(await publicTypeIds(admin.token)).toEqual(["companion", "lan"]);
  });

  it("are quoted only to an admin", async () => {
    const quote = (token?: string) => apiFetch("POST", "/tickets/quote", { token, body: { attendees: order } });

    expect(await quote()).toMatchObject({ status: 409, body: "not on sale: companion" });
    expect(await quote(member.token)).toMatchObject({ status: 409, body: "not on sale: companion" });
    expect((await quote(admin.token)).status).toBe(200);
  });

  it("are sold online only to an admin", async () => {
    expect(await buyOnline(order)).toMatchObject({ status: 409, body: "not on sale: companion" });
    expect(await buyOnline(order, { token: member.token })).toMatchObject({ status: 409, body: "not on sale: companion" });
    expect(await soldCount("companion")).toBe(0);
    expect(await soldCount("lan")).toBe(0);

    expect((await buyOnline(order, { token: admin.token })).status).toBe(200);
    expect(await soldCount("companion")).toBe(1);
  });

  it("are sold at the door only by an admin", async () => {
    const sell = (token: string) => apiFetch("POST", "/tickets/door", {
      token,
      body: {
        paymentMethod: "cash",
        items: [{ typeId: "lan" }, { typeId: "companion", with: 0 }]
          .map((item) => ({ holderName: "Someone", holderEmail: "someone@example.com", ...item })),
      },
    });

    expect(await sell(staff.token)).toMatchObject({ status: 409, body: "not on sale: companion" });
    expect(await soldCount("companion")).toBe(0);
    expect((await sell(admin.token)).status).toBe(200);
  });

  it("leave the other types as they were", async () => {
    expect((await buyOnline([order[0]])).status).toBe(200);
  });
});
