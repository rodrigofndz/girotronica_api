import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { getFirestore } from "firebase-admin/firestore";
import { HTTPException } from "hono/http-exception";

import { audit, auditedAs } from "../audit/audit";
import { requireAdmin, requireStaff, type Env } from "../auth";
import { bearerAuth } from "../schemas";
import { isOnSale } from "../tickets/capacity";
import { EXTRA_GROUPS, type Extra, type TicketType, typeSettings } from "../types";

export const extras = new OpenAPIHono<Env>();
export const adminExtras = new OpenAPIHono<Env>();

const EXTRA_ID = /^[a-z0-9-]+$/;

const ExtraSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  price: z.int().nonnegative().openapi({
    description: "Cents; comes from Stripe and only changes there. Always 0 for an extra made in the admin",
  }),
  options: z.array(z.string()).openapi({ description: "e.g. sizes; when not empty the buyer must pick one" }),
  consent: z.string().nullable().openapi({ description: "Text the buyer accepts by choosing this extra" }),
  groups: z.array(z.enum(EXTRA_GROUPS)).openapi({
    description: "Offered with ticket types whose extrasFrom is one of these; empty: not offered",
  }),
  capacity: z.int().nonnegative().nullable().openapi({ description: "Total stock; null for unlimited" }),
  sold: z.int().nonnegative(),
  remaining: z.int().nonnegative().nullable(),
  stripeProductId: z.string().nullable().openapi({
    description: "The Stripe product it was synced from; null for a free extra made in the admin",
  }),
});

// Price and the Stripe link come from the sync; strict so trying to set them is an error
const UpdateSchema = ExtraSchema.pick({
  name: true, description: true, options: true, consent: true, groups: true, capacity: true,
})
  .extend({
    name: z.string().min(1),
    options: z.array(z.string().trim().min(1)).refine((o) => new Set(o).size === o.length, "options must be unique"),
    groups: z.array(z.enum(EXTRA_GROUPS)).refine((g) => new Set(g).size === g.length, "groups must be unique"),
  })
  .partial()
  .strict();

// No price: one made here is free, and charging means making it a Stripe product instead
const CreateSchema = UpdateSchema.extend({
  id: z.string().regex(EXTRA_ID, "lowercase letters, digits and dashes only"),
  name: z.string().trim().min(1),
}).strict();

const params = z.object({
  id: z.string().min(1).openapi({ param: { name: "id", in: "path" } }),
});

function present(id: string, extra: Omit<Extra, "id">) {
  const sold = extra.sold ?? 0;
  return {
    id,
    name: extra.name,
    description: extra.description ?? null,
    price: extra.price,
    options: extra.options ?? [],
    consent: extra.consent ?? null,
    groups: extra.groups ?? [],
    capacity: extra.capacity ?? null,
    sold,
    remaining: extra.capacity === null || extra.capacity === undefined ? null : Math.max(extra.capacity - sold, 0),
    stripeProductId: extra.stripeProductId,
  };
}

const listExtras = async () =>
  (await getFirestore().collection("extras").get()).docs
    .map((d) => present(d.id, d.data() as Omit<Extra, "id">));

extras.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["Extras"],
    summary: "List extras",
    description:
      "Public. Only the extras some ticket type on sale offers: a ticket offers those whose " +
      "`groups` include its type's `extrasFrom`. Sold-out ones stay, with nothing remaining. " +
      "Staff and admins see them all in GET /extras/all.",
    responses: {
      200: { description: "Extras", content: { "application/json": { schema: z.array(ExtraSchema) } } },
    },
  }),
  async (c) => {
    const types = await getFirestore().collection("ticketTypes").get();
    const offered = new Set(types.docs
      .map((d) => d.data() as TicketType)
      .filter((type) => isOnSale(type))
      .map((type) => typeSettings(type).extrasFrom));

    const listed = (await listExtras()).filter((extra) => extra.groups.some((group) => offered.has(group)));
    return c.json(listed, 200);
  },
);

adminExtras.openapi(
  createRoute({
    method: "get",
    path: "/all",
    tags: ["Extras"],
    summary: "List every extra",
    description: "Staff or admin. Every extra, offered with a ticket type on sale or not.",
    security: bearerAuth,
    middleware: [requireStaff] as const,
    responses: {
      200: { description: "Extras", content: { "application/json": { schema: z.array(ExtraSchema) } } },
      403: { description: "Caller is not staff or admin" },
    },
  }),
  async (c) => c.json(await listExtras(), 200),
);

