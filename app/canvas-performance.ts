export const MAX_CANVAS_BACKING_SCALE = 2;

export type CanvasBackingDimensions = Readonly<{
  width: number;
  height: number;
  scale: number;
}>;

/**
 * Sizes a canvas backing store for its actual on-screen footprint while all
 * draw calls remain in the authored logical coordinate plane. The 2x cap
 * bounds one 1280x720 RGBA surface to 2560x1440 (about 14.1 MiB) even on 4K
 * or high-DPI displays.
 */
export function canvasBackingDimensions(
  logicalWidth: number,
  logicalHeight: number,
  renderedWidth: number,
  renderedHeight: number,
  devicePixelRatio: number,
  maximumScale = MAX_CANVAS_BACKING_SCALE,
): CanvasBackingDimensions {
  const safeLogicalWidth =
    Number.isFinite(logicalWidth) && logicalWidth > 0 ? logicalWidth : 1;
  const safeLogicalHeight =
    Number.isFinite(logicalHeight) && logicalHeight > 0 ? logicalHeight : 1;
  const safeRenderedWidth =
    Number.isFinite(renderedWidth) && renderedWidth > 0
      ? renderedWidth
      : safeLogicalWidth;
  const safeRenderedHeight =
    Number.isFinite(renderedHeight) && renderedHeight > 0
      ? renderedHeight
      : safeLogicalHeight;
  const safeDevicePixelRatio =
    Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
      ? devicePixelRatio
      : 1;
  const safeMaximumScale =
    Number.isFinite(maximumScale) && maximumScale >= 1
      ? maximumScale
      : MAX_CANVAS_BACKING_SCALE;
  const renderedScale = Math.min(
    safeRenderedWidth / safeLogicalWidth,
    safeRenderedHeight / safeLogicalHeight,
  );
  const scale = Math.min(
    safeMaximumScale,
    Math.max(1, renderedScale * safeDevicePixelRatio),
  );
  return {
    width: Math.max(1, Math.round(safeLogicalWidth * scale)),
    height: Math.max(1, Math.round(safeLogicalHeight * scale)),
    scale,
  };
}
