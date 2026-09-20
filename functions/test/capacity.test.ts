import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  apiFetch, createUser, resetEmulators, seedTicketType, soldCount, startApi, stopApi,
  type TestUser,
} from "./helpers";

let staff: TestUser;

const sell = (typeId: string, count = 1) =>
  apiFetch("POST", "/tickets/door", {
    token: staff.token,
    body: {
      paymentMethod: "cash",
      items: Array.from({ length: count }, (_, i) => ({
        typeId, holderName: `H${i}`, holderEmail: `h${i}@example.com`,
      })),
    },
  });

beforeAll(startApi);
afterAll(stopApi);

beforeEach(async () => {
  await resetEmulators();
  staff = await createUser("staff@example.com", "staff");
});

describe("ticket type capacity", () => {
  it("counts sales on a type seeded without a sold field", async () => {
    await seedTicketType("lan", { capacity: 2, sold: undefined as unknown as number });

    expect((await sell("lan")).status).toBe(200);
    expect(await soldCount("lan")).toBe(1);
  });

  it("refuses a basket larger than what is left, reserving nothing", async () => {
    await seedTicketType("lan", { capacity: 2 });
    await sell("lan");

    const res = await sell("lan", 2);

    expect(res.status).toBe(409);
    expect(await soldCount("lan")).toBe(1);
  });

  it("sells the last slot and then refuses", async () => {
    await seedTicketType("lan", { capacity: 2 });

    expect((await sell("lan", 2)).status).toBe(200);
    expect((await sell("lan")).status).toBe(409);
    expect(await soldCount("lan")).toBe(2);
  });

  it("does not oversell when buyers arrive at once", async () => {
    await seedTicketType("race", { capacity: 5 });

    const results = await Promise.all(Array.from({ length: 10 }, () => sell("race")));

    expect(results.filter((r) => r.status === 200)).toHaveLength(5);
    expect(results.filter((r) => r.status === 409)).toHaveLength(5);
    expect(await soldCount("race")).toBe(5);
  });

  it("treats a null capacity as unlimited but still counts", async () => {
    await seedTicketType("open", { capacity: null });

    expect((await sell("open", 6)).status).toBe(200);
    expect(await soldCount("open")).toBe(6);
  });

  it("rejects a mixed basket as a whole when one type is short", async () => {
    await seedTicketType("open", { capacity: null });
    await seedTicketType("small", { capacity: 1 });

    const res = await apiFetch("POST", "/tickets/door", {
      token: staff.token,
      body: {
        paymentMethod: "cash",
        items: [
          { typeId: "open", holderName: "A", holderEmail: "a@example.com" },
          { typeId: "small", holderName: "B", holderEmail: "b@example.com" },
          { typeId: "small", holderName: "C", holderEmail: "c@example.com" },
        ],
      },
    });

    expect(res.status).toBe(409);
    expect(await soldCount("open")).toBe(0);
    expect(await soldCount("small")).toBe(0);
  });

  it("rejects an unknown ticket type", async () => {
    expect((await sell("nope")).status).toBe(400);
  });
});
