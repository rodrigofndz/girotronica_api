import type Stripe from "stripe";

import { EVENT_TIMEZONE, type PriceChange } from "./types";

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

/**
 * When a price's metadata.from says it starts: a date ("2026-11-01", midnight at the event)
 * or a date-time with its offset ("2026-11-01T12:00:00+01:00"). Null if it's neither.
 */
export function priceStart(value: string): Date | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const utcMidnight = new Date(`${value}T00:00:00Z`);
    // Rejects dates that don't exist, like 2026-02-30
    if (Number.isNaN(utcMidnight.getTime()) || utcMidnight.toISOString().slice(0, 10) !== value) return null;
    // The event's offset that day, e.g. "GMT+01:00" in winter and "GMT+02:00" in summer
    const zone = new Intl.DateTimeFormat("en-US", { timeZone: EVENT_TIMEZONE, timeZoneName: "longOffset" })
      .formatToParts(utcMidnight).find((part) => part.type === "timeZoneName")!.value;
    const [, sign, hours, minutes] = /([+-])(\d{2}):(\d{2})/.exec(zone) ?? [, "+", "00", "00"];
    const offset = (sign === "-" ? -1 : 1) * (Number(hours) * 60 + Number(minutes)) * 60_000;
    return new Date(utcMidnight.getTime() - offset);
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(value)) {
    const time = new Date(value);
    return Number.isNaN(time.getTime()) ? null : time;
  }
  return null;
}

/**
 * A product's dated prices: its active prices with metadata.from, the default one included,
 * oldest first. A price that can't be used is left out and named in `notes`; two starting at
 * the same moment is an error, since neither can be picked.
 */
export function priceChanges(
  product: Stripe.Product,
  prices: Stripe.Price[],
): { changes: PriceChange[]; notes: string[] } | string {
  // The default price comes expanded on the product; the listing may have it too
  const own = typeof product.default_price === "object" && product.default_price
    ? [product.default_price, ...prices.filter((p) => p.id !== (product.default_price as Stripe.Price).id)]
    : prices;
  const changes: PriceChange[] = [];
  const notes: string[] = [];

  for (const price of own) {
    const raw = price.metadata?.from?.trim();
    if (!price.active || !raw) continue;

    const start = priceStart(raw);
    if (!start) {
      notes.push(`price ${price.id} is left out: metadata.from must be a date like 2026-11-01, got "${raw}"`);
    } else if (price.type !== "one_time" || price.currency !== "eur" || price.unit_amount === null) {
      notes.push(`price ${price.id} is left out: it must be a one-time price in EUR`);
    } else {
      changes.push({ from: start.toISOString(), price: price.unit_amount, stripePriceId: price.id });
    }
  }

  changes.sort((a, b) => a.from.localeCompare(b.from));
  const clash = changes.find((change, i) => i > 0 && changes[i - 1].from === change.from);
  if (clash) return `two prices start at ${clash.from}; give them different metadata.from dates`;

  return { changes, notes };
}
