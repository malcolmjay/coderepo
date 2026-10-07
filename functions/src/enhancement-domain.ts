import {PortalError, text} from "./domain.js";
import {ENHANCEMENT_STATUSES, type EnhancementStatus} from "./enhancement-config.js";

export function enhancementId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{32}$/.test(value)) throw new PortalError("invalid-argument", "Invalid enhancement request.");
  return value;
}

export function enhancementFields(data: Record<string, unknown>) {
  return {title: text(data.title, "request title", 120), description: text(data.description, "request description", 5000)};
}

export function enhancementReview(data: Record<string, unknown>) {
  if (!ENHANCEMENT_STATUSES.includes(data.status as EnhancementStatus)) throw new PortalError("invalid-argument", "Choose a valid request status.");
  if (!Number.isSafeInteger(data.reviewVersion) || (data.reviewVersion as number) < 0) throw new PortalError("invalid-argument", "Refresh the request before updating its status.");
  return {status: data.status as EnhancementStatus, statusNote: text(data.statusNote ?? "", "status note", 5000, false), reviewVersion: data.reviewVersion as number};
}
