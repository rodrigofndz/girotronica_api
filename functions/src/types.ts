export type Role = "user" | "staff" | "admin";

export type TicketStatus = "pending" | "active" | "cancelled";

export type PaymentMethod = "stripe" | "cash" | "card_terminal";

export type TicketType = {
  id: string;
  name: string;
  price: number;          // cents
  capacity: number | null;
  isLanParty: boolean;
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
  checkedInAt: