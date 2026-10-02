import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { getFirestore } from "firebase-admin/firestore";
import { HTTPException } from "hono/http-exception";

import { audit, auditedAs } from "../audit/audit";
import { requireAdmin, type Env } from "../auth";
import { bearerAuth } from "../schemas";
import { EXTRA_GROUPS, type Extra } from "../types";

export const extras = new OpenAPIHono<Env>();
export const adminExtras = new OpenAPIHono<Env>();

const ExtraSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  price: z.int().nonnegative().openapi({ description: "Cents; comes from Stripe and only changes there" }),
  options: z.array(z.string()).openapi({ description: "e.g. sizes; when not empty the buyer must pick one" }),
  consent: z.string().nullable().openapi({ description: "Text the buyer accepts by choosing this extra" }),
  groups: z.array(z.enum(EXTRA_GROUPS)).openapi({
    description: "Offered with ticket types whose extrasFrom is one of these; empty: not offered",
  }),
  capacity: z.int().nonnegative().nullable().openapi({ description: "Total stock; null for unlimited" }),
  sold: z.int().nonnegative(),
  remaining: z.int().nonnegative().nullable(),
  stripeProductId: z.string(),
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

extras.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["Extras"],
    summary: "List extras",
    description:
      "Public. Every extra with what's left; a ticket offers those whose `groups` include its " +
      "type's `extrasFrom`. Extras with no groups aren't offered yet.",
    responses: {
      200: { description: "Extras", content: { "application/json": { schema: z.array(ExtraSchema) } } },
    },
  }),
  async (c) => {
    const snap = await getFirestore().collection("extras").get();
    return c.json(snap.docs.map((d) => present(d.id, d.data() as Omit<Extra, "id">)), 200);
  },
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
      params: z.object({ id: z.string().min(1).openapi({ param: { name: "id", in: "path" } }) }),
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
