import { initializeApp } from "firebase-admin/app";
import { getRequestListener } from "@hono/node-server";
import { onRequest } from "firebase-functions/v2/https";
import { Hono } from "hono";
import { logger } from "hono/logger";

import { type Env, requireAuth, requireRole } from "./auth";
import { tickets } from "./tickets";


initializeApp();

const app = new Hono<Env>().basePath("/api");

app.use(logger());

app.get("/health", (c) => c.json({ ok: true }));

app.use("*", requireAuth);
app.get("/me", (c) => c.json(c.get("user")));
app.route("/tickets", tickets);
app.get("/admin/ping", requireRole("admin"), (c) => c.json({ ok: true }));

export const api = onRequest(
  { region: "europe-west1", maxInstances: 10 },
  getRequestListener(app.fetch),
);