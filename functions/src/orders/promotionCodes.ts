import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { getFirestore } from "firebase-admin/firestore";
import { HTTPException } from "hono/http-exception";
import Stripe from "stripe";

import { requireAdmin, type Env } from "../auth";
import { bearerAuth } from "../schemas";
import { stripeSecretKey } from "../stripe";
import { CODE_PROBLEMS, codeProblem, codeState, codeTerms } from "./discounts";

export const promotionCodes = new OpenAPIHono<Env>();

// A code whose coupon was deleted is never listed: it can't come back, so it's only clutter
const LISTED_STATES = ["active", "inactive"] as const;

const PromotionCodeViewSchema = z.object({
  id: z.string().openapi({ description: "Stripe's promotion code id" }),
  code: z.string(),
  state: z.enum(LISTED_STATES).openapi({
    description: "active: switched on in Stripe (it may still have expired or run out, see usable); inactive: switched off",
  }),
  usable: z.boolean().openapi({ description: "Whether a buyer can use it now, in an order it applies to" }),
  problem: z.enum(CODE_PROBLEMS).nullable().openapi({ description: "Why it can't be used, when not usable" }),
  percentOff: z.number().nullable(),
  amountOff: z.int().nullable().openapi({ description: "Cents" }),
  minimumAmount: z.int().nullable().openapi({ description: "Cents" }),
  maxTickets: z.int().nullable().openapi({
    description: "The most tickets (people) per order it takes off, from metadata.maxTickets on the promotion code or its coupon; null for no limit",
  }),
  appliesTo: z.array(z.object({
    kind: z.enum(["ticketType", "extra"]).nullable().openapi({ description: "Null for a Stripe product we don't sell" }),
    id: z.string().openapi({ description: "Our type's or extra's id, or else the Stripe product id" }),
    name: z.string().nullable(),
  })).nullable().openapi({ description: "Null for the whole order" }),
  expiresAt: z.string().nullable().openapi({ description: "ISO date-time" }),
  maxRedemptions: z.int().nullable(),
  timesRedeemed: z.int().openapi({ description: "Paid checkouts that used it, as Stripe counts them" }),
  createdAt: z.string(),
});

async function listCodes(): Promise<Stripe.PromotionCode[]> {
  try {
    return await new Stripe(stripeSecretKey()).promotionCodes
      .list({ limit: 100, expand: ["data.promotion.coupon.applies_to"] })
      .autoPagingToArray({ limit: 1000 });
  } catch (err) {
    console.error("failed to list promotion codes", err);
    throw new HTTPException(502, { message: "could not list the promotion codes" });
  }
}

const iso = (seconds: number | null) => (seconds === null ? null : new Date(seconds * 1000).toISOString());

promotionCodes.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["Promotion codes"],
    summary: "List promotion codes",
    description:
      "Admin only. The promotion codes in Stripe, newest first, and whether each can be used. " +
      "They're made, changed and switched off in the Stripe dashboard (a coupon with a promotion " +
      "code). Codes tied to a customer or a first purchase can't be used online. Codes whose " +
      "coupon was deleted are left out.",
    security: bearerAuth,
    middleware: [requireAdmin] as const,
    request: {
      query: z.object({
        state: z.enum(LISTED_STATES).default("active").openapi({ description: "Which codes to list; the active ones by default" }),
      }),
    },
    responses: {
      200: {
        description: "Promotion codes",
        content: { "application/json": { schema: z.array(PromotionCodeViewSchema) } },
      },
      400: { description: "Unknown state" },
      403: { description: "Caller is not admin" },
      502: { description: "Stripe could not be reached" },
    },
  }),
  async (c) => {
    const { state } = c.req.valid("query");
    const db = getFirestore();
    const [codes, types, extras] = await Promise.all([
      listCodes(),
      db.collection("ticketTypes").get(),
      db.collection("extras").get(),
    ]);

    const ours = new Map<string, { kind: "ticketType" | "extra"; id: string; name: string }>();
    for (const [kind, snap] of [["ticketType", types], ["extra", extras]] as const) {
      for (const doc of snap.docs) {
        const productId = doc.get("stripeProductId");
        if (productId) ours.set(productId, { kind, id: doc.id, name: doc.get("name") });
      }
    }

    const wanted = codes.filter((promo) => codeState(promo) === state);
    return c.json(wanted.map((promo) => {
      const problem = codeProblem(promo);
      const { percentOff, amountOff, minimumAmount, products, maxTickets } = codeTerms(promo);
      return {
        id: promo.id,
        code: promo.code,
        state,
        usable: problem === null,
        problem: problem?.reason ?? null,
        percentOff,
        amountOff,
        minimumAmount,
        maxTickets,
        appliesTo: products && products.map((p) => ours.get(p) ?? { kind: null, id: p, name: null }),
        expiresAt: iso(promo.expires_at),
        maxRedemptions: promo.max_redemptions,
        timesRedeemed: promo.times_redeemed,
        createdAt: iso(promo.created)!,
      };
    }), 200);
  },
);
