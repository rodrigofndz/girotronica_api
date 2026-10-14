import { getFirestore } from "firebase-admin/firestore";

/** Each type's name as it is now, read once per type; a type that's gone has no entry. */
export async function typeNames(typeIds: Iterable<string>): Promise<Map<string, string>> {
  const db = getFirestore();
  const ids = [...new Set(typeIds)];
  const docs = ids.length > 0 ? await db.getAll(...ids.map((id) => db.doc(`ticketTypes/${id}`))) : [];
  return new Map(docs.filter((doc) => doc.get("name")).map((doc) => [doc.id, doc.get("name") as string]));
}
