import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  apiFetch, createUser, resetEmulators, seedTicketType, soldCount, startApi, stopApi,
  type TestUser,
} from "./helpers";

let admin: TestUser;
let staff: TestUser;

const HOUR = 60 * 60 * 1000;
const hoursFromNow = (hours: number) => new Date(Date.now() + hours * HOUR).toISOString();

const item = (typeId: string) => ({ typeId, holderName: "Holder", holderEmail: "holder@example.com" });

const sellAtDoor = (typeId: string) =>
  apiFetch("POST", "/tickets/door", {
    token: staff.token,
    body: { paymentMethod: "cash", items: [item(typeId)] },
  });

const catalogEntry = async (id: string) =>
  (await apiFetch("GET", "/ticket-types")).body.find((t: { id: string }) => t.id === id);

beforeAll(startApi);
afterAll(stopApi);

beforeEach(async () => {
  await resetEmulators();
  admin = await createUser("admin@example.com", "admin");
  staff = await createUser("staff@example.com", "staff");
});

describe("the sale window in the catalog", () => {
  it("tells the site whether each type can be bought right now", async () => {
    await seedTicketType("early", { salesEnd: hoursFromNow(-1) });
    await seedTicketType("regular", { salesStart: hoursFromNow(-1), salesEnd: hoursFromNow(24) });
    await seedTicketType("later", { salesStart: hoursFromNow(1) });
    await seedTicketType("always");

    expect((await catalogEntry("early")).onSale).toBe(false);
    expect((await catalogEntry("regular")).onSale).toBe(true);
    expect((await catalogEntry("later")).onSale).toBe(false);
    expect(await catalogEntry("always")).toMatchObject({ onSale: true, salesStart: null, salesEnd: null });
  });
});

describe("selling outside the window", () => {
  it("refuses once early bird has ended, reserving nothing", async () => {
    await seedTicketType("early", { salesEnd: hoursFromNow(-1) });

    const res = await sellAtDoor("early");

    expect(res.status).toBe(409);
    expect(res.body).toBe("not on sale: early");
    expect(await soldCount("early")).toBe(0);
  });

  it("refuses before sales open", async () => {
    await seedTicketType("later", { salesStart: hoursFromNow(1) });

    expect((await sellAtDoor("later")).status).toBe(409);
  });

  it("refuses the whole basket if any one type is closed", async () => {
    await seedTicketType("early", { salesEnd: hoursFromNow(-1) });
    await seedTicketType("always");

    const res = await apiFetch("POST", "/tickets/door", {
      token: staff.token,
      body: { paymentMethod: "cash", items: [item("always"), item("early")] },
    });

    expect(res.status).toBe(409);
    expect(await soldCount("always")).toBe(0);
  });

  it("sells inside the window", async () => {
    await seedTicketType("regular", { salesStart: hoursFromNow(-1), salesEnd: hoursFromNow(1) });

    expect((await sellAtDoor("regular")).status).toBe(200);
  });
});

describe("setting the window", () => {
  const setWindow = (body: Record<string, unknown>) =>
    apiFetch("PATCH", "/ticket-types/early", { token: admin.token, body });

  beforeEach(() => seedTicketType("early"));

  it("accepts any timezone offset and stores UTC", async () => {
    const res = await setWindow({ salesEnd: "2026-10-31T23:59:59+01:00" });

    expect(res.status).toBe(200);
    expect(res.body.salesEnd).toBe("2026-10-31T22:59:59.000Z");
    expect((await catalogEntry("early")).salesEnd).toBe("2026-10-31T22:59:59.000Z");
  });

  it("refuses a date without a timezone, which would be ambiguous", async () => {
    const res = await setWindow({ salesEnd: "2026-10-31T23:59:59" });

    expect(res.status).toBe(400);
  });

  it("refuses a window that ends before it starts", async () => {
    const res = await setWindow({ salesStart: "2026-11-01T00:00:00Z", salesEnd: "2026-10-01T00:00:00Z" });

    expect(res.status).toBe(400);
  });

  it("checks an edited bound against the one already stored", async () => {
    await seedTicketType("regular", { salesStart: "2026-11-01T00:00:00.000Z" });

    const res = await apiFetch("PATCH", "/ticket-types/regular", {
      token: admin.token,
      body: { salesEnd: "2026-10-01T00:00:00Z" },
    });

    expect(res.status).toBe(400);
    expect(res.body).toBe("salesStart must be before salesEnd");
  });

  it("reopens sales when a bound is cleared with null", async () => {
    await seedTicketType("early", { salesEnd: hoursFromNow(-1) });

    const res = await apiFetch("PATCH", "/ticket-types/early", { token: admin.token, body: { salesEnd: null } });

    expect(res.body).toMatchObject({ salesEnd: null, onSale: true });
    expect((await sellAtDoor("early")).status).toBe(200);
  });
});
