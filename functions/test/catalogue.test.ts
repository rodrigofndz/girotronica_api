import { getFirestore } from "firebase-admin/firestore";
import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  apiFetch, auditEntries, createUser, resetEmulators, seedTicketType, soldCount, startApi, stopApi,
  type TestUser,
} from "./helpers";

const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid" }).format(new Date());

let admin: TestUser;
let staff: TestUser;

const sell = (typeId: string, people: number) =>
  apiFetch("POST", "/tickets/door", {
    token: staff.token,
    body: {
      paymentMethod: "cash",
      items: Array.from({ length: people }, (_, i) => ({
        typeId, holderName: `Person ${i + 1}`, holderEmail: `p${i + 1}@example.com`,
      })),
    },
  });

const ticket = async (id: string) => (await getFirestore().doc(`tickets/${id}`).get()).data()!;
const cancel = (id: string) => apiFetch("POST", `/tickets/${id}/cancel`, { token: admin.token });
const scan = (code: string) => apiFetch("POST", "/tickets/checkin", { token: staff.token, body: { code } });

beforeAll(startApi);
afterAll(stopApi);

beforeEach(async () => {
  await resetEmulators();
  admin = await createUser("admin@example.com", "admin");
  staff = await createUser("staff@example.com", "staff");
});

describe("the catalogue fields", () => {
  it("defaults them for types stored before they existed", async () => {
    await seedTicketType("old");

    const [type] = (await apiFetch("GET", "/ticket-types")).body;

    expect(type).toMatchObject({ category: "general", packSize: 1, singleEntry: false, extrasFrom: "general" });
  });

  it("lets an admin set them", async () => {
    await seedTicketType("pack-10-lan-party");

    const res = await apiFetch("PATCH", "/ticket-types/pack-10-lan-party", {
      token: admin.token,
      body: { category: "pack", packSize: 10, extrasFrom: "lan" },
    });

    expect(res.body).toMatchObject({ category: "pack", packSize: 10, singleEntry: false, extrasFrom: "lan" });
  });

  it("refuses changing the pack size once units are sold", async () => {
    await seedTicketType("pack", { packSize: 10, sold: 1 });

    const res = await apiFetch("PATCH", "/ticket-types/pack", { token: admin.token, body: { packSize: 5 } });

    expect(res.status).toBe(409);
  });

  it.each([
    ["an unknown category", { category: "vip" }],
    ["a pack of zero", { packSize: 0 }],
    ["an unknown extras group", { extrasFrom: "pack" }],
  ])("refuses %s", async (_label, body) => {
    await seedTicketType("general");

    expect((await apiFetch("PATCH", "/ticket-types/general", { token: admin.token, body })).status).toBe(400);
  });
});

describe("selling packs", () => {
  beforeEach(() => seedTicketType("pack-10", { packSize: 3, capacity: 2, price: 9000 }));

  it("counts a pack's people as one unit of stock, all sharing one pack id", async () => {
    const res = await sell("pack-10", 6);

    expect(res.status).toBe(200);
    expect(await soldCount("pack-10")).toBe(2);
    const packs = await Promise.all(res.body.map((t: { id: string }) => ticket(t.id).then((d) => d.packId)));
    expect(new Set(packs).size).toBe(2);
    expect(packs.slice(0, 3).every((p) => p === packs[0])).toBe(true);
  });

  it("refuses a number of people that isn't whole packs", async () => {
    const res = await sell("pack-10", 4);

    expect(res.status).toBe(400);
    expect(res.body).toBe("pack-10 is sold in packs of 3; got 4 tickets");
    expect(await soldCount("pack-10")).toBe(0);
  });

  it("counts remaining stock in packs", async () => {
    await sell("pack-10", 6);

    expect((await sell("pack-10", 3)).body).toBe("sold out: pack-10 has 0 left, asked for 1");
  });

  it("logs each ticket with its pack", async () => {
    await sell("pack-10", 3);

    const entries = await auditEntries("ticket.doorSale");
    expect(entries).toHaveLength(3);
    expect(new Set(entries.map((e) => e.details.packId)).size).toBe(1);
    expect(entries[0].details.price).toBe(9000);
  });

  it("frees the pack's stock only when its last ticket is cancelled", async () => {
    const [a, b, c] = (await sell("pack-10", 3)).body as { id: string }[];

    await cancel(a.id);
    await cancel(b.id);
    expect(await soldCount("pack-10")).toBe(1);

    await cancel(c.id);
    expect(await soldCount("pack-10")).toBe(0);
  });

  it("frees nothing twice when a ticket is cancelled again", async () => {
    const tickets = (await sell("pack-10", 3)).body as { id: string }[];
    for (const t of tickets) await cancel(t.id);

    await cancel(tickets[0].id);

    expect(await soldCount("pack-10")).toBe(0);
  });

  it("still frees single tickets at once", async () => {
    await seedTicketType("general", { capacity: 5 });
    const [t] = (await sell("general", 1)).body;

    await cancel(t.id);

    expect(await soldCount("general")).toBe(0);
  });
});

describe("single-entry tickets", () => {
  it("let their holder in once, then refuse on any day", async () => {
    await seedTicketType("entrada-infants", { singleEntry: true, days: [today(), "2099-01-01"] });
    const [t] = (await sell("entrada-infants", 1)).body;

    expect((await scan(t.code)).body.result).toBe("valid");
    expect((await scan(t.code)).body.result).toBe("already_used");
    expect((await ticket(t.id)).singleEntry).toBe(true);
  });

  it("refuse a second entry even when the first was on another day", async () => {
    await seedTicketType("entrada-jubilats", { singleEntry: true, days: [today(), "2099-01-01"] });
    const [t] = (await sell("entrada-jubilats", 1)).body;
    await getFirestore().doc(`tickets/${t.id}`).update({
      "checkins.2099-01-01": { at: new Date("2099-01-01T10:00:00Z"), by: staff.uid },
    });

    const res = await scan(t.code);

    expect(res.body).toMatchObject({ result: "already_used", checkedInBy: staff.uid });
  });

  it("don't change multi-day tickets, which allow one entry per day", async () => {
    await seedTicketType("pack-3-dies", { days: [today(), "2099-01-01"] });
    const [t] = (await sell("pack-3-dies", 1)).body;
    await getFirestore().doc(`tickets/${t.id}`).update({
      "checkins.2099-01-01": { at: new Date("2099-01-01T10:00:00Z"), by: staff.uid },
    });

    expect((await scan(t.code)).body.result).toBe("valid");
  });
});
