import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";

import type { Env } from "../auth";
import { bearerAuth } from "../schemas";
import { ROLES } from "../types";

export const me = new OpenAPIHono<Env>();

const MeSchema = z.object({
  uid: z.string(),
  email: z.string().optional(),
  displayName: z.string().nullable(),
  role: z.enum(ROLES),
});

me.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["Users"],
    summary: "Get the caller's identity and role",
    security: bearerAuth,
    responses: {
      200: { description: "The authenticated user", content: { "application/json": { schema: MeSchema } } },
      401: { description: "Missing or invalid token" },
    },
  }),
  (c) => c.json(c.get("user"), 200),
);
