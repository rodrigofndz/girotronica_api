import { randomUUID } from "node:crypto";

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { FieldValue, getFirestore } from "firebase-admin/firestore";

import { audit, auditedAs } from "../audit/audit";
import { requireStaff, type Env } from "../auth";
import { queueTicketEmails } from "../mail";
import { bearerAuth, EmailSchema } from "../schemas";
import { PAYMENT_METHODS, type TicketWrite, typeSettings } from "../types";
import { packIds, reserveCapacity } from "./capacity";
import { companionLinks, loadHostTickets, pairCompanions, refuseHiddenCompanions, WithSchema } from "./companions";

export const doorSale = new OpenAPIHono<Env>();

const DoorSaleSchema = z.object({
  paymentMethod: z.enum(PAYMENT_METHODS).exclude(["stripe", "assigned"]),
  items: z
    .array(
      z.object({
        typeId: z.string().min(1),
        holderName: z.string().min(1),
        holderEmail: EmailSchema,
        with: WithSchema,
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
    "`soldBy` and `paymentMethod` are recorded for till reconciliation. A companion ticket goes " +
    "`with` someone in the same sale or with any active ticket.",
  security: bearerAuth,
  ...auditedAs("ticket.doorSale"),
  middleware: [requireStaff] as const,
  request: {
    body: { required: true, content: { "application/json": { schema: DoorSaleSchema } } },
  },
  responses: {
    200: {
      description: "Tickets created",
      content: { "application/json": { schema: z.array(SoldTicketSchema) } },
    },
    400: { description: "Invalid body, unknown ticket type or ticket, or a companion without a valid `with`" },
    403: { description: "Caller is not staff or admin" },
    409: {
      description: "A requested ticket type is sold out, or the ticket a companion goes with can't take one " +
        "(not active, already has one, or its type doesn't take them)",
    },
  },
});

doorSale.openapi(doorSaleRoute, async (c) => {
  const { paymentMethod, items } = c.req.valid("json");
  const seller = c.get("user");
  const soldBy = seller.uid;
  const db = getFirestore();

  const ticketRefs = items.map(() => db.collection("tickets").doc());
  const codes = items.map(() => randomUUID());

  // One transaction so the capacity check and the tickets that consume it can't interleave
  const types = await db.runTransaction(async (tx) => {
    const hosts = await loadHostTickets(tx, items, "anyone");
    const reserved = await reserveCapacity(tx, items);
    refuseHiddenCompanions(reserved, seller);
    const packs = packIds(items, reserved);
    const { companionOf, companionId } = companionLinks(
      pairCompanions(items, reserved, hosts),
      ticketRefs.map((ref) => ref.id),
    );
    for (const [id, { ref }] of hosts) {
      tx.update(ref, { companionId: companionId.get(id) } satisfies Partial<TicketWrite>);
    }

    items.forEach((item, i) => {
      const type = reserved.get(item.typeId)!;
      const host = companionOf[i];
      tx.set(ticketRefs[i], {
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
        entries: typeSettings(type).entries,
        packId: packs[i],
        poolId: type.poolId ?? null,
        checkins: {},
        ...(host && { companionOf: host }),
        ...(companionId.has(ticketRefs[i].id) && { companionId: companionId.get(ticketRefs[i].id) }),
      } satisfies TicketWrite);
      audit(tx, {
        actor: seller,
        action: "ticket.doorSale",
        target: { id: ticketRefs[i].id, label: item.holderName },
        details: { typeId: item.typeId, price: type.price, paymentMethod, packId: packs[i], ...(host && { companionOf: host }) },
      });
    });

    return reserved;
  });

  // The ticket is the source of truth; if queueing the email fails, staff still has the
  // code on screen and can resend it from the lookup
  try {
    await queueTicketEmails(
      items.map((item, i) => ({
        code: codes[i],
        typeId: item.typeId,
        holderName: item.holderName,
        holderEmail: item.holderEmail,
        days: types.get(item.typeId)!.days,
      })),
    );
  } catch (err) {
    console.error("failed to queue door sale ticket email", err);
  }

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
