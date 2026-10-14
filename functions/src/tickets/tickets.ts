import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { getFirestore } from "firebase-admin/firestore";

import type { Env } from "../auth";
import { bearerAuth, CheckinsSchema, checkinTimes } from "../schemas";
import type { Ticket } from "../types";
import { typeNames } from "./typeNames";

export const tickets = new OpenAPIHono<Env>();


const OwnTicketSchema = z.object({
  id: z.string(),
  typeId: z.string(),
  typeName: z.string().nullable().openapi({
    description: "Its type's name as it is now, even once the type is no longer on sale; null if the type is gone",
  }),
  code: z.string(),
  holderName: z.string(),
  days: z.array(z.string()),
  isLanParty: z.boolean().openapi({ description: "Copied from its type when sold, so it stays once the type closes" }),
  checkins: CheckinsSchema,
});

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Tickets"],
  summary: "List the caller's active tickets",
  security: bearerAuth,
  responses: {
    200: {
      description: "Active tickets owned by the caller",
      content: { "application/json": { schema: z.array(OwnTicketSchema) } },
    },
  },
});

tickets.openapi(listRoute, async (c) => {
  const { uid } = c.get("user");

  const snap = await getFirestore()
    .collection("tickets")
    .where("uid", "==", uid)
    .where("status", "==", "active")
    .get();

  const names = await typeNames(snap.docs.map((d) => (d.data() as Ticket).typeId));
  const result = snap.docs.map((d) => {
    const t = d.data() as Ticket;
    return {
      id: d.id,
      typeId: t.typeId,
      typeName: names.get(t.typeId) ?? null,
      code: t.code,
      holderName: t.holderName,
      days: t.days,
      isLanParty: t.isLanParty ?? false,
      checkins: checkinTimes(t.checkins),
    };
  });

  return c.json(result, 200);
});
