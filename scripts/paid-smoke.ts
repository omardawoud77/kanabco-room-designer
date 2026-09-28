import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import type { ServerConfig } from "../src/lib/config";
import { normalizeGeneratedImage, normalizeUploadedImage } from "../src/lib/images";
import { billableUsageKnown, editRoomImage, estimatedCostCents, moderateRoomImage } from "../src/lib/openai-image";
import { buildRoomPrompt } from "../src/lib/prompt";

const MODEL = "gpt-image-2.5-flare-2026-09-08";
const OUTPUT_DIR = "work/local-test";
const OUTPUT_FILE = "paid-kitchen-concept.jpg";

class SmokeSetupError extends Error {}
let imageEditStarted = false;

async function loadKeyFromLocalEnv(): Promise<string> {
  const envPath = resolve(process.cwd(), ".env.local");
  let contents: string;
  try {
    const info = await lstat(envPath);
    if (!info.isFile()) throw new Error();
    contents = await readFile(envPath, "utf8");
  } catch {
    throw new SmokeSetupError("A regular .env.local file is required in the project directory.");
  }

  let key: string | undefined;
  try {
    key = parseEnv(contents).OPENAI_API_KEY?.trim();
  } catch {
    throw new SmokeSetupError("Could not parse .env.local.");
  }
  if (!key || !key.startsWith("sk-")) {
    throw new SmokeSetupError(".env.local must contain OPENAI_API_KEY.");
  }
  return key;
}

async function main(): Promise<void> {
  if (process.env.PAID_SMOKE_CONFIRM !== "one-generation") {
    throw new SmokeSetupError("Set PAID_SMOKE_CONFIRM=one-generation only after the project hard limit is enabled.");
  }

  const openAiKey = await loadKeyFromLocalEnv();
  const beforePath = resolve(process.cwd(), "demo/kitchen-before.png");
  let beforeBytes: Buffer;
  try {
    beforeBytes = await readFile(beforePath);
  } catch {
    throw new SmokeSetupError("The fictional demo/kitchen-before.png is required.");
  }
  const room = await normalizeUploadedImage(
    new File([new Uint8Array(beforeBytes)], "kitchen-before.png", { type: "image/png" }),
    8 * 1024 * 1024,
    12_000_000,
  );
  const prompt = buildRoomPrompt({
    projectType: "kitchen",
    product: null,
    style: "warm-minimal",
    color: "warm-ivory",
    material: "wood",
  });

  const outputDir = resolve(process.cwd(), OUTPUT_DIR);
  await mkdir(outputDir, { recursive: true });
  const outputPath = resolve(outputDir, OUTPUT_FILE);
  try {
    await lstat(outputPath);
    throw new SmokeSetupError("A paid smoke output already exists. Inspect it before deciding whether to retry.");
  } catch (error) {
    if (error instanceof SmokeSetupError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new SmokeSetupError("Could not inspect the paid smoke output path.");
    }
  }
  const lockPath = resolve(outputDir, "paid-smoke.lock");
  try {
    const lock = await open(lockPath, "wx", 0o600);
    await lock.writeFile(new Date().toISOString() + "\n");
    await lock.close();
  } catch {
    throw new SmokeSetupError("A paid smoke attempt already exists. Inspect it before deciding whether to retry.");
  }

  const config = {
    openAiKey,
    model: MODEL,
    openAiTimeoutMs: 150_000,
    gatewayBaseUrl: null,
    cfAigToken: null,
  } as ServerConfig;

  const allowed = await moderateRoomImage(config, room, prompt);
  if (!allowed) throw new SmokeSetupError("The fictional test image did not pass moderation. No image edit was sent.");

  const safetyUserHash = createHash("sha256").update("kanabco-paid-smoke-fictional-session").digest("hex");
  imageEditStarted = true;
  const result = await editRoomImage({ config, room, prompt, safetyUserHash });
  const jpeg = await normalizeGeneratedImage(result.image);
  await writeFile(outputPath, jpeg, { flag: "wx", mode: 0o600 });

  const known = billableUsageKnown(result.usage);
  const usage = result.usage;
  console.log(JSON.stringify({
    result: "one-image-edit-completed",
    output: `${OUTPUT_DIR}/${OUTPUT_FILE}`,
    model: MODEL,
    usageKnown: known,
    imageInputTokens: usage?.input_tokens_details?.image_tokens ?? null,
    textInputTokens: usage?.input_tokens_details?.text_tokens ?? null,
    outputTokens: usage?.output_tokens ?? null,
    estimatedProviderUsd: known ? (estimatedCostCents(usage, 100) / 100).toFixed(2) : null,
  }));
}

main().catch((error: unknown) => {
  if (error instanceof SmokeSetupError) console.error(error.message);
  else if (imageEditStarted) console.error("Paid smoke stopped after the image edit began. It may have been billed; check project usage before any retry.");
  else console.error("Paid smoke stopped before any image edit was sent.");
  process.exitCode = 1;
});
