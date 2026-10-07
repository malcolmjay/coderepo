import {PortalError, text} from "./domain.js";
import {COMMUNITY_CATEGORIES, COMMUNITY_MAX_BYTES, COMMUNITY_MAX_LABEL, COMMUNITY_SHARING} from "./community-config.js";

export function communityFields(data: Record<string, unknown>) {
  const kind = text(data.kind, "category", 20);
  if (!(kind in COMMUNITY_CATEGORIES) || !Object.hasOwn(COMMUNITY_CATEGORIES, kind)) throw new PortalError("invalid-argument", "Choose 3D files or Code & software.");
  return {
    title: text(data.title, "build title", 120), authorName: text(data.authorName, "contributor name", 60),
    version: text(data.version, "version", 40), kind,
    compatibility: text(data.compatibility, "compatibility", 200),
    notes: text(data.notes, "description and instructions", 10000),
  };
}

export function communitySize(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > COMMUNITY_MAX_BYTES) {
    throw new PortalError("invalid-argument", `Choose a community file between 1 byte and ${COMMUNITY_MAX_LABEL}.`);
  }
  return value as number;
}

export function assertSharing(data: Record<string, unknown>) {
  if (data.sharingAccepted !== true || data.sharingVersion !== COMMUNITY_SHARING.version) {
    throw new PortalError("failed-precondition", "Review and accept the current community sharing agreement before uploading.");
  }
}

export function assertBuildOwner(uid: string, role: string, uploadedBy: unknown) {
  if (uid !== uploadedBy && role !== "admin") throw new PortalError("permission-denied", "Only the uploader or an administrator can manage this build.");
}
