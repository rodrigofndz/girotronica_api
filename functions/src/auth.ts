import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";

import { normalizeEmail } from "./schemas";
import type { Role, UserProfile, UserProfileWrite } from "./types";

export type User = { uid: string; email?: string; role: Role };
export type Env = { Variables: { user: User } };

const ALREADY_EXISTS = 6;

export const requireAuth = createMiddleware<Env>(async (c, next) => {
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer ")) {
    throw new HTTPException(401, { message: "missing bearer token" });
  }

  let decoded;
  try {
    decoded = await getAuth().verifyIdToken(header.slice(7));
  } catch {
    throw new HTTPException(401, { message: "invalid token" });
  }

  const ref = getFirestore().doc(`users/${decoded.uid}`);
  const snap = await ref.get();
  const profile = snap.data() as UserProfile | undefined;

  const email = decoded.email ? normalizeEmail(decoded.email) : null;
  const displayName: string | null = decoded.name ?? null;

  if (!profile) {
    // A concurrent first request may have created it already; that one wins
    await ref
      .create({
        role: "user",
        email,
        displayName,
        createdAt: FieldValue.serverTimestamp(),
      } satisfies UserProfileWrite)
      .catch((err) => {
        if (err.code !== ALREADY_EXISTS) throw err;
      });
  } else if (profile.email !== email || profile.displayName !== displayName) {
    await ref.update({ email, displayName } satisfies Partial<UserProfileWrite>);
  }

  c.set("user", {
    uid: decoded.uid,
    email: email ?? undefined,
    role: profile?.role ?? "user",
  });

  await next();
});

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
