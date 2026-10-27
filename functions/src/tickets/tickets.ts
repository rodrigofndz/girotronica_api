import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { getFirestore } from "firebase-admin/firestore";

import type { Env } from "../auth";
import { bearerAuth, CheckinsSchema, checkinTimes } from "../schemas";
import { type Ticket, typeSettings } from "../types";
import { currentTypes } from "./typeNames";

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
  companionOf: z.string().nullable().openapi({ description: "For a companion ticket, the ticket it goes with" }),
  companionId: z.string().nullable().openapi({ description: "Its companion ticket, if it has one" }),
  allowsCompanion: z.boolean().openapi({
    description: "Whether its type takes companions now, even once its sale has closed; with no companionId, it can take one",
  }),
  isCompanion: z.boolean().openapi({ description: "Whether its type is a companion type" }),
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

  const types = await currentTypes(snap.docs.map((d) => (d.data() as Ticket).typeId));
  const result = snap.docs.map((d) => {
    const t = d.data() as Ticket;
    const type = types.get(t.typeId);
    const settings = type && typeSettings(type);
    return {
      id: d.id,
      typeId: t.typeId,
      typeName: type?.name || null,
      code: t.code,
      holderName: t.holderName,
      days: t.days,
      isLanParty: t.isLanParty ?? false,
      checkins: checkinTimes(t.checkins),
      companionOf: t.companionOf ?? null,
      companionId: t.companionId ?? null,
      allowsCompanion: settings?.allowsCompanion ?? false,
      isCompanion: settings?.isCompanion ?? false,
    };
  });

  return c.json(result, 200);
});
