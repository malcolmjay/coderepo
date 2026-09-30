import { initializeApp } from "firebase-admin/app";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { setGlobalOptions } from "firebase-functions/v2";
import { logger } from "firebase-functions";
import { dispatch } from "./service.js";
import { PortalError } from "./domain.js";

initializeApp();
setGlobalOptions({region: "us-central1", maxInstances: 5, memory: "256MiB", timeoutSeconds: 60});

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
