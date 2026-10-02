import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { getFirestore } from "firebase-admin/firestore";
import { HTTPException } from "hono/http-exception";
import Stripe from "stripe";

import { audit, auditedAs } from "../audit/audit";
import { requireAdmin, type Env, type User } from "../auth";
import { syncExtraProduct } from "../extras/sync";
import { chargeablePrice, slugify } from "../stripeCatalogue";
import { bearerAuth } from "../schemas";
import { stripeSecretKey } from "../stripe";
import type { TicketType } from "../types";

export const ticketTypeSync = new OpenAPIHono<Env>();

const TYPE_ID = /^[a-z0-9-]+$/;

type StoredType = Omit<TicketType, "id">;
export type Changes = Record<string, { from: unknown; to: unknown }>;

const ResultSchema = z.object({
  stripeProductId: z.string(),
  name: z.string(),
  kind: z.enum(["ticketType", "extra"]).openapi({ description: "Products with metadata.kind = extra are extras" }),
  result: z.enum(["created", "updated", "unchanged", "skipped"]),
  typeId: z.string().nullable().openapi({ description: "The ticket type, for kind ticketType" }),
  extraId: z.string().nullable().openapi({ description: "The extra, for kind extra" }),
  changes: z.record(z.string(), z.object({ from: z.unknown(), to: z.unknown() })),
  reason: z.string().nullable().openapi({ description: "Why it was skipped" }),
});
export type SyncResult = z.infer<typeof ResultSchema>;
type Result = SyncResult;

/**
 * Brings one Stripe product into its ticket type. Stripe owns the price; the name is
 * only filled in when empty, so the web can word it its own way; everything else
 * (days, capacity, LAN, sale window) is the admin's and never touched.
 */
async function syncProduct(actor: User, product: Stripe.Product): Promise<Result> {
  const base = {
    stripeProductId: product.id, name: product.name, kind: "ticketType" as const,
    typeId: null, extraId: null, changes: {}, reason: null,
  };
  const skip = (reason: string): Result => ({ ...base, result: "skipped", reason });

  const price = chargeablePrice(product);
  if (typeof price === "string") return skip(price);
  const amount = price.unit_amount!;

  const db = getFirestore();

  return db.runTransaction(async (tx): Promise<Result> => {
    const linked = await tx.get(
      db.collection("ticketTypes").where("stripeProductId", "==", product.id).limit(1),
    );

    if (linked.empty) {
      if (!product.active) return skip("archived in Stripe and never synced");

      const id = product.metadata.typeId || slugify(product.name);
      if (!TYPE_ID.test(id)) {
        return skip(`can't make a ticket type id from "${product.name}"; set metadata.typeId in Stripe`);
      }
      const ref = db.doc(`ticketTypes/${id}`);
      if ((await tx.get(ref)).exists) {
        return skip(`the id "${id}" is taken by another ticket type; set metadata.typeId in Stripe`);
      }

      // Not for sale until an admin sets its days and capacity, which Stripe doesn't know
      const type: StoredType = {
        name: product.name,
        price: amount,
        capacity: 0,
        isLanParty: false,
        days: [],
        sold: 0,
        stripeProductId: product.id,
        stripePriceId: price.id,
        category: "general",
        packSize: 1,
        singleEntry: false,
        extrasFrom: "general",
      };
      const changes = Object.fromEntries(Object.entries(type).map(([field, to]) => [field, { from: null, to }]));

      tx.create(ref, type);
      audit(tx, {
        actor,
        action: "ticketType.stripeSync",
        target: { id, label: product.name },
        details: { stripeProductId: product.id, created: true, changes },
      });
      return { ...base, result: "created", typeId: id, changes };
    }

    const doc = linked.docs[0];
    const current = doc.data() as StoredType;
    const sold = current.sold ?? 0;
    const changes: Changes = {};

    if (current.price !== amount) changes.price = { from: current.price, to: amount };
    if (current.stripePriceId !== price.id) changes.stripePriceId = { from: current.stripePriceId ?? null, to: price.id };
    if (!current.name) changes.name = { from: current.name ?? null, to: product.name };
    // Archived in Stripe: stop sales the documented way, without losing what was sold
    if (!product.active && (current.capacity === null || current.capacity > sold)) {
      changes.capacity = { from: current.capacity, to: sold };
    }

    if (Object.keys(changes).length === 0) {
      return { ...base, result: "unchanged", typeId: doc.id };
    }

    tx.update(doc.ref, Object.fromEntries(Object.entries(changes).map(([field, { to }]) => [field, to])));
    audit(tx, {
      actor,
      action: "ticketType.stripeSync",
      target: { id: doc.id, label: current.name || product.name },
      details: { stripeProductId: product.id, created: false, changes },
    });
    return { ...base, result: "updated", typeId: doc.id, changes };
  });
}

ticketTypeSync.openapi(
  createRoute({
    method: "post",
    path: "/sync",
    tags: ["Ticket types"],
    summary: "Sync ticket types from Stripe",
    description:
      "Admin only. Each Stripe product is one ticket type, priced by its default price, or an " +
      "extra if its metadata has kind = extra. " +
      "New products arrive not for sale (no days, capacity 0) until an admin completes them. " +
      "Prices always follow Stripe; a name is only filled in when empty. " +
      "Products archived in Stripe stop selling. Safe to run as often as needed.",
    security: bearerAuth,
    ...auditedAs("ticketType.stripeSync", "extra.stripeSync"),
    middleware: [requireAdmin] as const,
    responses: {
      200: {
        description: "What happened to each Stripe product",
        content: { "application/json": { schema: z.object({ results: z.array(ResultSchema) }) } },
      },
      403: { description: "Caller is not admin" },
      502: { description: "Stripe could not be reached; nothing was changed" },
    },
  }),
  async (c) => {
    let products: Stripe.Product[];
    try {
      products = await new Stripe(stripeSecretKey())
        .products.list({ limit: 100, expand: ["data.default_price"] })
        .autoPagingToArray({ limit: 10000 });
    } catch (err) {
      console.error("failed to list Stripe products", err);
      throw new HTTPException(502, { message: "could not read the Stripe catalogue" });
    }

    // One at a time, so two products that would take the same id can't race each other
    const results: Result[] = [];
    for (const product of products) {
      results.push(
        product.metadata.kind === "extra"
          ? await syncExtraProduct(c.get("user"), product)
          : await syncProduct(c.get("user"), product),
      );
    }

    return c.json({ results }, 200);
  },
);
