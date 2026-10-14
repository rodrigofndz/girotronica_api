import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { getFirestore } from "firebase-admin/firestore";
import { HTTPException } from "hono/http-exception";
import Stripe from "stripe";

import { audit, auditedAs } from "../audit/audit";
import { requireAdmin, requireStaff, type Env } from "../auth";
import { bearerAuth } from "../schemas";
import { stripeSecretKey } from "../stripe";
import {
  type CapacityPool, ENTRY_RULES, EXTRA_GROUPS, priceAt, TICKET_CATEGORIES, type TicketType, typeSettings,
} from "../types";
import { isOnSale, POOLS_COLLECTION } from "./capacity";

export const ticketTypes = new OpenAPIHono<Env>();
export const adminTicketTypes = new OpenAPIHono<Env>();

// One online order holds at most 20 people, so a bigger pack couldn't be bought
const MAX_PACK_SIZE = 20;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be an ISO date (YYYY-MM-DD)");

// Accepts any offset and stores UTC, so comparisons never depend on how it was written
const saleBound = z.iso
  .datetime({ offset: true })
  .transform((value) => new Date(value).toISOString())
  .nullable()
  .openapi({ type: "string", format: "date-time", example: "2026-10-31T23:59:59+01:00" });

const TicketTypeSchema = z.object({
  id: z.string(),
  name: z.string(),
  price: z.int().nonnegative().openapi({
    description:
      "Cents per person, at the moment of asking; comes from Stripe and only changes there. " +
      "A pack costs price × packSize",
  }),
  nextPrice: z.object({
    price: z.int().nonnegative().openapi({ description: "Cents per person, like `price`" }),
    from: z.string().openapi({ format: "date-time" }),
  }).nullable().openapi({ description: "The next price change set in Stripe, if one is still to come" }),
  capacity: z.int().nonnegative().nullable(), // 0 means not for sale, null unlimited
  isLanParty: z.boolean(),
  days: z.array(isoDate).openapi({ description: "Empty on a type just synced from Stripe, until an admin sets it" }),
  salesStart: saleBound.optional().openapi({ description: "When sales open; null or absent means already open" }),
  salesEnd: saleBound.optional().openapi({ description: "When sales close (exclusive); null or absent means never" }),
  sold: z.int().nonnegative(),
  remaining: z.int().nonnegative().nullable().openapi({
    description: "Units still for sale, its shared places included (a pack needs packSize of them); null: unlimited",
  }),
  onSale: z.boolean().openapi({
    description: "Whether it can be bought now: days set and the sale window open, by the server's clock",
  }),
  stripeProductId: z.string().nullable().openapi({ description: "The Stripe product it was synced from" }),
  category: z.enum(TICKET_CATEGORIES).openapi({ description: "How the web groups it" }),
  packSize: z.int().min(1).max(MAX_PACK_SIZE).openapi({
    description:
      "People per unit sold, one ticket each; capacity, sold and remaining count units. " +
      `Set by an admin (default 1, at most ${MAX_PACK_SIZE}, the most one online order can hold)`,
  }),
  entries: z.enum(ENTRY_RULES).openapi({
    description: "once: one check-in in total, on any of its days (default). daily: one per day it covers",
  }),
  extrasFrom: z.enum(EXTRA_GROUPS).nullable().openapi({ description: "Which extras it offers; null for none" }),
  description: z.string().nullable().openapi({ description: "Shop card: short line under the title" }),
  features: z.array(z.string()).openapi({ description: "Shop card: the \"Més informació\" bullet list" }),
  disclaimer: z.string().nullable().openapi({ description: "Shop card: small print under the card" }),
  poolId: z.string().nullable().openapi({
    description: "Shared places it sells from as well as its own capacity (see /capacity-pools); null: none",
  }),
});

/** Trimmed; an empty string means "no text" (null). */
const optionalText = (max: number) =>
  z.string().trim().max(max).nullable().transform((value) => value || null);

const windowInOrder = (type: { salesStart?: string | null; salesEnd?: string | null }) =>
  !type.salesStart || !type.salesEnd || type.salesStart < type.salesEnd;

const WINDOW_ORDER_MESSAGE = "salesStart must be before salesEnd";

// What the web may change. Price, name source and the Stripe link come from the Stripe sync;
// strict so trying to set one of those (or `sold`) is an error, not silently ignored.
// Only checks the window when both ends are in the patch; the handler checks it against the stored type
const UpdateSchema = TicketTypeSchema.pick({
  name: true, capacity: true, isLanParty: true, salesStart: true, salesEnd: true,
  category: true, entries: true, extrasFrom: true, packSize: true, poolId: true,
})
  .extend({
    days: z.array(isoDate).min(1),
    description: optionalText(200),
    features: z.array(z.string().trim().min(1).max(300)).max(20),
    disclaimer: optionalText(500),
  })
  .partial()
  .strict();

// No price: a type made here is free (children's), and charging means a Stripe product instead
const CreateSchema = UpdateSchema.extend({
  id: z.string().regex(/^[a-z0-9-]+$/, "lowercase letters, digits and dashes only"),
  name: z.string().trim().min(1),
}).strict();

const params = z.object({
  id: z.string().min(1).openapi({ param: { name: "id", in: "path" } }),
});

function present(id: string, type: Omit<TicketType, "id">, pools: Map<string, CapacityPool>) {
  const sold = type.sold ?? 0;
  const own = type.capacity === null ? null : Math.max(type.capacity - sold, 0);
  const pool = type.poolId ? pools.get(type.poolId) : undefined;
  // A pack needs a place for each of its people
  const shared = pool && Math.floor(Math.max(pool.capacity - pool.sold, 0) / typeSettings(type).packSize);
  const { price, next } = priceAt(type);
  return {
    id,
    name: type.name,
    price,
    nextPrice: next && { price: next.price, from: next.from },
    capacity: type.capacity,
    isLanParty: type.isLanParty,
    days: type.days,
    salesStart: type.salesStart ?? null,
    salesEnd: type.salesEnd ?? null,
    sold,
    remaining: shared === undefined ? own : own === null ? shared : Math.min(own, shared),
    onSale: isOnSale(type),
    stripeProductId: type.stripeProductId ?? null,
    ...typeSettings(type),
    description: type.description ?? null,
    features: type.features ?? [],
    disclaimer: type.disclaimer ?? null,
    poolId: type.poolId ?? null,
  };
}

const listTypes = async () => {
  const db = getFirestore();
  const [types, pools] = await Promise.all([
    db.collection("ticketTypes").get(),
    db.collection(POOLS_COLLECTION).get(),
  ]);
  const byId = new Map(pools.docs.map((d) => [d.id, { id: d.id, ...d.data() } as CapacityPool]));
  return types.docs.map((d) => present(d.id, d.data() as Omit<TicketType, "id">, byId));
};

ticketTypes.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["Ticket types"],
    summary: "List ticket types on sale",
    description:
      "Public. Only the types on sale right now: days set and the sale window open. Sold-out " +
      "ones stay, with nothing remaining; types not set up yet, not open yet or closed are left " +
      "out. Staff and admins see them all in GET /ticket-types/all.",
    responses: {
      200: {
        description: "Ticket types",
        content: { "application/json": { schema: z.array(TicketTypeSchema) } },
      },
    },
  }),
  async (c) => c.json((await listTypes()).filter((type) => type.onSale), 200),
);

adminTicketTypes.openapi(
  createRoute({
    method: "get",
    path: "/all",
    tags: ["Ticket types"],
    summary: "List every ticket type",
    description:
      "Staff or admin. Every type, on sale or not: not set up yet, not open yet or closed; " +
      "`onSale` says which.",
    security: bearerAuth,
    middleware: [requireStaff] as const,
    responses: {
      200: {
        description: "Ticket types",
        content: { "application/json": { schema: z.array(TicketTypeSchema) } },
      },
      403: { description: "Caller is not staff or admin" },
    },
  }),
  async (c) => c.json(await listTypes(), 200),
);

adminTicketTypes.openapi(
  createRoute({
    method: "patch",
    path: "/{id}",
    tags: ["Ticket types"],
    summary: "Update a ticket type",
    description:
      "Admin only. The price can't be changed here: change it in Stripe and sync. " +
      "Capacity cannot go below what is already sold; set it equal to `sold` to stop sales. " +
      "Changing `days`, `isLanParty` or `entries` does not affect tickets already issued; " +
"`packSize` can't change once units are sold, since they were sold as packs of the old size; " +
      "nor can `poolId`, since its tickets give their places back to the pool they took them from. " +
      "Send null for `salesStart` or `salesEnd` to remove that bound.",
    security: bearerAuth,
    ...auditedAs("ticketType.update"),
    middleware: [requireAdmin] as const,
    request: {
      params,
      body: { required: true, content: { "application/json": { schema: UpdateSchema } } },
    },
    responses: {
      200: {
        description: "Updated",
        content: { "application/json": { schema: TicketTypeSchema } },
      },
      400: { description: "Invalid body, an unknown poolId, or the sale window would end before it starts" },
      403: { description: "Caller is not admin" },
      404: { description: "No such ticket type" },
      409: { description: "Capacity is below the number already sold, or a pack size or pool change after sales" },
    },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const patch = c.req.valid("json");
    const db = getFirestore();
    const ref = db.doc(`ticketTypes/${id}`);

    const updated = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const current = snap.data() as Omit<TicketType, "id"> | undefined;
      if (!current) {
        throw new HTTPException(404, { message: "ticket type not found" });
      }

      const sold = current.sold ?? 0;
      if (patch.capacity !== undefined && patch.capacity !== null && patch.capacity < sold) {
        throw new HTTPException(409, {
          message: `capacity ${patch.capacity} is below the ${sold} already sold`,
        });
      }

      const packSize = typeSettings(current).packSize;
      if (patch.packSize !== undefined && patch.packSize !== packSize && sold > 0) {
        throw new HTTPException(409, {
          message: `${sold} units were sold as packs of ${packSize}, so the pack size can't change`,
        });
      }

      // Its tickets took places from the pool they were sold under and give them back there
      const poolId = current.poolId ?? null;
      if (patch.poolId !== undefined && patch.poolId !== poolId && sold > 0) {
        throw new HTTPException(409, {
          message: `${sold} units were sold with ${poolId ? `the shared places ${poolId}` : "no shared places"}, so that can't change`,
        });
      }

      const merged = { ...current, ...patch };
      if (!windowInOrder(merged)) {
        throw new HTTPException(400, { message: WINDOW_ORDER_MESSAGE });
      }

      const pools = new Map<string, CapacityPool>();
      if (merged.poolId) {
        const pool = (await tx.get(db.doc(`${POOLS_COLLECTION}/${merged.poolId}`))).data();
        if (!pool) throw new HTTPException(400, { message: `unknown shared places: ${merged.poolId}` });
        pools.set(merged.poolId, { id: merged.poolId, ...pool } as CapacityPool);
      }

      tx.update(ref, patch);

      // A field sent with the value it already had isn't a change worth recording
      const changes = Object.fromEntries(
        Object.entries(patch)
          .map(([field, to]) => [field, { from: current[field as keyof typeof current] ?? null, to }] as const)
          .filter(([, { from, to }]) => JSON.stringify(from) !== JSON.stringify(to)),
      );
      if (Object.keys(changes).length > 0) {
        audit(tx, {
          actor: c.get("user"),
          action: "ticketType.update",
          target: { id, label: merged.name },
          details: { changes },
        });
      }

      return { merged, pools };
    });

    return c.json(present(id, updated.merged, updated.pools), 200);
  },
);

adminTicketTypes.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["Ticket types"],
    summary: "Make a free ticket type",
    description:
      "Admin only. For tickets given away, like children's, so it needs no Stripe product. It's " +
      "always free: to charge for a type, make it a Stripe product and sync instead. Takes the " +
      "same settings as an update; without days and a capacity it isn't for sale yet. An online " +
      "order can't hold only free tickets.",
    security: bearerAuth,
    ...auditedAs("ticketType.create"),
    middleware: [requireAdmin] as const,
    request: { body: { required: true, content: { "application/json": { schema: CreateSchema } } } },
    responses: {
      201: { description: "Created", content: { "application/json": { schema: TicketTypeSchema } } },
      400: { description: "Invalid body, a price was sent, an unknown poolId, or the sale window ends before it starts" },
      403: { description: "Caller is not admin" },
      409: { description: "The id is taken" },
    },
  }),
  async (c) => {
    const { id, ...fields } = c.req.valid("json");
    const db = getFirestore();
    const ref = db.doc(`ticketTypes/${id}`);

    // Same starting point as a type synced from Stripe, but free and with no Stripe link
    const type: Omit<TicketType, "id"> = {
      price: 0,
      capacity: 0,
      isLanParty: false,
      days: [],
      sold: 0,
      stripeProductId: null,
      stripePriceId: null,
      priceChanges: [],
      category: "general",
      packSize: 1,
      entries: "once",
      extrasFrom: "general",
      description: null,
      features: [],
      disclaimer: null,
      ...fields,
    };
    if (!windowInOrder(type)) {
      throw new HTTPException(400, { message: WINDOW_ORDER_MESSAGE });
    }

    const pools = await db.runTransaction(async (tx) => {
      const [existing, pool] = await Promise.all([
        tx.get(ref),
        type.poolId ? tx.get(db.doc(`${POOLS_COLLECTION}/${type.poolId}`)) : undefined,
      ]);
      if (existing.exists) {
        throw new HTTPException(409, { message: `the id "${id}" is taken by another ticket type` });
      }
      if (pool && !pool.exists) {
        throw new HTTPException(400, { message: `unknown shared places: ${type.poolId}` });
      }
      tx.create(ref, type);
      audit(tx, {
        actor: c.get("user"),
        action: "ticketType.create",
        target: { id, label: type.name },
        details: { fields: type },
      });
      return new Map(pool ? [[pool.id, { id: pool.id, ...pool.data() } as CapacityPool]] : []);
    });

    return c.json(present(id, type, pools), 201);
  },
);

/**
 * A synced type must be archived in Stripe before it's deleted here, or the next sync would
 * recreate it. A product deleted outright in Stripe counts as archived.
 */
async function requireArchivedInStripe(productId: string): Promise<void> {
  let active: boolean;
  try {
    active = (await new Stripe(stripeSecretKey()).products.retrieve(productId)).active;
  } catch (err) {
    if ((err as { code?: string }).code === "resource_missing") return;
    console.error("failed to check the Stripe product before deleting", err);
    throw new HTTPException(502, { message: "could not check the product in Stripe" });
  }
  if (active) {
    throw new HTTPException(409, {
      message: "its Stripe product is still active; archive it in Stripe first, or the next sync brings it back",
    });
  }
}

/** Cancelling or refunding a ticket updates its type's sold counter, so the type must stay. */
function requireNoSales(id: string, type: Omit<TicketType, "id">): void {
  const sold = type.sold ?? 0;
  if (sold > 0) {
    throw new HTTPException(409, {
      message: `${id} has ${sold} sold; set its capacity to ${sold} to stop sales instead`,
    });
  }
}

adminTicketTypes.openapi(
  createRoute({
    method: "delete",
    path: "/{id}",
    tags: ["Ticket types"],
    summary: "Delete a ticket type",
    description:
      "Admin only. A type with tickets sold can't be deleted, since cancelling or refunding " +
      "them needs it; set its capacity to what's sold to stop sales instead. A type synced " +
      "from Stripe can only be deleted once its product is archived in Stripe, or the next sync " +
      "would bring it back.",
    security: bearerAuth,
    ...auditedAs("ticketType.delete"),
    middleware: [requireAdmin] as const,
    request: { params },
    responses: {
      200: { description: "Deleted", content: { "application/json": { schema: z.object({ ok: z.boolean() }) } } },
      403: { description: "Caller is not admin" },
      404: { description: "No such ticket type" },
      409: { description: "It has tickets sold, or its Stripe product is still active" },
      502: { description: "Stripe could not be reached to check the product; nothing was deleted" },
    },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const db = getFirestore();
    const ref = db.doc(`ticketTypes/${id}`);

    // Checked before asking Stripe too, so a type that can't go anyway doesn't send the admin
    // to archive its product
    const stored = (await ref.get()).data() as Omit<TicketType, "id"> | undefined;
    if (stored) requireNoSales(id, stored);
    // Asked before the transaction, since Stripe can't take part in it; the sold check below
    // still runs inside it
    if (stored?.stripeProductId) {
      await requireArchivedInStripe(stored.stripeProductId);
    }

    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const current = snap.data() as Omit<TicketType, "id"> | undefined;
      if (!current) {
        throw new HTTPException(404, { message: "ticket type not found" });
      }
      requireNoSales(id, current);
      tx.delete(ref);
      audit(tx, {
        actor: c.get("user"),
        action: "ticketType.delete",
        target: { id, label: current.name },
        details: { sold: current.sold ?? 0 },
      });
    });

    return c.json({ ok: true }, 200);
  },
);