adminExtras.openapi(
  createRoute({
    method: "patch",
    path: "/{id}",
    tags: ["Extras"],
    summary: "Update an extra",
    description:
      "Admin only. The price can't be changed here: change it in Stripe and sync. " +
      "Capacity can't go below what's already sold.",
    security: bearerAuth,
    ...auditedAs("extra.update"),
    middleware: [requireAdmin] as const,
    request: {
      params,
      body: { required: true, content: { "application/json": { schema: UpdateSchema } } },
    },
    responses: {
      200: { description: "Updated", content: { "application/json": { schema: ExtraSchema } } },
      400: { description: "Invalid body" },
      403: { description: "Caller is not admin" },
      404: { description: "No such extra" },
      409: { description: "Capacity is below the number already sold" },
    },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const patch = c.req.valid("json");
    const db = getFirestore();
    const ref = db.doc(`extras/${id}`);

    const updated = await db.runTransaction(async (tx) => {
      const current = (await tx.get(ref)).data() as Omit<Extra, "id"> | undefined;
      if (!current) {
        throw new HTTPException(404, { message: "extra not found" });
      }

      const sold = current.sold ?? 0;
      if (patch.capacity !== undefined && patch.capacity !== null && patch.capacity < sold) {
        throw new HTTPException(409, { message: `capacity ${patch.capacity} is below the ${sold} already sold` });
      }

      const changes = Object.fromEntries(
        Object.entries(patch)
          .map(([field, to]) => [field, { from: current[field as keyof typeof current] ?? null, to }] as const)
          .filter(([, { from, to }]) => JSON.stringify(from) !== JSON.stringify(to)),
      );

      tx.update(ref, patch);
      if (Object.keys(changes).length > 0) {
        audit(tx, {
          actor: c.get("user"),
          action: "extra.update",
          target: { id, label: patch.name ?? current.name },
          details: { changes },
        });
      }
      return { ...current, ...patch };
    });

    return c.json(present(id, updated), 200);
  },
);

adminExtras.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["Extras"],
    summary: "Make a free extra",
    description:
      "Admin only. For something given away with a ticket (a welcome pack, a dormitory place), " +
      "so it needs no Stripe product. It's always free: to charge for something, make it a " +
      "Stripe product with metadata kind = extra and sync instead. Not offered with any ticket " +
      "until it has `groups`.",
    security: bearerAuth,
    ...auditedAs("extra.create"),
    middleware: [requireAdmin] as const,
    request: { body: { required: true, content: { "application/json": { schema: CreateSchema } } } },
    responses: {
      201: { description: "Created", content: { "application/json": { schema: ExtraSchema } } },
      400: { description: "Invalid body, or a price was sent" },
      403: { description: "Caller is not admin" },
      409: { description: "The id is taken" },
    },
  }),
  async (c) => {
    const { id, ...fields } = c.req.valid("json");
    const db = getFirestore();
    const extra: Omit<Extra, "id"> = {
      name: fields.name,
      description: fields.description ?? null,
      price: 0,
      options: fields.options ?? [],
      consent: fields.consent ?? null,
      groups: fields.groups ?? [],
      capacity: fields.capacity ?? null,
      sold: 0,
      stripeProductId: null,
      stripePriceId: null,
    };

    await db.runTransaction(async (tx) => {
      const ref = db.doc(`extras/${id}`);
      if ((await tx.get(ref)).exists) {
        throw new HTTPException(409, { message: `the id "${id}" is taken by another extra` });
      }
      tx.create(ref, extra);
      audit(tx, {
        actor: c.get("user"),
        action: "extra.create",
        target: { id, label: extra.name },
        details: { fields: extra },
      });
    });

    return c.json(present(id, extra), 201);
  },
);

adminExtras.openapi(
  createRoute({
    method: "delete",
    path: "/{id}",
    tags: ["Extras"],
    summary: "Delete a free extra",
    description:
      "Admin only, for extras made in the admin and only before any is sold, since cancelling " +
      "a ticket gives its extras back to their stock. To stop offering one that has sold, empty " +
      "its `groups`. An extra from Stripe stops by archiving its product there and syncing.",
    security: bearerAuth,
    ...auditedAs("extra.delete"),
    middleware: [requireAdmin] as const,
    request: { params },
    responses: {
      200: { description: "Deleted", content: { "application/json": { schema: z.object({ ok: z.boolean() }) } } },
      403: { description: "Caller is not admin" },
      404: { description: "No such extra" },
      409: { description: "It comes from Stripe, or some have been sold" },
    },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const db = getFirestore();
    const ref = db.doc(`extras/${id}`);

    await db.runTransaction(async (tx) => {
      const current = (await tx.get(ref)).data() as Omit<Extra, "id"> | undefined;
      if (!current) throw new HTTPException(404, { message: "extra not found" });
      if (current.stripeProductId) {
        throw new HTTPException(409, {
          message: `${id} comes from Stripe; archive its product there and sync to stop offering it`,
        });
      }
      const sold = current.sold ?? 0;
      if (sold > 0) {
        throw new HTTPException(409, { message: `${id} has ${sold} sold; empty its groups to stop offering it instead` });
      }
      tx.delete(ref);
      audit(tx, {
        actor: c.get("user"),
        action: "extra.delete",
        target: { id, label: current.name },
        details: {},
      });
    });

    return c.json({ ok: true }, 200);
  },
);
