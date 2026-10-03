import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { HTTPException } from "hono/http-exception";

import { type Extra, type Ticket, type TicketType, typeSettings } from "../types";

export type ExtraPick = { extraId: string; option?: string | null };

/**
 * Reads the extras a purchase asks for. Separate from reserving them because a Firestore
 * transaction must do all its reads before any write, and the ticket places are reserved
 * (written) in between.
 */
export async function loadExtras(
  tx: FirebaseFirestore.Transaction,
  extraIds: string[],
): Promise<Map<string, Extra>> {
  const ids = [...new Set(extraIds)];
  if (ids.length === 0) return new Map();

  const db = getFirestore();
  const docs = await tx.getAll(...ids.map((id) => db.doc(`extras/${id}`)));

  const extras = new Map<string, Extra>();
  for (const doc of docs) {
    if (!doc.exists) {
      throw new HTTPException(400, { message: `unknown extra: ${doc.id}` });
    }
    extras.set(doc.id, { id: doc.id, ...(doc.data() as Omit<Extra, "id">) });
  }
  return extras;
}

/**
 * Checks each attendee's extras against their ticket type and the extras' stock, then takes
 * the stock. Writes only, so call it after every read in the transaction.
 */
export function reserveExtras(
  tx: FirebaseFirestore.Transaction,
  extras: Map<string, Extra>,
  wanted: { type: TicketType; picks: ExtraPick[] }[],
): void {
  const counts = new Map<string, number>();

  for (const { type, picks } of wanted) {
    const group = typeSettings(type).extrasFrom;
    const seen = new Set<string>();

    for (const pick of picks) {
      const extra = extras.get(pick.extraId)!;
      if (seen.has(extra.id)) {
        throw new HTTPException(400, { message: `extra ${extra.id} chosen twice for one person` });
      }
      seen.add(extra.id);

      if (group === null || !(extra.groups ?? []).includes(group)) {
        throw new HTTPException(400, { message: `extra ${extra.id} isn't offered with ${type.id}` });
      }

      const options = extra.options ?? [];
      if (options.length > 0 && !options.includes(pick.option ?? "")) {
        throw new HTTPException(400, {
          message: `extra ${extra.id} needs one of: ${options.join(", ")}`,
        });
      }
      if (options.length === 0 && pick.option) {
        throw new HTTPException(400, { message: `extra ${extra.id} has no options` });
      }

      counts.set(extra.id, (counts.get(extra.id) ?? 0) + 1);
    }
  }

  for (const [id, count] of counts) {
    const extra = extras.get(id)!;
    const sold = extra.sold ?? 0;
    if (extra.capacity !== null && extra.capacity !== undefined && sold + count > extra.capacity) {
      throw new HTTPException(409, {
        message: `sold out: extra ${id} has ${Math.max(extra.capacity - sold, 0)} left, asked for ${count}`,
      });
    }
  }

  const db = getFirestore();
  for (const [id, count] of counts) {
    tx.update(db.doc(`extras/${id}`), { sold: FieldValue.increment(count) });
  }
}

/** Gives back the stock of the extras on tickets that stop counting. Writes only. */
export function releaseExtras(tx: FirebaseFirestore.Transaction, tickets: Ticket[]): void {
  const counts = new Map<string, number>();
  for (const ticket of tickets) {
    for (const extra of ticket.extras ?? []) {
      counts.set(extra.extraId, (counts.get(extra.extraId) ?? 0) + 1);
    }
  }

  const db = getFirestore();
  for (const [id, count] of counts) {
    tx.update(db.doc(`extras/${id}`), { sold: FieldValue.increment(-count) });
  }
}
