import {email} from "./domain.js";

export type WelcomeConfig = {host: string; port: number; user: string; password: string; from: string; replyTo?: string};

/** Only operator-controlled Secret Manager configuration may supply these fields. */
export function parseWelcomeConfig(raw: string): WelcomeConfig | null {
  let value;
  try {value = JSON.parse(raw);} catch {throw new Error("Invalid welcome sender configuration.");}
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid welcome sender configuration.");
  if (value.enabled === false) return null;
  if (typeof value.host !== "string" || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(value.host) || value.host.length > 253
      || ![465, 587, 2525].includes(value.port)
      || typeof value.user !== "string" || !value.user || value.user.length > 500 || /[\r\n]/.test(value.user)
      || typeof value.password !== "string" || !value.password || value.password.length > 4096) {
    throw new Error("Invalid welcome sender configuration.");
  }
  // Do not accept display-name syntax, comma-separated recipients, or headers.
  const mailbox = (input: unknown) => {
    if (typeof input !== "string" || /[<>(),;:\s]/.test(input)) throw new Error("Use a single sender email address.");
    return email(input);
  };
  return {host: value.host, port: value.port, user: value.user, password: value.password,
    from: mailbox(value.from), ...(value.replyTo ? {replyTo: mailbox(value.replyTo)} : {})};
}
