import type Stripe from "stripe";

// Helpers shared by the ticket type and extras syncs

/** "Trònic-con (dissabte)" → "tronic-con-dissabte" */
export function slugify(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // combining accents left by NFD
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** The product's default price when it's one this API can charge: one-time, in euros. */
export function chargeablePrice(product: Stripe.Product): Stripe.Price | string {
  const price = product.default_price;
  if (!price || typeof price === "string") {
    return "the product has no default price";
  }
  if (price.type !== "one_time" || price.currency !== "eur" || price.unit_amount === null) {
    return "the default price must be a one-time price in EUR";
  }
  return price;
}
