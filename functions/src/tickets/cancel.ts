import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { getFirestore } from "firebase-admin/firestore";
import { HTTPException } from "hono/http-exception";

import { requireAdmin, type Env } from "../auth";
import { bearerAuth } from "../schemas";
import type { Ticket, TicketWrite } from "../types";
import { releaseCapacity } from "./capacity";

export const ticketCancel = new OpenAPIHono<Env>();

/**
 * Cancels the tickets that are still live and frees their slots. Already cancelled ones
 * are skipped so repeating this (a Stripe retry, a second click) changes nothing.
 * Returns the ids it actually cancelled.
 */
export function cancelInTransaction(
  tx: FirebaseFirestore.Transaction,
  docs: FirebaseFirestore.DocumentSnapshot[],
): string[] {
  const live = docs.filter((doc) => {
    const ticket = doc.data() as Ticket | undefined;
    return ticket !== undefined && ticket.status !== "cancelled";
  });

  for (const doc of live) {
    tx.update(doc.ref, { status: "cancelled" } satisfies Partial<TicketWrite>);
  }

  releaseCapacity(tx, live.map((doc) => (doc.data() as Ticket).typeId));

  return live.map((doc) => doc.id);
}

ticketCancel.openapi(
  createRoute({
    method: "post",
    path: "/{id}/cancel",
    tags: ["Tickets"],
    summary: "Cancel a ticket",
    description:
      "Admin only. Voids the ticket and frees its capacity. Does not refund: issue the refund " +
      "in Stripe, which cancels the tickets through the webhook. Repeating this is harmless.",
    security: bearerAuth,
    middleware: [requireAdmin] as const,
    request: {
      params: z.object({ id: z.string().min(1).openapi({ param: { name: "id", in: "path" } }) }),
    },
    responses: {
      200: {
        description: "Ticket is cancelled",
        content: {
          "application/json": {
            schema: z.object({ id: z.string(), status: z.literal("cancelled"), changed: z.boolean() }),
          },
        },
      },
      403: { description: "Caller is not admin" },
      404: { description: "No such ticket" },
    },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const db = getFirestore();
    const ref = db.doc(`tickets/${id}`);

    const changed = await db.runTransaction(async (tx) => {
      const doc = await tx.get(ref);
      if (!doc.exists) {
        throw new HTTPException(404, { message: "ticket not found" });
      }
      return cancelInTransaction(tx, [doc]).length > 0;
    });

    return c.json({ id, status: "cancelled" as const, changed }, 200);
  },
);
