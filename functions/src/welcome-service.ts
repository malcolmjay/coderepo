import {randomUUID} from "node:crypto";
import {getFirestore, type DocumentData} from "firebase-admin/firestore";
import {email} from "./domain.js";

export const WELCOME_LEASE_MS = 5 * 60_000;
export const welcomeRef = (address: string) => getFirestore().collection("welcomeEmails").doc(email(address));
export const newWelcome = (createdAt: number) => ({status: "queued", revision: 0, attempts: 0, memberCreatedAt: createdAt, createdAt, updatedAt: createdAt});

export function welcomeSummary(data: DocumentData | undefined, now = Date.now()) {
  if (!data) return null;
  const stale = data.status === "sending" && now - data.updatedAt >= WELCOME_LEASE_MS;
  const status = stale ? "uncertain" : data.status;
  return {status, revision: data.revision, sentAt: data.sentAt ?? null, error: data.error ?? null,
    canRetry: ["failed", "uncertain", "cancelled"].includes(status) || (status === "queued" && now - data.updatedAt >= WELCOME_LEASE_MS)};
}

export class WelcomeSendError extends Error {
  constructor(public readonly reason: "setup" | "rejected" | "uncertain" | "quota") {super("Sign-in invitation could not be confirmed.");}
}
export type WelcomeSender = (message: {to: string}) => Promise<void>;

/** Firestore events can be duplicated or arrive out of order. Only one claim sends. */
export async function deliverWelcome(address: string, revision: number, send: WelcomeSender) {
  const db = getFirestore(), ref = welcomeRef(address), customer = db.collection("members").doc(ref.id);
  const claim = randomUUID();
  const claimed = await db.runTransaction(async tx => {
    const [job, member] = await tx.getAll(ref, customer);
    const data = job.data();
    if (!data || data.revision !== revision || !["queued", "sending"].includes(data.status)) return null;
    if (data.status === "sending") {
      if (Date.now() - data.updatedAt < WELCOME_LEASE_MS) throw new Error("Welcome delivery already in progress.");
      // Email requests have no exactly-once contract. A crashed worker may have sent it;
      // require an explicit admin decision instead of silently sending twice.
      tx.update(ref, {status: "uncertain", error: "uncertain", updatedAt: Date.now()});
      return null;
    }
    if (!member.exists || member.get("active") !== true || member.get("role") !== "customer"
        || member.get("createdAt") !== data.memberCreatedAt) {
      tx.update(ref, {status: "cancelled", updatedAt: Date.now()});
      return null;
    }
    tx.update(ref, {status: "sending", claim, attempts: data.attempts + 1, error: null, updatedAt: Date.now()});
    return true;
  });
  if (!claimed) return;
  let outcome: DocumentData;
  try {
    await send({to: ref.id});
    outcome = {status: "sent", error: null, sentAt: Date.now()};
  } catch (error) {
    const reason = error instanceof WelcomeSendError ? error.reason : "uncertain";
    outcome = {status: reason === "uncertain" ? "uncertain" : "failed", error: reason};
  }
  // If this write fails after Firebase acceptance, the retried event sees the claim
  // and eventually marks it uncertain. It does not send another copy.
  await db.runTransaction(async tx => {
    const current = await tx.get(ref);
    if (current.get("revision") !== revision || current.get("claim") !== claim || current.get("status") !== "sending") return;
    tx.update(ref, {...outcome, updatedAt: Date.now()});
  });
}
