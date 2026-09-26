import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { getFirestore } from "firebase-admin/firestore";
import { HTTPException } from "hono/http-exception";

import { requireStaff, type Env } from "../auth";
import { bearerAuth, EmailSchema, UserProfileSchema } from "../schemas";
import type { UserProfile } from "../types";

export const userLookup = new OpenAPIHono<Env>();

userLookup.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["Users"],
    summary: "Find a user by email",
    description: "Staff or admin. Resolves an email to the account's uid and role.",
    security: bearerAuth,
    middleware: [requireStaff] as const,
    request: {
      query: z.object({ email: EmailSchema.openapi({ param: { name: "email", in: "query" } }) }),
    },
    responses: {
      200: {
        description: "The user profile",
        content: { "application/json": { schema: UserProfileSchema } },
      },
      400: { description: "Missing or malformed email" },
      403: { description: "Caller is not staff or admin" },
      404: { description: "No user with that email" },
    },
  }),
  async (c) => {
    const { email } = c.req.valid("query");

    const snap = await getFirestore()
      .collection("users")
      .where("email", "==", email)
      .limit(1)
      .get();

    if (snap.empty) {
      throw new HTTPException(404, { message: "user not found" });
    }

    const doc = snap.docs[0];
    const profile = doc.data() as UserProfile;

    return c.json(
      {
        uid: doc.id,
        email: profile.email,
        displayName: profile.displayName,
        role: profile.role,
      },
      200,
    );
  },
);
