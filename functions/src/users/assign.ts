import { randomUUID } from "node:crypto";

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { HTTPException } from "hono/http-exception";

import { audit, auditedAs } from "../audit/audit";
import { requireAdmin, type Env } from "../auth";
import { queueTicketEmails } from "../mail";
import { bearerAuth } from "../schemas";
import { takePlaces } from "../tickets/capacity";
import { loadHostTickets, pairCompanions } from "../tickets/companions";
import { type TicketType, type TicketWrite, type UserProfile, typeSettings } from "../types";

export const ticketAssignment = new OpenAPIHono<Env>();

const AssignedTicketSchema = z.object({
  id: z.string(),
  typeId: z.string(),
  code: z.string(),
  holderName: z.string(),
  holderEmail: z.string(),
  days: z.array(z.string()),
});

ticketAssignment.openapi(
  createRoute({
    method: "post",
    path: "/{uid}/tickets",
    tags: ["Users"],
    summary: "Give a registered user a ticket",
    description:
      "Admin only. One active ticket of any type, linked to the account and emailed to it like " +
      "a door sale. It takes a place (capacity is enforced) but ignores the sale window. Recorded " +
      "as paymentMethod \"assigned\" with the admin as seller.",
    security: bearerAuth,
    ...auditedAs("ticket.assign"),
    middleware: [requireAdmin] as const,
    request: {
      params: z.object({ uid: z.string().min(1).openapi({ param: { name: "uid", in: "path" } }) }),
      body: {
        required: true,
        content: {
          "application/json": {
            schema: z.object({
              typeId: z.string().min(1),
              with: z.string().min(1).optional().openapi({
                description: "Only for a companion type, and required there: the id of the active ticket it " +
                  "goes with, anyone's, whose type allowsCompanion and has no companion yet",
              }),
            }).strict(),
          },
        },
      },
    },
    responses: {
      200: { description: "The ticket", content: { "application/json": { schema: AssignedTicketSchema } } },
      400: {
        description: "A pack type, a type without days yet, an account without an email, an unknown ticket, " +
          "or a companion without `with` (or `with` on another type)",
      },
      403: { description: "Caller is not admin" },
      404: { description: "No such user or ticket type" },
      409: {
        description: "The type is sold out, the account is suspended, or the ticket a companion goes with " +
          "can't take one (not active, already has one, or its type doesn't take them)",
      },
    },
  }),
  async (c) => {
    const { uid } = c.req.valid("param");
    const body = c.req.valid("json");
    const { typeId } = body;
    const admin = c.get("user");
    const db = getFirestore();
    const ticketRef = db.collection("tickets").doc();
    const code = randomUUID();

    const ticket = await db.runTransaction(async (tx) => {
      const typeRef = db.doc(`ticketTypes/${typeId}`);
      const [profileSnap, typeSnap] = await tx.getAll(db.doc(`users/${uid}`), typeRef);
      const hosts = await loadHostTickets(tx, [body], "anyone");

      const profile = profileSnap.data() as UserProfile | undefined;
      if (!profile) throw new HTTPException(404, { message: "user not found" });
      if (profile.suspended) throw new HTTPException(409, { message: "account suspended" });
      if (!profile.email) throw new HTTPException(400, { message: "the account has no email to send the ticket to" });

      const type = typeSnap.data() as Omit<TicketType, "id"> | undefined;
      if (!type) throw new HTTPException(404, { message: `unknown ticket type: ${typeId}` });

      const settings = typeSettings(type);
      if (settings.packSize > 1) {
        throw new HTTPException(400, { message: `${typeId} is a pack of ${settings.packSize}; assign single tickets` });
      }
      if (type.days.length === 0) {
        throw new HTTPException(400, { message: `${typeId} has no days set yet` });
      }
      const sold = type.sold ?? 0;
      if (type.capacity !== null && sold + 1 > type.capacity) {
        throw new HTTPException(409, {
          message: `sold out: ${typeId} has ${Math.max(type.capacity - sold, 0)} left, asked for 1`,
        });
      }

      const [host] = pairCompanions([body], new Map([[typeId, { id: typeId, ...type }]]), hosts) as (string | null)[];

      if (type.poolId) await takePlaces(tx, new Map([[type.poolId, 1]]));

      const ticket = {
        uid,
        typeId,
        status: "active",
        code,
        holderName: profile.displayName || profile.email,
        holderEmail: profile.email,
        paymentMethod: "assigned",
        soldBy: admin.uid,
        purchasedAt: FieldValue.serverTimestamp(),
        days: type.days,
        isLanParty: type.isLanParty,
        entries: settings.entries,
        packId: null,
        poolId: type.poolId ?? null,
        checkins: {},
        ...(host && { companionOf: host }),
      } satisfies TicketWrite;

      tx.update(typeRef, { sold: FieldValue.increment(1) });
      tx.set(ticketRef, ticket);
      if (host) tx.update(hosts.get(host)!.ref, { companionId: ticketRef.id } satisfies Partial<TicketWrite>);
      audit(tx, {
        actor: admin,
        action: "ticket.assign",
        target: { id: ticketRef.id, label: ticket.holderName },
        details: { typeId, uid, email: profile.email, ...(host && { companionOf: host }) },
      });
      return ticket;
    });

    // The ticket is the source of truth; a failed email shouldn't fail the assignment
    try {
      await queueTicketEmails([
        { code, typeId, holderName: ticket.holderName, holderEmail: ticket.holderEmail, days: ticket.days },
      ]);
    } catch (err) {
      console.error("failed to queue assigned ticket email", err);
    }

    return c.json({
      id: ticketRef.id,
      typeId,
      code,
      holderName: ticket.holderName,
      holderEmail: ticket.holderEmail,
      days: ticket.days,
    }, 200);
  },
);
