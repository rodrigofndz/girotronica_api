import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { getFirestore } from "firebase-admin/firestore";
import { HTTPException } from "hono/http-exception";

import { audit, auditedAs } from "../audit/audit";
import { requireAdmin, type Env } from "../auth";
import { bearerAuth } from "../schemas";
import type { CapacityPool } from "../types";
import { POOLS_COLLECTION } from "./capacity";

export const capacityPools = new OpenAPIHono<Env>();

const POOL_ID = /^[a-z0-9-]+$/;

const PoolSchema = z.object({
  id: z.string(),
  name: z.string(),
  capacity: z.int().nonnegative().openapi({ description: "Places, one per person" }),
  sold: z.int().nonnegative().openapi({ description: "Places taken by live tickets, pending or active" }),
  remaining: z.int().nonnegative(),
  typeIds: z.array(z.string()).openapi({ description: "The ticket types that sell from it" }),
});

const CreateSchema = z.object({
  id: z.string().regex(POOL_ID, "lowercase letters, digits and dashes only"),
  name: z.string().trim().min(1),
  capacity: z.int().nonnegative(),
}).strict();

const UpdateSchema = CreateSchema.omit({ id: true }).partial().strict();

const params = z.object({
  id: z.string().min(1).openapi({ param: { name: "id", in: "path" } }),
});

type StoredPool = Omit<CapacityPool, "id">;

function present(id: string, pool: StoredPool, typeIds: string[]) {
  return {
    id,
    name: pool.name,
    capacity: pool.capacity,
    sold: pool.sold,
    remaining: Math.max(pool.capacity - pool.sold, 0),
    typeIds,
  };
}

const typesOf = async (poolId: string) =>
  (await getFirestore().collection("ticketTypes").where("poolId", "==", poolId).get()).docs.map((d) => d.id);

capacityPools.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["Capacity pools"],
    summary: "List shared places",
    description:
      "Admin only. Places several ticket types sell from, e.g. the LAN seats shared by the LAN " +
      "ticket and the LAN pack. Each ticket takes one, so a pack takes one per person; a sale must " +
      "fit both its type's capacity and its pool.",
    security: bearerAuth,
    middleware: [requireAdmin] as const,
    responses: {
      200: { description: "Pools", content: { "application/json": { schema: z.array(PoolSchema) } } },
      403: { description: "Caller is not admin" },
    },
  }),
  async (c) => {
    const db = getFirestore();
    const [pools, types] = await Promise.all([
      db.collection(POOLS_COLLECTION).get(),
      db.collection("ticketTypes").get(),
    ]);
    const typeIds = (poolId: string) => types.docs.filter((d) => d.get("poolId") === poolId).map((d) => d.id);
    return c.json(pools.docs.map((d) => present(d.id, d.data() as StoredPool, typeIds(d.id))), 200);
  },
);

capacityPools.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["Capacity pools"],
    summary: "Create shared places",
    description: "Admin only. Then point ticket types at it with their `poolId`.",
    security: bearerAuth,
    ...auditedAs("capacityPool.create"),
    middleware: [requireAdmin] as const,
    request: { body: { required: true, content: { "application/json": { schema: CreateSchema } } } },
    responses: {
      201: { description: "Created", content: { "application/json": { schema: PoolSchema } } },
      400: { description: "Invalid body" },
      403: { description: "Caller is not admin" },
      409: { description: "The id is taken" },
    },
  }),
  async (c) => {
    const { id, name, capacity } = c.req.valid("json");
    const db = getFirestore();
    const pool: StoredPool = { name, capacity, sold: 0 };

    await db.runTransaction(async (tx) => {
      const ref = db.doc(`${POOLS_COLLECTION}/${id}`);
      if ((await tx.get(ref)).exists) {
        throw new HTTPException(409, { message: `shared places ${id} already exist` });
      }
      tx.create(ref, pool);
      audit(tx, {
        actor: c.get("user"),
        action: "capacityPool.create",
        target: { id, label: name },
        details: { name, capacity },
      });
    });

    return c.json(present(id, pool, []), 201);
  },
);

capacityPools.openapi(
  createRoute({
    method: "patch",
    path: "/{id}",
    tags: ["Capacity pools"],
    summary: "Update shared places",
    description: "Admin only. Capacity can't go below the places already taken.",
    security: bearerAuth,
    ...auditedAs("capacityPool.update"),
    middleware: [requireAdmin] as const,
    request: {
      params,
      body: { required: true, content: { "application/json": { schema: UpdateSchema } } },
    },
    responses: {
      200: { description: "Updated", content: { "application/json": { schema: PoolSchema } } },
      400: { description: "Invalid body" },
      403: { description: "Caller is not admin" },
      404: { description: "No such pool" },
      409: { description: "Capacity is below the places already taken" },
    },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const patch = c.req.valid("json");
    const db = getFirestore();
    const ref = db.doc(`${POOLS_COLLECTION}/${id}`);

    const updated = await db.runTransaction(async (tx) => {
      const current = (await tx.get(ref)).data() as StoredPool | undefined;
      if (!current) throw new HTTPException(404, { message: "shared places not found" });
      if (patch.capacity !== undefined && patch.capacity < current.sold) {
        throw new HTTPException(409, { message: `capacity ${patch.capacity} is below the ${current.sold} places taken` });
      }

      const changes = Object.fromEntries(
        Object.entries(patch)
          .map(([field, to]) => [field, { from: current[field as keyof StoredPool], to }] as const)
          .filter(([, { from, to }]) => from !== to),
      );
      tx.update(ref, patch);
      if (Object.keys(changes).length > 0) {
        audit(tx, {
          actor: c.get("user"),
          action: "capacityPool.update",
          target: { id, label: patch.name ?? current.name },
          details: { changes },
        });
      }
      return { ...current, ...patch };
    });

    return c.json(present(id, updated, await typesOf(id)), 200);
  },
);

capacityPools.openapi(
  createRoute({
    method: "delete",
    path: "/{id}",
    tags: ["Capacity pools"],
    summary: "Delete shared places",
    description:
      "Admin only. Only when no ticket type sells from it and no places are taken; take it off " +
      "its types first (possible only before they sell).",
    security: bearerAuth,
    ...auditedAs("capacityPool.delete"),
    middleware: [requireAdmin] as const,
    request: { params },
    responses: {
      200: { description: "Deleted", content: { "application/json": { schema: z.object({ ok: z.boolean() }) } } },
      403: { description: "Caller is not admin" },
      404: { description: "No such pool" },
      409: { description: "Ticket types still sell from it, or places are taken" },
    },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const db = getFirestore();
    const ref = db.doc(`${POOLS_COLLECTION}/${id}`);

    await db.runTransaction(async (tx) => {
      const [snap, users] = await Promise.all([
        tx.get(ref),
        tx.get(db.collection("ticketTypes").where("poolId", "==", id)),
      ]);
      const current = snap.data() as StoredPool | undefined;
      if (!current) throw new HTTPException(404, { message: "shared places not found" });
      if (!users.empty) {
        throw new HTTPException(409, {
          message: `still used by ${users.docs.map((d) => d.id).join(", ")}; take it off them first`,
        });
      }
      if (current.sold > 0) {
        throw new HTTPException(409, { message: `${current.sold} places are taken` });
      }
      tx.delete(ref);
      audit(tx, {
        actor: c.get("user"),
        action: "capacityPool.delete",
        target: { id, label: current.name },
        details: { capacity: current.capacity },
      });
    });

    return c.json({ ok: true }, 200);
  },
);
