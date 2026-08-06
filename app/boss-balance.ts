/** Shared, deterministic balance contract for the first and recurring boss. */

export const BLANK_CARTOGRAPHER_BASE_HP = 650;

export const BLANK_CARTOGRAPHER_PATTERN_SEQUENCE = [
  "aimedVolley",
  "teleport",
  "charge",
  "timeRifts",
  "summon",
  "radialVolley",
] as const;

export type BlankCartographerPattern =
  (typeof BLANK_CARTOGRAPHER_PATTERN_SEQUENCE)[number];

export const BLANK_CARTOGRAPHER_PATTERN_LABELS: Readonly<
  Record<BlankCartographerPattern, string>
> = {
  aimedVolley: "추적 미사일",
  teleport: "백지 도약",
  charge: "붉은 교정",
  timeRifts: "시간 좌표 포격",
  summon: "기억 소환",
  radialVolley: "전방위 교열",
};

export const BLANK_CARTOGRAPHER_TELEGRAPH_SECONDS: Readonly<
  Record<BlankCartographerPattern, number>
> = {
  aimedVolley: 0.52,
  teleport: 0.68,
  charge: 0.88,
  timeRifts: 0.9,
  summon: 0.78,
  radialVolley: 0.72,
};

export const BLANK_CARTOGRAPHER_RECOVERY_SECONDS = 0.72;
export const BLANK_CARTOGRAPHER_RIFT_COUNT = 4;
export const BLANK_CARTOGRAPHER_SUMMON_COUNT = 2;

/** Every six completed patterns returns to the opening aimed volley. */
export function blankCartographerPatternAt(
  completedPatternCount: number,
): BlankCartographerPattern {
  const safeCount = Number.isFinite(completedPatternCount)
    ? Math.max(0, Math.floor(completedPatternCount))
    : 0;
  return BLANK_CARTOGRAPHER_PATTERN_SEQUENCE[
    safeCount % BLANK_CARTOGRAPHER_PATTERN_SEQUENCE.length
  ];
}
