export type WelcomeStatus = {status: string; revision: number; sentAt: number | null; error: string | null; canRetry: boolean};

export function welcomeLabel(welcome?: WelcomeStatus | null) {
  if (!welcome) return "—";
  if (welcome.error === "setup") return "Sender setup needed";
  return ({queued: "Queued", sending: "Sending…", sent: "Sent", failed: "Not sent", uncertain: "Check delivery", cancelled: "Cancelled"} as Record<string, string>)[welcome.status] ?? "Check delivery";
}
