import { initializeApp, getApp } from "firebase-admin/app";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { setGlobalOptions } from "firebase-functions/v2";
import { logger } from "firebase-functions";
import { dispatch } from "./service.js";
import { PortalError } from "./domain.js";
import { VERIFICATION_TIMEOUT_SECONDS } from "./upload-config.js";
import {onDocumentWritten} from "firebase-functions/v2/firestore";
import {deliverWelcome} from "./welcome-service.js";
import {firebaseWelcomeSender} from "./welcome-firebase.js";

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

const emulated = process.env.FUNCTIONS_EMULATOR === "true";
let invitationSender: ReturnType<typeof firebaseWelcomeSender> | undefined;

export const sendWelcomeEmail = onDocumentWritten({
  document: "welcomeEmails/{email}", database: "(default)",
  retry: true,
  maxInstances: 2, concurrency: 1, timeoutSeconds: 120,
}, async event => {
  // Local development and CI never send real mail.
  // Emulator tests exercise deliverWelcome directly with an injected sender.
  if (emulated) return;
  const after = event.data?.after.data();
  if (!after || after.status !== "queued") return;
  try {
    invitationSender ??= firebaseWelcomeSender(getApp().options.projectId ?? process.env.GCLOUD_PROJECT ?? "");
    await deliverWelcome(event.params.email, after.revision, invitationSender);
  } catch {
    // A generic error requests Eventarc redelivery without logging customer data.
    throw new Error("Welcome delivery will be retried.");
  }
});
