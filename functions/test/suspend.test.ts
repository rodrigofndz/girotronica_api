import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  apiFetch, createUser, resetEmulators, seedTicketType, startApi, stopApi, type TestUser,
} from "./helpers";

const AUTH = `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1`;

const signIn = async (email: string) => {
  const res = await fetch(`${AUTH}/accounts:signInWithPassword?key=fake`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "secret123", returnSecureToken: true }),
  });
  return res.json() as Promise<{ idToken?: string; error?: { message: string } }>;
};

const suspend = (uid: string, actor: TestUser) =>
  apiFetch("POST", `/users/${uid}/suspend`, { token: actor.token });

const reactivate = (uid: string, actor: TestUser) =>
  apiFetch("DELETE", `/users/${uid}/suspend`, { token: actor.token });

const profile = async (uid: string) => (await getFirestore().doc(`users/${uid}`).get()).data()!;

let admin: TestUser;
let staff: TestUser;
let user: TestUser;

beforeAll(startApi);
afterAll(stopApi);

beforeEach(async () => {
  await resetEmulators();
  admin = await createUser("admin@example.com", "admin");
  staff = await createUser("staff@example.com", "staff");
  user = await createUser("user@example.com");
});

describe("suspending an account", () => {
  it("blocks the account's existing token on its very next request", async () => {
    expect((await suspend(user.uid, staff)).body).toMatchObject({ uid: user.uid, suspended: true });

    const res = await apiFetch("GET", "/me", { token: user.token });

    expect(res.status).toBe(403);
    expect(res.body).toBe("account suspended");
  });

  // In production the token itself stays valid until it expires; only the profile flag stops it
  it("blocks on the profile flag alone, as it must in production", async () => {
    await getFirestore().doc(`users/${user.uid}`).update({ suspended: true });

    const res = await apiFetch("GET", "/me", { token: user.token });

    expect(res.status).toBe(403);
    expect(res.body).toBe("account suspended");
  });

  it("disables sign-in in Firebase Auth", async () => {
    await suspend(user.uid, staff);

    expect((await getAuth().getUser(user.uid)).disabled).toBe(true);
    expect((await signIn("user@example.com")).error?.message).toBe("USER_DISABLED");
  });

  it("records who suspended it and when", async () => {
    await suspend(user.uid, staff);

    const stored = await profile(user.uid);
    expect(stored.suspendedBy).toBe(staff.uid);
    expect(stored.suspendedAt).toBeTruthy();
  });

  it("is harmless to repeat, keeping the original record", async () => {
    await suspend(user.uid, staff);

    const again = await suspend(user.uid, admin);

    expect(again.status).toBe(200);
    expect((await profile(user.uid)).suspendedBy).toBe(staff.uid);
  });

  it("leaves tickets already issued valid at the door", async () => {
    await seedTicketType("general", { days: [new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid" }).format(new Date())] });
    const ref = await getFirestore().collection("tickets").add({
      uid: user.uid, typeId: "general", status: "active", code: "kept-code",
      holderName: "User", holderEmail: "user@example.com", paymentMethod: "stripe",
      soldBy: null, purchasedAt: new Date(),
      days: [new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid" }).format(new Date())],
      isLanParty: false, checkins: {},
    });
    await suspend(user.uid, staff);

    const scan = await apiFetch("POST", "/tickets/checkin", { token: staff.token, body: { code: "kept-code" } });

    expect(scan.body.result).toBe("valid");
    expect((await ref.get()).data()!.status).toBe("active");
  });
});

describe("reactivating an account", () => {
  it("lets the person sign in and use the API again", async () => {
    await suspend(user.uid, staff);

    const res = await reactivate(user.uid, staff);
    const fresh = await signIn("user@example.com");

    expect(res.body).toMatchObject({ suspended: false });
    expect((await getAuth().getUser(user.uid)).disabled).toBe(false);
    expect((await apiFetch("GET", "/me", { token: fresh.idToken })).status).toBe(200);
  });

  it("clears the suspension record", async () => {
    await suspend(user.uid, staff);
    await reactivate(user.uid, staff);

    expect(await profile(user.uid)).toMatchObject({ suspended: false, suspendedAt: null, suspendedBy: null });
  });
});

describe("who may suspend whom", () => {
  it("lets only admins act on staff, in both directions", async () => {
    const colleague = await createUser("colleague@example.com", "staff");

    expect((await suspend(colleague.uid, staff)).status).toBe(403);
    expect((await suspend(colleague.uid, admin)).status).toBe(200);
    expect((await reactivate(colleague.uid, staff)).status).toBe(403);
    expect((await reactivate(colleague.uid, admin)).status).toBe(200);
  });

  it("never suspends an admin", async () => {
    const otherAdmin = await createUser("other.admin@example.com", "admin");

    expect((await suspend(otherAdmin.uid, admin)).status).toBe(409);
    expect((await profile(otherAdmin.uid)).suspended).toBeUndefined();
  });

  it("never lets someone suspend themselves", async () => {
    expect((await suspend(staff.uid, staff)).status).toBe(409);
  });

  it("is closed to plain users and to anonymous callers", async () => {
    const other = await createUser("other@example.com");

    expect((await suspend(other.uid, user)).status).toBe(403);
    expect((await apiFetch("POST", `/users/${other.uid}/suspend`)).status).toBe(401);
  });

  it("reports an unknown user", async () => {
    expect((await suspend("ghost", admin)).status).toBe(404);
  });
});

describe("the suspended flag in responses", () => {
  it("shows in the email lookup and the user list", async () => {
    await suspend(staff.uid, admin);

    const lookup = await apiFetch("GET", "/users/by-email?email=user@example.com", { token: admin.token });
    const list = await apiFetch("GET", "/users?role=staff", { token: admin.token });

    expect(lookup.body.suspended).toBe(false);
    expect(list.body.users.find((p: { uid: string }) => p.uid === staff.uid).suspended).toBe(true);
  });
});
