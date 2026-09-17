import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { initializeApp } from "firebase-admin/app";
import { getRequestListener } from "@hono/node-server";
import { onRequest } from "firebase-functions/v2/https";
import { logger } from "hono/logger";
import { Scalar } from "@scalar/hono-api-reference";

import { type Env, requireAuth, requireRole } from "./auth";
import { bearerAuth } from "./schemas";
import { stripeSecretKey, stripeWebhook, stripeWebhookSecret } from "./stripe";
import { checkin } from "./tickets/checkin";
import { doorSale } from "./tickets/doorSale";
import { tickets } from "./tickets/tickets";
import { lanParty } from "./users/lanParty";


initializeApp();

const app = new OpenAPIHono<Env>().basePath("/api/v1");

app.use(logger());

app.openAPIRegistry.registerComponent("securitySchemes", "Bearer", {
  type: "http",
  scheme: "bearer",
  bearerFormat: "JWT",
});

if (process.env.FUNCTIONS_EMULATOR === "true") {
  app.doc31("/openapi.json", {
    openapi: "3.1.0",
    info: { title: "Girotronica API", version: "1.0.0" },
  });
  // Relative so it resolves under the emulator's /<project>/<region>/api prefix
  app.get("/docs", Scalar({ url: "openapi.json" }));
}

const OkSchema = z.object({ ok: z.boolean() });

app.openapi(
  createRoute({
    method: "get",
    path: "/health",
    tags: ["System"],
    summary: "Health check",
    responses: {
      200: { description: "Service is up", content: { "application/json": { schema: OkSchema } } },
    },
  }),
  (c) => c.json({ ok: true }, 200),
);

app.route("/stripe/webhook", stripeWebhook);

app.use("*", requireAuth);

app.openapi(
  createRoute({
    method: "get",
    path: "/me",
    tags: ["Users"],
    summary: "Get the caller's identity and role",
    security: bearerAuth,
    responses: {
      200: {
        description: "The authenticated user",
        content: {
          "application/json": {
            schema: z.object({ uid: z.string(), email: z.string().optional(), role: z.string() }),
          },
        },
      },
      401: { description: "Missing or invalid token" },
    },
  }),
  (c) => c.json(c.get("user"), 200),
);

app.route("/tickets", tickets);
app.route("/tickets/checkin", checkin);
app.route("/tickets/door", doorSale);
app.route("/users/lan-party", lanParty);

app.openapi(
  createRoute({
    method: "get",
    path: "/admin/ping",
    tags: ["System"],
    summary: "Admin role smoke test",
    security: bearerAuth,
    middleware: [requireRole("admin")] as const,
    responses: {
      200: { description: "Caller is admin", content: { "application/json": { schema: OkSchema } } },
      403: { description: "Caller is not admin" },
    },
  }),
  (c) => c.json({ ok: true }, 200),
);

export const api = onRequest(
  { region: "europe-west1", maxInstances: 10, secrets: [stripeSecretKey, stripeWebhookSecret] },
  getRequestListener(app.fetch),
);
