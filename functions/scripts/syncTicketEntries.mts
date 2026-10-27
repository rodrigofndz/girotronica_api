/**
 * Local only, never deployed. Makes sold tickets follow their type's entry rule ("once" /
 * "daily") after it was changed: tickets copy it when sold, so changing the type leaves the
 * ones already sold as they were. Live (pending or active) tickets only; tickets whose type is
 * gone are left.
 *
 *   node scripts/syncTicketEntries.mts --as admin@example.com            # only lists them
 *   node scripts/syncTicketEntries.mts --as admin@example.com --apply    # changes them
 *
 * Against the emulators set FIRESTORE_EMULATOR_HOST=127.0.0.1:8180; without it, it uses the
 * real project through `gcloud auth application-default login`.
 */
import { initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";

// Two writes per ticket (the ticket and its audit entry), well under a batch's 500
const CHUNK = 200;

const args = process.argv.slice(2);
const email = args[args.indexOf("--as") + 1];
const apply = args.includes("--apply");
if (!args.includes("--as") || !email) {
  console.error("usage: --as <admin email> [--apply]");
  process.exit(1);
}

const projectId = process.env.GCLOUD_PROJECT ?? "girotronica-api";
initializeApp({ projectId });
const db = getFirestore();
console.log(`${projectId} (${process.env.FIRESTORE_EMULATOR_HOST ? `emulator ${process.env.FIRESTORE_EMULATOR_HOST}` : "PRODUCTION"})`);

// The audit log says which admin did it
const admin = (await db.collection("users").where("email", "==", email).get())
  .docs.find((d) => d.get("role") === "admin");
if (!admin) {
  console.error(`no admin with the email ${email}`);
  process.exit(1);
}

const [typeSnap, ticketSnap] = await Promise.all([
  db.collection("ticketTypes").get(),
  db.collection("tickets").where("status", "in", ["pending", "active"]).get(),
]);
// Types stored before the field existed get in once, as typeSettings() reads them
const rules = new Map(typeSnap.docs.map((d) => [d.id, d.get("entries") ?? "once"]));

const changes: { id: string; holderName: string; typeId: string; from: string; to: string }[] = [];
for (const doc of ticketSnap.docs) {
  const to = rules.get(doc.get("typeId"));
  const from = doc.get("entries") ?? "once";
  if (to && to !== from) changes.push({ id: doc.id, holderName: doc.get("holderName"), typeId: doc.get("typeId"), from, to });
}

const byType = new Map<string, number>();
for (const c of changes) {
  const key = `${c.typeId}: ${c.from} → ${c.to}`;
  byType.set(key, (byType.get(key) ?? 0) + 1);
}
for (const [key, count] of byType) console.log(`  ${key}  ×${count}`);

if (changes.length === 0) {
  console.log("Every live ticket already follows its type.");
} else if (!apply) {
  console.log(`${changes.length} tickets would change; run again with --apply.`);
} else {
  for (let i = 0; i < changes.length; i += CHUNK) {
    const batch = db.batch();
    for (const c of changes.slice(i, i + CHUNK)) {
      batch.update(db.doc(`tickets/${c.id}`), { entries: c.to });
      // Shaped as audit() in src/audit/audit.ts writes it
      batch.create(db.collection("auditLog").doc(), {
        at: FieldValue.serverTimestamp(),
        action: "ticket.entriesSync",
        targetType: "ticket",
        targetId: c.id,
        targetLabel: c.holderName,
        actorUid: admin.id,
        actorEmail: email,
        actorRole: "admin",
        details: { typeId: c.typeId, from: c.from, to: c.to },
      });
    }
    await batch.commit();
  }
  console.log(`Changed ${changes.length} tickets.`);
}
