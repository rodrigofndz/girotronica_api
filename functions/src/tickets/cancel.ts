import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { getFirestore } from "firebase-admin/firestore";
import { HTTPException } from "hono/http-exception";

import { audit, type AuditActor, auditedAs } from "../audit/audit";
import { requireStaff, type Env } from "../auth";
import { bearerAuth } from "../schemas";
import type { Ticket, TicketWrite } from "../types";
import { releaseExtras } from "../extras/stock";
import { releaseCapacity, releasePlaces, unitsFreedBy } from "./capacity";

export const ticketCancel = new OpenAPIHono<Env>();

const liveTickets = (docs: FirebaseFirestore.DocumentSnapshot[]) => docs
  .filter((doc) => {
    const ticket = doc.data() as Ticket | undefined;
    return ticket !== undefined && ticket.status !== "cancelled";
  })
  .map((doc) => ({ id: doc.id, ref: doc.ref, ticket: doc.data() as Ticket }));

/**
 * Cancels the tickets that are still live and frees their slots: a single ticket's at once,
 * a pack's only when its last ticket goes. Shared places come back one per ticket, packs
 * included. The extras bought with them go back to stock. Already cancelled ones are skipped so repeating
 * this (a Stripe retry, a second click) changes nothing. A host's companion goes with it,
 * logged as `actor`'s ticket.cancelWithHost; a companion going alone frees its host to take
 * another. Reads before it writes, so call it before anything else in the transaction writes.
 * Returns the tickets it was asked to cancel and actually did, as they were before, so
 * callers can log them.
 */
export async function cancelInTransaction(
  tx: FirebaseFirestore.Transaction,
  docs: FirebaseFirestore.DocumentSnapshot[],
  actor: AuditActor,
): Promise<{ id: string; ticket: Ticket }[]> {
  const db = getFirestore();
  const live = liveTickets(docs);
  const asked = new Set(live.map(({ id }) => id));

  const companionIds = live.flatMap(({ ticket }) =>
    ticket.companionId && !asked.has(ticket.companionId) ? [ticket.companionId] : []);
  const companions = companionIds.length > 0
    ? liveTickets(await tx.getAll(...companionIds.map((id) => db.doc(`tickets/${id}`))))
    : [];
  const all = [...live, ...companions];
  const going = new Set(all.map(({ id }) => id));

  const hostIds = all.flatMap(({ ticket }) =>
    ticket.companionOf && !going.has(ticket.companionOf) ? [ticket.companionOf] : []);
  const hosts = hostIds.length > 0 ? await tx.getAll(...hostIds.map((id) => db.doc(`tickets/${id}`))) : [];

  const freed = await unitsFreedBy(tx, all);

  for (const { ref } of all) {
    tx.update(ref, { status: "cancelled" } satisfies Partial<TicketWrite>);
  }
  releaseCapacity(tx, freed);
  releasePlaces(tx, all.map(({ ticket }) => ticket));
  releaseExtras(tx, all.map(({ ticket }) => ticket));

  for (const host of hosts) {
    if (host.exists && going.has((host.data() as Ticket).companionId ?? "")) {
      tx.update(host.ref, { companionId: null } satisfies Partial<TicketWrite>);
    }
  }
  for (const { id, ticket } of companions) {
    audit(tx, {
      actor,
      action: "ticket.cancelWithHost",
      target: { id, label: ticket.holderName },
      details: { hostId: ticket.companionOf!, previousStatus: ticket.status },
    });
  }

  return live.map(({ id, ticket }) => ({ id, ticket }));
}

ticketCancel.openapi(
  createRoute({
    method: "post",
    path: "/{id}/cancel",
    tags: ["Tickets"],
    summary: "Cancel a ticket",
    description:
      "Staff or admin. Voids the ticket and frees its capacity, and its companion's if it has " +
      "one; cancelling a companion alone lets its ticket take another. Does not refund: issue the " +
      "refund in Stripe, which cancels the tickets through the webhook. Repeating this is harmless.",
    security: bearerAuth,
    ...auditedAs("ticket.cancel", "ticket.cancelWithHost"),
    middleware: [requireStaff] as const,
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
      403: { description: "Caller is not staff or admin" },
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
      const cancelled = await cancelInTransaction(tx, [doc], c.get("user"));
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
