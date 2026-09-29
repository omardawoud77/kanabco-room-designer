import sharp from "sharp";
import { roomImageOutputSize } from "./image-output-size";
import { MAX_RESULT_IMAGE_BYTES } from "./payload-limits";

export class InvalidImageError extends Error {}

function signatureMatches(bytes: Buffer, mime: string): boolean {
  if (mime === "image/jpeg") return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mime === "image/png") return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mime === "image/webp") return bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  return false;
}

export async function normalizeUploadedImage(file: File, maxBytes: number, maxPixels: number): Promise<Buffer> {
  if (file.size < 1000 || file.size > maxBytes) throw new InvalidImageError();
  const bytes = Buffer.from(await file.arrayBuffer());
  if (!signatureMatches(bytes, file.type)) throw new InvalidImageError();
  try {
    const decoder = sharp(bytes, { limitInputPixels: maxPixels, failOn: "error" });
    const metadata = await decoder.metadata();
    if (!metadata.width || !metadata.height || metadata.width < 320 || metadata.height < 320) throw new InvalidImageError();
    if (!metadata.format || !["jpeg", "png", "webp"].includes(metadata.format) || (metadata.pages ?? 1) > 1) throw new InvalidImageError();
    roomImageOutputSize(metadata.width, metadata.height);
    return await decoder.rotate().resize(1536, 1536, { fit: "inside", withoutEnlargement: true }).flatten({ background: "#ffffff" }).jpeg({ quality: 82, mozjpeg: true }).toBuffer();
  } catch {
    throw new InvalidImageError();
  }
}

export async function normalizeGeneratedImage(bytes: Buffer): Promise<Buffer> {
  try {
    const decoder = sharp(bytes, { limitInputPixels: 8_300_000, failOn: "error" });
    const metadata = await decoder.metadata();
    if (!metadata.width || !metadata.height || metadata.width < 512 || metadata.height < 512) throw new InvalidImageError();
    for (const { maxDimension, quality } of [
      { maxDimension: 1536, quality: 85 },
      { maxDimension: 1536, quality: 70 },
      { maxDimension: 1024, quality: 70 },
      { maxDimension: 768, quality: 60 },
    ]) {
      const encoded = await decoder.clone()
        .resize(maxDimension, maxDimension, { fit: "inside", withoutEnlargement: true })
        .flatten({ background: "#ffffff" })
        .jpeg({ quality, mozjpeg: true })
        .toBuffer();
      if (encoded.length <= MAX_RESULT_IMAGE_BYTES) return encoded;
    }
    throw new InvalidImageError();
  } catch {
    throw new InvalidImageError();
  }
}
