import { z } from "@hono/zod-openapi";
import { FieldValue, getFirestore } from "firebase-admin/firestore";

import type { User } from "../auth";
import { PAYMENT_METHODS, TICKET_STATUSES, type Role } from "../types";

export const AUDIT_COLLECTION = "auditLog";

export const AUDIT_TARGETS = ["ticket", "ticketType", "user"] as const;
export type AuditTarget = (typeof AUDIT_TARGETS)[number];

export const SCAN_REJECTIONS = ["already_used", "wrong_day", "invalid", "not_found"] as const;

const stripeEvent = { stripeEventId: z.string() };

/**
 * Every action the log can record, and the details each one carries. The part of the
 * name before the dot is the kind of thing it acts on.
 *
 * To log something new: add it here, call `audit()` in the same transaction as the
 * change, and name it in that route's `auditedAs(...)`.
 */
export const AUDIT_ACTIONS = {
  // Kept so entries from before the Stripe sync still read well; nothing writes it any more
  "ticketType.create": {
    description: "Ticket type created by hand (before types came from Stripe)",
    details: z.object({ fields: z.record(z.string(), z.unknown()) }),
  },
  "ticketType.stripeSync": {
    description: "Ticket type created or updated from its Stripe product",
    details: z.object({
      stripeProductId: z.string(),
      created: z.boolean(),
      changes: z.record(z.string(), z.object({ from: z.unknown(), to: z.unknown() })),
    }),
  },
  "ticketType.update": {
    description: "Ticket type edited; only the fields that changed",
    details: z.object({ changes: z.record(z.string(), z.object({ from: z.unknown(), to: z.unknown() })) }),
  },
  "ticketType.delete": {
    description: "Ticket type deleted",
    details: z.object({}),
  },
  "ticket.doorSale": {
    description: "Sold at the door",
    details: z.object({ typeId: z.string(), price: z.int(), paymentMethod: z.enum(PAYMENT_METHODS) }),
  },
  "ticket.checkin": {
    description: "Checked in at the door",
    details: z.object({ day: z.string() }),
  },
  "ticket.scanRejected": {
    description: "Scan refused at the door; the code is kept only when no ticket has it",
    details: z.object({ day: z.string(), reason: z.enum(SCAN_REJECTIONS), code: z.string().optional() }),
  },
  "ticket.cancel": {
    description: "Cancelled by an admin",
    details: z.object({ previousStatus: z.enum(TICKET_STATUSES) }),
  },
  "ticket.purchase": {
    description: "Bought online; waiting for payment",
    details: z.object({ typeId: z.string(), price: z.int() }),
  },
  "ticket.checkoutFailed": {
    description: "Online purchase dropped because Stripe checkout could not be started",
    details: z.object({}),
  },
  "ticket.paid": {
    description: "Payment confirmed by Stripe",
    details: z.object({ ...stripeEvent, paymentIntentId: z.string().nullable() }),
  },
  "ticket.expired": {
    description: "Stripe checkout expired unpaid",
    details: z.object(stripeEvent),
  },
  "ticket.refunded": {
    description: "Fully refunded in Stripe, so cancelled",
    details: z.object({ ...stripeEvent, chargeId: z.string(), previousStatus: z.enum(TICKET_STATUSES) }),
  },
  "ticket.partiallyRefunded": {
    description: "Partly refunded in Stripe; left active for an admin to decide",
    details: z.object({ ...stripeEvent, chargeId: z.string(), amount: z.int(), amountRefunded: z.int() }),
  },
  "user.promote": {
    description: "Promoted to staff",
    details: z.object({}),
  },
  "user.demote": {
    description: "Demoted from staff to user",
    details: z.object({}),
  },
  "user.suspend": {
    description: "Account suspended",
    details: z.object({}),
  },
  "user.reactivate": {
    description: "Account reactivated",
    details: z.object({}),
  },
} satisfies Record<`${AuditTarget}.${string}`, { description: string; details: z.ZodType }>;

export type AuditAction = keyof typeof AUDIT_ACTIONS;
export type AuditDetails<A extends AuditAction> = z.input<(typeof AUDIT_ACTIONS)[A]["details"]>;

export const AUDIT_ACTION_NAMES = Object.keys(AUDIT_ACTIONS) as [AuditAction, ...AuditAction[]];

/** Stripe acts through the webhook; which event did it is in the entry's details. */
export const STRIPE_ACTOR = { uid: null, email: null, role: "stripe" } as const;

export type AuditActor = User | typeof STRIPE_ACTOR;
export type AuditActorRole = Role | typeof STRIPE_ACTOR.role;

export type AuditEntry = {
  at: FirebaseFirestore.Timestamp;
  action: AuditAction;
  targetType: AuditTarget;
  targetId: string | null;
  targetLabel: string | null; // readable name as it was then: holder, type name or email
  actorUid: string | null;
  actorEmail: string | null;
  actorRole: AuditActorRole;
  details: Record<string, unknown>;
};

/**
 * Records one action. Call it with the transaction or batch that makes the change,
 * so the entry and the change are saved together or not at all.
 * `id` makes the entry idempotent for callers that can't tell a retry from new work.
 */
export function audit<A extends AuditAction>(
  writer: FirebaseFirestore.Transaction | FirebaseFirestore.WriteBatch,
  entry: {
    actor: AuditActor;
    action: A;
    target: { id: string | null; label: string | null };
    details: AuditDetails<A>;
    id?: string;
  },
): void {
  const log = getFirestore().collection(AUDIT_COLLECTION);
  const ref = entry.id ? log.doc(entry.id) : log.doc();

  const data: Omit<AuditEntry, "at"> & { at: FirebaseFirestore.FieldValue } = {
    at: FieldValue.serverTimestamp(),
    action: entry.action,
    targetType: entry.action.split(".")[0] as AuditTarget,
    targetId: entry.target.id,
    targetLabel: entry.target.label,
    actorUid: entry.actor.uid,
    actorEmail: entry.actor.email ?? null,
    actorRole: entry.actor.role,
    details: entry.details,
  };

  // Both writers have the same create(); TypeScript can't call through the union directly
  (writer as FirebaseFirestore.WriteBatch).create(ref, data);
}

/**
 * Declares on a route which actions it logs. It shows in the API docs, and a test fails
 * when a route that changes data declares nothing.
 */
export const auditedAs = (...actions: AuditAction[]) => ({ "x-audit": actions });
