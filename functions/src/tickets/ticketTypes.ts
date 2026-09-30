import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { getFirestore } from "firebase-admin/firestore";
import { HTTPException } from "hono/http-exception";
import Stripe from "stripe";

import { audit, auditedAs } from "../audit/audit";
import { requireAdmin, type Env } from "../auth";
import { bearerAuth } from "../schemas";
import { stripeSecretKey } from "../stripe";
import type { TicketType } from "../types";
import { isOnSale } from "./capacity";

export const ticketTypes = new OpenAPIHono<Env>();
export const adminTicketTypes = new OpenAPIHono<Env>();

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
  price: z.int().nonnegative().openapi({ description: "Cents; comes from Stripe and only changes there" }),
  capacity: z.int().nonnegative().nullable(), // 0 means not for sale, null unlimited
  isLanParty: z.boolean(),
  days: z.array(isoDate).openapi({ description: "Empty on a type just synced from Stripe, until an admin sets it" }),
  salesStart: saleBound.optional().openapi({ description: "When sales open; null or absent means already open" }),
  salesEnd: saleBound.optional().openapi({ description: "When sales close (exclusive); null or absent means never" }),
  sold: z.int().nonnegative(),
  remaining: z.int().nonnegative().nullable(),
  onSale: z.boolean().openapi({
    description: "Whether it can be bought now: days set and the sale window open, by the server's clock",
  }),
  stripeProductId: z.string().nullable().openapi({ description: "The Stripe product it was synced from" }),
});

const windowInOrder = (type: { salesStart?: string | null; salesEnd?: string | null }) =>
  !type.salesStart || !type.salesEnd || type.salesStart < type.salesEnd;

const WINDOW_ORDER_MESSAGE = "salesStart must be before salesEnd";

// What the web may change. Price, name source and the Stripe link come from the Stripe sync;
// strict so trying to set one of those (or `sold`) is an error, not silently ignored.
// Only checks the window when both ends are in the patch; the handler checks it against the stored type
const UpdateSchema = TicketTypeSchema.pick({
  name: true, capacity: true, isLanParty: true, salesStart: true, salesEnd: true,
})
  .extend({ days: z.array(isoDate).min(1) })
  .partial()
  .strict();

const params = z.object({
  id: z.string().min(1).openapi({ param: { name: "id", in: "path" } }),
});

function present(id: string, type: Omit<TicketType, "id">) {
  const sold = type.sold ?? 0;
  return {
    id,
    name: type.name,
    price: type.price,
    capacity: type.capacity,
    isLanParty: type.isLanParty,
    days: type.days,
    salesStart: type.salesStart ?? null,
    salesEnd: type.salesEnd ?? null,
    sold,
    remaining: type.capacity === null ? null : Math.max(type.capacity - sold, 0),
    onSale: isOnSale(type),
    stripeProductId: type.stripeProductId ?? null,
  };
}

ticketTypes.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["Ticket types"],
    summary: "List ticket types on sale",
    description:
      "Public. Includes how many are left and whether each type is on sale right now, " +
      "so the site can show what is sold out, coming soon or closed.",
    responses: {
      200: {
        description: "Ticket types",
        content: { "application/json": { schema: z.array(TicketTypeSchema) } },
      },
    },
  }),
  async (c) => {
    const snap = await getFirestore().collection("ticketTypes").get();
    return c.json(
      snap.docs.map((d) => present(d.id, d.data() as Omit<TicketType, "id">)),
      200,
    );
  },
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
      "Changing `days` or `isLanParty` does not affect tickets already issued. " +
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
      400: { description: "Invalid body, or the sale window would end before it starts" },
      403: { description: "Caller is not admin" },
      404: { description: "No such ticket type" },
      409: { description: "Capacity is below the number already sold" },
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

      const merged = { ...current, ...patch };
      if (!windowInOrder(merged)) {
        throw new HTTPException(400, { message: WINDOW_ORDER_MESSAGE });
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

      return merged;
    });

    return c.json(present(id, updated), 200);
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

adminTicketTypes.openapi(
  createRoute({
    method: "delete",
    path: "/{id}",
    tags: ["Ticket types"],
    summary: "Delete a ticket type",
    description:
      "Admin only. For now it deletes even a type with tickets sold (while testing); those tickets " +
      "still work at the door but can no longer be cancelled or refunded through the API. A type " +
      "synced from Stripe can only be deleted once its product is archived in Stripe, or the next " +
      "sync would bring it back.",
    security: bearerAuth,
    ...auditedAs("ticketType.delete"),
    middleware: [requireAdmin] as const,
    request: { params },
    responses: {
      200: { description: "Deleted", content: { "application/json": { schema: z.object({ ok: z.boolean() }) } } },
      403: { description: "Caller is not admin" },
      404: { description: "No such ticket type" },
      409: { description: "Its Stripe product is still active" },
      502: { description: "Stripe could not be reached to check the product; nothing was deleted" },
    },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const db = getFirestore();
    const ref = db.doc(`ticketTypes/${id}`);

    // Asked before the transaction, since Stripe can't take part in it; the sold check below
    // still runs inside it
    const linkedProduct = ((await ref.get()).data() as Omit<TicketType, "id"> | undefined)?.stripeProductId;
    if (linkedProduct) {
      await requireArchivedInStripe(linkedProduct);
    }

    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const current = snap.data() as Omit<TicketType, "id"> | undefined;
      if (!current) {
        throw new HTTPException(404, { message: "ticket type not found" });
      }
      // TEMPORARY while testing: types with tickets sold can be deleted too. Those tickets keep
      // their days so check-in still works, but cancelling one fails, since that updates this
      // type's sold counter. Restore the refusal below before real sales:
      //   if ((current.sold ?? 0) > 0) throw new HTTPException(409, { message: ... });
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
