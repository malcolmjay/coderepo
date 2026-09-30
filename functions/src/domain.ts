export const MAX_BYTES = 5 * 1024 ** 3;
export const CATEGORIES = ["firmware", "software", "models", "guide"] as const;

export class PortalError extends Error {
  constructor(public code: "invalid-argument" | "unauthenticated" | "permission-denied" | "not-found" | "failed-precondition" | "resource-exhausted", message: string) { super(message); }
}

export function email(value: unknown): string {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  // Dots and plus aliases are deliberately preserved. Slash is excluded because
  // canonical email addresses are also the Firestore document IDs.
  if (normalized.length > 254 || !/^[^\s/@]+@[^\s/@]+\.[^\s/@]+$/.test(normalized)) {
    throw new PortalError("invalid-argument", "Enter a valid email address.");
  }
  return normalized;
}

export function text(value: unknown, name: string, max: number, required = true): string {
  if (typeof value !== "string" || value.trim().length > max || (required && !value.trim())) {
    throw new PortalError("invalid-argument", `Check ${name} (maximum ${max} characters).`);
  }
  return value.trim();
}

export function releaseId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{32}$/.test(value)) throw new PortalError("invalid-argument", "Invalid release.");
  return value;
}

export function filename(value: unknown): string {
  const raw = text(value, "filename", 200);
  const safe = raw.replace(/[^a-zA-Z0-9._ -]/g, "_").replace(/^\.+/, "").slice(0, 150);
  if (!safe.trim()) throw new PortalError("invalid-argument", "Choose a file with a valid name.");
  return safe;
}

export function releaseFields(data: Record<string, unknown>) {
  const kind = text(data.kind, "category", 20);
  if (!CATEGORIES.includes(kind as typeof CATEGORIES[number])) throw new PortalError("invalid-argument", "Choose a file category.");
  const sha256 = text(data.sha256 ?? "", "SHA-256", 64, false).toLowerCase();
  if (sha256 && !/^[a-f0-9]{64}$/.test(sha256)) throw new PortalError("invalid-argument", "SHA-256 must contain 64 hexadecimal characters.");
  return {
    title: text(data.title, "title", 120), version: text(data.version, "version", 40), kind,
    compatibility: text(data.compatibility, "compatibility", 200),
    notes: text(data.notes ?? "", "release notes", 10000, false), sha256,
  };
}

export interface Identity { uid: string; email?: unknown; email_verified?: unknown; auth_time?: unknown; }
export interface Member { email: string; role: "admin" | "customer"; active: boolean; validAfter: number; source: string; createdAt: number; updatedAt: number; }

export function assertAccess(identity: Identity | undefined, member: Member | undefined, admin = false): Member {
  if (!identity || identity.email_verified !== true || typeof identity.auth_time !== "number") {
    throw new PortalError("unauthenticated", "Sign in using the link sent to your email.");
  }
  if (!member || !member.active || member.email !== email(identity.email) || identity.auth_time * 1000 < member.validAfter || (admin && member.role !== "admin")) {
    throw new PortalError("permission-denied", "This email does not currently have access. If access was restored, sign in with a new link.");
  }
  return member;
}

export function bulkEmails(value: unknown): string[] {
  if (typeof value !== "string" || value.length > 26000) throw new PortalError("invalid-argument", "Add up to 100 email addresses at a time.");
  const values = [...new Set(value.split(/[\s,;]+/).filter(Boolean).map(email))];
  if (!values.length || values.length > 100) throw new PortalError("invalid-argument", "Add between 1 and 100 email addresses.");
  return values;
}

export function uploadSize(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > MAX_BYTES) throw new PortalError("invalid-argument", "Choose a file between 1 byte and 5 GiB.");
  return value as number;
}
