import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { getFirestore } from "firebase-admin/firestore";
import { HTTPException } from "hono/http-exception";

import { requireAdmin, type Env } from "../auth";
import { bearerAuth } from "../schemas";
import type { TicketType } from "../types";

export const ticketTypes = new OpenAPIHono<Env>();
export const adminTicketTypes = new OpenAPIHono<Env>();

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be an ISO date (YYYY-MM-DD)");

const TicketTypeSchema = z.object({
  id: z.string(),
  name: z.string(),
  price: z.int().nonnegative(),
  capacity: z.int().nonnegative().nullable(), // 0 means not for sale, null unlimited
  isLanParty: z.boolean(),
  days: z.array(isoDate).min(1),
  sold: z.int().nonnegative(),
  remaining: z.int().nonnegative().nullable(),
});

// strict so a misspelled or system-managed field (like `sold`) is an error, not ignored
const CreateSchema = TicketTypeSchema.omit({ sold: true, remaining: true })
  .extend({ id: z.string().regex(/^[a-z0-9-]+$/, "must be lowercase letters, numbers and dashes") })
  .strict();

const UpdateSchema = CreateSchema.omit({ id: true }).partial().strict();

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
    sold,
    remaining: type.capacity === null ? null : Math.max(type.capacity - sold, 0),
  };
}

ticketTypes.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["Ticket types"],
    summary: "List ticket types on sale",
    description: "Public. Includes how many are left so the site can show what is sold out.",
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
    method: "post",
    path: "/",
    tags: ["Ticket types"],
    summary: "Create a ticket type",
    description: "Admin only. `sold` is maintained by the API and cannot be set here.",
    security: bearerAuth,
    middleware: [requireAdmin] as const,
    request: {
      body: { required: true, content: { "application/json": { schema: CreateSchema } } },
    },
    responses: {
      200: {
        description: "Created",
        content: { "application/json": { schema: TicketTypeSchema } },
      },
      400: { description: "Invalid body" },
      403: { description: "Caller is not admin" },
      409: { description: "A ticket type with that id already exists" },
    },
  }),
  async (c) => {
    const { id, ...type } = c.req.valid("json");
    const ref = getFirestore().doc(`ticketTypes/${id}`);

    try {
      await ref.create({ ...type, sold: 0 });
    } catch {
      throw new HTTPException(409, { message: `ticket type already exists: ${id}` });
    }

    return c.json(present(id, { ...type, sold: 0 }), 200);
  },
);

adminTicketTypes.openapi(
  createRoute({
    method: "patch",
    path: "/{id}",
    tags: ["Ticket types"],
    summary: "Update a ticket type",
    description:
      "Admin only. Capacity cannot go below what is already sold; set it equal to `sold` to stop sales. " +
      "Changing `days` or `isLanParty` does not affect tickets already issued.",
    security: bearerAuth,
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
      400: { description: "Invalid body" },
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

      tx.update(ref, patch);
      return { ...current, ...patch };
    });

    return c.json(present(id, updated), 200);
  },
);

adminTicketTypes.openapi(
  createRoute({
    method: "delete",
    path: "/{id}",
    tags: ["Ticket types"],
    summary: "Delete a ticket type",
    description: "Admin only. Refused once tickets exist for it, since they reference it.",
    security: bearerAuth,
    middleware: [requireAdmin] as const,
    request: { params },
    responses: {
      200: { description: "Deleted", content: { "application/json": { schema: z.object({ ok: z.boolean() }) } } },
      403: { description: "Caller is not admin" },
      404: { description: "No such ticket type" },
      409: { description: "Tickets have already been sold for this type" },
    },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const db = getFirestore();
    const ref = db.doc(`ticketTypes/${id}`);

    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const current = snap.data() as Omit<TicketType, "id"> | undefined;
      if (!current) {
        throw new HTTPException(404, { message: "ticket type not found" });
      }
      if ((current.sold ?? 0) > 0) {
        throw new HTTPException(409, {
          message: `${current.sold} tickets exist for ${id}; set capacity to stop sales instead`,
        });
      }
      tx.delete(ref);
    });

    return c.json({ ok: true }, 200);
  },
);
