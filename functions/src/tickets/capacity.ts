import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { HTTPException } from "hono/http-exception";

import type { TicketType } from "../types";

/**
 * Loads the requested ticket types, refuses the sale if any of them would go over
 * capacity, and reserves the slots by bumping their `sold` counters. Must run inside
 * a transaction so two buyers can't take the same last slot.
 */
export async function reserveCapacity(
  tx: FirebaseFirestore.Transaction,
  items: { typeId: string }[],
): Promise<Map<string, TicketType>> {
  const db = getFirestore();

  const wanted = new Map<string, number>();
  for (const item of items) {
    wanted.set(item.typeId, (wanted.get(item.typeId) ?? 0) + 1);
  }

  const refs = [...wanted.keys()].map((id) => db.doc(`ticketTypes/${id}`));
  const docs = await tx.getAll(...refs);

  const types = new Map<string, TicketType>();
  for (const doc of docs) {
    if (!doc.exists) {
      throw new HTTPException(400, { message: `unknown ticket type: ${doc.id}` });
    }
    types.set(doc.id, { id: doc.id, ...(doc.data() as Omit<TicketType, "id">) });
  }

  for (const [typeId, count] of wanted) {
    const type = types.get(typeId)!;
    if (type.capacity !== null && (type.sold ?? 0) + count > type.capacity) {
      throw new HTTPException(409, {
        message: `sold out: ${typeId} has ${type.capacity - (type.sold ?? 0)} left, asked for ${count}`,
      });
    }
  }

  for (const [typeId, count] of wanted) {
    tx.update(db.doc(`ticketTypes/${typeId}`), { sold: FieldValue.increment(count) });
  }

  return types;
}

/** Frees slots when tickets stop counting, i.e. cancelled or expired. */
export function releaseCapacity(
  tx: FirebaseFirestore.Transaction,
  typeIds: string[],
): void {
  const db = getFirestore();

  const counts = new Map<string, number>();
  for (const typeId of typeIds) {
    counts.set(typeId, (counts.get(typeId) ?? 0) + 1);
  }

  for (const [typeId, count] of counts) {
    tx.update(db.doc(`ticketTypes/${typeId}`), { sold: FieldValue.increment(-count) });
  }
}
