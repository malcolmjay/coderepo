import nodemailer from "nodemailer";
import {parseWelcomeConfig} from "./welcome-config.js";
import {WelcomeSendError, type WelcomeSender} from "./welcome-service.js";

export function smtpWelcomeSender(secret: () => string, transportFactory = nodemailer.createTransport): WelcomeSender {
  return async message => {
    let config;
    try {config = parseWelcomeConfig(secret());} catch {throw new WelcomeSendError("setup");}
    if (!config) throw new WelcomeSendError("setup");
    const transport = transportFactory({host: config.host, port: config.port, secure: config.port === 465,
      requireTLS: true, tls: {minVersion: "TLSv1.2", rejectUnauthorized: true},
      auth: {user: config.user, pass: config.password},
      connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 45_000,
      disableFileAccess: true, disableUrlAccess: true, logger: false, debug: false});
    try {
      const result = await transport.sendMail({
        from: {name: "Camera Hacks by Malcolm-Jay", address: config.from},
        ...(config.replyTo ? {replyTo: config.replyTo} : {}),
        to: {address: message.to, name: ""}, envelope: {from: config.from, to: [message.to]},
        subject: message.subject, text: message.text, html: message.html,
        messageId: `<welcome-${message.id}@${config.from.split("@")[1]}>`,
        disableFileAccess: true, disableUrlAccess: true,
      });
      if (!result.accepted.some(address => String(address).toLowerCase() === message.to)) throw new WelcomeSendError("rejected");
    } catch (error) {
      if (error instanceof WelcomeSendError) throw error;
      const failure = error as {code?: string; responseCode?: number};
      // Never persist/log SMTP responses: they can contain credentials or PII.
      if (["EAUTH", "EDNS", "ECONNECTION", "ETLS", "EENVELOPE"].includes(failure.code ?? "")
          || (failure.responseCode && failure.responseCode >= 400 && failure.responseCode <= 599)) throw new WelcomeSendError("rejected");
      throw new WelcomeSendError("uncertain");
    } finally {transport.close();}
  };
}
