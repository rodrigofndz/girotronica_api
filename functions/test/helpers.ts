import http from "node:http";
import type { AddressInfo } from "node:net";

import { getFirestore } from "firebase-admin/firestore";
import Stripe from "stripe";

import { api } from "../src/index";
import type { Role, TicketType } from "../src/types";

const PROJECT = process.env.GCLOUD_PROJECT ?? "girotronica-api";
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST;
const FIRESTORE_HOST = process.env.FIRESTORE_EMULATOR_HOST;
const AUTH = `http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1`;

let server: http.Server;
let baseUrl: string;

export async function startApi(): Promise<void> {
  server = http.createServer((req, res) => api(req, res));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
}

export async function stopApi(): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
}

/** Wipes both emulators so each test file starts from nothing. */
export async function resetEmulators(): Promise<void> {
  await Promise.all([
    fetch(
      `http://${FIRESTORE_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
      { method: "DELETE" },
    ),
    fetch(`http://${AUTH_HOST}/emulator/v1/projects/${PROJECT}/accounts`, { method: "DELETE" }),
  ]);
}

export type ApiResponse<T = any> = { status: number; body: T; headers: Headers };

export async function apiFetch<T = any>(
  method: string,
  path: string,
  options: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<ApiResponse<T>> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body: body as T, headers: res.headers };
}

export type TestUser = { uid: string; token: string; email: string };

/** Creates an account and gives it a role, making the profile the way requireAuth would. */
export async function createUser(email: string, role: Role = "user"): Promise<TestUser> {
  const res = await fetch(`${AUTH}/accounts:signUp?key=fake`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "secret123", returnSecureToken: true }),
  });
  const account = await res.json();
  const user = { uid: account.localId, token: account.idToken, email };

  await apiFetch("GET", "/me", { token: user.token }); // creates users/{uid}
  if (role !== "user") {
    await getFirestore().doc(`users/${user.uid}`).update({ role });
  }
  return user;
}

export async function seedTicketType(
  id: string,
  overrides: Partial<Omit<TicketType, "id">> = {},
): Promise<void> {
  const doc: Record<string, unknown> = {
    name: id,
    price: 900,
    capacity: null,
    isLanParty: false,
    days: ["2026-11-20"],
    sold: 0,
    ...overrides,
  };
  // `sold: undefined` means "seed it the way a hand-made doc looks", i.e. without the field
  for (const [key, value] of Object.entries(doc)) {
    if (value === undefined) delete doc[key];
  }

  await getFirestore().doc(`ticketTypes/${id}`).set(doc);
}

export const soldCount = async (typeId: string): Promise<number> =>
  (await getFirestore().doc(`ticketTypes/${typeId}`).get()).data()?.sold ?? 0;

export const ticketStatus = async (id: string): Promise<string | undefined> =>
  (await getFirestore().doc(`tickets/${id}`).get()).data()?.status;

export const mailDocs = async (): Promise<any[]> =>
  (await getFirestore().collection("mail").get()).docs.map((d) => d.data());

/** Posts a Stripe event with a valid signature for the test webhook secret. */
export async function sendStripeEvent(
  type: string,
  object: Record<string, unknown>,
): Promise<{ status: number }> {
  const payload = JSON.stringify({
    id: `evt_${Math.random().toString(36).slice(2)}`,
    object: "event",
    type,
    data: { object },
  });

  const res = await fetch(`${baseUrl}/stripe/webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "stripe-signature": Stripe.webhooks.generateTestHeaderString({
        payload,
        secret: process.env.STRIPE_WEBHOOK_SECRET!,
      }),
    },
    body: payload,
  });

  return { status: res.status };
}

export const checkoutSession = (ticketIds: string[], extra: Record<string, unknown> = {}) => ({
  id: "cs_test",
  object: "checkout.session",
  metadata: { ticketIds: JSON.stringify(ticketIds) },
  ...extra,
});

/** QR responses are binary, so they need their own fetch rather than the JSON one. */
export async function fetchQr(
  ticketId: string,
  token?: string,
): Promise<{ status: number; contentType: string | null; isPng: boolean; decoded: Buffer }> {
  const res = await fetch(`${baseUrl}/tickets/${ticketId}/qr`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  const decoded = Buffer.from(await res.arrayBuffer());

  return {
    status: res.status,
    contentType: res.headers.get("content-type"),
    isPng: decoded.subarray(1, 4).toString() === "PNG",
    decoded,
  };
}
