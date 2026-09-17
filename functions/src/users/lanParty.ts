import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { getFirestore } from "firebase-admin/firestore";

import { requireRole, type Env } from "../auth";
import { bearerAuth, CheckinsSchema, checkinTimes } from "../schemas";
import type { Ticket } from "../types";

export const lanParty = new OpenAPIHono<Env>();

const MemberSchema = z.object({
  id: z.string(),
  holderName: z.string(),
  holderEmail: z.string(),
  checkins: CheckinsSchema,
});

const membersRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Users"],
  summary: "List LAN party members",
  description: "Staff or admin. Holders of active LAN party tickets.",
  security: bearerAuth,
  middleware: [requireRole("staff", "admin")] as const,
  responses: {
    200: {
      description: "LAN party members",
      content: { "application/json": { schema: z.array(MemberSchema) } },
    },
    403: { description: "Caller is not staff or admin" },
  },
});

lanParty.openapi(membersRoute, async (c) => {
  const snap = await getFirestore()
    .collection("tickets")
    .where("isLanParty", "==", true)
    .where("status", "==", "active")
    .get();

  const result = snap.docs.map((d) => {
    const t = d.data() as Ticket;
    return {
      id: d.id,
      holderName: t.holderName,
      holderEmail: t.holderEmail,
      checkins: checkinTimes(t.checkins),
    };
  });

  return c.json(result, 200);
});
