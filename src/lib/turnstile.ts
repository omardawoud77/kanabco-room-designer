import { isLocalTurnstileTestConfig, type ServerConfig } from "./config";

export class TurnstileUnavailableError extends Error {}

function localTestKeys(config: ServerConfig, ip: string): boolean {
  return isLocalTurnstileTestConfig(config) && ip === "127.0.0.1";
}

export async function verifyTurnstile(token: string, ip: string, config: ServerConfig): Promise<boolean> {
  try {
    if (localTestKeys(config, ip) && token !== "XXXX.DUMMY.TOKEN.XXXX") return false;
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: config.turnstileSecretKey, response: token, remoteip: ip }),
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });
    if (!response.ok) throw new TurnstileUnavailableError();
    const data = await response.json() as { success?: boolean; hostname?: string; action?: string; metadata?: { result_with_testing_key?: boolean } };
    // Cloudflare's public test keys return example.com and omit the widget action.
    // Accept that response only for a development server on loopback with exact test keys.
    if (localTestKeys(config, ip)) {
      return data.success === true && data.hostname === "example.com" && data.metadata?.result_with_testing_key === true;
    }
    return data.success === true && data.hostname === config.turnstileHostname && data.action === "room_design";
  } catch {
    throw new TurnstileUnavailableError();
  }
}
