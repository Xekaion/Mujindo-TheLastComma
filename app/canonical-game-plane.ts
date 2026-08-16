export const GAME_DESIGN_WIDTH = 1920;
export const GAME_DESIGN_HEIGHT = 1080;

type ClientRectSize = Pick<DOMRect, "width" | "height">;

export type GamePlaneMetrics = {
  width: number;
  height: number;
  clientToPlaneScaleX: number;
  clientToPlaneScaleY: number;
  clientLeft: number;
  clientTop: number;
};

function positiveOr(value: number, fallback: number) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Reads the single transformed 1920x1080 game plane. Browser client
 * coordinates are physical CSS pixels, while every overlay is laid out in
 * unscaled design pixels. Keeping the conversion here prevents a tooltip or
 * popover from acquiring a second, window-size-dependent layout contract.
 */
export function readGamePlaneMetrics(): GamePlaneMetrics {
  if (typeof document === "undefined") {
    return {
      width: GAME_DESIGN_WIDTH,
      height: GAME_DESIGN_HEIGHT,
      clientToPlaneScaleX: 1,
      clientToPlaneScaleY: 1,
      clientLeft: 0,
      clientTop: 0,
    };
  }

  const plane = document.body;
  const rect = plane.getBoundingClientRect();
  const width = positiveOr(plane.clientWidth, GAME_DESIGN_WIDTH);
  const height = positiveOr(plane.clientHeight, GAME_DESIGN_HEIGHT);
  const renderedWidth = positiveOr(rect.width, width);
  const renderedHeight = positiveOr(rect.height, height);

  return {
    width,
    height,
    clientToPlaneScaleX: width / renderedWidth,
    clientToPlaneScaleY: height / renderedHeight,
    clientLeft: Number.isFinite(rect.left) ? rect.left : 0,
    clientTop: Number.isFinite(rect.top) ? rect.top : 0,
  };
}

export function clientPointToGamePlane(
  clientX: number,
  clientY: number,
  metrics = readGamePlaneMetrics(),
) {
  return {
    x: (clientX - metrics.clientLeft) * metrics.clientToPlaneScaleX,
    y: (clientY - metrics.clientTop) * metrics.clientToPlaneScaleY,
  };
}

export function clientRectSizeToGamePlane(rect: ClientRectSize) {
  const metrics = readGamePlaneMetrics();
  return {
    width: rect.width * metrics.clientToPlaneScaleX,
    height: rect.height * metrics.clientToPlaneScaleY,
  };
}
