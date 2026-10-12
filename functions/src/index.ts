import { initializeApp } from "firebase-admin/app";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { setGlobalOptions } from "firebase-functions/v2";
import { logger } from "firebase-functions";
import { dispatch } from "./service.js";
import { PortalError } from "./domain.js";
import { VERIFICATION_TIMEOUT_SECONDS } from "./upload-config.js";
import {onDocumentWritten} from "firebase-functions/v2/firestore";
import {defineSecret} from "firebase-functions/params";
import {deliverWelcome} from "./welcome-service.js";
import {smtpWelcomeSender} from "./welcome-smtp.js";

initializeApp();
setGlobalOptions({region: "northamerica-northeast1", maxInstances: 5, memory: "256MiB", timeoutSeconds: VERIFICATION_TIMEOUT_SECONDS});

export const portal = onCall(async request => {
  try {
    const identity = request.auth ? {uid: request.auth.uid, email: request.auth.token.email,
      email_verified: request.auth.token.email_verified, auth_time: request.auth.token.auth_time} : undefined;
    return await dispatch(identity, request.data);
  } catch (error) {
    if (error instanceof PortalError) throw new HttpsError(error.code, error.message);
    // Never log tokens, signed URLs, login links, or customer payloads.
    logger.error("Portal operation failed", {type: error instanceof Error ? error.name : "UnknownError"});
    throw new HttpsError("internal", "Something went wrong. Please try again or contact Camera Hacks.");
  }
});

const welcomeConfig = defineSecret("WELCOME_EMAIL_CONFIG");
const emulated = process.env.FUNCTIONS_EMULATOR === "true";

export const sendWelcomeEmail = onDocumentWritten({
  document: "welcomeEmails/{email}", database: "(default)",
  secrets: emulated ? [] : [welcomeConfig], retry: true,
  maxInstances: 2, concurrency: 1, timeoutSeconds: 120,
}, async event => {
  // Local development and CI never send mail or load production SMTP secrets.
  // Emulator tests exercise deliverWelcome directly with an injected sender.
  if (emulated) return;
  const after = event.data?.after.data();
  if (!after || after.status !== "queued") return;
  try {
    await deliverWelcome(event.params.email, after.revision, smtpWelcomeSender(() => welcomeConfig.value()));
  } catch {
    // A generic error requests Eventarc redelivery without logging customer data.
    throw new Error("Welcome delivery will be retried.");
  }
});
