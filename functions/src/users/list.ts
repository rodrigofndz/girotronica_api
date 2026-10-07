import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { getFirestore } from "firebase-admin/firestore";

import { requireAdmin, type Env } from "../auth";
import { bearerAuth } from "../schemas";
import { ROLES, type Ticket, type UserProfile } from "../types";

export const userList = new OpenAPIHono<Env>();

const SORTS = ["name", "email", "createdAt", "tickets"] as const;

// Query strings only carry text, so "true"/"false" are read as booleans
const queryBoolean = z.enum(["true", "false"]).transform((v) => v === "true");

const QuerySchema = z.object({
  q: z.string().trim().min(1).optional().openapi({ description: "Part of the email or name, any case" }),
  role: z.string()
    .transform((v) => [...new Set(v.split(",").map((r) => r.trim()))])
    .pipe(z.array(z.enum(ROLES)).min(1))
    .optional()
    .openapi({ type: "string", description: "One role or several, comma separated, e.g. staff,admin" }),
  suspended: queryBoolean.optional(),
  hasTickets: queryBoolean.optional(),
  sort: z.enum(SORTS).default("createdAt"),
  order: z.enum(["asc", "desc"]).optional().openapi({
    description: "Default: newest / most tickets first for createdAt and tickets, A–Z for name and email",
  }),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0).openapi({ description: "`next` from the previous page" }),
});

const ListedUserSchema = z.object({
  uid: z.string(),
  email: z.string().nullable(),
  displayName: z.string().nullable(),
  role: z.enum(ROLES),
  suspended: z.boolean(),
  createdAt: z.string().nullable().openapi({ format: "date-time" }),
  ticketCount: z.int().nonnegative().openapi({
    description: "Active tickets on the account: bought while signed in, or assigned to it",
  }),
});
type ListedUser = z.infer<typeof ListedUserSchema>;

userList.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["Users"],
    summary: "List users",
    description:
      "Admin only. Filters combine. Firestore can't search inside text or sort by a count, so " +
      "the list is built in memory from all profiles and active tickets; fine at this event's scale.",
    security: bearerAuth,
    middleware: [requireAdmin] as const,
    request: { query: QuerySchema },
    responses: {
      200: {
        description: "One page of users",
        content: {
          "application/json": {
            schema: z.object({
              users: z.array(ListedUserSchema),
              total: z.int().openapi({ description: "How many match the filters, across all pages" }),
              next: z.int().nullable().openapi({ description: "The offset of the next page; null on the last" }),
            }),
          },
        },
      },
      400: { description: "Invalid filter" },
      403: { description: "Caller is not admin" },
    },
  }),
  async (c) => {
    const q = c.req.valid("query");
    const db = getFirestore();

    const [profiles, tickets] = await Promise.all([
      db.collection("users").get(),
      db.collection("tickets").where("status", "==", "active").get(),
    ]);

    const counts = new Map<string, number>();
    for (const doc of tickets.docs) {
      const { uid } = doc.data() as Ticket;
      if (uid) counts.set(uid, (counts.get(uid) ?? 0) + 1);
    }

    const needle = q.q?.toLowerCase();
    let users: ListedUser[] = profiles.docs.map((doc) => {
      const p = doc.data() as UserProfile;
      return {
        uid: doc.id,
        email: p.email ?? null,
        displayName: p.displayName ?? null,
        role: p.role,
        suspended: p.suspended ?? false,
        createdAt: p.createdAt ? p.createdAt.toDate().toISOString() : null,
        ticketCount: counts.get(doc.id) ?? 0,
      };
    });

    users = users.filter((u) =>
      (!needle || [u.email, u.displayName].some((v) => v?.toLowerCase().includes(needle)))
      && (q.role === undefined || q.role.includes(u.role))
      && (q.suspended === undefined || u.suspended === q.suspended)
      && (q.hasTickets === undefined || (u.ticketCount > 0) === q.hasTickets));

    const order = q.order ?? (q.sort === "createdAt" || q.sort === "tickets" ? "desc" : "asc");
    const text = (v: string | null) => (v ?? "").toLocaleLowerCase("ca");
    const compare: Record<(typeof SORTS)[number], (a: ListedUser, b: ListedUser) => number> = {
      name: (a, b) => text(a.displayName ?? a.email).localeCompare(text(b.displayName ?? b.email), "ca"),
      email: (a, b) => text(a.email).localeCompare(text(b.email), "ca"),
      createdAt: (a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""),
      tickets: (a, b) => a.ticketCount - b.ticketCount,
    };
    // Ties broken by uid, so the order is the same on every page
    users.sort((a, b) => (order === "asc" ? 1 : -1) * compare[q.sort](a, b) || a.uid.localeCompare(b.uid));

    const page = users.slice(q.offset, q.offset + q.limit);
    const next = q.offset + q.limit < users.length ? q.offset + q.limit : null;

    return c.json({ users: page, total: users.length, next }, 200);
  },
);
