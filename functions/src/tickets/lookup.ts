import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { getFirestore } from "firebase-admin/firestore";

import { requireStaff, type Env } from "../auth";
import { bearerAuth, CheckinsSchema, checkinTimes } from "../schemas";
import { TICKET_STATUSES, type Ticket } from "../types";

export const ticketLookup = new OpenAPIHono<Env>();

const FoundTicketSchema = z.object({
  id: z.string(),
  code: z.string(),
  typeId: z.string(),
  status: z.enum(TICKET_STATUSES),
  holderName: z.string(),
  holderEmail: z.string(),
  days: z.array(z.string()),
  checkins: CheckinsSchema,
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
      query: z.object({ email: z.email().openapi({ param: { name: "email", in: "query" } }) }),
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

    const snap = await getFirestore()
      .collection("tickets")
      .where("holderEmail", "==", email)
      .get();

    const result = snap.docs.map((d) => {
      const t = d.data() as Ticket;
      return {
        id: d.id,
        code: t.code,
        typeId: t.typeId,
        status: t.status,
        holderName: t.holderName,
        holderEmail: t.holderEmail,
        days: t.days,
        checkins: checkinTimes(t.checkins),
      };
    });

    return c.json(result, 200);
  },
);
