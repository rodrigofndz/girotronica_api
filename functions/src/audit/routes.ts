import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { HTTPException } from "hono/http-exception";

import { requireAdmin, type Env } from "../auth";
import { bearerAuth } from "../schemas";
import { ROLES } from "../types";
import {
  AUDIT_ACTION_NAMES, AUDIT_ACTIONS, AUDIT_COLLECTION, AUDIT_TARGETS, STRIPE_ACTOR, type AuditEntry,
} from "./audit";

export const auditLog = new OpenAPIHono<Env>();

const isoDateTime = z.iso
  .datetime({ offset: true })
  .openapi({ type: "string", format: "date-time", example: "2026-11-20T09:00:00+01:00" });

// Every filter is an equality on one field plus time, which the indexes in
// firestore.indexes.json cover in both orders, alone or combined
const QuerySchema = z.object({
  actor: z.string().min(1).optional().openapi({ description: "Uid of who did it" }),
  role: z.enum([...ROLES, STRIPE_ACTOR.role, "guest"]).optional()
    .openapi({ description: "Their role at the time; guest for purchases without an account" }),
  action: z.enum(AUDIT_ACTION_NAMES).optional(),
  targetType: z.enum(AUDIT_TARGETS).optional(),
  target: z.string().min(1).optional().openapi({ description: "Id of the ticket, ticket type or user acted on" }),
  from: isoDateTime.optional().openapi({ description: "Entries at or after this time" }),
  to: isoDateTime.optional().openapi({ description: "Entries before this time" }),
  order: z.enum(["desc", "asc"]).default("desc").openapi({ description: "Newest first by default" }),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  after: z.string().min(1).optional().openapi({ description: "`next` from the previous page" }),
});

const EntrySchema = z.object({
  id: z.string(),
  at: z.string().openapi({ format: "date-time" }),
  action: z.enum(AUDIT_ACTION_NAMES),
  targetType: z.enum(AUDIT_TARGETS),
  targetId: z.string().nullable(),
  targetLabel: z.string().nullable(),
  actorUid: z.string().nullable(),
  actorEmail: z.string().nullable(),
  actorRole: z.enum([...ROLES, STRIPE_ACTOR.role, "guest"]),
  details: z.record(z.string(), z.unknown()),
});

auditLog.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["Audit"],
    summary: "Read the activity log",
    description:
      "Admin only. Who did what and when, across staff, admins and Stripe. " +
      "Filters combine; results are ordered by time and paged with `next`.",
    security: bearerAuth,
    middleware: [requireAdmin] as const,
    request: { query: QuerySchema },
    responses: {
      200: {
        description: "One page of entries",
        content: {
          "application/json": {
            schema: z.object({ entries: z.array(EntrySchema), next: z.string().nullable() }),
          },
        },
      },
      400: { description: "Invalid filter, or a `next` cursor that doesn't exist" },
      403: { description: "Caller is not admin" },
    },
  }),
  async (c) => {
    const q = c.req.valid("query");
    const db = getFirestore();

    let query: FirebaseFirestore.Query = db.collection(AUDIT_COLLECTION);
    if (q.actor) query = query.where("actorUid", "==", q.actor);
    if (q.role) query = query.where("actorRole", "==", q.role);
    if (q.action) query = query.where("action", "==", q.action);
    if (q.targetType) query = query.where("targetType", "==", q.targetType);
    if (q.target) query = query.where("targetId", "==", q.target);
    if (q.from) query = query.where("at", ">=", Timestamp.fromDate(new Date(q.from)));
    if (q.to) query = query.where("at", "<", Timestamp.fromDate(new Date(q.to)));
    query = query.orderBy("at", q.order);

    if (q.after) {
      const cursor = await db.doc(`${AUDIT_COLLECTION}/${q.after}`).get();
      if (!cursor.exists) {
        throw new HTTPException(400, { message: "unknown cursor" });
      }
      query = query.startAfter(cursor);
    }

    // One extra tells us whether another page exists without a second query
    const snap = await query.limit(q.limit + 1).get();
    const page = snap.docs.slice(0, q.limit);

    const entries = page.map((doc) => {
      const entry = doc.data() as AuditEntry;
      return { id: doc.id, ...entry, at: entry.at.toDate().toISOString() };
    });

    return c.json({ entries, next: snap.docs.length > q.limit ? page[page.length - 1].id : null }, 200);
  },
);

auditLog.openapi(
  createRoute({
    method: "get",
    path: "/actions",
    tags: ["Audit"],
    summary: "List the actions the log records",
    description: "Admin only. For building the action filter.",
    security: bearerAuth,
    middleware: [requireAdmin] as const,
    responses: {
      200: {
        description: "Every action with a short description",
        content: {
          "application/json": {
            schema: z.array(z.object({ action: z.enum(AUDIT_ACTION_NAMES), description: z.string() })),
          },
        },
      },
      403: { description: "Caller is not admin" },
    },
  }),
  (c) =>
    c.json(
      AUDIT_ACTION_NAMES.map((action) => ({ action, description: AUDIT_ACTIONS[action].description })),
      200,
    ),
);
