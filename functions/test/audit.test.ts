import { getFirestore } from "firebase-admin/firestore";
import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";

import { AUDIT_ACTION_NAMES } from "../src/audit/audit";
import {
  apiFetch, auditEntries, createUser, resetEmulators, seedTicketType, startApi, stopApi,
  type TestUser,
} from "./helpers";

const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid" }).format(new Date());

let admin: TestUser;
let staff: TestUser;
let user: TestUser;

const doorSale = (holders: string[], typeId = "general") =>
  apiFetch("POST", "/tickets/door", {
    token: staff.token,
    body: {
      paymentMethod: "cash",
      items: holders.map((holderName) => ({ typeId, holderName, holderEmail: "holder@example.com" })),
    },
  });

const scan = (code: string) => apiFetch("POST", "/tickets/checkin", { token: staff.token, body: { code } });

const soldTicket = async (holder = "Holder") => (await doorSale([holder])).body[0] as { id: string; code: string };

const readLog = (query = "", token = admin.token) => apiFetch("GET", `/audit${query}`, { token });

beforeAll(startApi);
afterAll(stopApi);

beforeEach(async () => {
  await resetEmulators();
  admin = await createUser("admin@example.com", "admin");
  staff = await createUser("staff@example.com", "staff");
  user = await createUser("user@example.com");
  await seedTicketType("general", { price: 700, days: [today()] });
});

describe("what gets recorded", () => {
  it("records only the fields an edit actually changed, and nothing for a no-op edit", async () => {
    await apiFetch("PATCH", "/ticket-types/general", { token: admin.token, body: { capacity: 3, name: "general" } });
    await apiFetch("PATCH", "/ticket-types/general", { token: admin.token, body: { capacity: 3 } });

    const entries = await auditEntries("ticketType.update");

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      targetId: "general", actorUid: admin.uid, actorEmail: "admin@example.com", actorRole: "admin",
      details: { changes: { capacity: { from: null, to: 3 } } },
    });
  });

  it("keeps a deleted type's name so the entry still reads well", async () => {
    await seedTicketType("unused", { name: "Unused" });

    await apiFetch("DELETE", "/ticket-types/unused", { token: admin.token });

    expect((await auditEntries("ticketType.delete"))[0]).toMatchObject({ targetId: "unused", targetLabel: "Unused" });
  });

  it("records one entry per ticket sold at the door, with the price charged", async () => {
    const sold = (await doorSale(["Anna", "Biel"])).body as { id: string }[];

    const entries = await auditEntries("ticket.doorSale");

    expect(entries.map((e) => e.targetId).sort()).toEqual(sold.map((t) => t.id).sort());
    expect(entries[0]).toMatchObject({
      actorUid: staff.uid, actorRole: "staff",
      details: { typeId: "general", price: 700, paymentMethod: "cash" },
    });
  });

  it("records a check-in and every refused scan with its reason", async () => {
    const ticket = await soldTicket("Anna");
    await seedTicketType("later", { days: ["2099-01-01"] });
    const tomorrowOnly = (await doorSale(["Biel"], "later")).body[0];

    await scan(ticket.code);
    await scan(ticket.code);
    await scan(tomorrowOnly.code);
    await scan("forged-code");

    expect(await auditEntries("ticket.checkin")).toEqual([
      expect.objectContaining({ targetId: ticket.id, targetLabel: "Anna", details: { day: today() } }),
    ]);
    expect((await auditEntries("ticket.scanRejected")).map((e) => [e.targetId, e.details])).toEqual([
      [ticket.id, { day: today(), reasons: ["already_used"] }],
      [tomorrowOnly.id, { day: today(), reasons: ["wrong_day"] }],
      [null, { day: today(), reasons: ["not_found"], code: "forged-code" }],
    ]);
  });

  it("records a scan of a cancelled ticket as invalid", async () => {
    const ticket = await soldTicket();
    await apiFetch("POST", `/tickets/${ticket.id}/cancel`, { token: admin.token });

    await scan(ticket.code);

    expect((await auditEntries("ticket.scanRejected"))[0].details.reasons).toEqual(["invalid"]);
  });

  it("records a cancellation once, with the status it had", async () => {
    const ticket = await soldTicket();

    await apiFetch("POST", `/tickets/${ticket.id}/cancel`, { token: admin.token });
    await apiFetch("POST", `/tickets/${ticket.id}/cancel`, { token: admin.token });

    const entries = await auditEntries("ticket.cancel");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ targetId: ticket.id, actorUid: admin.uid, details: { previousStatus: "active" } });
  });

  it("records promotions, demotions, suspensions and reactivations, but not repeats", async () => {
    await apiFetch("POST", `/users/${user.uid}/staff`, { token: admin.token });
    await apiFetch("POST", `/users/${user.uid}/staff`, { token: admin.token });
    await apiFetch("DELETE", `/users/${user.uid}/staff`, { token: admin.token });
    await apiFetch("POST", `/users/${user.uid}/suspend`, { token: staff.token });
    await apiFetch("POST", `/users/${user.uid}/suspend`, { token: staff.token });
    await apiFetch("DELETE", `/users/${user.uid}/suspend`, { token: admin.token });

    const entries = await auditEntries();

    expect(entries.filter((e) => e.targetType === "user").map((e) => [e.action, e.actorEmail])).toEqual([
      ["user.promote", "admin@example.com"],
      ["user.demote", "admin@example.com"],
      ["user.suspend", "staff@example.com"],
      ["user.reactivate", "admin@example.com"],
    ]);
    expect(entries[0].targetLabel).toBe("user@example.com");
  });

  it("records nothing when the action is refused", async () => {
    await seedTicketType("full", { capacity: 1, sold: 1 });

    await doorSale(["Anna"], "full");
    await apiFetch("POST", `/users/${admin.uid}/suspend`, { token: staff.token });
    await apiFetch("PATCH", "/ticket-types/general", { token: admin.token, body: { price: 1 } });

    expect(await auditEntries()).toEqual([]);
  });
});

