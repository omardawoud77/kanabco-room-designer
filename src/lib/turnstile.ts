import type { ServerConfig } from "./config";

export class TurnstileUnavailableError extends Error {}

export async function verifyTurnstile(token: string, ip: string, config: ServerConfig): Promise<boolean> {
  try {
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: config.turnstileSecretKey, response: token, remoteip: ip }),
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });
    if (!response.ok) throw new TurnstileUnavailableError();
    const data = await response.json() as { success?: boolean; hostname?: string; action?: string };
    return data.success === true && data.hostname === config.turnstileHostname && data.action === "room_design";
  } catch {
    throw new TurnstileUnavailableError();
  }
}
