import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  attendee, buyOnline, createUser, resetEmulators, seedTicketType, soldCount, startApi, stopApi, type TestUser,
} from "./helpers";

// How production runs while the deployed setup is tested with Stripe's test key
vi.mock("../src/features", () => ({ ONLINE_SALES: true, ONLINE_SALES_MODE: "staff" }));

const createSession = vi.hoisted(() => vi.fn());

vi.mock("stripe", async (importOriginal) => {
  const Real = ((await importOriginal()) as { default: new (key: string) => object }).default;
  class FakeCheckoutStripe extends Real {
    checkout = { sessions: { create: createSession } };
  }
  return { default: FakeCheckoutStripe };
});

let user: TestUser;
let staff: TestUser;
let admin: TestUser;

const buy = (token?: string) => buyOnline([attendee()], { token });

beforeAll(startApi);
afterAll(stopApi);

beforeEach(async () => {
  await resetEmulators();
  createSession.mockReset();
  createSession.mockResolvedValue({ id: "cs_test_1", url: "https://checkout.stripe.test/cs_test_1" });
  user = await createUser("user@example.com");
  staff = await createUser("staff@example.com", "staff");
  admin = await createUser("admin@example.com", "admin");
  await seedTicketType("general", { capacity: 10 });
});

describe("online sales open to staff only", () => {
  it("refuses a plain user before reserving anything or calling Stripe", async () => {
    const res = await buy(user.token);

    expect(res.status).toBe(403);
    expect(res.body).toBe("online sales are open to staff only for now");
    expect(await soldCount("general")).toBe(0);
    expect(createSession).not.toHaveBeenCalled();
  });

  it("refuses a guest too", async () => {
    expect((await buy()).status).toBe(403);
    expect(await soldCount("general")).toBe(0);
  });

  it("lets staff and admins buy", async () => {
    expect((await buy(staff.token)).status).toBe(200);
    expect((await buy(admin.token)).status).toBe(200);
    expect(await soldCount("general")).toBe(2);
  });
});
