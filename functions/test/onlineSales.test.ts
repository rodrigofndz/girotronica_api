import { declaredParams } from "firebase-functions/params";
import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";

import { api } from "../src/index";
import {
  apiFetch, createUser, resetEmulators, seedTicketType, startApi, stopApi, type TestUser,
} from "./helpers";

let buyer: TestUser;

beforeAll(startApi);
afterAll(stopApi);

beforeEach(async () => {
  await resetEmulators();
  buyer = await createUser("buyer@example.com");
});

describe("with online sales switched off, as shipped", () => {
  it("has no online purchase endpoint", async () => {
    await seedTicketType("general");

    const res = await apiFetch("POST", "/tickets", {
      token: buyer.token,
      body: { items: [{ typeId: "general", holderName: "Buyer", holderEmail: "buyer@example.com" }] },
    });

    expect(res.status).toBe(404);
  });

  // Signed in, since unknown paths without a token are answered by sign-in with 401
  it("has no Stripe webhook", async () => {
    const res = await apiFetch("POST", "/stripe/webhook", { token: buyer.token });

    expect(res.status).toBe(404);
  });

  it("still lists the caller's own tickets", async () => {
    expect((await apiFetch("GET", "/tickets", { token: buyer.token })).status).toBe(200);
  });

  // Any declared secret must exist in Secret Manager or the deploy fails, bound or not.
  // The API key is still needed: the catalogue sync reads Stripe while online sales are off.
  it("needs only the Stripe API key, not the webhook secret", () => {
    const secretNames = declaredParams.map((param) => param.name);

    expect(secretNames).toContain("STRIPE_SECRET_KEY");
    expect(secretNames).not.toContain("STRIPE_WEBHOOK_SECRET");
    expect(api.__endpoint.secretEnvironmentVariables?.map((s) => s.key)).toEqual(["STRIPE_SECRET_KEY"]);
  });
});
