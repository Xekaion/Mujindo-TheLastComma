export type FittedSpriteFrame = {
  width: number;
  height: number;
};

/**
 * Fits an authored sprite cell inside a runtime draw box without distorting it.
 *
 * Walk atlases use deliberately padded, non-square cells. Stretching those cells
 * independently on each axis makes every silhouette unnaturally tall and thin,
 * so the smaller axis scale must govern both output dimensions.
 */
export function fitSpriteFrameWithin(
  sourceWidth: number,
  sourceHeight: number,
  maxWidth: number,
  maxHeight: number,
): FittedSpriteFrame {
  if (
    !Number.isFinite(sourceWidth) ||
    !Number.isFinite(sourceHeight) ||
    !Number.isFinite(maxWidth) ||
    !Number.isFinite(maxHeight) ||
    sourceWidth <= 0 ||
    sourceHeight <= 0 ||
    maxWidth <= 0 ||
    maxHeight <= 0
  ) {
    return { width: 0, height: 0 };
  }

  const scale = Math.min(maxWidth / sourceWidth, maxHeight / sourceHeight);
  return {
    width: sourceWidth * scale,
    height: sourceHeight * scale,
  };
}
