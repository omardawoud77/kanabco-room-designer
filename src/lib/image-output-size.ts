const TARGET_PIXELS = 1024 * 1024;
const MIN_PIXELS = Math.ceil(TARGET_PIXELS * 0.9);
const MAX_PIXELS = Math.floor(TARGET_PIXELS * 1.1);

export class UnsupportedRoomAspectError extends Error {}

export function roomImageOutputSize(width: number, height: number): string {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 ||
      Math.max(width, height) > 3 * Math.min(width, height)) {
    throw new UnsupportedRoomAspectError();
  }

  const sourceRatio = width / height;
  let best: { width: number; height: number; score: number } | null = null;

  // The model accepts 16-pixel steps. Keep output near 1 MP so aspect matching does not expand the cost class.
  for (let candidateWidth = 512; candidateWidth <= 2048; candidateWidth += 16) {
    for (let candidateHeight = 512; candidateHeight <= 2048; candidateHeight += 16) {
      const pixels = candidateWidth * candidateHeight;
      if (pixels < MIN_PIXELS || pixels > MAX_PIXELS ||
          Math.max(candidateWidth, candidateHeight) > 3 * Math.min(candidateWidth, candidateHeight)) continue;
      const areaError = Math.abs(Math.log(pixels / TARGET_PIXELS));
      const ratioError = Math.abs(Math.log((candidateWidth / candidateHeight) / sourceRatio));
      const score = ratioError * 10 + areaError;
      if (!best || score < best.score - 1e-12 ||
          (Math.abs(score - best.score) <= 1e-12 && pixels < best.width * best.height)) {
        best = { width: candidateWidth, height: candidateHeight, score };
      }
    }
  }
  if (!best) throw new UnsupportedRoomAspectError();
  return `${best.width}x${best.height}`;
}
