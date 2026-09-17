import { initializeApp } from "firebase-admin/app";
import { getRequestListener } from "@hono/node-server";
import { onRequest } from "firebase-functions/v2/https";
import { Hono } from "hono";
import { logger } from "hono/logger";

import { type Env, requireAuth, requireRole } from "./auth";
import { stripeSecretKey, stripeWebhook, stripeWebhookSecret } from "./stripe";
import { checkin } from "./tickets/checkin";
import { doorSale } from "./tickets/doorSale";
import { tickets } from "./tickets/tickets";
import { lanParty } from "./users/lanParty";


initializeApp();

const app = new Hono<Env>().basePath("/api");

app.use(logger());

app.get("/health", (c) => c.json({ ok: true }));
app.route("/stripe/webhook", stripeWebhook);

app.use("*", requireAuth);
app.get("/me", (c) => c.json(c.get("user")));
app.route("/tickets", tickets);
app.route("/tickets/checkin", checkin);
app.route("/tickets/door", doorSale);
app.route("/users/lan-party", lanParty);
app.get("/admin/ping", requireRole("admin"), (c) => c.json({ ok: true }));

export const api = onRequest(
  { region: "europe-west1", maxInstances: 10, secrets: [stripeSecretKey, stripeWebhookSecret] },
  getRequestListener(app.fetch),
);