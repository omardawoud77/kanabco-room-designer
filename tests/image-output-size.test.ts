import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { roomImageOutputSize, UnsupportedRoomAspectError } from "../src/lib/image-output-size";
import { InvalidImageError, normalizeUploadedImage } from "../src/lib/images";

test("room edits request valid roughly 1 MP output in the source orientation", () => {
  const cases = [
    { input: [1600, 1200], expected: "1152x864" },
    { input: [1200, 1600], expected: "864x1152" },
    { input: [1000, 1000], expected: "1024x1024" },
    { input: [1920, 1080], expected: "1360x768" },
  ];
  for (const { input: [width, height], expected } of cases) {
    const size = roomImageOutputSize(width, height);
    assert.equal(size, expected);
    const [outWidth, outHeight] = size.split("x").map(Number);
    assert.equal(outWidth % 16, 0);
    assert.equal(outHeight % 16, 0);
    assert.ok(outWidth * outHeight >= 655_360 && outWidth * outHeight <= 8_294_400);
    assert.ok(Math.max(outWidth, outHeight) <= 3 * Math.min(outWidth, outHeight));
    assert.ok(Math.abs((outWidth / outHeight) / (width / height) - 1) < 0.01);
  }
});

test("unsupported panoramas fail during upload normalization before any paid image edit", async () => {
  assert.throws(() => roomImageOutputSize(1600, 400), UnsupportedRoomAspectError);
  const bytes = await sharp({ create: { width: 1600, height: 400, channels: 3, background: "#d9d0c6" } }).jpeg().toBuffer();
  const file = new File([new Uint8Array(bytes)], "wide-room.jpg", { type: "image/jpeg" });
  await assert.rejects(() => normalizeUploadedImage(file, 8 * 1024 * 1024, 12_000_000), InvalidImageError);
});
