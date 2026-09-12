import { initializeApp } from "firebase-admin/app";
import { getRequestListener } from "@hono/node-server";
import { onRequest } from "firebase-functions/v2/https";
import { Hono } from "hono";
import { logger } from "hono/logger";

initializeApp();

const app = new Hono().basePath("/api");

app.use(logger());

app.get("/health", (c) => c.json({ ok: true }));

export const api = onRequest(
  { region: "europe-west1", maxInstances: 10 },
  getRequestListener(app.fetch),
);