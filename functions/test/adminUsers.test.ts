import { getFirestore } from "firebase-admin/firestore";
import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  apiFetch, auditEntries, createUser, mailDocs, resetEmulators, seedTicketType, soldCount, startApi, stopApi,
  type TestUser,
} from "./helpers";

let admin: TestUser;
let staff: TestUser;

const list = async (query = "", token = admin.token) => apiFetch("GET", `/users${query}`, { token });
const emails = async (query = "") =>
  ((await list(query)).body.users as { email: string }[]).map((u) => u.email);

const assign = (uid: string, typeId = "general", token = admin.token) =>
  apiFetch("POST", `/users/${uid}/tickets`, { token, body: { typeId } });

const ticketDoc = async (id: string) => (await getFirestore().doc(`tickets/${id}`).get()).data()!;

beforeAll(startApi);
afterAll(stopApi);

beforeEach(async () => {
  await resetEmulators();
  admin = await createUser("admin@example.com", "admin", "Admin");
  staff = await createUser("staff@example.com", "staff", "Zoe Staff");
  await seedTicketType("general", { capacity: 2 });
});

describe("the user list", () => {
  beforeEach(async () => {
    await createUser("anna@example.com", "user", "Anna Puig");
    await createUser("biel@example.com", "user", "Biel");
  });

  it("is for admins only", async () => {
    expect((await list("", staff.token)).status).toBe(403);
  });

  it("lists every profile with its details, newest first by default", async () => {
    const res = await list();

    expect(res.body.total).toBe(4);
    expect(res.body.users.map((u: { email: string }) => u.email)).toEqual([
      "biel@example.com", "anna@example.com", "staff@example.com", "admin@example.com",
    ]);
    expect(res.body.users[0]).toEqual({
      uid: expect.any(String), email: "biel@example.com", displayName: "Biel", role: "user",
      suspended: false, createdAt: expect.any(String), ticketCount: 0,
    });
  });

  it("searches email and name, ignoring case", async () => {
    expect(await emails("?q=PUIG")).toEqual(["anna@example.com"]);
    expect(await emails("?q=biel@")).toEqual(["biel@example.com"]);
  });

  it("filters by role and by suspended", async () => {
    const anna = (await list("?q=anna")).body.users[0];
    await getFirestore().doc(`users/${anna.uid}`).update({ suspended: true });

    expect(await emails("?role=staff")).toEqual(["staff@example.com"]);
    expect(await emails("?role=staff,admin&sort=email")).toEqual(["admin@example.com", "staff@example.com"]);
    expect(await emails("?suspended=true")).toEqual(["anna@example.com"]);
    expect(await emails("?suspended=false&role=user")).toEqual(["biel@example.com"]);
  });

  it("counts the active tickets on each account, and filters and sorts by them", async () => {
    const biel = (await list("?q=biel")).body.users[0];
    await assign(biel.uid);
    await assign(biel.uid);
    // A cancelled ticket counts for nobody
    await getFirestore().collection("tickets").add({ uid: staff.uid, status: "cancelled" });

    expect((await list("?q=biel")).body.users[0].ticketCount).toBe(2);
    expect(await emails("?hasTickets=true")).toEqual(["biel@example.com"]);
    expect((await emails("?sort=tickets"))[0]).toBe("biel@example.com");
  });

  it("sorts by name or email, A–Z by default and either way on request", async () => {
    expect(await emails("?sort=name")).toEqual([
      "admin@example.com", "anna@example.com", "biel@example.com", "staff@example.com",
    ]);
    expect(await emails("?sort=email&order=desc")).toEqual([
      "staff@example.com", "biel@example.com", "anna@example.com", "admin@example.com",
    ]);
  });

  it("pages by offset", async () => {
    const first = await list("?sort=email&limit=3");
    const second = await list(`?sort=email&limit=3&offset=${first.body.next}`);

    expect(first.body.next).toBe(3);
    expect(second.body.users.map((u: { email: string }) => u.email)).toEqual(["staff@example.com"]);
    expect(second.body.next).toBeNull();
  });

  it.each(["?role=boss", "?role=staff,boss", "?role=", "?suspended=yes", "?sort=age", "?limit=0", "?offset=-1"])("refuses %s", async (query) => {
    expect((await list(query)).status).toBe(400);
  });
});

describe("assigning a ticket", () => {
  let anna: TestUser;
  beforeEach(async () => { anna = await createUser("anna@example.com", "user", "Anna Puig"); });

  it("creates an active ticket on the account, emails it, and takes a place", async () => {
    const res = await assign(anna.uid);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: expect.any(String), typeId: "general", code: expect.any(String),
      holderName: "Anna Puig", holderEmail: "anna@example.com", days: ["2026-11-20"],
    });
    expect(await ticketDoc(res.body.id)).toMatchObject({
      uid: anna.uid, status: "active", paymentMethod: "assigned", soldBy: admin.uid, packId: null,
    });
    expect(await soldCount("general")).toBe(1);
    expect((await mailDocs()).map((m) => m.to[0])).toEqual(["anna@example.com"]);
  });

  it("shows in the user's own ticket list", async () => {
    const { body } = await assign(anna.uid);

    expect((await apiFetch("GET", "/tickets", { token: anna.token })).body.map((t: { id: string }) => t.id))
      .toEqual([body.id]);
  });

  it("uses the email as the name when the account has none", async () => {
    const nameless = await createUser("nameless@example.com");

    expect((await assign(nameless.uid)).body.holderName).toBe("nameless@example.com");
  });

  it("is logged as the admin's", async () => {
    const res = await assign(anna.uid);

    expect((await auditEntries("ticket.assign"))[0]).toMatchObject({
      actorUid: admin.uid, targetId: res.body.id, details: { typeId: "general", uid: anna.uid, email: "anna@example.com" },
    });
  });

  it("ignores the sale window but not the stock", async () => {
    await seedTicketType("closed", { capacity: 1, salesEnd: new Date(Date.now() - 3600_000).toISOString() });

    expect((await assign(anna.uid, "closed")).status).toBe(200);
    const full = await assign(anna.uid, "closed");
    expect(full.status).toBe(409);
    expect(full.body).toBe("sold out: closed has 0 left, asked for 1");
  });

  it.each([
    ["a pack", { packSize: 10 }, 400],
    ["a type without days", { days: [] }, 400],
  ])("refuses %s", async (_label, overrides, status) => {
    await seedTicketType("special", overrides);

    expect((await assign(anna.uid, "special")).status).toBe(status);
    expect(await soldCount("special")).toBe(0);
  });

  it("refuses an unknown user or type, and a suspended account", async () => {
    await getFirestore().doc(`users/${anna.uid}`).update({ suspended: true });

    expect((await assign("ghost")).status).toBe(404);
    expect((await assign(staff.uid, "ghost")).status).toBe(404);
    expect((await assign(anna.uid)).body).toBe("account suspended");
    expect(await soldCount("general")).toBe(0);
  });

  it("is for admins only", async () => {
    expect((await assign(anna.uid, "general", staff.token)).status).toBe(403);
  });

  it("can't be used to fake an assigned door sale", async () => {
    const res = await apiFetch("POST", "/tickets/door", {
      token: staff.token,
      body: { paymentMethod: "assigned", items: [{ typeId: "general", holderName: "X", holderEmail: "x@example.com" }] },
    });

    expect(res.status).toBe(400);
  });
});
