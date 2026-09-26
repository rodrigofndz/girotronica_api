import { getFirestore } from "firebase-admin/firestore";
import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";

import { apiFetch, createUser, resetEmulators, startApi, stopApi, type TestUser } from "./helpers";

const AUTH = `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1`;

const signIn = async (email: string) => {
  const res = await fetch(`${AUTH}/accounts:signInWithPassword?key=fake`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "secret123", returnSecureToken: true }),
  });
  return (await res.json()).idToken as string;
};

const profile = async (uid: string) => (await getFirestore().doc(`users/${uid}`).get()).data();

let admin: TestUser;

beforeAll(startApi);
afterAll(stopApi);

beforeEach(async () => {
  await resetEmulators();
  admin = await createUser("admin@example.com", "admin");
});

describe("authentication", () => {
  it("rejects a request with no token", async () => {
    expect((await apiFetch("GET", "/me")).status).toBe(401);
  });

  it("rejects a malformed token", async () => {
    expect((await apiFetch("GET", "/me", { token: "not-a-token" })).status).toBe(401);
  });

  it("creates the profile on the first authenticated request", async () => {
    const user = await createUser("newcomer@example.com");

    expect(await profile(user.uid)).toMatchObject({
      role: "user",
      email: "newcomer@example.com",
      displayName: null,
    });
  });

  it("keeps one profile when first requests arrive together", async () => {
    const res = await fetch(`${AUTH}/accounts:signUp?key=fake`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "racer@example.com", password: "secret123", returnSecureToken: true }),
    });
    const account = await res.json();

    const calls = await Promise.all(
      Array.from({ length: 5 }, () => apiFetch("GET", "/me", { token: account.idToken })),
    );

    expect(calls.every((r) => r.status === 200)).toBe(true);
    const users = await getFirestore().collection("users").where("email", "==", "racer@example.com").get();
    expect(users.size).toBe(1);
  });

  it("never downgrades a role when the profile is refreshed", async () => {
    const staff = await createUser("staff@example.com", "staff");

    await apiFetch("GET", "/me", { token: staff.token });

    expect((await profile(staff.uid))!.role).toBe("staff");
  });

  it("updates the display name when it changes in the token", async () => {
    const user = await createUser("renamed@example.com");
    await fetch(`${AUTH}/accounts:update?key=fake`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken: user.token, displayName: "New Name" }),
    });

    await apiFetch("GET", "/me", { token: await signIn("renamed@example.com") });

    expect((await profile(user.uid))!.displayName).toBe("New Name");
  });
});

describe("role management", () => {
  it("promotes and demotes a user, taking effect on their next request", async () => {
    const user = await createUser("target@example.com");

    const promoted = await apiFetch("POST", `/users/${user.uid}/staff`, { token: admin.token });
    expect(promoted.body.role).toBe("staff");
    expect((await apiFetch("GET", "/me", { token: user.token })).body.role).toBe("staff");

    await apiFetch("DELETE", `/users/${user.uid}/staff`, { token: admin.token });
    expect((await apiFetch("GET", "/me", { token: user.token })).body.role).toBe("user");
  });

  it("is harmless to promote someone twice", async () => {
    const user = await createUser("target@example.com");
    await apiFetch("POST", `/users/${user.uid}/staff`, { token: admin.token });

    const again = await apiFetch("POST", `/users/${user.uid}/staff`, { token: admin.token });

    expect(again.status).toBe(200);
    expect(again.body.role).toBe("staff");
  });

  it("refuses to change an admin's role", async () => {
    const res = await apiFetch("DELETE", `/users/${admin.uid}/staff`, { token: admin.token });

    expect(res.status).toBe(409);
    expect((await profile(admin.uid))!.role).toBe("admin");
  });

  it("is closed to staff and to plain users", async () => {
    const staff = await createUser("staff@example.com", "staff");
    const plain = await createUser("plain@example.com");
    const target = await createUser("target@example.com");

    expect((await apiFetch("POST", `/users/${target.uid}/staff`, { token: staff.token })).status).toBe(403);
    expect((await apiFetch("POST", `/users/${target.uid}/staff`, { token: plain.token })).status).toBe(403);
  });

  it("reports an unknown user", async () => {
    expect((await apiFetch("POST", "/users/ghost/staff", { token: admin.token })).status).toBe(404);
  });
});

describe("user lookup", () => {
  it("finds a user by email for staff", async () => {
    const staff = await createUser("staff@example.com", "staff");
    const target = await createUser("target@example.com");

    const res = await apiFetch("GET", "/users/by-email?email=target@example.com", { token: staff.token });

    expect(res.status).toBe(200);
    expect(res.body.uid).toBe(target.uid);
  });

  it("finds a user whatever the case of the email typed", async () => {
    const staff = await createUser("staff@example.com", "staff");
    const target = await createUser("Mixed.Case@Example.com");

    const res = await apiFetch("GET", "/users/by-email?email=MIXED.CASE@example.COM", {
      token: staff.token,
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ uid: target.uid, email: "mixed.case@example.com" });
  });

  it("reports an unknown email", async () => {
    const staff = await createUser("staff@example.com", "staff");

    expect((await apiFetch("GET", "/users/by-email?email=nobody@example.com", { token: staff.token })).status)
      .toBe(404);
  });

  it("rejects a malformed or missing email", async () => {
    const staff = await createUser("staff@example.com", "staff");

    expect((await apiFetch("GET", "/users/by-email?email=nope", { token: staff.token })).status).toBe(400);
    expect((await apiFetch("GET", "/users/by-email", { token: staff.token })).status).toBe(400);
  });

  it("is closed to plain users", async () => {
    const plain = await createUser("plain@example.com");

    expect((await apiFetch("GET", "/users/by-email?email=a@example.com", { token: plain.token })).status)
      .toBe(403);
  });
});
