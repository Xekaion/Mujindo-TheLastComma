export const MARGIN_SEVERER_KIND = 8 as const;

export const MARGIN_SEVERER_UNLOCK_DEPTH = 4;
export const MARGIN_SEVERER_MAX_PER_ROOM = 1;
export const MARGIN_SEVERER_TELEGRAPH_SECONDS = 0.95;
export const MARGIN_SEVERER_ACTIVE_SECONDS = 1.55;
export const MARGIN_SEVERER_RECOVERY_SECONDS = 0.8;
export const MARGIN_SEVERER_LINE_LENGTH = 520;
export const MARGIN_SEVERER_HIT_HALF_WIDTH = 12;
export const MARGIN_SEVERER_DAMAGE_MULTIPLIER = 1.2;

export type MarginSeverLine = {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
};

export function marginSeverLine(
  centerX: number,
  centerY: number,
  directionX: number,
  directionY: number,
): MarginSeverLine {
  const magnitude = Math.hypot(directionX, directionY) || 1;
  const normalizedX = directionX / magnitude;
  const normalizedY = directionY / magnitude;
  const halfLength = MARGIN_SEVERER_LINE_LENGTH / 2;
  return {
    startX: centerX - normalizedX * halfLength,
    startY: centerY - normalizedY * halfLength,
    endX: centerX + normalizedX * halfLength,
    endY: centerY + normalizedY * halfLength,
  };
}
