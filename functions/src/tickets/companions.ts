import { z } from "@hono/zod-openapi";
import { getFirestore } from "firebase-admin/firestore";
import { HTTPException } from "hono/http-exception";

import type { User } from "../auth";
import { COMPANIONS_ADMIN_ONLY } from "../features";
import { type Ticket, type TicketType, typeSettings } from "../types";

/**
 * Who a companion ticket goes with: the position of another person in the same sale (from 0),
 * or the id of a ticket already sold. One companion per ticket, and only with a ticket whose
 * type allowsCompanion.
 */
export const WITH_DESCRIPTION =
  "Only for a companion type (isCompanion), and required there: who it goes with. The position " +
  "of another person in this same list (from 0), or the id of a ticket already sold. That " +
  "ticket's type must allowsCompanion, and it takes one companion.";

export const WithSchema = z.union([z.int().nonnegative(), z.string().min(1)]).optional()
  .openapi({ description: WITH_DESCRIPTION });

/** Whether `user` may see and get companion types now (see COMPANIONS_ADMIN_ONLY). */
export const seesCompanions = (user: User | undefined) => !COMPANIONS_ADMIN_ONLY || user?.role === "admin";

/** Refuses companion types to anyone who can't get them yet, as if they weren't on sale. */
export function refuseHiddenCompanions(types: Map<string, Omit<TicketType, "id">>, user: User | undefined) {
  if (seesCompanions(user)) return;
  for (const [id, type] of types) {
    if (typeSettings(type).isCompanion) throw new HTTPException(409, { message: `not on sale: ${id}` });
  }
}

/** A host ticket sold before, read for linking a companion to it. */
export type HostTicket = { ref: FirebaseFirestore.DocumentReference; ticket: Ticket };

/**
 * Reads the tickets sold before that companions in this sale go with, and refuses any that
 * can't take one: unknown, not `owner`'s (when given), not active, already with a companion,
 * or of a type that doesn't allowsCompanion (now; turning it off stops new companions).
 * Reads only, so call it before the transaction writes.
 */
export async function loadHostTickets(
  tx: FirebaseFirestore.Transaction,
  items: { with?: number | string }[],
  owner: { uid: string } | null | "anyone",
): Promise<Map<string, HostTicket>> {
  const ids = [...new Set(items.flatMap((item) => (typeof item.with === "string" ? [item.with] : [])))];
  if (ids.length === 0) return new Map();
  if (owner === null) {
    throw new HTTPException(400, { message: "sign in to bring a companion for a ticket you already have" });
  }

  const db = getFirestore();
  const docs = await tx.getAll(...ids.map((id) => db.doc(`tickets/${id}`)));
  const hosts = new Map<string, HostTicket>();
  for (const doc of docs) {
    const ticket = doc.data() as Ticket | undefined;
    // Someone else's ticket reads as unknown, so ids can't be probed
    if (!ticket || (owner !== "anyone" && ticket.uid !== owner.uid)) {
      throw new HTTPException(400, { message: `unknown ticket: ${doc.id}` });
    }
    if (ticket.status !== "active") {
      throw new HTTPException(409, { message: `ticket ${doc.id} isn't active, so it can't take a companion` });
    }
    if (ticket.companionId) {
      throw new HTTPException(409, { message: `ticket ${doc.id} already has a companion` });
    }
    hosts.set(doc.id, { ref: doc.ref, ticket: { ...ticket, id: doc.id } });
  }

  const typeIds = [...new Set([...hosts.values()].map((h) => h.ticket.typeId))];
  const types = await tx.getAll(...typeIds.map((id) => db.doc(`ticketTypes/${id}`)));
  const allowing = new Set(types.filter((t) => t.exists && typeSettings(t.data()!).allowsCompanion).map((t) => t.id));
  for (const [id, { ticket }] of hosts) {
    if (!allowing.has(ticket.typeId)) {
      throw new HTTPException(409, { message: `ticket ${id} is a ${ticket.typeId}, which doesn't take companions` });
    }
  }
  return hosts;
}

/**
 * Checks that every companion in a sale says who it goes with, and only companions do: a
 * person in the same sale whose type allowsCompanion, or a ticket from loadHostTickets
 * (`hosts`; null skips checking those, for a quote). Each host takes one companion.
 * Returns, per item, the position or ticket id it goes with, or null.
 */
export function pairCompanions(
  items: { typeId: string; with?: number | string }[],
  types: Map<string, TicketType>,
  hosts: Map<string, HostTicket> | null,
): (number | string | null)[] {
  const taken = new Set<number | string>();

  return items.map((item, i) => {
    const { isCompanion } = typeSettings(types.get(item.typeId)!);
    const host = item.with;
    if (!isCompanion) {
      if (host !== undefined) {
        throw new HTTPException(400, { message: `${item.typeId} isn't a companion ticket, so it goes with no one` });
      }
      return null;
    }
    if (host === undefined) {
      throw new HTTPException(400, { message: `${item.typeId} is a companion ticket: say who it goes with` });
    }
    if (typeof host === "number") {
      const hostItem = items[host];
      if (!hostItem || host === i) {
        throw new HTTPException(400, { message: `person ${i} goes with person ${host}, who isn't in this sale` });
      }
      if (!typeSettings(types.get(hostItem.typeId)!).allowsCompanion) {
        throw new HTTPException(400, { message: `${hostItem.typeId} doesn't take companions` });
      }
    } else if (hosts && !hosts.has(host)) {
      throw new HTTPException(400, { message: `unknown ticket: ${host}` });
    }
    if (taken.has(host)) {
      throw new HTTPException(400, { message: `only one companion per ticket; two go with ${typeof host === "number" ? `person ${host}` : host}` });
    }
    taken.add(host);
    return host;
  });
}

/**
 * Turns pairCompanions' result into ids once the new tickets have theirs: the host each
 * companion goes with (`companionOf`, per item), and each host's companion.
 */
export function companionLinks(pairs: (number | string | null)[], ticketIds: string[]) {
  const companionOf = pairs.map((host) => (host === null ? null : typeof host === "number" ? ticketIds[host] : host));
  const companionId = new Map<string, string>();
  companionOf.forEach((host, i) => {
    if (host) companionId.set(host, ticketIds[i]);
  });
  return { companionOf, companionId };
}
