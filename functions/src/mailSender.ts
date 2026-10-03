import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { defineSecret } from "firebase-functions/params";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import nodemailer from "nodemailer";

import { MAIL_COLLECTION, type MailDoc } from "./mail";

// Replaces the "Trigger Email" extension (Firebase shuts extensions down in March 2027), with
// the same contract: whatever writes a document to `mail` gets it sent, and the document gets
// a `delivery` record saying how it went.

/** The Google Workspace account the emails come from; its app password is the secret. */
export const SMTP = { host: "smtp.gmail.com", port: 465, user: "info@lagirotronica.cat" } as const;
export const MAIL_FROM = "La Girotrònica <info@lagirotronica.cat>";

export const smtpPassword = defineSecret("SMTP_PASSWORD");

export type Delivery = {
  state: "PROCESSING" | "SUCCESS" | "ERROR";
  attempts: number;
  startTime: FirebaseFirestore.FieldValue | FirebaseFirestore.Timestamp;
  endTime?: FirebaseFirestore.FieldValue | FirebaseFirestore.Timestamp;
  error?: string | null;
  info?: { messageId: string; accepted: string[]; rejected: string[] } | null;
};

/** What actually sends; nodemailer in production, a fake in tests. */
export type Transport = {
  sendMail(message: Record<string, unknown>): Promise<{ messageId: string; accepted: unknown[]; rejected: unknown[] }>;
};

/**
 * Sends one queued email and records the outcome on its document. Firestore triggers can fire
 * more than once for the same document, so it first claims the document in a transaction and
 * does nothing if someone already did: an email is never sent twice.
 */
export async function deliverMail(
  ref: FirebaseFirestore.DocumentReference,
  transport: Transport,
): Promise<"sent" | "failed" | "skipped"> {
  const db = getFirestore();

  const mail = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const doc = snap.data() as (MailDoc & { delivery?: Delivery }) | undefined;
    if (!doc || doc.delivery) return null;

    tx.update(ref, {
      delivery: { state: "PROCESSING", attempts: 1, startTime: FieldValue.serverTimestamp() } satisfies Delivery,
    });
    return doc;
  });
  if (!mail) return "skipped";

  try {
    const result = await transport.sendMail({
      from: MAIL_FROM,
      to: mail.to,
      subject: mail.message.subject,
      text: mail.message.text,
      html: mail.message.html,
      attachments: mail.message.attachments,
    });
    await ref.update({
      "delivery.state": "SUCCESS",
      "delivery.endTime": FieldValue.serverTimestamp(),
      "delivery.error": null,
      "delivery.info": {
        messageId: result.messageId,
        accepted: result.accepted.map(String),
        rejected: result.rejected.map(String),
      },
    });
    return "sent";
  } catch (err) {
    console.error(`failed to send mail ${ref.id}`, err);
    await ref.update({
      "delivery.state": "ERROR",
      "delivery.endTime": FieldValue.serverTimestamp(),
      "delivery.error": err instanceof Error ? err.message : String(err),
    });
    return "failed";
  }
}

export const sendMail = onDocumentCreated(
  // Next to the database (Madrid): a Firestore trigger has to run where the database is
  { document: `${MAIL_COLLECTION}/{id}`, region: "europe-southwest1", secrets: [smtpPassword] },
  async (event) => {
    if (!event.data) return;

    const password = smtpPassword.value();
    if (!password) {
      // The emulator without a password in .secret.local: say so on the document instead of failing
      await event.data.ref.update({
        delivery: {
          state: "ERROR", attempts: 0, startTime: FieldValue.serverTimestamp(),
          error: "SMTP_PASSWORD is not set, so nothing was sent",
        } satisfies Delivery,
      });
      return;
    }

    await deliverMail(event.data.ref, nodemailer.createTransport({
      host: SMTP.host,
      port: SMTP.port,
      secure: true,
      auth: { user: SMTP.user, pass: password },
    }));
  },
);
