import { getFirestore } from "firebase-admin/firestore";
import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  apiFetch, auditEntries, createUser, resetEmulators, seedTicketType, soldCount, startApi, stopApi,
  type TestUser,
} from "./helpers";

let admin: TestUser;
let staff: TestUser;

const seedPool = (id: string, capacity: number, sold = 0) =>
  getFirestore().doc(`capacityPools/${id}`).set({ name: `${id} places`, capacity, sold });

const placesTaken = async (id: string): Promise<number> =>
  (await getFirestore().doc(`capacityPools/${id}`).get()).data()!.sold;

const item = (typeId: string, n = 0) => ({ typeId, holderName: `Holder ${n}`, holderEmail: `holder${n}@example.com` });
const people = (typeId: string, count: number) => Array.from({ length: count }, (_, n) => item(typeId, n));

const doorSale = (items: unknown[]) =>
  apiFetch("POST", "/tickets/door", { token: staff.token, body: { paymentMethod: "cash", items } });

const cancel = (id: string) => apiFetch("POST", `/tickets/${id}/cancel`, { token: staff.token });

const catalog = async () =>
  Object.fromEntries((await apiFetch("GET", "/ticket-types")).body.map((t: { id: string; remaining: number | null }) => [t.id, t.remaining]));

beforeAll(startApi);
afterAll(stopApi);

beforeEach(async () => {
  await resetEmulators();
  admin = await createUser("admin@example.com", "admin");
  staff = await createUser("staff@example.com", "staff");
  await seedPool("lan", 7);
  await seedTicketType("lan-ticket", { poolId: "lan", isLanParty: true });
  await seedTicketType("lan-pack", { poolId: "lan", isLanParty: true, packSize: 5, capacity: 10 });
});

describe("selling from shared places", () => {
  it("takes one place per person, a pack one for each of its people", async () => {
    const res = await doorSale([item("lan-ticket"), ...people("lan-pack", 5)]);

    expect(res.status).toBe(200);
    expect(await placesTaken("lan")).toBe(6);
    expect(await soldCount("lan-pack")).toBe(1);
    expect((await getFirestore().collection("tickets").where("poolId", "==", "lan").get()).size).toBe(6);
  });

  it("refuses what would go over them, across both types, taking nothing", async () => {
    await doorSale(people("lan-ticket", 3));

    const res = await doorSale(people("lan-pack", 5));

    expect(res.status).toBe(409);
    expect(res.body).toBe("sold out: lan places has 4 places left, asked for 5");
    expect(await placesTaken("lan")).toBe(3);
    expect(await soldCount("lan-pack")).toBe(0);
  });

  it("sells the last place, and not one more", async () => {
    await seedPool("lan", 7, 6);

    expect((await doorSale([item("lan-ticket")])).status).toBe(200);
    expect((await doorSale([item("lan-ticket")])).status).toBe(409);
    expect(await placesTaken("lan")).toBe(7);
  });

  it("still applies the type's own capacity", async () => {
    await seedTicketType("lan-ticket", { poolId: "lan", capacity: 1 });

    const res = await doorSale(people("lan-ticket", 2));

    expect(res.status).toBe(409);
    expect(await placesTaken("lan")).toBe(0);
  });

  it("leaves types without shared places as they were", async () => {
    await seedTicketType("general", { capacity: 1 });

    expect((await doorSale([item("general")])).status).toBe(200);
    expect(await placesTaken("lan")).toBe(0);
  });

  it("counts a ticket an admin gives too", async () => {
    const user = await createUser("user@example.com");
    await seedPool("lan", 7, 7);

    const res = await apiFetch("POST", `/users/${user.uid}/tickets`, { token: admin.token, body: { typeId: "lan-ticket" } });

    expect(res.status).toBe(409);
    await seedPool("lan", 7, 6);
    expect((await apiFetch("POST", `/users/${user.uid}/tickets`, { token: admin.token, body: { typeId: "lan-ticket" } })).status)
      .toBe(200);
    expect(await placesTaken("lan")).toBe(7);
  });
});

describe("giving shared places back", () => {
  it("frees a place for each cancelled ticket, even one out of a pack", async () => {
    const sold = (await doorSale([item("lan-ticket"), ...people("lan-pack", 5)])).body as { id: string; typeId: string }[];
    const packTicket = sold.find((t) => t.typeId === "lan-pack")!;

    await cancel(sold[0].id);
    await cancel(packTicket.id);

    expect(await placesTaken("lan")).toBe(4);
    // The pack itself still holds its unit until its last ticket goes
    expect(await soldCount("lan-pack")).toBe(1);
  });

  it("frees nothing twice", async () => {
    const [ticket] = (await doorSale([item("lan-ticket")])).body;

    await cancel(ticket.id);
    await cancel(ticket.id);

    expect(await placesTaken("lan")).toBe(0);
  });
});