describe("reading the log", () => {
  it("is for admins only", async () => {
    expect((await readLog("", staff.token)).status).toBe(403);
    expect((await readLog("", user.token)).status).toBe(403);
  });

  it("returns entries newest first, with readable times", async () => {
    await soldTicket("First");
    await soldTicket("Second");

    const res = await readLog();

    expect(res.status).toBe(200);
    expect(res.body.entries.map((e: { targetLabel: string }) => e.targetLabel)).toEqual(["Second", "First"]);
    expect(new Date(res.body.entries[0].at).toISOString()).toBe(res.body.entries[0].at);
    expect(res.body.next).toBeNull();
  });

  it("can return oldest first", async () => {
    await soldTicket("First");
    await soldTicket("Second");

    const res = await readLog("?order=asc");

    expect(res.body.entries.map((e: { targetLabel: string }) => e.targetLabel)).toEqual(["First", "Second"]);
  });

  it("filters by who, what and which target, and combines filters", async () => {
    const ticket = await soldTicket();
    await scan(ticket.code);
    await apiFetch("POST", `/tickets/${ticket.id}/cancel`, { token: admin.token });
    await apiFetch("POST", `/users/${user.uid}/staff`, { token: admin.token });

    const labels = async (query: string) =>
      (await readLog(query)).body.entries.map((e: { action: string }) => e.action);

    expect(await labels(`?actor=${admin.uid}`)).toEqual(["user.promote", "ticket.cancel"]);
    expect(await labels("?role=staff")).toEqual(["ticket.checkin", "ticket.doorSale"]);
    expect(await labels("?action=ticket.checkin")).toEqual(["ticket.checkin"]);
    expect(await labels(`?target=${ticket.id}`)).toEqual(["ticket.cancel", "ticket.checkin", "ticket.doorSale"]);
    expect(await labels("?targetType=user")).toEqual(["user.promote"]);
    expect(await labels(`?target=${ticket.id}&role=staff&order=asc`)).toEqual(["ticket.doorSale", "ticket.checkin"]);
  });

  it("filters by a time range", async () => {
    await soldTicket("Before");
    const [{ at: first }] = await auditEntries();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const middle = new Date();
    await soldTicket("After");

    const after = await readLog(`?from=${encodeURIComponent(middle.toISOString())}`);
    const before = await readLog(`?to=${encodeURIComponent(middle.toISOString())}`);

    expect(after.body.entries.map((e: { targetLabel: string }) => e.targetLabel)).toEqual(["After"]);
    expect(before.body.entries.map((e: { targetLabel: string }) => e.targetLabel)).toEqual(["Before"]);
    expect(first.toDate().getTime()).toBeLessThan(middle.getTime());
  });

  it("pages through long results with the next cursor", async () => {
    for (const holder of ["A", "B", "C"]) await soldTicket(holder);

    const first = await readLog("?limit=2");
    const second = await readLog(`?limit=2&after=${first.body.next}`);

    expect(first.body.entries.map((e: { targetLabel: string }) => e.targetLabel)).toEqual(["C", "B"]);
    expect(second.body.entries.map((e: { targetLabel: string }) => e.targetLabel)).toEqual(["A"]);
    expect(second.body.next).toBeNull();
  });

  it("refuses an unknown cursor or action", async () => {
    expect((await readLog("?after=nope")).status).toBe(400);
    expect((await readLog("?action=ticket.teleport")).status).toBe(400);
  });

  it("lists every action it can record, for building the filter", async () => {
    const res = await apiFetch("GET", "/audit/actions", { token: admin.token });

    expect(res.body.map((a: { action: string }) => a.action)).toEqual(AUDIT_ACTION_NAMES);
    expect(res.body.every((a: { description: string }) => a.description.length > 0)).toBe(true);
  });

  it("cannot be edited or deleted through the API", async () => {
    await soldTicket();
    const [{ id }] = await auditEntries();

    for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
      expect([404, 405]).toContain((await apiFetch(method, `/audit/${id}`, { token: admin.token })).status);
    }
    expect((await getFirestore().doc(`auditLog/${id}`).get()).exists).toBe(true);
  });
});

// A new endpoint that changes data has to say what it logs, or this fails
describe("every data-changing endpoint", () => {
  it("declares which actions it records, all of them real", async () => {
    const spec = (await apiFetch("GET", "/openapi.json")).body as {
      paths: Record<string, Record<string, { "x-audit"?: string[] }>>;
    };

    const undeclared: string[] = [];
    const unknown: string[] = [];
    for (const [path, operations] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(operations)) {
        if (method === "get") continue;
        const actions = operation["x-audit"];
        if (!actions || actions.length === 0) undeclared.push(`${method.toUpperCase()} ${path}`);
        for (const action of actions ?? []) {
          if (!AUDIT_ACTION_NAMES.includes(action as never)) unknown.push(action);
        }
      }
    }

    expect(undeclared).toEqual([]);
    expect(unknown).toEqual([]);
  });
});
