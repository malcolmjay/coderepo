import {email} from "./domain.js";
import {WelcomeSendError, type WelcomeSender} from "./welcome-service.js";

const AUTH_ENDPOINT = "https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode";

/** Reuse Hosting's public Firebase config, just as the browser does. No SMTP,
 * service-account key, Auth administration privilege, or user ID token needed. */
export function firebaseWelcomeSender(projectId: string, request: typeof fetch = fetch): WelcomeSender {
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)) throw new WelcomeSendError("setup");
  const origin = `https://${projectId}.web.app`;
  let cached: {apiKey: string; expiresAt: number} | undefined;

  return async message => {
    const recipient = email(message.to);
    if (!cached || cached.expiresAt < Date.now()) {
      try {
        const response = await request(`${origin}/__/firebase/init.json`, {signal: AbortSignal.timeout(15_000), redirect: "error"});
        if (!response.ok) throw new Error("Hosting config unavailable.");
        const config = await response.json() as {apiKey?: unknown; projectId?: unknown};
        if (config.projectId !== projectId || typeof config.apiKey !== "string" || !/^[\w-]{1,200}$/.test(config.apiKey)) throw new Error("Invalid Hosting config.");
        cached = {apiKey: config.apiKey, expiresAt: Date.now() + 60 * 60_000};
      } catch {throw new WelcomeSendError("setup");}
    }

    let response: Response;
    try {
      // Firebase sends its existing sign-in template from the project's current
      // sender. Do not generate, return, store, or log the action link ourselves.
      response = await request(`${AUTH_ENDPOINT}?key=${encodeURIComponent(cached.apiKey)}`, {
        method: "POST", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({requestType: "EMAIL_SIGNIN", email: recipient,
          continueUrl: `${origin}/`, canHandleCodeInApp: true}),
        signal: AbortSignal.timeout(30_000), redirect: "error",
      });
    } catch {
      // The request may have reached Firebase even if its response was lost.
      throw new WelcomeSendError("uncertain");
    }
    if (response.ok) return;

    let code = "";
    try {
      const result = await response.json() as {error?: {message?: unknown}};
      if (typeof result.error?.message === "string") code = result.error.message.split(/[ :]/)[0];
    } catch { /* A non-JSON error response is mapped by HTTP status below. */ }
    // Persist only fixed error categories, never Firebase response bodies/links.
    if (response.status === 429 || ["TOO_MANY_ATTEMPTS_TRY_LATER", "QUOTA_EXCEEDED", "RATE_LIMIT_EXCEEDED", "EMAIL_LIMIT_EXCEEDED"].includes(code)) throw new WelcomeSendError("quota");
    if ([401, 403].includes(response.status) || ["OPERATION_NOT_ALLOWED", "INVALID_API_KEY", "API_KEY_INVALID", "PROJECT_NOT_FOUND", "CONFIGURATION_NOT_FOUND", "UNAUTHORIZED_DOMAIN", "INVALID_CONTINUE_URI", "MISSING_CONTINUE_URI"].includes(code)) {
      cached = undefined;
      throw new WelcomeSendError("setup");
    }
    throw new WelcomeSendError(response.status >= 500 ? "uncertain" : "rejected");
  };
}
