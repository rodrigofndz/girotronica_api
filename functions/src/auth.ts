import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";

export type User = { uid: string; email?: string; role: string };
export type Env = { Variables: { user: User } };

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

  const snap = await getFirestore().doc(`users/${decoded.uid}`).get();

  c.set("user", {
    uid: decoded.uid,
    email: decoded.email,
    role: snap.data()?.role ?? "user",
  });

  await next();
});

export const requireRole = (...roles: string[]) =>
  createMiddleware<Env>(async (c, next) => {
    if (!roles.includes(c.get("user").role)) {
      throw new HTTPException(403, { message: "insufficient role" });
    }
    await next();
  });