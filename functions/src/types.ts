// Each list below is the single source for both its TypeScript type and its Zod schemas
export const ROLES = ["user", "staff", "admin"] as const;
export type Role = (typeof ROLES)[number];

export const TICKET_STATUSES = ["pending", "active", "cancelled"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const PAYMENT_METHODS = ["stripe", "cash", "card_terminal"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export type UserProfile = {
  role: Role;
  email: string | null;
  displayName: string | null;
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
};

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
  checkins: Record<string, CheckIn>;  // keyed by ISO date
};

/** A stored type as it is written: timestamps may be serverTimestamp() sentinels. */
type Written<T> = {
  [K in keyof T]: FirebaseFirestore.Timestamp extends T[K]
    ? T[K] | FirebaseFirestore.FieldValue
    : T[K];
};

export type TicketWrite = Omit<Written<Ticket>, "id">;

export type UserProfileWrite = Written<UserProfile>;