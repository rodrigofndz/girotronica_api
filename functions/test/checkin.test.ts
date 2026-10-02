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
    // The name comes from the scanner's sign-in account, as Google sign-in provides
    staff = await createUser("named.staff@example.com", "staff", "Staff Member");
    await scan(ticket.code);

    const res = await scan(ticket.code);

    expect(res.body).toMatchObject({ result: "rejected", holderName: "Holder" });
    expect(res.body.problems).toEqual([
      { reason: "already_used", checkedInBy: staff.uid, checkedInByEmail: "named.staff@example.com",
        checkedInByName: "Staff Member", checkedInAt: expect.any(String) },
    ]);
    expect(Date.parse(res.body.problems[0].checkedInAt)).not.toBeNaN();
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

    expect(res.body.problems).toEqual([{ reason: "wrong_day", days: ["2026-01-01"] }]);
  });

  it("refuses a ticket that is not paid for", async () => {
    const ticket = await givenTicket({ status: "pending" });

    expect((await scan(ticket.code)).body.problems).toEqual([{ reason: "invalid", status: "pending" }]);
  });

  it("refuses a cancelled ticket", async () => {
    const ticket = await givenTicket({ status: "cancelled" });

    expect((await scan(ticket.code)).body.problems).toEqual([{ reason: "invalid", status: "cancelled" }]);
  });

  it("reports an unknown code as not found", async () => {
    expect((await scan("no-such-code")).body).toEqual({
      result: "rejected", holderName: null, typeId: null, problems: [{ reason: "not_found" }],
    });
  });

  it("lists every problem at once, not just the first", async () => {
    const ticket = await givenTicket({ status: "cancelled", days: ["2026-01-01"] });
    await getFirestore().doc(`tickets/${ticket.id}`).update({
      "checkins.2026-01-01": { at: new Date("2026-01-01T10:00:00Z"), by: staff.uid },
    });

    const res = await scan(ticket.code);

    expect(res.body.problems.map((p: { reason: string }) => p.reason)).toEqual(["invalid", "wrong_day", "already_used"]);
  });

  it("lets only one of two simultaneous scans win", async () => {
    const ticket = await givenTicket();

    const results = await Promise.all([scan(ticket.code), scan(ticket.code)]);
    const outcomes = results.map((r) => r.body.problems?.[0].reason ?? r.body.result).sort();

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
