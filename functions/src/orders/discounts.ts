import { z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import type Stripe from "stripe";

import type { Extra, TicketType } from "../types";

/**
 * Why a promotion code can't be used: it doesn't exist, it was switched off, its date passed,
 * its uses ran out, it's tied to a Stripe customer or a first purchase (buyers have no Stripe
 * customer, so that can't be checked), it covers nothing in the order, or the order is below
 * its minimum.
 */
export const CODE_PROBLEMS = [
  "not_found", "inactive", "expired", "used_up", "restricted", "not_applicable", "below_minimum",
] as const;
export type CodeProblem = { reason: (typeof CODE_PROBLEMS)[number]; message: string };

export const PromotionCodeSchema = z.string().trim().min(1).max(100).openapi({
  description: "A promotion code made in Stripe, as the buyer typed it (any case)",
});

/** One thing an order charges for: a ticket type or an extra, with how many of it. */
export type PriceLine = {
  kind: "ticketType" | "extra";
  id: string;
  name: string;
  unitPrice: number;          // cents
  quantity: number;
  amount: number;             // cents
  stripePriceId: string | null;
  // The Stripe product it's charged as, which is what a code limited to some products names.
  // Null when Stripe charges it under a product made on the fly, or not at all (free)
  stripeProductId: string | null;
};

/**
 * What an order charges: one line per ticket type, one per person since prices are per person
 * (packs included), and one per extra. Types are expected at their current price (priceAt).
 */
export function priceLines(
  attendees: { typeId: string; extras: { extraId: string }[] }[],
  types: Map<string, TicketType>,
  extras: Map<string, Extra>,
): PriceLine[] {
  const lines: PriceLine[] = [];

  for (const type of types.values()) {
    const quantity = attendees.filter((a) => a.typeId === type.id).length;
    lines.push({
      kind: "ticketType", id: type.id, name: type.name, unitPrice: type.price, quantity,
      amount: type.price * quantity,
      stripePriceId: type.stripePriceId ?? null,
      // Without its own price Stripe charges it as a product made for that checkout
      stripeProductId: type.stripePriceId ? type.stripeProductId ?? null : null,
    });
  }

  for (const extra of extras.values()) {
    const quantity = attendees.flatMap((a) => a.extras).filter((e) => e.extraId === extra.id).length;
    lines.push({
      kind: "extra", id: extra.id, name: extra.name, unitPrice: extra.price, quantity,
      amount: extra.price * quantity,
      stripePriceId: extra.stripePriceId,
      stripeProductId: extra.stripeProductId,
    });
  }

  return lines;
}

/**
 * Where a code stands in Stripe: switched on, switched off (archived), or its coupon deleted,
 * which Stripe still lists the code for but which can never come back. Expiry and uses are
 * apart from this: an active code may still have expired or run out (see codeProblem).
 */
export const CODE_STATES = ["active", "inactive", "deleted"] as const;
export type CodeState = (typeof CODE_STATES)[number];

/** The coupon behind a code, when it was looked up with it expanded and still exists. */
export function couponOf(promo: Stripe.PromotionCode): Stripe.Coupon | null {
  const coupon = promo.promotion.coupon as Stripe.Coupon | Stripe.DeletedCoupon | string | null;
  return coupon && typeof coupon === "object" && !coupon.deleted ? coupon : null;
}

export function codeState(promo: Stripe.PromotionCode): CodeState {
  if (!couponOf(promo)) return "deleted";
  return promo.active ? "active" : "inactive";
}

/** The code's minimum order in euros, or undefined when it has one only in other currencies. */
function minimumInEuros(promo: Stripe.PromotionCode): number | null | undefined {
  const { minimum_amount, minimum_amount_currency, currency_options } = promo.restrictions;
  if (minimum_amount === null) return null;
  if (minimum_amount_currency === "eur") return minimum_amount;
  return currency_options?.eur?.minimum_amount;
}

/** The coupon's fixed amount off in euros, or undefined when it has one only in other currencies. */
function amountOffInEuros(coupon: Stripe.Coupon): number | null | undefined {
  if (coupon.amount_off === null) return null;
  if (coupon.currency === "eur") return coupon.amount_off;
  return coupon.currency_options?.eur?.amount_off;
}

const euros = (cents: number) => `${(cents / 100).toFixed(2).replace(".", ",")} €`;

/** How the code is set up in Stripe, for showing it. */
export function codeTerms(promo: Stripe.PromotionCode) {
  const coupon = couponOf(promo);
  return {
    percentOff: coupon?.percent_off ?? null,
    amountOff: coupon ? amountOffInEuros(coupon) ?? null : null,
    minimumAmount: minimumInEuros(promo) ?? null,
    // Null: the whole order
    products: coupon?.applies_to?.products ?? null,
  };
}

/**
 * Whether the code can be used at all at `now`, regardless of the order. Mirrors what Stripe
 * checks, so a code we accept is one Stripe applies.
 */
export function codeProblem(promo: Stripe.PromotionCode, now = new Date()): CodeProblem | null {
  const coupon = couponOf(promo);
  const time = now.getTime();
  const passed = (seconds: number | null) => seconds !== null && seconds * 1000 <= time;
  const usedUp = (max: number | null, used: number) => max !== null && used >= max;

  if (!coupon) return { reason: "not_found", message: `${promo.code} doesn't exist` };
  if (passed(promo.expires_at) || passed(coupon.redeem_by)) {
    return { reason: "expired", message: `${promo.code} has expired` };
  }
  if (usedUp(promo.max_redemptions, promo.times_redeemed) || usedUp(coupon.max_redemptions, coupon.times_redeemed)) {
    return { reason: "used_up", message: `${promo.code} has been used up` };
  }
  if (!promo.active || !coupon.valid) {
    return { reason: "inactive", message: `${promo.code} is no longer active` };
  }
  if (promo.customer || promo.customer_account || promo.restrictions.first_time_transaction) {
    return { reason: "restricted", message: `${promo.code} is for one customer or a first purchase only, which online sales can't check` };
  }
  if (amountOffInEuros(coupon) === undefined || minimumInEuros(promo) === undefined) {
    return { reason: "restricted", message: `${promo.code} isn't set up for euros` };
  }
  return null;
}

/**
 * What the code takes off an order: a percentage of, or a fixed amount up to, what it covers
 * (the whole order, or only the lines of its products). Stripe charges the real amount; a
 * percentage over several lines may round a cent differently, which the order records when paid.
 */
export function applyCode(
  promo: Stripe.PromotionCode,
  lines: PriceLine[],
  now = new Date(),
): { ok: true; discount: number; lineIds: string[] | null } | { ok: false; problem: CodeProblem } {
  const problem = codeProblem(promo, now);
  if (problem) return { ok: false, problem };

  const { percentOff, amountOff, minimumAmount, products } = codeTerms(promo);
  const subtotal = lines.reduce((sum, l) => sum + l.amount, 0);

  if (minimumAmount !== null && subtotal < minimumAmount) {
    return {
      ok: false,
      problem: { reason: "below_minimum", message: `${promo.code} needs an order of at least ${euros(minimumAmount)}` },
    };
  }

  const covered = lines.filter((l) => l.amount > 0
    && (products === null || (l.stripeProductId !== null && products.includes(l.stripeProductId))));
  const base = covered.reduce((sum, l) => sum + l.amount, 0);
  if (base === 0) {
    return { ok: false, problem: { reason: "not_applicable", message: `${promo.code} doesn't apply to anything in this order` } };
  }

  const discount = percentOff !== null ? Math.round((base * percentOff) / 100) : Math.min(amountOff ?? 0, base);
  return { ok: true, discount, lineIds: products === null ? null : covered.map((l) => l.id) };
}

/**
 * The code as the buyer typed it, matched without regard to case like Stripe does. Prefers an
 * active one, since a code can be reused once its old promotion code is switched off.
 */
export async function findPromotionCode(stripe: Stripe, code: string): Promise<Stripe.PromotionCode | null> {
  const found = await stripe.promotionCodes.list({
    code, limit: 100, expand: ["data.promotion.coupon.applies_to"],
  });
  const matches = found.data.filter((p) => p.code.toLowerCase() === code.toLowerCase());
  return matches.find((p) => p.active) ?? matches[0] ?? null;
}

/** findPromotionCode for a request: a Stripe failure is the API's, not the buyer's. */
export async function lookUpCode(stripe: Stripe, code: string): Promise<Stripe.PromotionCode | null> {
  try {
    return await findPromotionCode(stripe, code);
  } catch (err) {
    console.error("failed to look up a promotion code", err);
    throw new HTTPException(502, { message: "could not check the promotion code" });
  }
}
