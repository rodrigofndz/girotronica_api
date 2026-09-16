export type Role = "user" | "staff" | "admin";

export type TicketStatus = "pending" | "active" | "cancelled";

export type PaymentMethod = "stripe" | "cash" | "card_terminal";

export type TicketType = {
  id: string;
  name: string;
  price: number;          // cents
  capacity: number | null;
  isLanParty: boolean;
  days: string[];          // ISO dates (YYYY-MM-DD) this type grants access to
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
  purchasedAt: FirebaseFirestore.Timestamp;
  days: string[];               // ISO dates (YYYY-MM-DD) this ticket grants access to,
                                 // denormalized from the ticket type at purchase time
  checkins: Record<string, CheckIn>;  // keyed by ISO date
};