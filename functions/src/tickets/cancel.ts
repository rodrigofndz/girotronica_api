import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { getFirestore } from "firebase-admin/firestore";
import { HTTPException } from "hono/http-exception";

import { audit, auditedAs } from "../audit/audit";
import { requireAdmin, type Env } from "../auth";
import { bearerAuth } from "../schemas";
import type { Ticket, TicketWrite } from "../types";
import { releaseExtras } from "../extras/stock";
import { releaseCapacity, unitsFreedBy } from "./capacity";

export const ticketCancel = new OpenAPIHono<Env>();

/**
 * Cancels the tickets that are still live and frees their slots: a single ticket's at once,
 * a pack's only when its last ticket goes. The extras bought with them go back to stock. Already cancelled ones are skipped so repeating
 * this (a Stripe retry, a second click) changes nothing. Reads before it writes, so call it
 * before anything else in the transaction writes. Returns the tickets it actually
 * cancelled, as they were before, so callers can log them.
 */
export async function cancelInTransaction(
  tx: FirebaseFirestore.Transaction,
  docs: FirebaseFirestore.DocumentSnapshot[],
): Promise<{ id: string; ticket: Ticket }[]> {
  const live = docs
    .filter((doc) => {
      const ticket = doc.data() as Ticket | undefined;
      return ticket !== undefined && ticket.status !== "cancelled";
    })
    .map((doc) => ({ id: doc.id, ref: doc.ref, ticket: doc.data() as Ticket }));

  const freed = await unitsFreedBy(tx, live);

  for (const { ref } of live) {
    tx.update(ref, { status: "cancelled" } satisfies Partial<TicketWrite>);
  }
  releaseCapacity(tx, freed);
  releaseExtras(tx, live.map(({ ticket }) => ticket));

  return live.map(({ id, ticket }) => ({ id, ticket }));
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
    ...auditedAs("ticket.cancel"),
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
      const cancelled = await cancelInTransaction(tx, [doc]);
      for (const { id: ticketId, ticket } of cancelled) {
        audit(tx, {
          actor: c.get("user"),
          action: "ticket.cancel",
          target: { id: ticketId, label: ticket.holderName },
          details: { previousStatus: ticket.status },
        });
      }
      return cancelled.length > 0;
    });

    return c.json({ id, status: "cancelled" as const, changed }, 200);
  },
);
