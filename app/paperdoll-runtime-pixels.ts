function assertRgbaPixelBuffer(
  pixels: ArrayLike<number>,
  label: string,
): void {
  if (pixels.length % 4 !== 0) {
    throw new RangeError(`${label} must contain complete RGBA pixels`);
  }
}

/** Counts destination pixels that received any non-transparent contribution. */
export function countPaperdollAlphaPixels(
  pixels: ArrayLike<number>,
): number {
  assertRgbaPixelBuffer(pixels, "paperdoll pixel buffer");
  let count = 0;
  for (let index = 3; index < pixels.length; index += 4) {
    if (pixels[index] > 0) count += 1;
  }
  return count;
}

/** Counts RGBA pixels changed by equipment relative to a body-only render. */
export function countPaperdollChangedPixels(
  baseline: ArrayLike<number>,
  candidate: ArrayLike<number>,
): number {
  assertRgbaPixelBuffer(baseline, "paperdoll baseline");
  assertRgbaPixelBuffer(candidate, "paperdoll candidate");
  if (baseline.length !== candidate.length) {
    throw new RangeError("paperdoll pixel buffers must have equal lengths");
  }

  let count = 0;
  for (let index = 0; index < baseline.length; index += 4) {
    if (
      baseline[index] !== candidate[index] ||
      baseline[index + 1] !== candidate[index + 1] ||
      baseline[index + 2] !== candidate[index + 2] ||
      baseline[index + 3] !== candidate[index + 3]
    ) {
      count += 1;
    }
  }
  return count;
}
