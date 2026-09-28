export class ConfigurationError extends Error {
  constructor() {
    super("Service configuration is incomplete");
  }
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new ConfigurationError();
  return value;
}

function boundedInteger(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new ConfigurationError();
  return value;
}

function dollarCents(name: string, fallback: string, minCents: number, maxCents: number): number {
  const raw = process.env[name] ?? fallback;
  if (!/^\d{1,7}(?:\.\d{1,2})?$/.test(raw)) throw new ConfigurationError();
  const [dollars, fractional = ""] = raw.split(".");
  const cents = Number(dollars) * 100 + Number(fractional.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents < minCents || cents > maxCents) throw new ConfigurationError();
  return cents;
}

function gatewayBaseUrl(): string | null {
  const value = process.env.CLOUDFLARE_AI_GATEWAY_URL?.trim();
  if (!value) return null;
  if (!/^https:\/\/gateway\.ai\.cloudflare\.com\/v1\/[a-fA-F0-9]{32}\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}\/openai$/.test(value)) {
    throw new ConfigurationError();
  }
  return value;
}

export function featureEnabled(): boolean {
  return process.env.AI_FEATURE_ENABLED === "true";
}

export function publicConfig() {
  return { turnstileSiteKey: required("TURNSTILE_SITE_KEY") };
}

export function serverConfig() {
  const model = process.env.OPENAI_IMAGE_MODEL || "gpt-image-2.5-flare-2026-09-08";
  if (model !== "gpt-image-2.5-flare-2026-09-08") {
    throw new ConfigurationError();
  }
  const allowedOrigin = required("ALLOWED_ORIGIN");
  const origin = new URL(allowedOrigin);
  if (origin.origin !== allowedOrigin || (origin.protocol !== "https:" && process.env.NODE_ENV === "production")) {
    throw new ConfigurationError();
  }
  const sessionSigningKey = required("SESSION_SIGNING_KEY");
  if (sessionSigningKey.length < 32) throw new ConfigurationError();
  const edgeSharedSecret = required("AI_EDGE_SHARED_SECRET");
  if (edgeSharedSecret.length < 32) throw new ConfigurationError();
  const gateway = gatewayBaseUrl();
  const cfAigToken = process.env.CF_AIG_TOKEN?.trim() || null;
  if (cfAigToken && (cfAigToken.length > 1024 || /[\r\n]/.test(cfAigToken))) throw new ConfigurationError();
  return {
    allowedOrigin,
    sessionSigningKey,
    edgeSharedSecret,
    clientIpHeader: required("AI_TRUSTED_CLIENT_IP_HEADER").toLowerCase(),
    turnstileSiteKey: required("TURNSTILE_SITE_KEY"),
    turnstileSecretKey: required("TURNSTILE_SECRET_KEY"),
    turnstileHostname: required("TURNSTILE_EXPECTED_HOSTNAME"),
    openAiKey: required("OPENAI_API_KEY"),
    gatewayBaseUrl: gateway,
    cfAigToken,
    model,
    openAiTimeoutMs: boundedInteger("OPENAI_IMAGE_TIMEOUT_MS", 150000, 30000, 180000),
    imageReserveCents: dollarCents("AI_IMAGE_RESERVED_USD", "1.00", 100, 10000),
    maxBodyBytes: boundedInteger("AI_MAX_BODY_BYTES", 8519680, 1024, 12000000),
    maxImageBytes: boundedInteger("AI_MAX_IMAGE_BYTES", 8388608, 1024, 10000000),
    maxImagePixels: boundedInteger("AI_MAX_IMAGE_PIXELS", 12000000, 1000000, 40000000),
    ipPerMinute: boundedInteger("AI_REQ_PER_MIN_PER_IP", 2, 1, 100),
    ipPerDay: boundedInteger("AI_REQ_PER_DAY_PER_IP", 10, 1, 10000),
    sessionPerDay: boundedInteger("AI_REQ_PER_DAY_PER_SESSION", 2, 1, 100),
    globalPerDay: boundedInteger("AI_REQ_PER_DAY_GLOBAL", 100, 1, 100000),
    ipInflight: boundedInteger("AI_MAX_INFLIGHT_PER_IP", 1, 1, 100),
    sessionInflight: boundedInteger("AI_MAX_INFLIGHT_PER_SESSION", 1, 1, 100),
    globalInflight: boundedInteger("AI_MAX_INFLIGHT_GLOBAL", 2, 1, 1000),
    sessionUsdCents: dollarCents("AI_DAILY_SESSION_USD_CAP", "1.00", 1, 1000000),
    globalUsdCents: dollarCents("AI_DAILY_GLOBAL_USD_CAP", "10.00", 1, 100000000),
    alert10MinCents: dollarCents("ALERT_SPEND_USD_PER_10MIN", "2.00", 1, 100000000),
    logPrompts: process.env.LOG_PROMPTS === "true",
  };
}

export type ServerConfig = ReturnType<typeof serverConfig>;
