import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { HTTPException } from "hono/http-exception";

import { audit, auditedAs } from "../audit/audit";
import type { Env } from "../auth";
import { bearerAuth, BirthDateSchema } from "../schemas";
import { ROLES, type UserProfile, type UserProfileWrite } from "../types";

export const me = new OpenAPIHono<Env>();

const MeSchema = z.object({
  uid: z.string(),
  email: z.string().optional(),
  displayName: z.string().nullable(),
  role: z.enum(ROLES),
  birthDate: z.string().nullable().openapi({ description: "YYYY-MM-DD; null when not given. Optional, never required" }),
});

const MePatchSchema = z.object({
  displayName: z.string().trim().min(1).max(100).optional().openapi({
    description: "The name shown to others; also set on the sign-in account",
  }),
  birthDate: BirthDateSchema.nullable().optional().openapi({ description: "YYYY-MM-DD, or null to remove it" }),
}).strict();

const profileOf = async (uid: string) =>
  (await getFirestore().doc(`users/${uid}`).get()).data() as UserProfile | undefined;

me.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["Users"],
    summary: "Get the caller's identity, role and profile",
    security: bearerAuth,
    responses: {
      200: { description: "The authenticated user", content: { "application/json": { schema: MeSchema } } },
      401: { description: "Missing or invalid token" },
    },
  }),
  async (c) => {
    const user = c.get("user");
    return c.json({ ...user, birthDate: (await profileOf(user.uid))?.birthDate ?? null }, 200);
  },
);

me.openapi(
  createRoute({
    method: "patch",
    path: "/",
    tags: ["Users"],
    summary: "Edit the caller's profile",
    description:
      "Only what's sent changes, and only when it differs from what's stored. The name is also " +
      "set on the sign-in account, so refresh the ID token afterwards (getIdToken(true)) to " +
      "carry it. The birth date is optional: set it after signing up (with email and password " +
      "or Google), change it, or remove it with null.",
    security: bearerAuth,
    ...auditedAs("user.profileUpdate"),
    request: {
      body: { required: true, content: { "application/json": { schema: MePatchSchema } } },
    },
    responses: {
      200: { description: "The updated profile", content: { "application/json": { schema: MeSchema } } },
      400: { description: "Invalid body, e.g. an empty name, or a birth date in the future or not YYYY-MM-DD" },
      401: { description: "Missing or invalid token" },
      502: { description: "The name could not be set on the sign-in account; nothing changed" },
    },
  }),
  async (c) => {
    const user = c.get("user");
    const patch = c.req.valid("json");
    const db = getFirestore();
    const ref = db.doc(`users/${user.uid}`);

    // The profile exists: signing in made it, before this handler runs
    const current = (await profileOf(user.uid))!;
    const changes: Partial<UserProfileWrite> = {};
    if (patch.displayName !== undefined && patch.displayName !== current.displayName) {
      // Also the account's, so the sign-in name the API follows (see auth.ts) agrees with it
      changes.displayName = patch.displayName;
      changes.authName = patch.displayName;
      changes.nameSetAt = FieldValue.serverTimestamp();
    }
    if (patch.birthDate !== undefined && patch.birthDate !== (current.birthDate ?? null)) {
      changes.birthDate = patch.birthDate;
    }

    if (Object.keys(changes).length > 0) {
      if (changes.displayName !== undefined) {
        try {
          await getAuth().updateUser(user.uid, { displayName: changes.displayName });
        } catch (err) {
          console.error("failed to set the account's name", err);
          throw new HTTPException(502, { message: "could not change the name" });
        }
      }
      const batch = db.batch();
      batch.update(ref, changes);
      audit(batch, {
        actor: user,
        action: "user.profileUpdate",
        target: { id: user.uid, label: user.email ?? null },
        details: { fields: Object.keys(changes).filter((f) => f === "displayName" || f === "birthDate") },
      });
      await batch.commit();
    }

    return c.json({
      ...user,
      displayName: changes.displayName ?? current.displayName ?? null,
      birthDate: changes.birthDate !== undefined ? changes.birthDate : current.birthDate ?? null,
    }, 200);
  },
);
