import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { getFirestore } from "firebase-admin/firestore";
import { HTTPException } from "hono/http-exception";
import QRCode from "qrcode";

import type { Env } from "../auth";
import { bearerAuth } from "../schemas";
import type { Ticket } from "../types";

export const ticketQr = new OpenAPIHono<Env>();

/** The QR encodes the ticket's opaque code, nothing else; check-in looks it up. */
export function qrPng(code: string): Promise<Buffer> {
  return QRCode.toBuffer(code, { type: "png", errorCorrectionLevel: "Q", scale: 8, margin: 2 });
}

ticketQr.openapi(
  createRoute({
    method: "get",
    path: "/{id}/qr",
    tags: ["Tickets"],
    summary: "Get a ticket's QR code as a PNG",
    description:
      "The ticket's owner, or any staff member. Regenerated from the stored code, " +
      "so a ticket can be reprinted or resent without reissuing it.",
    security: bearerAuth,
    request: {
      params: z.object({ id: z.string().min(1).openapi({ param: { name: "id", in: "path" } }) }),
    },
    responses: {
      200: { description: "PNG image", content: { "image/png": { schema: z.string() } } },
      403: { description: "Not the ticket's owner and not staff" },
      404: { description: "No such ticket" },
    },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const user = c.get("user");

    const snap = await getFirestore().doc(`tickets/${id}`).get();
    if (!snap.exists) {
      throw new HTTPException(404, { message: "ticket not found" });
    }

    const ticket = snap.data() as Ticket;
    const isStaff = user.role === "staff" || user.role === "admin";
    if (!isStaff && ticket.uid !== user.uid) {
      throw new HTTPException(403, { message: "not your ticket" });
    }

    return c.body(new Uint8Array(await qrPng(ticket.code)), 200, {
      "Content-Type": "image/png",
      "Cache-Control": "private, max-age=3600",
    });
  },
);
