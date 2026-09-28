import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { HTTPException } from "hono/http-exception";

import { audit, auditedAs } from "../audit/audit";
import { requireStaff, type Env, type User } from "../auth";
import { bearerAuth, profileResponse, UserProfileSchema } from "../schemas";
import type { UserProfile, UserProfileWrite } from "../types";

export const suspension = new OpenAPIHono<Env>();

const params = z.object({
  uid: z.string().min(1).openapi({ param: { name: "uid", in: "path" } }),
});

const responses = {
  200: {
    description: "Updated user profile",
    content: { "application/json": { schema: UserProfileSchema } },
  },
  403: { description: "Plain users can't do this, and only admins can act on staff" },
  404: { description: "User not found" },
  409: { description: "Target is an admin, or is yourself" },
} as const;

/**
 * Staff can suspend plain users, only admins can suspend staff, nobody can suspend an admin
 * or themselves; reactivating follows the same rules. Tickets already issued stay valid.
 */
async function setSuspended(actor: User, uid: string, suspended: boolean) {
  if (actor.uid === uid) {
    throw new HTTPException(409, { message: "you cannot change your own suspension" });
  }

  const db = getFirestore();
  const ref = db.doc(`users/${uid}`);

  const profile = await db.runTransaction(async (tx) => {
    const current = (await tx.get(ref)).data() as UserProfile | undefined;

    if (!current) {
      throw new HTTPException(404, { message: "user not found" });
    }
    if (current.role === "admin") {
      throw new HTTPException(409, { message: "admins cannot be suspended" });
    }
    if (current.role === "staff" && actor.role !== "admin") {
      throw new HTTPException(403, { message: "only admins can suspend or reactivate staff" });
    }

    if ((current.suspended ?? false) !== suspended) {
      tx.update(
        ref,
        (suspended
          ? { suspended: true, suspendedAt: FieldValue.serverTimestamp(), suspendedBy: actor.uid }
          : { suspended: false, suspendedAt: null, suspendedBy: null }) satisfies Partial<UserProfileWrite>,
      );
      audit(tx, {
        actor,
        action: suspended ? "user.suspend" : "user.reactivate",
        target: { id: uid, label: current.email },
        details: {},
      });
    }
    return { ...current, suspended };
  });

  // The profile flag already blocks the API; this also stops new sign-ins and ends open
  // sessions. It isn't Firestore so it can't join the transaction, but it is idempotent,
  // so if it fails the whole request is safe to retry.
  try {
    await getAuth().updateUser(uid, { disabled: suspended });
    if (suspended) {
      await getAuth().revokeRefreshTokens(uid);
    }
  } catch (err) {
    // A profile whose sign-in account was deleted is still blocked by the flag
    if ((err as { code?: string }).code !== "auth/user-not-found") throw err;
  }

  return profileResponse(uid, profile);
}

suspension.openapi(
  createRoute({
    method: "post",
    path: "/{uid}/suspend",
    tags: ["Users"],
    summary: "Suspend an account",
    description:
      "Staff or admin. Blocks the account from the API immediately and disables its sign-in. " +
      "Tickets already issued stay valid unless an admin cancels them.",
    security: bearerAuth,
    ...auditedAs("user.suspend"),
    middleware: [requireStaff] as const,
    request: { params },
    responses,
  }),
  async (c) => c.json(await setSuspended(c.get("user"), c.req.valid("param").uid, true), 200),
);

suspension.openapi(
  createRoute({
    method: "delete",
    path: "/{uid}/suspend",
    tags: ["Users"],
    summary: "Reactivate a suspended account",
    description: "Staff or admin, with the same rules as suspending.",
    security: bearerAuth,
    ...auditedAs("user.reactivate"),
    middleware: [requireStaff] as const,
    request: { params },
    responses,
  }),
  async (c) => c.json(await setSuspended(c.get("user"), c.req.valid("param").uid, false), 200),
);
