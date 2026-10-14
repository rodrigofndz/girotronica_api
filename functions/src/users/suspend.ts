import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { HTTPException } from "hono/http-exception";

import { audit, auditedAs } from "../audit/audit";
import { requireStaff, type Env, type User } from "../auth";
import { bearerAuth, profileResponse, UserProfileSchema } from "../schemas";
import { cancelInTransaction } from "../tickets/cancel";
import type { UserProfile, UserProfileWrite } from "../types";

export const suspension = new OpenAPIHono<Env>();

const params = z.object({
  uid: z.string().min(1).openapi({ param: { name: "uid", in: "path" } }),
});

const responses = {
  200: {
    description: "Updated user profile",
    content: {
      "application/json": {
        schema: UserProfileSchema.extend({
          cancelledTickets: z.int().nonnegative().openapi({
            description: "Tickets cancelled by this call; 0 when reactivating or already suspended",
          }),
        }),
      },
    },
  },
  403: { description: "Plain users can't do this, and only admins can act on staff" },
  404: { description: "User not found" },
  409: { description: "Target is an admin, or is yourself" },
} as const;

/**
 * Every ticket that isn't cancelled yet and is linked to the account (bought while signed in,
 * friends' tickets in the same order included, or assigned to it) or held in its email
 * (bought as a guest, by them or for them). Reads only, so it can go first in a transaction.
 */
async function ticketsOfAccount(tx: FirebaseFirestore.Transaction, uid: string, email: string | null) {
  const tickets = getFirestore().collection("tickets");
  const [linked, held] = await Promise.all([
    tx.get(tickets.where("uid", "==", uid)),
    email ? tx.get(tickets.where("holderEmail", "==", email)) : null,
  ]);
  const byId = new Map([...linked.docs, ...(held?.docs ?? [])].map((doc) => [doc.id, doc]));
  return [...byId.values()];
}

/**
 * Staff can suspend plain users, only admins can suspend staff, nobody can suspend an admin
 * or themselves; reactivating follows the same rules. Suspending cancels the account's
 * tickets (see ticketsOfAccount), freeing their places; reactivating doesn't bring them back.
 */
async function setSuspended(actor: User, uid: string, suspended: boolean) {
  if (actor.uid === uid) {
    throw new HTTPException(409, { message: "you cannot change your own suspension" });
  }

  const db = getFirestore();
  const ref = db.doc(`users/${uid}`);

  const outcome = await db.runTransaction(async (tx) => {
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

    let cancelledTickets = 0;
    if ((current.suspended ?? false) !== suspended) {
      // Reads first: a transaction can't read after it writes
      const cancelled = suspended
        ? await cancelInTransaction(tx, await ticketsOfAccount(tx, uid, current.email))
        : [];
      cancelledTickets = cancelled.length;
      for (const { id, ticket } of cancelled) {
        audit(tx, {
          actor,
          action: "ticket.cancelOnSuspend",
          target: { id, label: ticket.holderName },
          details: { uid, previousStatus: ticket.status },
        });
      }

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
        details: suspended ? { cancelledTickets } : {},
      });
    }
    return { profile: { ...current, suspended }, cancelledTickets };
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

  return { ...profileResponse(uid, outcome.profile), cancelledTickets: outcome.cancelledTickets };
}

suspension.openapi(
  createRoute({
    method: "post",
    path: "/{uid}/suspend",
    tags: ["Users"],
    summary: "Suspend an account",
    description:
      "Staff or admin. Blocks the account from the API immediately and disables its sign-in, " +
      "and cancels every ticket linked to the account or held in its email, paid or not, " +
      "including friends' tickets bought in the same order; their places go back on sale. " +
      "Nothing is refunded: refund paid ones in Stripe by hand. Reactivating doesn't restore them.",
    security: bearerAuth,
    ...auditedAs("user.suspend", "ticket.cancelOnSuspend"),
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
