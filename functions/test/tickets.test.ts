import { getFirestore } from "firebase-admin/firestore";
import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  apiFetch, createUser, fetchQr, mailDocs, resetEmulators, seedTicketType, soldCount, startApi,
  stopApi, ticketStatus, type TestUser,
} from "./helpers";

let staff: TestUser;
let admin: TestUser;
let attendee: TestUser;

const doorSale = (items: unknown[], token = staff.token) =>
  apiFetch("POST", "/tickets/door", { token, body: { paymentMethod: "cash", items } });

const oneItem = (overrides = {}) => ({
  typeId: "general", holderName: "Holder", holderEmail: "holder@example.com", ...overrides,
});

beforeAll(startApi);
afterAll(stopApi);

beforeEach(async () => {
  await resetEmulators();
  staff = await createUser("staff@example.com", "staff");
  admin = await createUser("admin@example.com", "admin");
  attendee = await createUser("attendee@example.com");
  await seedTicketType("general", { capacity: 10, days: ["2026-11-20", "2026-11-21"] });
});

describe("door sales", () => {
  it("creates active tickets with the code staff needs", async () => {
    const res = await doorSale([oneItem()]);

    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({ typeId: "general", holderName: "Holder" });
    expect(res.body[0].code).toBeTruthy();
    expect(await ticketStatus(res.body[0].id)).toBe("active");
  });

  it("records who sold it and how it was paid, for the till", async () => {
    const res = await doorSale([oneItem()]);

    const stored = (await getFirestore().doc(`tickets/${res.body[0].id}`).get()).data()!;
    expect(stored).toMatchObject({ soldBy: staff.uid, paymentMethod: "cash", uid: null });
  });

  it("copies the days and LAN flag from the type", async () => {
    await seedTicketType("lan", { isLanParty: true, days: ["2026-11-20"] });

    const res = await doorSale([oneItem({ typeId: "lan" })]);

    const stored = (await getFirestore().doc(`tickets/${res.body[0].id}`).get()).data()!;
    expect(stored).toMatchObject({ isLanParty: true, days: ["2026-11-20"] });
  });

  it("rejects an unpayable method and an invalid holder email", async () => {
    const byCard = await apiFetch("POST", "/tickets/door", {
      token: staff.token,
      body: { paymentMethod: "stripe", items: [oneItem()] },
    });
    const badEmail = await doorSale([oneItem({ holderEmail: "nope" })]);

    expect(byCard.status).toBe(400);
    expect(badEmail.status).toBe(400);
  });

  it("is closed to attendees", async () => {
    expect((await doorSale([oneItem()], attendee.token)).status).toBe(403);
  });
});

describe("ticket emails", () => {
  it("sends one email per holder with every ticket attached", async () => {
    await doorSale([
      oneItem({ holderName: "A", holderEmail: "shared@example.com" }),
      oneItem({ holderName: "B", holderEmail: "shared@example.com" }),
      oneItem({ holderName: "C", holderEmail: "other@example.com" }),
    ]);

    const mail = await mailDocs();
    const shared = mail.find((m) => m.to[0] === "shared@example.com");

    expect(mail).toHaveLength(2);
    expect(shared.message.attachments).toHaveLength(2);
    expect(shared.message.attachments[0]).toMatchObject({ contentType: "image/png", encoding: "base64" });
  });

  it("shows the holder's name as text, never as markup", async () => {
    await doorSale([oneItem({ holderName: `<a href="https://evil.example">Claim refund</a>` })]);

    const [mail] = await mailDocs();

    expect(mail.message.html).not.toContain("<a ");
    expect(mail.message.html).toContain("&#60;a href=&#34;https://evil.example&#34;&#62;Claim refund");
  });

  it("still sells the ticket if the email cannot be queued", async () => {
    // A ticket must never be lost because mail failed, so the sale result is what matters here
    const res = await doorSale([oneItem()]);

    expect(res.status).toBe(200);
    expect(await ticketStatus(res.body[0].id)).toBe("active");
  });
});

describe("own tickets", () => {
  it("lists only the caller's active tickets", async () => {
    const db = getFirestore();
    const mine = await db.collection("tickets").add({
      uid: attendee.uid, typeId: "general", status: "active", code: "mine",
      holderName: "Me", holderEmail: "attendee@example.com", paymentMethod: "stripe",
      soldBy: null, purchasedAt: new Date(), days: ["2026-11-20"], isLanParty: false, checkins: {},
    });
    await db.collection("tickets").add({
      uid: attendee.uid, typeId: "general", status: "pending", code: "unpaid",
      holderName: "Me", holderEmail: "attendee@example.com", paymentMethod: "stripe",
      soldBy: null, purchasedAt: new Date(), days: ["2026-11-20"], isLanParty: false, checkins: {},
    });
    await doorSale([oneItem()]); // someone else's ticket

    const res = await apiFetch("GET", "/tickets", { token: attendee.token });

    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(mine.id);
  });

  it("never exposes internal fields", async () => {
    await getFirestore().collection("tickets").add({
      uid: attendee.uid, typeId: "general", status: "active", code: "mine",
      holderName: "Me", holderEmail: "attendee@example.com", paymentMethod: "stripe",
      soldBy: "someone", purchasedAt: new Date(), days: ["2026-11-20"], isLanParty: false, checkins: {},
    });

    const res = await apiFetch("GET", "/tickets", { token: attendee.token });

    expect(Object.keys(res.body[0]).sort()).toEqual(
      ["checkins", "code", "days", "holderName", "id", "typeId"],
    );
  });
});

