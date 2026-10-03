import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { initializeApp } from "firebase-admin/app";
import { getRequestListener } from "@hono/node-server";
import { onRequest } from "firebase-functions/v2/https";
import { logger } from "hono/logger";
import { Scalar } from "@scalar/hono-api-reference";

import { auditLog } from "./audit/routes";
import { type Env, requireAuth, requireAdmin } from "./auth";
import { corsMiddleware } from "./cors";
import { adminExtras, extras } from "./extras/routes";
import { bearerAuth } from "./schemas";
import { ONLINE_SALES } from "./features";
import { stripeSecrets, stripeWebhook } from "./stripe";
import { checkin } from "./tickets/checkin";
import { doorSale } from "./tickets/doorSale";
import { ticketLookup } from "./tickets/lookup";
import { ticketCancel } from "./tickets/cancel";
import { ticketQr } from "./tickets/qr";
import { ticketTypeSync } from "./tickets/stripeSync";
import { adminTicketTypes, ticketTypes } from "./tickets/ticketTypes";
import { tickets } from "./tickets/tickets";
import { orders } from "./orders/routes";
import { purchase } from "./orders/purchase";
import { lanParty } from "./users/lanParty";
import { me } from "./users/me";
import { userLookup } from "./users/lookup";
import { staff } from "./users/staff";
import { suspension } from "./users/suspend";


initializeApp();

const app = new OpenAPIHono<Env>().basePath("/api/v1");

app.use(logger());

// Ahead of requireAuth: a preflight carries no token, so it must not be authenticated
app.use("*", corsMiddleware);

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

if (ONLINE_SALES) {
  app.route("/stripe/webhook", stripeWebhook);
  // Open to guests, so mounted before requireAuth; signs the buyer in only if they send a token
  app.route("/tickets", purchase);
  app.route("/orders", orders);
}
app.route("/ticket-types", ticketTypes);
app.route("/extras", extras);

app.use("*", requireAuth);

app.route("/ticket-types", adminTicketTypes);
app.route("/ticket-types", ticketTypeSync);
app.route("/extras", adminExtras);

app.route("/me", me);

app.route("/tickets", tickets);
app.route("/tickets/checkin", checkin);
app.route("/tickets/door", doorSale);
app.route("/tickets/by-email", ticketLookup);
app.route("/tickets", ticketQr);
app.route("/tickets", ticketCancel);
app.route("/users/lan-party", lanParty);
app.route("/users/by-email", userLookup);
app.route("/users", staff);
app.route("/users", suspension);
app.route("/audit", auditLog);

app.openapi(
  createRoute({
    method: "get",
    path: "/admin/ping",
    tags: ["System"],
    summary: "Admin role smoke test",
    security: bearerAuth,
    middleware: [requireAdmin] as const,
    responses: {
      200: { description: "Caller is admin", content: { "application/json": { schema: OkSchema } } },
      403: { description: "Caller is not admin" },
    },
  }),
  (c) => c.json({ ok: true }, 200),
);

// Sends what the API queues in the `mail` collection
export { sendMail } from "./mailSender";

export const api = onRequest(
  { region: "europe-west1", maxInstances: 10, secrets: stripeSecrets },
  getRequestListener(app.fetch),
);
