import { z } from "@hono/zod-openapi";

import { ROLES, type Ticket } from "./types";

export const bearerAuth = [{ Bearer: [] }];

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

/**
 * Firestore compares strings exactly, so every email is stored and looked up in one form;
 * otherwise "Joan@x.com" and "joan@x.com" would never match.
 */
export const EmailSchema = z
  .string()
  .transform(normalizeEmail)
  .pipe(z.email())
  .openapi({ format: "email", description: "Case-insensitive; stored lowercase" });

export const UserProfileSchema = z.object({
  uid: z.string(),
  email: z.string().nullable(),
  displayName: z.string().nullable(),
  role: z.enum(ROLES),
});

export const CheckinsSchema = z
  .record(z.string(), z.string())
  .openapi({ description: "Check-in time (ISO 8601) keyed by event day (YYYY-MM-DD)" });

export function checkinTimes(checkins: Ticket["checkins"] | undefined): Record<string, string> {
  return Object.fromEntries(
    Object.entries(checkins ?? {}).map(([day, c]) => [day, c.at.toDate().toISOString()]),
  );
}