describe("finding tickets by holder email", () => {
  it("returns paid and unpaid tickets with their codes", async () => {
    await doorSale([oneItem({ holderEmail: "buyer@example.com" })]);
    await getFirestore().collection("tickets").add({
      uid: null, typeId: "general", status: "pending", code: "unpaid-1",
      holderName: "Buyer", holderEmail: "buyer@example.com", paymentMethod: "stripe",
      soldBy: null, purchasedAt: new Date(), days: ["2026-11-20"], isLanParty: false, checkins: {},
    });

    const res = await apiFetch("GET", "/tickets/by-email?email=buyer@example.com", { token: staff.token });

    expect(res.body.map((t: { status: string }) => t.status).sort()).toEqual(["active", "pending"]);
    expect(res.body.every((t: { code: string }) => t.code)).toBe(true);
  });

  it("returns an empty list rather than an error", async () => {
    const res = await apiFetch("GET", "/tickets/by-email?email=nobody@example.com", { token: staff.token });

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("is closed to attendees", async () => {
    const res = await apiFetch("GET", "/tickets/by-email?email=a@example.com", { token: attendee.token });

    expect(res.status).toBe(403);
  });
});

describe("ticket QR", () => {
  it("gives the owner a png of their own ticket", async () => {
    const ref = await getFirestore().collection("tickets").add({
      uid: attendee.uid, typeId: "general", status: "active", code: "owner-code",
      holderName: "Me", holderEmail: "attendee@example.com", paymentMethod: "stripe",
      soldBy: null, purchasedAt: new Date(), days: ["2026-11-20"], isLanParty: false, checkins: {},
    });

    const res = await fetchQr(ref.id, attendee.token);

    expect(res.status).toBe(200);
    expect(res.contentType).toBe("image/png");
    expect(res.isPng).toBe(true);
  });

  it("refuses someone else's ticket but allows staff", async () => {
    const sale = await doorSale([oneItem()]);
    const other = await createUser("other@example.com");

    expect((await fetchQr(sale.body[0].id, other.token)).status).toBe(403);
    expect((await fetchQr(sale.body[0].id, staff.token)).status).toBe(200);
  });

  it("reports an unknown ticket", async () => {
    expect((await fetchQr("ghost", staff.token)).status).toBe(404);
  });
});

describe("cancelling", () => {
  it("voids the ticket and frees the slot, only once", async () => {
    const sale = await doorSale([oneItem()]);
    const id = sale.body[0].id;

    const first = await apiFetch("POST", `/tickets/${id}/cancel`, { token: admin.token });
    const second = await apiFetch("POST", `/tickets/${id}/cancel`, { token: admin.token });

    expect(first.body.changed).toBe(true);
    expect(second.body.changed).toBe(false);
    expect(await ticketStatus(id)).toBe("cancelled");
    expect(await soldCount("general")).toBe(0);
  });

  it("is closed to staff", async () => {
    const sale = await doorSale([oneItem()]);

    expect((await apiFetch("POST", `/tickets/${sale.body[0].id}/cancel`, { token: staff.token })).status)
      .toBe(403);
  });

  it("reports an unknown ticket", async () => {
    expect((await apiFetch("POST", "/tickets/ghost/cancel", { token: admin.token })).status).toBe(404);
  });
});

describe("LAN party members", () => {
  it("lists only active LAN party tickets, with holder details", async () => {
    await seedTicketType("lan", { isLanParty: true, capacity: 10 });
    await doorSale([oneItem({ typeId: "lan", holderName: "Gamer", holderEmail: "gamer@example.com" })]);
    await doorSale([oneItem()]); // a normal ticket, not a member
    await getFirestore().collection("tickets").add({
      uid: null, typeId: "lan", status: "pending", code: "unpaid-lan",
      holderName: "Unpaid", holderEmail: "unpaid@example.com", paymentMethod: "stripe",
      soldBy: null, purchasedAt: new Date(), days: ["2026-11-20"], isLanParty: true, checkins: {},
    });

    const res = await apiFetch("GET", "/users/lan-party", { token: staff.token });

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ holderName: "Gamer", holderEmail: "gamer@example.com" });
  });

  it("is closed to attendees", async () => {
    expect((await apiFetch("GET", "/users/lan-party", { token: attendee.token })).status).toBe(403);
  });
});

describe("email matching", () => {
  it("stores holder emails in one form and finds them whatever the case", async () => {
    const sale = await doorSale([oneItem({ holderEmail: "  Joan.Pujol@Example.COM " })]);

    const stored = (await getFirestore().doc(`tickets/${sale.body[0].id}`).get()).data()!;
    expect(stored.holderEmail).toBe("joan.pujol@example.com");

    const found = await apiFetch("GET", "/tickets/by-email?email=JOAN.PUJOL@example.com", {
      token: staff.token,
    });
    expect(found.body).toHaveLength(1);
  });

  it("still rejects something that is not an email", async () => {
    expect((await doorSale([oneItem({ holderEmail: "  not an email  " })])).status).toBe(400);
  });
});
