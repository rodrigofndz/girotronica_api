import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { getFirestore } from "firebase-admin/firestore";
import { HTTPException } from "hono/http-exception";

import { ORDER_STATUSES, TICKET_STATUSES, type Order, type Ticket } from "../types";

export const orders = new OpenAPIHono();

// Public, reached by the order id in the confirmation link, so it shows only what's safe for
// whoever holds that link: no codes or QRs (each is an entry), no emails, phones or birth dates
const OrderViewSchema = z.object({
  id: z.string(),
  status: z.enum(ORDER_STATUSES).openapi({
    description: "pending until Stripe confirms payment; paid; expired if the checkout lapsed unpaid",
  }),
  total: z.int().nonnegative().openapi({ description: "Cents" }),
  tickets: z.array(z.object({
    id: z.string(),
    typeId: z.string(),
    status: z.enum(TICKET_STATUSES),
    holderName: z.string(),
    days: z.array(z.string()),
    extras: z.array(z.object({ extraId: z.string(), name: z.string(), option: z.string().nullable() })),
  })),
});

orders.openapi(
  createRoute({
    method: "get",
    path: "/{id}",
    tags: ["Tickets"],
    summary: "See an order",
    description:
      "Public: the order id is unguessable and only reaches the buyer, through the confirmation " +
      "link. Poll it after checkout until the status is paid. QR codes go out by email, not here.",
    request: {
      params: z.object({ id: z.string().min(1).openapi({ param: { name: "id", in: "path" } }) }),
    },
    responses: {
      200: { description: "The order", content: { "application/json": { schema: OrderViewSchema } } },
      404: { description: "No such order" },
    },
  }),
  async (c) => {
    const db = getFirestore();
    const snap = await db.doc(`orders/${c.req.valid("param").id}`).get();
    if (!snap.exists) {
      throw new HTTPException(404, { message: "order not found" });
    }

    const order = snap.data() as Omit<Order, "id">;
    const docs = order.ticketIds.length > 0
      ? await db.getAll(...order.ticketIds.map((id) => db.doc(`tickets/${id}`)))
      : [];

    const tickets = docs.filter((d) => d.exists).map((d) => {
      const t = d.data() as Ticket;
      return {
        id: d.id,
        typeId: t.typeId,
        status: t.status,
        holderName: t.holderName,
        days: t.days,
        extras: (t.extras ?? []).map((e) => ({ extraId: e.extraId, name: e.name, option: e.option })),
      };
    });

    return c.json({ id: snap.id, status: order.status, total: order.total, tickets }, 200);
  },
);
