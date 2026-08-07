/** Deterministic combat contract for the post-ending boss. */

export const FINAL_BINDER_KIND = 9 as const;
export const FINAL_BINDER_BASE_HP = 575;
export const FINAL_BINDER_BASE_SPEED = 35;
export const FINAL_BINDER_BASE_DAMAGE = 14;
export const FINAL_BINDER_RADIUS = 58;

export const FINAL_BINDER_PATTERN_SEQUENCE = [
  "pageWall",
  "threadSweep",
  "chapterTurn",
] as const;

export type FinalBinderPattern =
  (typeof FINAL_BINDER_PATTERN_SEQUENCE)[number];
export type FinalBinderAxis = "horizontal" | "vertical";
export type FinalBinderPhase =
  | "pursuit"
  | "telegraph"
  | "pageWall"
  | "threadSweep"
  | "chapterBurst"
  | "recovery";

export const FINAL_BINDER_PATTERN_LABELS: Readonly<
  Record<FinalBinderPattern, string>
> = {
  pageWall: "이동 제본선",
  threadSweep: "종언 재봉",
  chapterTurn: "장 넘김",
};

export const FINAL_BINDER_PHASE_LABELS: Readonly<
  Record<FinalBinderPhase, string>
> = {
  pursuit: "정본을 고르는 중",
  telegraph: "제본 예고",
  pageWall: "여백 봉쇄",
  threadSweep: "제본선 회전",
  chapterBurst: "장면 전환",
  recovery: "문장 정리",
};

export const FINAL_BINDER_TELEGRAPH_SECONDS: Readonly<
  Record<FinalBinderPattern, number>
> = {
  pageWall: 0.95,
  threadSweep: 1.05,
  chapterTurn: 0.78,
};

export const FINAL_BINDER_RECOVERY_SECONDS = 0.78;
export const FINAL_BINDER_PAGE_WALL_SECONDS = 1.6;
export const FINAL_BINDER_PAGE_WALL_HALF_WIDTH = 14;
export const FINAL_BINDER_PAGE_WALL_HORIZONTAL_GAP = 220;
export const FINAL_BINDER_PAGE_WALL_VERTICAL_GAP = 180;
export const FINAL_BINDER_THREAD_SWEEP_SECONDS = 1.8;
export const FINAL_BINDER_THREAD_SWEEP_ARC = Math.PI * 1.1;
export const FINAL_BINDER_THREAD_INNER_RADIUS = 94;
export const FINAL_BINDER_THREAD_OUTER_RADIUS = 640;
export const FINAL_BINDER_THREAD_HALF_WIDTH = 15;
export const FINAL_BINDER_CHAPTER_PULSES = 3;
export const FINAL_BINDER_CHAPTER_BURST_SECONDS = 0.16;
export const FINAL_BINDER_CHAPTER_INNER_RADIUS = 94;
export const FINAL_BINDER_CHAPTER_OUTER_RADIUS = 390;
export const FINAL_BINDER_CHAPTER_SAFE_HALF_ANGLE = Math.PI / 3;

export type FinalBinderLineSegment = {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
};

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

export function finalBinderPatternAt(
  completedPatternCount: number,
): FinalBinderPattern {
  const safeCount = Number.isFinite(completedPatternCount)
    ? Math.max(0, Math.floor(completedPatternCount))
    : 0;
  return FINAL_BINDER_PATTERN_SEQUENCE[
    safeCount % FINAL_BINDER_PATTERN_SEQUENCE.length
  ];
}

export function finalBinderPageWallSegments(
  axis: FinalBinderAxis,
  direction: 1 | -1,
  progress: number,
  safeCenter: number,
  arenaWidth = 1280,
  arenaHeight = 720,
): readonly [FinalBinderLineSegment, FinalBinderLineSegment] {
  const normalizedProgress = direction === 1 ? clamp01(progress) : 1 - clamp01(progress);
  const edgeInset = axis === "horizontal" ? 108 : 92;
  const travelSize = axis === "horizontal" ? arenaHeight : arenaWidth;
  const wallPosition =
    edgeInset + (travelSize - edgeInset * 2) * normalizedProgress;
  const lineInset = axis === "horizontal" ? 84 : 76;
  const lineSize = axis === "horizontal" ? arenaWidth : arenaHeight;
  const gapSize =
    axis === "horizontal"
      ? FINAL_BINDER_PAGE_WALL_HORIZONTAL_GAP
      : FINAL_BINDER_PAGE_WALL_VERTICAL_GAP;
  const clampedSafeCenter = Math.max(
    lineInset + gapSize / 2,
    Math.min(lineSize - lineInset - gapSize / 2, safeCenter),
  );
  const gapStart = clampedSafeCenter - gapSize / 2;
  const gapEnd = clampedSafeCenter + gapSize / 2;

  if (axis === "horizontal") {
    return [
      { startX: lineInset, startY: wallPosition, endX: gapStart, endY: wallPosition },
      { startX: gapEnd, startY: wallPosition, endX: arenaWidth - lineInset, endY: wallPosition },
    ];
  }
  return [
    { startX: wallPosition, startY: lineInset, endX: wallPosition, endY: gapStart },
    { startX: wallPosition, startY: gapEnd, endX: wallPosition, endY: arenaHeight - lineInset },
  ];
}

export function finalBinderThreadSweepSegment(
  centerX: number,
  centerY: number,
  startAngle: number,
  direction: 1 | -1,
  progress: number,
): FinalBinderLineSegment {
  const angle =
    startAngle + direction * FINAL_BINDER_THREAD_SWEEP_ARC * clamp01(progress);
  const directionX = Math.cos(angle);
  const directionY = Math.sin(angle);
  return {
    startX: centerX + directionX * FINAL_BINDER_THREAD_INNER_RADIUS,
    startY: centerY + directionY * FINAL_BINDER_THREAD_INNER_RADIUS,
    endX: centerX + directionX * FINAL_BINDER_THREAD_OUTER_RADIUS,
    endY: centerY + directionY * FINAL_BINDER_THREAD_OUTER_RADIUS,
  };
}

export function finalBinderChapterSafeSector(
  initialSector: number,
  direction: 1 | -1,
  pulseIndex: number,
): number {
  const normalized =
    Math.floor(initialSector) + direction * Math.max(0, Math.floor(pulseIndex));
  return ((normalized % 4) + 4) % 4;
}

export function finalBinderAngleDistance(a: number, b: number): number {
  return Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
}

export function finalBinderChapterHits(
  playerX: number,
  playerY: number,
  bossX: number,
  bossY: number,
  safeSector: number,
): boolean {
  const deltaX = playerX - bossX;
  const deltaY = playerY - bossY;
  const radius = Math.hypot(deltaX, deltaY);
  if (
    radius < FINAL_BINDER_CHAPTER_INNER_RADIUS ||
    radius > FINAL_BINDER_CHAPTER_OUTER_RADIUS
  ) {
    return false;
  }
  const safeAngle = (((safeSector % 4) + 4) % 4) * (Math.PI / 2);
  return (
    finalBinderAngleDistance(Math.atan2(deltaY, deltaX), safeAngle) >
    FINAL_BINDER_CHAPTER_SAFE_HALF_ANGLE
  );
}
