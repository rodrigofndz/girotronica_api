import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { getFirestore } from "firebase-admin/firestore";

import { requireStaff, type Env } from "../auth";
import { bearerAuth, CheckinsSchema, checkinTimes, EmailSchema } from "../schemas";
import { PAYMENT_METHODS, TICKET_STATUSES, type Ticket, typeSettings } from "../types";
import { currentTypes } from "./typeNames";

export const ticketLookup = new OpenAPIHono<Env>();

const FoundTicketSchema = z.object({
  id: z.string(),
  code: z.string(),
  typeId: z.string(),
  status: z.enum(TICKET_STATUSES),
  holderName: z.string(),
  holderEmail: z.string(),
  paymentMethod: z.enum(PAYMENT_METHODS).openapi({
    description: "stripe: bought online; cash or card_terminal: sold at the door; assigned: given by an admin",
  }),
  days: z.array(z.string()),
  checkins: CheckinsSchema,
  companionOf: z.string().nullable().openapi({ description: "For a companion ticket, the ticket it goes with" }),
  companionId: z.string().nullable().openapi({ description: "Its companion ticket, if it has one" }),
  allowsCompanion: z.boolean().openapi({
    description: "Whether its type takes companions now; with status active and no companionId, it can take one",
  }),
  isCompanion: z.boolean().openapi({ description: "Whether its type is a companion type" }),
});

ticketLookup.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["Tickets"],
    summary: "Find tickets by holder email",
    description:
      "Staff or admin. Returns every ticket held by that email, online or door sold, " +
      "with the code needed to reprint or resend it.",
    security: bearerAuth,
    middleware: [requireStaff] as const,
    request: {
      query: z.object({ email: EmailSchema.openapi({ param: { name: "email", in: "query" } }) }),
    },
    responses: {
      200: {
        description: "Matching tickets, empty if none",
        content: { "application/json": { schema: z.array(FoundTicketSchema) } },
      },
      400: { description: "Missing or malformed email" },
      403: { description: "Caller is not staff or admin" },
    },
  }),
  async (c) => {
    const { email } = c.req.valid("query");

    const db = getFirestore();
    const snap = await db.collection("tickets").where("holderEmail", "==", email).get();

    // The type's settings as they are now, which is what decides if a ticket can take a companion
    const types = await currentTypes(snap.docs.map((d) => (d.data() as Ticket).typeId));
    const settings = new Map([...types].map(([id, type]) => [id, typeSettings(type)]));

    const result = snap.docs.map((d) => {
      const t = d.data() as Ticket;
      return {
        id: d.id,
        code: t.code,
        typeId: t.typeId,
        status: t.status,
        holderName: t.holderName,
        holderEmail: t.holderEmail,
        paymentMethod: t.paymentMethod,
        days: t.days,
        checkins: checkinTimes(t.checkins),
        companionOf: t.companionOf ?? null,
        companionId: t.companionId ?? null,
        allowsCompanion: settings.get(t.typeId)?.allowsCompanion ?? false,
        isCompanion: settings.get(t.typeId)?.isCompanion ?? false,
      };
    });

    return c.json(result, 200);
  },
);