describe("what the shop sees", () => {
  it("counts the shared places in what remains, in whole packs", async () => {
    await doorSale(people("lan-ticket", 3));

    expect(await catalog()).toEqual({ "lan-ticket": 4, "lan-pack": 0 });
  });
});

describe("managing shared places", () => {
  const create = (body: Record<string, unknown>, token = admin.token) =>
    apiFetch("POST", "/capacity-pools", { token, body });

  it("creates them, lists them with their types, and logs it", async () => {
    const res = await create({ id: "fighting", name: "Fighting", capacity: 64 });
    await seedTicketType("fighting-ticket", { poolId: "fighting" });

    expect(res.status).toBe(201);
    const list = (await apiFetch("GET", "/capacity-pools", { token: admin.token })).body;
    expect(list.find((p: { id: string }) => p.id === "fighting")).toEqual({
      id: "fighting", name: "Fighting", capacity: 64, sold: 0, remaining: 64, typeIds: ["fighting-ticket"],
    });
    expect((await auditEntries("capacityPool.create"))[0]).toMatchObject({
      actorUid: admin.uid, targetId: "fighting", details: { name: "Fighting", capacity: 64 },
    });
  });

  it("refuses a taken id, or one that isn't lowercase", async () => {
    expect((await create({ id: "lan", name: "LAN", capacity: 1 })).status).toBe(409);
    expect((await create({ id: "LAN 2", name: "LAN", capacity: 1 })).status).toBe(400);
  });

  it("changes capacity, but never below the places taken", async () => {
    await seedPool("lan", 7, 5);

    expect((await apiFetch("PATCH", "/capacity-pools/lan", { token: admin.token, body: { capacity: 4 } })).status).toBe(409);
    const res = await apiFetch("PATCH", "/capacity-pools/lan", { token: admin.token, body: { capacity: 232 } });

    expect(res.body).toMatchObject({ capacity: 232, sold: 5, remaining: 227, typeIds: ["lan-pack", "lan-ticket"] });
    expect((await auditEntries("capacityPool.update"))[0].details).toEqual({ changes: { capacity: { from: 7, to: 232 } } });
  });

  it("deletes them only once no type sells from them and no places are taken", async () => {
    expect((await apiFetch("DELETE", "/capacity-pools/lan", { token: admin.token })).status).toBe(409);

    await seedTicketType("lan-ticket", {});
    await seedTicketType("lan-pack", {});
    await seedPool("lan", 7, 1);
    expect((await apiFetch("DELETE", "/capacity-pools/lan", { token: admin.token })).status).toBe(409);

    await seedPool("lan", 7, 0);
    expect((await apiFetch("DELETE", "/capacity-pools/lan", { token: admin.token })).status).toBe(200);
    expect((await auditEntries("capacityPool.delete"))).toHaveLength(1);
  });

  it("is for admins only, not even staff may look", async () => {
    const user = await createUser("user@example.com");

    expect((await apiFetch("GET", "/capacity-pools", { token: user.token })).status).toBe(403);
    expect((await apiFetch("GET", "/capacity-pools", { token: staff.token })).status).toBe(403);
    expect((await create({ id: "x", name: "X", capacity: 1 }, staff.token)).status).toBe(403);
    expect((await apiFetch("PATCH", "/capacity-pools/lan", { token: staff.token, body: { capacity: 9 } })).status).toBe(403);
    expect((await apiFetch("DELETE", "/capacity-pools/lan", { token: staff.token })).status).toBe(403);
  });
});

describe("pointing a type at shared places", () => {
  const edit = (id: string, body: Record<string, unknown>) =>
    apiFetch("PATCH", `/ticket-types/${id}`, { token: admin.token, body });

  it("sets and removes it before sales, refusing unknown ones", async () => {
    await seedTicketType("fighting-ticket");

    expect((await edit("fighting-ticket", { poolId: "nope" })).status).toBe(400);
    expect((await edit("fighting-ticket", { poolId: "lan" })).body).toMatchObject({ poolId: "lan", remaining: 7 });
    expect((await edit("fighting-ticket", { poolId: null })).body).toMatchObject({ poolId: null, remaining: null });
  });

  it("can't change it once the type has sold, since its tickets took places there", async () => {
    await doorSale([item("lan-ticket")]);

    const res = await edit("lan-ticket", { poolId: null });

    expect(res.status).toBe(409);
    expect(res.body).toBe("1 units were sold with the shared places lan, so that can't change");
  });
});
