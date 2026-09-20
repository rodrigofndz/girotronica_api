import { getFirestore } from "firebase-admin/firestore";
import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  apiFetch, createUser, resetEmulators, seedTicketType, startApi, stopApi, type TestUser,
} from "./helpers";

let staff: TestUser;
let attendee: TestUser;

/** The event day the server will compute: today in Europe/Madrid. */
const today = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid" }).format(new Date());

const givenTicket = async (overrides: Record<string, unknown> = {}) => {
  const ref = await getFirestore().collection("tickets").add({
    uid: null, typeId: "general", status: "active", code: `code-${Math.random()}`,
    holderName: "Holder", holderEmail: "holder@example.com", paymentMethod: "cash",
    soldBy: staff.uid, purchasedAt: new Date(), days: [today()], isLanParty: false,
    checkins: {}, ...overrides,
  });
  const doc = await ref.get();
  return { id: ref.id, ...(doc.data() as { code: string }) };
};

const scan = (code: string, token = staff.token) =>
  apiFetch("POST", "/tickets/checkin", { token, body: { code } });

beforeAll(startApi);
afterAll(stopApi);

beforeEach(async () => {
  await resetEmulators();
  staff = await createUser("staff@example.com", "staff");
  attendee = await createUser("attendee@example.com");
  await seedTicketType("general");
});

describe("check-in", () => {
  it("admits a valid ticket for today", async () => {
    const ticket = await givenTicket();

    const res = await scan(ticket.code);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ result: "valid", holderName: "Holder" });
  });

  it("reports a second scan as already used, with who and when", async () => {
    const ticket = await givenTicket();
    await scan(ticket.code);

    const res = await scan(ticket.code);

    expect(res.body.result).toBe("already_used");
    expect(res.body.checkedInBy).toBe(staff.uid);
    expect(Date.parse(res.body.checkedInAt)).not.toBeNaN();
  });

  it("does not turn a retried scan into a rejection", async () => {
    const ticket = await givenTicket();

    const [first, second] = [await scan(ticket.code), await scan(ticket.code)];

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });

  it("admits a multi-day ticket on each day separately", async () => {
    const ticket = await givenTicket({ days: ["2026-01-01", today()] });
    await scan(ticket.code);

    const stored = await getFirestore().doc(`tickets/${ticket.id}`).get();

    expect(Object.keys(stored.data()!.checkins)).toEqual([today()]);
  });

  it("refuses a ticket that is not valid today", async () => {
    const ticket = await givenTicket({ days: ["2026-01-01"] });

    const res = await scan(ticket.code);

    expect(res.body).toMatchObject({ result: "wrong_day", days: ["2026-01-01"] });
  });

  it("refuses a ticket that is not paid for", async () => {
    const ticket = await givenTicket({ status: "pending" });

    expect((await scan(ticket.code)).body).toMatchObject({ result: "invalid", status: "pending" });
  });

  it("refuses a cancelled ticket", async () => {
    const ticket = await givenTicket({ status: "cancelled" });

    expect((await scan(ticket.code)).body).toMatchObject({ result: "invalid", status: "cancelled" });
  });

  it("reports an unknown code as not found", async () => {
    expect((await scan("no-such-code")).body).toEqual({ result: "not_found" });
  });

  it("lets only one of two simultaneous scans win", async () => {
    const ticket = await givenTicket();

    const results = await Promise.all([scan(ticket.code), scan(ticket.code)]);
    const outcomes = results.map((r) => r.body.result).sort();

    expect(outcomes).toEqual(["already_used", "valid"]);
  });

  it("is closed to attendees", async () => {
    const ticket = await givenTicket();

    expect((await scan(ticket.code, attendee.token)).status).toBe(403);
  });

  it("requires a token", async () => {
    const res = await apiFetch("POST", "/tickets/checkin", { body: { code: "x" } });

    expect(res.status).toBe(401);
  });
});
