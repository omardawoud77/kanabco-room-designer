import type { ServerConfig } from "./config";
import sharp from "sharp";
import { roomImageOutputSize } from "./image-output-size";

export type ImageUsage = {
  input_tokens?: number;
  input_tokens_details?: { image_tokens?: number; text_tokens?: number };
  output_tokens?: number;
  total_tokens?: number;
};

type BillableImageUsage = ImageUsage & {
  input_tokens_details: { image_tokens: number; text_tokens: number };
  output_tokens: number;
};

export class OpenAiUnavailableError extends Error {}

function openAiEndpoint(config: ServerConfig): string {
  if (!config.gatewayBaseUrl) return "https://api.openai.com/v1/images/edits";
  return `${config.gatewayBaseUrl}/images/edits`;
}

function providerHeaders(key: string) {
  return { Authorization: `Bearer ${key}` };
}

function imageProviderHeaders(config: ServerConfig): Record<string, string> {
  const headers: Record<string, string> = providerHeaders(config.openAiKey);
  if (config.gatewayBaseUrl && config.cfAigToken) {
    headers["cf-aig-authorization"] = `Bearer ${config.cfAigToken}`;
  }
  return headers;
}

export async function moderateRoomImage(config: ServerConfig, room: Buffer, prompt: string): Promise<boolean> {
  try {
    const response = await fetch("https://api.openai.com/v1/moderations", {
      method: "POST",
      headers: { ...providerHeaders(config.openAiKey), "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "omni-moderation-latest",
        input: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${room.toString("base64")}` } },
        ],
      }),
      signal: AbortSignal.timeout(12_000),
      cache: "no-store",
      redirect: "error",
    });
    if (!response.ok) throw new OpenAiUnavailableError();
    const data = await response.json() as { results?: Array<{ flagged?: boolean }> };
    if (!Array.isArray(data.results) || data.results.length !== 1 || typeof data.results[0]?.flagged !== "boolean") {
      throw new OpenAiUnavailableError();
    }
    return !data.results.some((result) => result.flagged);
  } catch {
    throw new OpenAiUnavailableError();
  }
}

export async function editRoomImage(options: {
  config: ServerConfig;
  room: Buffer;
  productReference?: Buffer;
  prompt: string;
  safetyUserHash: string;
}): Promise<{ image: Buffer; usage: ImageUsage | null }> {
  const { config, room, productReference, prompt, safetyUserHash } = options;
  let size: string;
  try {
    const metadata = await sharp(room, { limitInputPixels: 12_000_000, failOn: "error" }).metadata();
    size = roomImageOutputSize(metadata.width ?? 0, metadata.height ?? 0);
  } catch {
    throw new OpenAiUnavailableError();
  }
  const form = new FormData();
  form.set("model", config.model);
  form.append("image[]", new Blob([new Uint8Array(room)], { type: "image/jpeg" }), "room.jpg");
  if (productReference) form.append("image[]", new Blob([new Uint8Array(productReference)], { type: "image/png" }), "kanabco-product.png");
  form.set("prompt", prompt);
  form.set("n", "1");
  form.set("quality", "low");
  form.set("size", size);
  form.set("output_format", "jpeg");
  form.set("output_compression", "80");
  form.set("user", safetyUserHash);
  try {
    const response = await fetch(openAiEndpoint(config), {
      method: "POST",
      headers: imageProviderHeaders(config),
      body: form,
      signal: AbortSignal.timeout(config.openAiTimeoutMs),
      cache: "no-store",
      redirect: "error",
    });
    if (!response.ok) throw new OpenAiUnavailableError();
    const data = await response.json() as { data?: Array<{ b64_json?: string }>; usage?: ImageUsage };
    const encoded = data.data?.[0]?.b64_json;
    if (!encoded || !/^[A-Za-z0-9+/=]+$/.test(encoded) || encoded.length > 20_000_000) throw new OpenAiUnavailableError();
    return { image: Buffer.from(encoded, "base64"), usage: data.usage ?? null };
  } catch {
    throw new OpenAiUnavailableError();
  }
}

export function estimatedCostCents(usage: ImageUsage | null, reservedCents: number): number {
  if (!billableUsageKnown(usage)) return reservedCents;
  const imageInput = usage.input_tokens_details?.image_tokens;
  const textInput = usage.input_tokens_details?.text_tokens;
  const output = usage.output_tokens;
  const usd = ((imageInput as number) * 8 + (textInput as number) * 5 + (output as number) * 30) / 1_000_000;
  return Math.max(1, Math.ceil(usd * 100));
}

export function billableUsageKnown(usage: ImageUsage | null): usage is BillableImageUsage {
  if (!usage) return false;
  return [usage.input_tokens_details?.image_tokens, usage.input_tokens_details?.text_tokens, usage.output_tokens]
    .every((value) => Number.isSafeInteger(value) && (value as number) >= 0);
}
