import { FieldValue, getFirestore } from "firebase-admin/firestore";
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
const reasons = (res: { body: { problems?: { reason: string }[] } }) => res.body.problems?.map((p) => p.reason);
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

    expect(type).toMatchObject({ category: "general", packSize: 1, entries: "once", extrasFrom: "general" });
  });

  it("lets an admin set them", async () => {
    await seedTicketType("pack-10-lan-party");

    const res = await apiFetch("PATCH", "/ticket-types/pack-10-lan-party", {
      token: admin.token,
      body: { category: "pack", entries: "daily", extrasFrom: "lan" },
    });

    expect(res.body).toMatchObject({ category: "pack", packSize: 1, entries: "daily", extrasFrom: "lan" });
  });

  // It comes from the Stripe product's metadata, like the price
  it("refuses setting the pack size by hand", async () => {
    await seedTicketType("pack");

    const res = await apiFetch("PATCH", "/ticket-types/pack", { token: admin.token, body: { packSize: 10 } });

    expect(res.status).toBe(400);
  });

  it.each([
    ["an unknown category", { category: "vip" }],
    ["an unknown extras group", { extrasFrom: "pack" }],
    ["an unknown entries rule", { entries: "twice" }],
    ["the old singleEntry flag", { singleEntry: true }],
  ])("refuses %s", async (_label, body) => {
    await seedTicketType("general");

    expect((await apiFetch("PATCH", "/ticket-types/general", { token: admin.token, body })).status).toBe(400);
  });
});

describe("shop card texts", () => {
  const edit = (body: Record<string, unknown>) =>
    apiFetch("PATCH", "/ticket-types/entrada-divendres", { token: admin.token, body });

  beforeEach(() => seedTicketType("entrada-divendres"));

  it("are empty for types stored before they existed", async () => {
    const [type] = (await apiFetch("GET", "/ticket-types")).body;

    expect(type).toMatchObject({ description: null, features: [], disclaimer: null });
  });

  it("are set by an admin, trimmed, and shown publicly", async () => {
    await edit({
      description: "  Entrada per divendres ",
      features: [" Accés al recinte ", "Concerts"],
      disclaimer: "Aquesta entrada dóna accés un sol cop al recinte.",
    });

    const [type] = (await apiFetch("GET", "/ticket-types")).body;
    expect(type).toMatchObject({
      description: "Entrada per divendres",
      features: ["Accés al recinte", "Concerts"],
      disclaimer: "Aquesta entrada dóna accés un sol cop al recinte.",
    });
  });

  it("clear with an empty string or list", async () => {
    await edit({ description: "x", features: ["y"], disclaimer: "z" });

    const res = await edit({ description: "  ", features: [], disclaimer: "" });

    expect(res.body).toMatchObject({ description: null, features: [], disclaimer: null });
  });

  it("are logged like any other edit", async () => {
    await edit({ features: ["Concerts"] });

    expect((await auditEntries("ticketType.update"))[0].details.changes)
      .toEqual({ features: { from: null, to: ["Concerts"] } });
  });

  it.each([
    ["a description over 200 characters", { description: "x".repeat(201) }],
    ["a feature over 300 characters", { features: ["x".repeat(301)] }],
    ["an empty feature", { features: ["ok", " "] }],
    ["more than 20 features", { features: Array.from({ length: 21 }, (_, i) => `f${i}`) }],
    ["a disclaimer over 500 characters", { disclaimer: "x".repeat(501) }],
  ])("refuse %s", async (_label, body) => {
    expect((await edit(body)).status).toBe(400);
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

describe("how often a ticket gets in", () => {
  // Today must be one of its days, and another day already used, to tell the two rules apart
  const usedYesterday = async (id: string) =>
    getFirestore().doc(`tickets/${id}`).update({
      "checkins.2099-01-01": { at: new Date("2099-01-01T10:00:00Z"), by: staff.uid },
    });

  it("once by default: in on any of its days, then refused", async () => {
    await seedTicketType("entrada-infants", { days: [today(), "2099-01-01"] });
    const [t] = (await sell("entrada-infants", 1)).body;

    expect((await scan(t.code)).body.result).toBe("valid");
    expect(reasons(await scan(t.code))).toEqual(["already_used"]);
    expect((await ticket(t.id)).entries).toBe("once");
  });

  it("once: refused even when the first entry was another day, naming it", async () => {
    await seedTicketType("entrada-jubilats", { days: [today(), "2099-01-01"] });
    const [t] = (await sell("entrada-jubilats", 1)).body;
    await usedYesterday(t.id);

    expect((await scan(t.code)).body.problems).toEqual([expect.objectContaining({ reason: "already_used", checkedInBy: staff.uid })]);
  });

  it("once also applies to tickets sold before the rule existed", async () => {
    await seedTicketType("old", { days: [today(), "2099-01-01"] });
    const [t] = (await sell("old", 1)).body;
    await getFirestore().doc(`tickets/${t.id}`).update({ entries: FieldValue.delete() });
    await usedYesterday(t.id);

    expect(reasons(await scan(t.code))).toEqual(["already_used"]);
  });

  it("daily: in once on each day it covers", async () => {
    await seedTicketType("pack-3-dies", { entries: "daily", days: [today(), "2099-01-01"] });
    const [t] = (await sell("pack-3-dies", 1)).body;
    await usedYesterday(t.id);

    expect((await scan(t.code)).body.result).toBe("valid");
    expect(reasons(await scan(t.code))).toEqual(["already_used"]);
  });

  it("still refuses a day the ticket doesn't cover, either way", async () => {
    await seedTicketType("entrada-dissabte", { days: ["2099-01-01"] });
    const [t] = (await sell("entrada-dissabte", 1)).body;

    expect((await scan(t.code)).body.problems).toEqual([{ reason: "wrong_day", days: ["2099-01-01"] }]);
  });
});
