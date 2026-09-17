import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { getFirestore } from "firebase-admin/firestore";
import { HTTPException } from "hono/http-exception";

import { requireAdmin, type Env } from "../auth";
import { bearerAuth, UserProfileSchema } from "../schemas";
import type { Role, UserProfile, UserProfileWrite } from "../types";

export const staff = new OpenAPIHono<Env>();

const params = z.object({
  uid: z.string().min(1).openapi({ param: { name: "uid", in: "path" } }),
});

const responses = {
  200: {
    description: "Updated user profile",
    content: { "application/json": { schema: UserProfileSchema } },
  },
  403: { description: "Caller is not admin" },
  404: { description: "User not found" },
  409: { description: "Target is an admin; admin roles can't be changed through the API" },
} as const;

async function setStaffRole(uid: string, role: Exclude<Role, "admin">) {
  const db = getFirestore();
  const ref = db.doc(`users/${uid}`);

  const profile = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const current = snap.data() as UserProfile | undefined;

    if (!current) {
      throw new HTTPException(404, { message: "user not found" });
    }
    if (current.role === "admin") {
      throw new HTTPException(409, { message: "cannot change an admin's role" });
    }
    if (current.role !== role) {
      tx.update(ref, { role } satisfies Partial<UserProfileWrite>);
    }
    return current;
  });

  return { uid, email: profile.email, displayName: profile.displayName, role };
}

staff.openapi(
  createRoute({
    method: "post",
    path: "/{uid}/staff",
    tags: ["Users"],
    summary: "Promote a user to staff",
    description: "Admin only. Takes effect on the user's next request.",
    security: bearerAuth,
    middleware: [requireAdmin] as const,
    request: { params },
    responses,
  }),
  async (c) => c.json(await setStaffRole(c.req.valid("param").uid, "staff"), 200),
);

staff.openapi(
  createRoute({
    method: "delete",
    path: "/{uid}/staff",
    tags: ["Users"],
    summary: "Demote a staff member back to user",
    description: "Admin only. Takes effect on the user's next request.",
    security: bearerAuth,
    middleware: [requireAdmin] as const,
    request: { params },
    responses,
  }),
  async (c) => c.json(await setStaffRole(c.req.valid("param").uid, "user"), 200),
);
