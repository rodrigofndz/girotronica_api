import { getFirestore } from "firebase-admin/firestore";
import type Stripe from "stripe";

import { audit } from "../audit/audit";
import type { User } from "../auth";
import { chargeablePrice, slugify } from "../stripeCatalogue";
import type { Changes, SyncResult } from "../tickets/stripeSync";
import type { Extra } from "../types";

const EXTRA_ID = /^[a-z0-9-]+$/;

type StoredExtra = Omit<Extra, "id">;

/**
 * Brings one Stripe product marked as an extra into the extras list. As with ticket types,
 * the price always follows Stripe and the name and description are only filled in when
 * empty; sizes, consent, groups and stock are the admin's. A new extra isn't offered with
 * any ticket until an admin picks its groups.
 */
export async function syncExtraProduct(actor: User, product: Stripe.Product): Promise<SyncResult> {
  const base = {
    stripeProductId: product.id, name: product.name, kind: "extra" as const,
    typeId: null, extraId: null, changes: {}, reason: null,
  };
  const skip = (reason: string): SyncResult => ({ ...base, result: "skipped", reason });

  const price = chargeablePrice(product);
  if (typeof price === "string") return skip(price);
  const amount = price.unit_amount!;

  const db = getFirestore();

  return db.runTransaction(async (tx): Promise<SyncResult> => {
    const linked = await tx.get(db.collection("extras").where("stripeProductId", "==", product.id).limit(1));

    if (linked.empty) {
      if (!product.active) return skip("archived in Stripe and never synced");

      const id = product.metadata.extraId || slugify(product.name);
      if (!EXTRA_ID.test(id)) {
        return skip(`can't make an extra id from "${product.name}"; set metadata.extraId in Stripe`);
      }
      const ref = db.doc(`extras/${id}`);
      if ((await tx.get(ref)).exists) {
        return skip(`the id "${id}" is taken by another extra; set metadata.extraId in Stripe`);
      }

      const extra: StoredExtra = {
        name: product.name,
        description: product.description ?? null,
        price: amount,
        options: [],
        consent: null,
        groups: [],
        capacity: null,
        sold: 0,
        stripeProductId: product.id,
        stripePriceId: price.id,
      };
      const changes = Object.fromEntries(Object.entries(extra).map(([field, to]) => [field, { from: null, to }]));

      tx.create(ref, extra);
      audit(tx, {
        actor,
        action: "extra.stripeSync",
        target: { id, label: product.name },
        details: { stripeProductId: product.id, created: true, changes },
      });
      return { ...base, result: "created", extraId: id, changes };
    }

    const doc = linked.docs[0];
    const current = doc.data() as StoredExtra;
    const sold = current.sold ?? 0;
    const changes: Changes = {};

    if (current.price !== amount) changes.price = { from: current.price, to: amount };
    if (current.stripePriceId !== price.id) changes.stripePriceId = { from: current.stripePriceId, to: price.id };
    if (!current.name) changes.name = { from: current.name ?? null, to: product.name };
    if (!current.description && product.description) {
      changes.description = { from: current.description ?? null, to: product.description };
    }
    // Archived in Stripe: stop offering it without losing what was sold
    if (!product.active && (current.capacity === null || current.capacity > sold)) {
      changes.capacity = { from: current.capacity, to: sold };
    }

    if (Object.keys(changes).length === 0) {
      return { ...base, result: "unchanged", extraId: doc.id };
    }

    tx.update(doc.ref, Object.fromEntries(Object.entries(changes).map(([field, { to }]) => [field, to])));
    audit(tx, {
      actor,
      action: "extra.stripeSync",
      target: { id: doc.id, label: current.name || product.name },
      details: { stripeProductId: product.id, created: false, changes },
    });
    return { ...base, result: "updated", extraId: doc.id, changes };
  });
}
