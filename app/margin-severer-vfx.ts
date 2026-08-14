export const MARGIN_SEVERER_VFX_PATH =
  "/assets/effects/margin-sever-line-v3.png";

export const MARGIN_SEVERER_VFX_COLUMNS = 2;
export const MARGIN_SEVERER_VFX_ROWS = 4;
export const MARGIN_SEVERER_VFX_FRAME_COUNT = 8;
export const MARGIN_SEVERER_VFX_CELL_WIDTH = 768;
export const MARGIN_SEVERER_VFX_CELL_HEIGHT = 160;
export const MARGIN_SEVERER_VFX_ENDPOINT_SPAN_RATIO = 728 / 768;

export type MarginSeverVfxPhase = "inscribe" | "sever";

const clampProgress = (progress: number) =>
  Math.max(0, Math.min(0.999999, Number.isFinite(progress) ? progress : 0));

export const marginSeverVfxFrameIndex = (
  phase: MarginSeverVfxPhase,
  progress: number,
) => {
  const safeProgress = clampProgress(progress);
  return phase === "inscribe"
    ? Math.min(2, Math.floor(safeProgress * 3))
    : 3 + Math.min(4, Math.floor(safeProgress * 5));
};

/**
 * The painted endpoint seals occupy a fixed share of every authored wide cell.
 * Aligning that share with the collision segment changes both axes by the same
 * scale, so no frame can be squeezed into a long, flat strip again.
 */
export const marginSeverVfxLayout = (lineLength: number) => {
  const safeLength = Math.max(0, Number.isFinite(lineLength) ? lineLength : 0);
  const width = safeLength / MARGIN_SEVERER_VFX_ENDPOINT_SPAN_RATIO;
  const scale = width / MARGIN_SEVERER_VFX_CELL_WIDTH;
  return {
    width,
    height: MARGIN_SEVERER_VFX_CELL_HEIGHT * scale,
    scale,
  };
};
