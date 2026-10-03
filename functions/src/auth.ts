import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";

import { normalizeEmail } from "./schemas";
import type { Role, UserProfile, UserProfileWrite } from "./types";

export type User = { uid: string; email?: string; displayName: string | null; role: Role };
export type Env = { Variables: { user: User } };

const ALREADY_EXISTS = 6;

/** For routes open to guests: a signed-in caller is optional, and `user` is unset without one. */
export type GuestEnv = { Variables: { user?: User } };

export const requireAuth = createMiddleware<Env>(async (c, next) => {
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer ")) {
    throw new HTTPException(401, { message: "missing bearer token" });
  }
  c.set("user", await authenticate(header));
  await next();
});

/**
 * Signs the caller in when they send a token, exactly as requireAuth does (a bad token is
 * still a 401 and a suspended account a 403), and lets them through as a guest when they don't.
 */
export const optionalAuth = createMiddleware<GuestEnv>(async (c, next) => {
  const header = c.req.header("Authorization");
  if (header !== undefined) {
    if (!header.startsWith("Bearer ")) {
      throw new HTTPException(401, { message: "malformed authorization header" });
    }
    c.set("user", await authenticate(header));
  }
  await next();
});

async function authenticate(header: string): Promise<User> {

  let decoded;
  try {
    decoded = await getAuth().verifyIdToken(header.slice(7));
  } catch (err) {
    // Only raised where the token is checked against the account (the emulator does this);
    // answered like the profile check below so a suspension looks the same everywhere
    if ((err as { code?: string }).code === "auth/user-disabled") {
      throw new HTTPException(403, { message: "account suspended" });
    }
    throw new HTTPException(401, { message: "invalid token" });
  }

  const ref = getFirestore().doc(`users/${decoded.uid}`);
  const snap = await ref.get();
  const profile = snap.data() as UserProfile | undefined;

  // Checked on every request, so a suspension bites immediately rather than when the token expires
  if (profile?.suspended) {
    throw new HTTPException(403, { message: "account suspended" });
  }

  const email = decoded.email ? normalizeEmail(decoded.email) : null;
  const authName: string | null = decoded.name ?? null;
  let displayName = profile?.displayName ?? authName;

  if (!profile) {
    // A concurrent first request may have created it already; that one wins
    await ref
      .create({
        role: "user",
        email,
        displayName: authName,
        authName,
        createdAt: FieldValue.serverTimestamp(),
      } satisfies UserProfileWrite)
      .catch((err) => {
        if (err.code !== ALREADY_EXISTS) throw err;
      });
  } else {
    const updates: Partial<UserProfileWrite> = {};
    if (profile.email !== email) updates.email = email;

    if (profile.authName === undefined) {
      // A profile from before authName: start tracking, and only fill an empty name
      updates.authName = authName;
      if (!profile.displayName && authName) updates.displayName = displayName = authName;
    } else if (authName && authName !== profile.authName) {
      // The name changed at the sign-in provider (e.g. in Google), so follow it
      updates.authName = authName;
      updates.displayName = displayName = authName;
    }

    if (Object.keys(updates).length > 0) {
      await ref.update(updates);
    }
  }

  return {
    uid: decoded.uid,
    email: email ?? undefined,
    displayName: displayName ?? null,
    role: profile?.role ?? "user",
  };
}

const requireRole = (...roles: Role[]) =>
  createMiddleware<Env>(async (c, next) => {
    if (!roles.includes(c.get("user").role)) {
      throw new HTTPException(403, { message: "insufficient role" });
    }
    await next();
  });

/** Door and back-office operations: admins can do everything staff can. */
export const requireStaff = requireRole("staff", "admin");

export const requireAdmin = requireRole("admin");
