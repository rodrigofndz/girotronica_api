import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";

import { apiFetch, auditEntries, createUser, resetEmulators, startApi, stopApi, type TestUser } from "./helpers";

let user: TestUser;

const edit = (body: Record<string, unknown>, token = user.token) => apiFetch("PATCH", "/me", { token, body });
const AUTH = `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1`;

/** A fresh token, as the web gets after getIdToken(true) or signing in again. */
const freshToken = async (email = "anna@example.com") => {
  const res = await fetch(`${AUTH}/accounts:signInWithPassword?key=fake`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "secret123", returnSecureToken: true }),
  });
  return (await res.json()).idToken as string;
};

const profile = async () => (await getFirestore().doc(`users/${user.uid}`).get()).data()!;
const stored = async () => (await getFirestore().doc(`users/${user.uid}`).get()).data()!.birthDate;

beforeAll(startApi);
afterAll(stopApi);

beforeEach(async () => {
  await resetEmulators();
  user = await createUser("anna@example.com", "user", "Anna");
});

describe("the birth date in the profile", () => {
  it("is optional: a new profile has none", async () => {
    expect((await apiFetch("GET", "/me", { token: user.token })).body).toEqual({
      uid: user.uid, email: "anna@example.com", displayName: "Anna", role: "user", birthDate: null,
    });
  });

  it("can be added, changed and removed", async () => {
    expect((await edit({ birthDate: "1990-05-10" })).body).toMatchObject({ birthDate: "1990-05-10" });
    expect((await apiFetch("GET", "/me", { token: user.token })).body.birthDate).toBe("1990-05-10");

    await edit({ birthDate: "1991-06-11" });
    expect(await stored()).toBe("1991-06-11");

    expect((await edit({ birthDate: null })).body.birthDate).toBeNull();
    expect(await stored()).toBeNull();
  });

  it("logs who changed which field, but not the date", async () => {
    await edit({ birthDate: "1990-05-10" });
    await edit({ birthDate: "1990-05-10" });

    const entries = await auditEntries("user.profileUpdate");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ actorUid: user.uid, targetId: user.uid, details: { fields: ["birthDate"] } });
    expect(JSON.stringify(entries[0])).not.toContain("1990");
  });

  it("changes nothing when it isn't sent", async () => {
    await edit({ birthDate: "1990-05-10" });

    expect((await edit({})).body.birthDate).toBe("1990-05-10");
  });

  it("refuses a date in the future, one not written YYYY-MM-DD, or other fields", async () => {
    expect((await edit({ birthDate: "2999-01-01" })).status).toBe(400);
    expect((await edit({ birthDate: "10/05/1990" })).status).toBe(400);
    expect((await edit({ role: "admin" })).status).toBe(400);
    expect(await stored()).toBeUndefined();
  });

  it("only changes the caller's own, and needs a token", async () => {
    const biel = await createUser("biel@example.com");
    await edit({ birthDate: "1990-05-10" }, biel.token);

    expect(await stored()).toBeUndefined();
    expect((await apiFetch("PATCH", "/me", { body: { birthDate: "1990-05-10" } })).status).toBe(401);
  });

  it("isn't shown to admins in the user list", async () => {
    const admin = await createUser("admin@example.com", "admin");
    await edit({ birthDate: "1990-05-10" });

    const res = await apiFetch("GET", "/users", { token: admin.token });

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain("1990-05-10");
  });
});

describe("the name in the profile", () => {
  it("changes it in the profile and on the sign-in account, and logs it", async () => {
    const res = await edit({ displayName: "  Anna Puig " });

    expect(res.body).toMatchObject({ displayName: "Anna Puig", birthDate: null });
    expect(await profile()).toMatchObject({ displayName: "Anna Puig", authName: "Anna Puig" });
    expect((await getAuth().getUser(user.uid)).displayName).toBe("Anna Puig");
    expect((await auditEntries("user.profileUpdate"))[0].details).toEqual({ fields: ["displayName"] });
    expect((await apiFetch("GET", "/me", { token: await freshToken() })).body.displayName).toBe("Anna Puig");
  });

  it("changes nothing, not even the account, when it's the same name", async () => {
    await getAuth().updateUser(user.uid, { displayName: "Changed elsewhere" });

    await edit({ displayName: "Anna" });

    expect((await getAuth().getUser(user.uid)).displayName).toBe("Changed elsewhere");
    expect((await profile()).nameSetAt).toBeUndefined();
    expect(await auditEntries("user.profileUpdate")).toHaveLength(0);
  });

  it("changes the name and the birth date in one go", async () => {
    const res = await edit({ displayName: "Anna Puig", birthDate: "1990-05-10" });

    expect(res.body).toMatchObject({ displayName: "Anna Puig", birthDate: "1990-05-10" });
    expect((await auditEntries("user.profileUpdate"))[0].details).toEqual({ fields: ["displayName", "birthDate"] });
  });

  it("keeps it when a token from before the change still carries the old name", async () => {
    await edit({ displayName: "Anna Puig" });

    // user.token was issued before the change, with "Anna"
    expect((await apiFetch("GET", "/me", { token: user.token })).body.displayName).toBe("Anna Puig");
    expect((await profile()).displayName).toBe("Anna Puig");
  });

  it("still follows a later change at the sign-in provider", async () => {
    await edit({ displayName: "Anna Puig" });
    await new Promise((resolve) => setTimeout(resolve, 1100)); // tokens are timed in whole seconds
    await getAuth().updateUser(user.uid, { displayName: "Anna P." });

    expect((await apiFetch("GET", "/me", { token: await freshToken() })).body.displayName).toBe("Anna P.");
  });

  it("refuses an empty name", async () => {
    expect((await edit({ displayName: "   " })).status).toBe(400);
    expect((await profile()).displayName).toBe("Anna");
  });
});
