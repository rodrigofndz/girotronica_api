import { declaredParams } from "firebase-functions/params";
import { getFirestore } from "firebase-admin/firestore";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { queueTicketEmails } from "../src/mail";
import { deliverMail, MAIL_FROM, sendMail, type Transport } from "../src/mailSender";
import { resetEmulators } from "./helpers";

const fakeTransport = (fail?: string): Transport & { sent: Record<string, unknown>[] } => {
  const sent: Record<string, unknown>[] = [];
  return {
    sent,
    sendMail: vi.fn(async (message: Record<string, unknown>) => {
      if (fail) throw new Error(fail);
      sent.push(message);
      return { messageId: "<id@test>", accepted: message.to as string[], rejected: [] };
    }),
  };
};

const queued = async () => {
  await queueTicketEmails([
    { code: "code-1", holderName: "Anna Puig", holderEmail: "anna@example.com", days: ["2026-11-20"] },
  ]);
  return (await getFirestore().collection("mail").get()).docs[0].ref;
};

beforeEach(resetEmulators);

describe("sending a queued email", () => {
  it("sends it from the event's address, with the QR attached, and records the success", async () => {
    const ref = await queued();
    const transport = fakeTransport();

    expect(await deliverMail(ref, transport)).toBe("sent");

    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]).toMatchObject({
      from: MAIL_FROM, to: ["anna@example.com"], subject: "La teva entrada per la Girotrònica",
      attachments: [expect.objectContaining({ cid: "qr-code-1", contentType: "image/png", encoding: "base64" })],
    });
    expect(transport.sent[0].html).toContain('cid:qr-code-1');
    expect((await ref.get()).data()!.delivery).toMatchObject({
      state: "SUCCESS", attempts: 1, error: null,
      info: { messageId: "<id@test>", accepted: ["anna@example.com"], rejected: [] },
    });
  });

  it("records the reason when sending fails", async () => {
    const ref = await queued();

    expect(await deliverMail(ref, fakeTransport("Invalid login: 535 bad credentials"))).toBe("failed");

    expect((await ref.get()).data()!.delivery).toMatchObject({
      state: "ERROR", error: "Invalid login: 535 bad credentials",
    });
  });

  it("never sends the same email twice when the trigger fires again", async () => {
    const ref = await queued();
    const transport = fakeTransport();

    const outcomes = await Promise.all([deliverMail(ref, transport), deliverMail(ref, transport)]);
    await deliverMail(ref, transport);

    expect(outcomes.sort()).toEqual(["sent", "skipped"]);
    expect(transport.sent).toHaveLength(1);
  });

  it("doesn't retry an email that already failed", async () => {
    const ref = await queued();
    await deliverMail(ref, fakeTransport("boom"));
    const transport = fakeTransport();

    expect(await deliverMail(ref, transport)).toBe("skipped");
    expect(transport.sent).toHaveLength(0);
  });
});

describe("the sendMail function", () => {
  it("runs next to the database and needs the SMTP password", () => {
    expect(sendMail.__endpoint.region).toEqual(["europe-southwest1"]);
    expect(sendMail.__endpoint.secretEnvironmentVariables?.map((s) => s.key)).toEqual(["SMTP_PASSWORD"]);
    expect(declaredParams.map((p) => p.name)).toContain("SMTP_PASSWORD");
  });
});
