import { getFirestore } from "firebase-admin/firestore";

import { qrPng } from "./tickets/qr";

// Watched by the Firebase "Trigger Email" extension; writing a doc here is what sends the mail
const COLLECTION = "mail";

export type TicketEmail = {
  code: string;
  holderName: string;
  holderEmail: string;
  days: string[];
  extras?: { name: string; option: string | null }[];
};

// The holder's name is typed by the buyer, and the buyer also picks where the mail goes
const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/** "Samarreta (M), Gymsack": what was bought with the ticket, to collect at the event. */
const extrasLine = (t: TicketEmail) =>
  (t.extras ?? []).length === 0
    ? ""
    : "<br>Extres: " + t.extras!.map((e) => escapeHtml(e.option ? `${e.name} (${e.option})` : e.name)).join(", ");

function html(tickets: TicketEmail[]): string {
  const items = tickets
    .map(
      (t) =>
        `<li><strong>${escapeHtml(t.holderName)}</strong> — ${t.days.join(", ")}${extrasLine(t)}<br>` +
        `<img src="cid:qr-${t.code}" alt="Codi QR" width="200"></li>`,
    )
    .join("");

  const intro =
    tickets.length === 1
      ? "Aquí tens la teva entrada. Mostra el codi QR a l'entrada del recinte."
      : "Aquí tens les teves entrades. Mostra els codis QR a l'entrada del recinte.";

  return `<p>${intro}</p><ul>${items}</ul><p>Ens veiem a la Girotrònica!</p>`;
}

/**
 * Queues one email per holder with their tickets attached. Best effort by design:
 * the caller treats a failure here as non-fatal, since the ticket itself already exists.
 */
export async function queueTicketEmails(tickets: TicketEmail[]): Promise<void> {
  const byHolder = new Map<string, TicketEmail[]>();
  for (const ticket of tickets) {
    const group = byHolder.get(ticket.holderEmail) ?? [];
    group.push(ticket);
    byHolder.set(ticket.holderEmail, group);
  }

  const db = getFirestore();
  const batch = db.batch();

  for (const [holderEmail, group] of byHolder) {
    const attachments = await Promise.all(
      group.map(async (t) => ({
        filename: `ticket-${t.code}.png`,
        content: (await qrPng(t.code)).toString("base64"),
        encoding: "base64",
        contentType: "image/png",
        cid: `qr-${t.code}`,
      })),
    );

    batch.set(db.collection(COLLECTION).doc(), {
      to: [holderEmail],
      message: {
        subject:
          group.length === 1
            ? "La teva entrada per la Girotrònica"
            : "Les teves entrades per la Girotrònica",
        text:
          group.length === 1
            ? "Mostra el codi QR adjunt a l'entrada del recinte."
            : "Mostra els codis QR adjunts a l'entrada del recinte.",
        html: html(group),
        attachments,
      },
    });
  }

  await batch.commit();
}
