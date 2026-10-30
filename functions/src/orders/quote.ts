import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { getFirestore } from "firebase-admin/firestore";
import { HTTPException } from "hono/http-exception";
import Stripe from "stripe";

import { changesNothing } from "../audit/audit";
import { EmailSchema } from "../schemas";
import { stripeSecretKey } from "../stripe";
import { isOnSale } from "../tickets/capacity";
import { pairCompanions, WITH_DESCRIPTION, WithSchema } from "../tickets/companions";
import { type Extra, priceAt, type TicketType } from "../types";
import { alreadyUsed, applyCode, CODE_PROBLEMS, codeTerms, lookUpCode, paidWithCode, priceLines, PromotionCodeSchema } from "./discounts";

export const quote = new OpenAPIHono();

const QuoteSchema = z.object({
  attendees: z.array(z.object({
    typeId: z.string().min(1),
    extras: z.array(z.object({ extraId: z.string().min(1) })).max(10).default([]),
    with: WithSchema.openapi({
      description: `${WITH_DESCRIPTION} Here only a position in the list is checked; a ticket already sold is checked when buying.`,
    }),
  })).min(1).max(20).openapi({ description: "One per person, as for buying; only what's priced" }),
  promotionCode: PromotionCodeSchema.optional(),
  email: EmailSchema.optional().openapi({
    description: "The buyer's email, once known: a code it already paid with is shown as not applied",
  }),
});

const QuoteViewSchema = z.object({
  lines: z.array(z.object({
    kind: z.enum(["ticketType", "extra"]),
    id: z.string(),
    name: z.string(),
    unitPrice: z.int().nonnegative(),
    quantity: z.int().positive(),
    amount: z.int().nonnegative(),
  })),
  subtotal: z.int().nonnegative().openapi({ description: "Cents, before the discount" }),
  discount: z.int().nonnegative().openapi({ description: "Cents; 0 without a code, or with one that can't be used" }),
  total: z.int().nonnegative().openapi({ description: "Cents: what the buyer will be asked to pay" }),
  promotionCode: z.object({
    code: z.string().openapi({ description: "As Stripe has it" }),
    applied: z.boolean(),
    problem: z.object({ reason: z.enum(CODE_PROBLEMS), message: z.string() }).nullable().openapi({
      description: "Why it can't be used, when not applied",
    }),
    percentOff: z.number().nullable(),
    amountOff: z.int().nullable().openapi({ description: "Cents" }),
    minimumAmount: z.int().nullable().openapi({ description: "Cents; the least the order must come to" }),
    maxTickets: z.int().nullable().openapi({
      description: "The most tickets (people) per order it takes off, from metadata.maxTickets in Stripe; null for no limit",
    }),
    appliesTo: z.array(z.string()).nullable().openapi({
      description: "The ids of the lines it takes off; null for the whole order",
    }),
  }).nullable(),
});

quote.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["Tickets"],
    summary: "Price an order",
    description:
      "Public. What an order would cost, with a promotion code taken off when one is given and " +
      "can be used, so the buyer sees the final price before paying. Reserves nothing and doesn't " +
      "check stock; buying checks the code again. Stripe charges the real amount, which with a " +
      "percentage on some products only may differ by a rounding cent.",
    ...changesNothing,
    request: {
      body: { required: true, content: { "application/json": { schema: QuoteSchema } } },
    },
    responses: {
      200: { description: "The price", content: { "application/json": { schema: QuoteViewSchema } } },
      400: { description: "Invalid body, an unknown type or extra, or a companion without a valid `with`" },
      409: { description: "A ticket type isn't on sale" },
      502: { description: "The promotion code could not be checked" },
    },
  }),
  async (c) => {
    const { attendees, promotionCode: code, email } = c.req.valid("json");
    const db = getFirestore();

    const typeIds = [...new Set(attendees.map((a) => a.typeId))];
    const extraIds = [...new Set(attendees.flatMap((a) => a.extras.map((e) => e.extraId)))];
    const [typeDocs, extraDocs, promo] = await Promise.all([
      db.getAll(...typeIds.map((id) => db.doc(`ticketTypes/${id}`))),
      extraIds.length > 0 ? db.getAll(...extraIds.map((id) => db.doc(`extras/${id}`))) : [],
      code ? lookUpCode(new Stripe(stripeSecretKey()), code) : null,
    ]);

    const types = new Map<string, TicketType>();
    for (const doc of typeDocs) {
      if (!doc.exists) throw new HTTPException(400, { message: `unknown ticket type: ${doc.id}` });
      const type = doc.data() as Omit<TicketType, "id">;
      if (!isOnSale(type)) throw new HTTPException(409, { message: `not on sale: ${doc.id}` });
      const { price, stripePriceId } = priceAt(type);
      types.set(doc.id, { id: doc.id, ...type, price, stripePriceId });
    }
    const extras = new Map<string, Extra>();
    for (const doc of extraDocs) {
      if (!doc.exists) throw new HTTPException(400, { message: `unknown extra: ${doc.id}` });
      extras.set(doc.id, { id: doc.id, ...(doc.data() as Omit<Extra, "id">) });
    }

    pairCompanions(attendees, types, null);

    const lines = priceLines(attendees, types, extras);
    const subtotal = lines.reduce((sum, l) => sum + l.amount, 0);
    let applied = promo && applyCode(promo, lines);
    if (applied?.ok && email && await paidWithCode(promo!.id, email)) applied = { ok: false, problem: alreadyUsed(promo!) };
    const discount = applied?.ok ? applied.discount : 0;

    return c.json({
      lines: lines.map(({ kind, id, name, unitPrice, quantity, amount }) => ({ kind, id, name, unitPrice, quantity, amount })),
      subtotal,
      discount,
      total: subtotal - discount,
      promotionCode: !code ? null : !promo || !applied
        ? {
          code, applied: false, problem: { reason: "not_found" as const, message: `${code} doesn't exist` },
          percentOff: null, amountOff: null, minimumAmount: null, maxTickets: null, appliesTo: null,
        }
        : {
          code: promo.code,
          applied: applied.ok,
          problem: applied.ok ? null : applied.problem,
          ...termsOf(codeTerms(promo)),
          appliesTo: applied.ok ? applied.lineIds : null,
        },
    }, 200);
  },
);

const termsOf = ({ percentOff, amountOff, minimumAmount, maxTickets }: ReturnType<typeof codeTerms>) =>
  ({ percentOff, amountOff, minimumAmount, maxTickets });
