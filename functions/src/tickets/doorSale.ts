import { randomUUID } from "node:crypto";

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { HTTPException } from "hono/http-exception";

import { requireRole, type Env } from "../auth";
import { bearerAuth } from "../schemas";
import type { TicketType } from "../types";

export const doorSale = new OpenAPIHono<Env>();

const DoorSaleSchema = z.object({
  paymentMethod: z.enum(["cash", "card_terminal"]),
  items: z
    .array(
      z.object({
        typeId: z.string().min(1),
        holderName: z.string().min(1),
        holderEmail: z.email(),
      }),
    )
    .min(1)
    .max(20),
});

const SoldTicketSchema = z.object({
  id: z.string(),
  code: z.string(),
  typeId: z.string(),
  holderName: z.string(),
});

const doorSaleRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Tickets"],
  summary: "Sell tickets in person",
  description:
    "Staff or admin. Tickets are created active with no account attached; " +
    "`soldBy` and `paymentMethod` are recorded for till reconciliation.",
  security: bearerAuth,
  middleware: [requireRole("staff", "admin")] as const,
  request: {
    body: { required: true, content: { "application/json": { schema: DoorSaleSchema } } },
  },
  responses: {
    200: {
      description: "Tickets created",
      content: { "application/json": { schema: z.array(SoldTicketSchema) } },
    },
    400: { description: "Invalid body or unknown ticket type" },
    403: { description: "Caller is not staff or admin" },
  },
});

doorSale.openapi(doorSaleRoute, async (c) => {
  const { paymentMethod, items } = c.req.valid("json");
  const { uid: soldBy } = c.get("user");
  const db = getFirestore();

  const typeIds = [...new Set(items.map((item) => item.typeId))];
  const typeDocs = await db.getAll(
    ...typeIds.map((id) => db.doc(`ticketTypes/${id}`)),
  );

  const types = new Map<string, TicketType>();
  for (const doc of typeDocs) {
    if (!doc.exists) {
      throw new HTTPException(400, { message: `unknown ticket type: ${doc.id}` });
    }
    types.set(doc.id, { id: doc.id, ...(doc.data() as Omit<TicketType, "id">) });
  }

  const ticketRefs = items.map(() => db.collection("tickets").doc());
  const codes = items.map(() => randomUUID());

  const batch = db.batch();
  items.forEach((item, i) => {
    const type = types.get(item.typeId)!;
    batch.set(ticketRefs[i], {
      uid: null,
      typeId: item.typeId,
      status: "active",
      code: codes[i],
      holderName: item.holderName,
      holderEmail: item.holderEmail,
      paymentMethod,
      soldBy,
      purchasedAt: FieldValue.serverTimestamp(),
      days: type.days,
      isLanParty: type.isLanParty,
      checkins: {},
    });
  });

  await batch.commit();

  return c.json(
    items.map((item, i) => ({
      id: ticketRefs[i].id,
      code: codes[i],
      typeId: item.typeId,
      holderName: item.holderName,
    })),
    200,
  );
});
