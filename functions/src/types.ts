// Each list below is the single source for both its TypeScript type and its Zod schemas
export const ROLES = ["user", "staff", "admin"] as const;
export type Role = (typeof ROLES)[number];

export const TICKET_STATUSES = ["pending", "active", "cancelled"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const PAYMENT_METHODS = ["stripe", "cash", "card_terminal"] as const;
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
  stripeProductId: string;
  stripePriceId: string;
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
};

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
  // Set by an admin; absent on types made before they existed, read through typeSettings()
  category?: TicketCategory;
  packSize?: number;       // one unit sold is this many tickets, one per person; capacity counts units
  entries?: EntryRule;
  extrasFrom?: ExtraGroup | null; // null: no extras offered
};

/** A type's admin settings with the defaults for types stored before the fields existed. */
export function typeSettings(type: Pick<TicketType, "category" | "packSize" | "entries" | "extrasFrom">) {
  const category = type.category ?? "general";
  return {
    category,
    packSize: type.packSize ?? 1,
    entries: type.entries ?? "once",
    extrasFrom: type.extrasFrom !== undefined
      ? type.extrasFrom
      : (EXTRA_GROUPS as readonly string[]).includes(category) ? (category as ExtraGroup) : null,
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
  total: number;                // cents
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