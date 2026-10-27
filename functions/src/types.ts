// Each list below is the single source for both its TypeScript type and its Zod schemas
export const ROLES = ["user", "staff", "admin"] as const;
export type Role = (typeof ROLES)[number];

export const TICKET_STATUSES = ["pending", "active", "cancelled"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

// "assigned": given by an admin to a registered user, with no payment
export const PAYMENT_METHODS = ["stripe", "cash", "card_terminal", "assigned"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/** How the web groups ticket types: single tickets, LAN/Fighting, and season passes. */
export const TICKET_CATEGORIES = ["general", "lan", "pack"] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];

/**
 * How often a ticket gets in: "once" in total, on any day it covers (the default; single-day
 * tickets, kids, seniors), or "daily", once on each day it covers (multi-day passes).
 */
export const ENTRY_RULES = ["once", "daily"] as const;
export type EntryRule = (typeof ENTRY_RULES)[number];

/** Which set of extras a ticket type offers; packs borrow one of the other two. */
export const EXTRA_GROUPS = ["general", "lan"] as const;
export type ExtraGroup = (typeof EXTRA_GROUPS)[number];

/**
 * Something sold alongside a ticket (a T-shirt, a dormitory place…). Its price comes from its
 * Stripe product, like a ticket type's; the rest is set by an admin.
 */
export type Extra = {
  id: string;
  name: string;
  description: string | null;
  price: number;              // cents; comes from Stripe and only changes there
  options: string[];          // e.g. sizes; when not empty the buyer must pick one
  consent: string | null;     // text the buyer accepts by choosing it
  groups: ExtraGroup[];       // which ticket types offer it (by their extrasFrom); empty: not offered
  capacity: number | null;    // total stock, null for unlimited
  sold?: number;
  // Null on an extra made in the admin instead of Stripe, which is always free
  stripeProductId: string | null;
  stripePriceId: string | null;
};

export type UserProfile = {
  role: Role;
  email: string | null;
  displayName: string | null;     // shown to others, e.g. staff at check-in
  // The last name their sign-in account gave (set by the web's profile form, or by Google).
  // displayName only follows it when it changes, so a name set in Firestore by hand isn't
  // overwritten on every request.
  // Absent on profiles from before it existed.
  authName?: string | null;
  createdAt: FirebaseFirestore.Timestamp;
  // Absent on profiles created before suspension existed; treated as not suspended
  suspended?: boolean;
  suspendedAt?: FirebaseFirestore.Timestamp | null;
  suspendedBy?: string | null;
  // Optional, set by the user in their profile (YYYY-MM-DD); absent or null when not given
  birthDate?: string | null;
  // When the user last set their name through the API; a sign-in token issued before it still
  // carries the old name, so it mustn't be followed. Absent until they do
  nameSetAt?: FirebaseFirestore.Timestamp;
};

/** Where the event happens; its days and dates without a time are read in this zone. */
export const EVENT_TIMEZONE = "Europe/Madrid";

export type TicketType = {
  id: string;
  name: string;
  price: number;          // cents
  capacity: number | null; // null means unlimited
  isLanParty: boolean;
  days: string[];          // ISO dates (YYYY-MM-DD) this type grants access to
  sold?: number;           // pending + active tickets; absent on hand-seeded docs
  // Sale window as UTC ISO date-times; absent or null means open on that side
  salesStart?: string | null;
  salesEnd?: string | null;
  // Set by the Stripe sync; the price is Stripe's and only changes there
  stripeProductId?: string | null;
  stripePriceId?: string | null;
  // The Stripe prices with metadata.from, the default one included, oldest first. When there
  // are any, they set the price instead of price/stripePriceId; read it through priceAt()
  priceChanges?: PriceChange[];
  // Set by an admin; absent on types made before they existed, read through typeSettings()
  category?: TicketCategory;
  packSize?: number;       // one unit sold is this many tickets, one per person; capacity counts units
  entries?: EntryRule;
  extrasFrom?: ExtraGroup | null; // null: no extras offered
  // Shop card texts, edited in the admin; absent on older types (null / [])
  description?: string | null;   // short line under the title
  features?: string[];           // the "+ Més informació" bullet list
  disclaimer?: string | null;    // small print under the card
  // Places it shares with other types, on top of its own capacity; absent or null: none
  poolId?: string | null;
  // Companions: a cheaper ticket for someone who comes along with a ticket holder (e.g. a
  // parent with a LAN player). Set by an admin; absent on older types, read through typeSettings()
  allowsCompanion?: boolean; // each of its tickets may bring one companion
  isCompanion?: boolean;     // it's a companion ticket, sold only linked to a host ticket
};

/**
 * Places shared by several ticket types, e.g. the LAN seats both the LAN ticket and the LAN pack
 * sell. Counted in people: each live ticket (pending or active) of its types takes one.
 */
export type CapacityPool = {
  id: string;
  name: string;
  capacity: number;
  sold: number;            // live tickets that took a place
};

export type PriceChange = {
  from: string;            // UTC ISO date-time
  price: number;           // cents
  stripePriceId: string;
};

/**
 * The price a type sells at, at `now`, and the next change still to come. With dated prices,
 * it's the one whose date passed last, or the earliest one before any date has passed; the
 * plain price is only for a type without dated prices.
 */
export function priceAt(
  type: Pick<TicketType, "price" | "stripePriceId" | "priceChanges">,
  now = new Date(),
): { price: number; stripePriceId: string | null; next: PriceChange | null } {
  const changes = type.priceChanges ?? [];
  if (changes.length === 0) {
    return { price: type.price, stripePriceId: type.stripePriceId ?? null, next: null };
  }
  // Oldest first, so the started ones lead; none started yet means the earliest applies
  const started = changes.filter((change) => Date.parse(change.from) <= now.getTime()).length;
  const current = changes[Math.max(started - 1, 0)];
  return {
    price: current.price,
    stripePriceId: current.stripePriceId,
    next: changes[Math.max(started, 1)] ?? null,
  };
}

/** A type's admin settings with the defaults for types stored before the fields existed. */
export function typeSettings(
  type: Pick<TicketType, "category" | "packSize" | "entries" | "extrasFrom" | "allowsCompanion" | "isCompanion">,
) {
  const category = type.category ?? "general";
  return {
    category,
    packSize: type.packSize ?? 1,
    entries: type.entries ?? "once",
    extrasFrom: type.extrasFrom !== undefined
      ? type.extrasFrom
      : (EXTRA_GROUPS as readonly string[]).includes(category) ? (category as ExtraGroup) : null,
    allowsCompanion: type.allowsCompanion ?? false,
    isCompanion: type.isCompanion ?? false,
  };
}

export type CheckIn = {
  at: FirebaseFirestore.Timestamp;
  by: string;
};

export type Ticket = {
  id: string;
  uid: string | null;
  typeId: string;
  status: TicketStatus;
  code: string;
  holderName: string;
  holderEmail: string;
  paymentMethod: PaymentMethod;
  soldBy: string | null;
  paymentIntentId?: string | null; // set when Stripe confirms payment; links refunds back
  purchasedAt: FirebaseFirestore.Timestamp;
  days: string[];               // ISO dates (YYYY-MM-DD) this ticket grants access to,
                                 // denormalized from the ticket type at purchase time
  isLanParty: boolean;           // denormalized from the ticket type, for the member list query
  // Denormalized from the type at sale time
  entries?: EntryRule;           // absent on older tickets: "once"
  packId?: string | null;        // shared by the tickets of one pack unit
  poolId?: string | null;        // the shared places it took, if its type had them when sold
  checkins: Record<string, CheckIn>;  // keyed by ISO date
  // Set on tickets bought through an order (online); absent on door sales and older tickets
  orderId?: string;
  holder?: TicketHolder;
  extras?: TicketExtra[];
};

/** The attendee's details from the purchase form. */
export type TicketHolder = {
  name: string;               // full name, as one field
  birthDate: string;          // YYYY-MM-DD
  phone: string | null;       // only asked for LAN-group tickets
  discord: string | null;     // only asked for LAN-group tickets, optional
};

/** An extra bought with a ticket, as it was at purchase time. */
export type TicketExtra = {
  extraId: string;
  name: string;
  option: string | null;
  price: number;              // cents
};

export const ORDER_STATUSES = ["pending", "paid", "expired"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/**
 * One online purchase: who paid and the tickets it created. Its id is unguessable and is what
 * the buyer's confirmation page uses, so a guest needs no account to see what they bought.
 */
export type Order = {
  id: string;
  status: OrderStatus;          // a free order is paid as soon as it's created
  buyer: { name: string; email: string; newsletter: boolean };
  uid: string | null;           // the buyer's account, when they bought signed in
  ticketIds: string[];
  // Cents. Orders from before promotion codes have only the total, with nothing off
  subtotal?: number;            // before the discount
  discount?: number;
  total: number;                // what the buyer is asked to pay
  promotionCode?: { id: string; code: string } | null;
  // What Stripe charged, set when it confirms payment; it decides the discount, so it can
  // differ from the total by a rounding cent
  amountPaid?: number | null;
  stripeSessionId: string | null;
  paymentIntentId: string | null;
  createdAt: FirebaseFirestore.Timestamp;
  paidAt: FirebaseFirestore.Timestamp | null;
};

/** A stored type as it is written: timestamps may be serverTimestamp() sentinels. */
type Written<T> = {
  [K in keyof T]: FirebaseFirestore.Timestamp extends T[K]
    ? T[K] | FirebaseFirestore.FieldValue
    : T[K];
};

export type TicketWrite = Omit<Written<Ticket>, "id">;

export type UserProfileWrite = Written<UserProfile>;

export type OrderWrite = Omit<Written<Order>, "id">;