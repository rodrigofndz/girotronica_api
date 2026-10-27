import { getFirestore } from "firebase-admin/firestore";

import type { TicketType } from "../types";

/** Each type as it is now, read once per type; a type that's gone has no entry. */
export async function currentTypes(typeIds: Iterable<string>): Promise<Map<string, Omit<TicketType, "id">>> {
  const db = getFirestore();
  const ids = [...new Set(typeIds)];
  const docs = ids.length > 0 ? await db.getAll(...ids.map((id) => db.doc(`ticketTypes/${id}`))) : [];
  return new Map(docs.filter((doc) => doc.exists).map((doc) => [doc.id, doc.data() as Omit<TicketType, "id">]));
}

/** Each type's name as it is now, read once per type; a type that's gone has no entry. */
export async function typeNames(typeIds: Iterable<string>): Promise<Map<string, string>> {
  const types = await currentTypes(typeIds);
  return new Map([...types].filter(([, type]) => type.name).map(([id, type]) => [id, type.name]));
}
