/**
 * Pure deterministic encounter contract for the Forbidden Indexer.
 *
 * Rendering, movement, audio, and projectile simulation remain runtime
 * concerns.  This module owns authored pattern order, phase transitions,
 * arena-safe anchors, and the exact collision geometry used by the encounter.
 */

export const FORBIDDEN_INDEXER_KIND = 13 as const;
export const FORBIDDEN_INDEXER_DISPLAY_NAME = "금서의 색인관";
export const FORBIDDEN_INDEXER_BASE_HP = 840;
export const FORBIDDEN_INDEXER_BASE_SPEED = 36;
export const FORBIDDEN_INDEXER_BASE_DAMAGE = 19;
export const FORBIDDEN_INDEXER_RADIUS = 60;

export const FORBIDDEN_INDEXER_PATTERN_SEQUENCE = [
  "indexLances",
  "marginPrison",
  "eclipseRing",
] as const;

export type ForbiddenIndexerPattern =
  (typeof FORBIDDEN_INDEXER_PATTERN_SEQUENCE)[number];

export type ForbiddenIndexerPhase =
  | "pursuit"
  | "telegraph"
  | "indexLances"
  | "marginPrison"
  | "eclipseRing"
  | "recovery";

export type ForbiddenIndexerAxis = "horizontal" | "vertical";
export type ForbiddenIndexerPoint = Readonly<{ x: number; y: number }>;
export type ForbiddenIndexerArena = Readonly<{
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}>;

export const FORBIDDEN_INDEXER_PATTERN_LABELS: Readonly<
  Record<ForbiddenIndexerPattern, string>
> = {
  indexLances: "색인 창진",
  marginPrison: "여백 감옥",
  eclipseRing: "일식 고리",
};

export const FORBIDDEN_INDEXER_PHASE_LABELS: Readonly<
  Record<ForbiddenIndexerPhase, string>
> = {
  pursuit: "금단 목록 탐색",
  telegraph: "색인 예고",
  indexLances: "색인 창 집행",
  marginPrison: "여백 봉쇄",
  eclipseRing: "일식 색인 전개",
  recovery: "금서 재정렬",
};

export const FORBIDDEN_INDEXER_PURSUIT_SECONDS = 0.7;
export const FORBIDDEN_INDEXER_RECOVERY_SECONDS = 0.76;
export const FORBIDDEN_INDEXER_TELEGRAPH_SECONDS: Readonly<
  Record<ForbiddenIndexerPattern, number>
> = {
  indexLances: 0.82,
  marginPrison: 0.96,
  eclipseRing: 1.08,
};
export const FORBIDDEN_INDEXER_LANCE_SECONDS = 0.22;
export const FORBIDDEN_INDEXER_LANCE_COUNT = 3;
export const FORBIDDEN_INDEXER_LANCE_SPREAD_RADIANS = 0.16;
export const FORBIDDEN_INDEXER_LANCE_LENGTH = 1_400;
export const FORBIDDEN_INDEXER_LANCE_HALF_WIDTH = 16;
export const FORBIDDEN_INDEXER_MARGIN_SECONDS = 0.88;
export const FORBIDDEN_INDEXER_MARGIN_SAFE_HALF_GAP = 110;
export const FORBIDDEN_INDEXER_ECLIPSE_PULSE_SECONDS = 0.42;
export const FORBIDDEN_INDEXER_ECLIPSE_RADII = [238, 168, 98] as const;
export const FORBIDDEN_INDEXER_ECLIPSE_HALF_WIDTH = 20;
export const FORBIDDEN_INDEXER_ECLIPSE_SAFE_HALF_ANGLE = Math.PI / 7;
export const FORBIDDEN_INDEXER_WALL_PADDING = 22;
export const FORBIDDEN_INDEXER_MAX_REDUCER_DT = 8;

const DEFAULT_ARENA: ForbiddenIndexerArena = {
  minX: 0,
  minY: 0,
  maxX: 1280,
  maxY: 720,
};
const PHASES: readonly ForbiddenIndexerPhase[] = [
  "pursuit",
  "telegraph",
  "indexLances",
  "marginPrison",
  "eclipseRing",
  "recovery",
];
const EPSILON = 1e-9;
const MAX_COORDINATE = 1_000_000;
const MAX_PHASE_TRANSITIONS_PER_STEP = 32;
const MAX_COMMANDS_PER_STEP = 32;
const MAX_HIT_TOKENS = 16;
const TAU = Math.PI * 2;

const finite = (value: number, fallback = 0): number =>
  Number.isFinite(value) ? value : fallback;

const finiteCoordinate = (value: number, fallback = 0): number =>
  Math.max(-MAX_COORDINATE, Math.min(MAX_COORDINATE, finite(value, fallback)));

const nonNegative = (value: number, fallback = 0): number =>
  Math.max(0, finite(value, fallback));

const finiteInteger = (value: number, fallback = 0): number =>
  Math.max(0, Math.floor(finite(value, fallback)));

const clamp01 = (value: number): number => Math.max(0, Math.min(1, finite(value)));

const normalizeAngle = (value: number): number => {
  const angle = finite(value) % TAU;
  return angle < 0 ? angle + TAU : angle;
};

const angleDistance = (left: number, right: number): number => {
  const delta = Math.abs(normalizeAngle(left) - normalizeAngle(right));
  return Math.min(delta, TAU - delta);
};

const isFinitePoint = (
  point: ForbiddenIndexerPoint | undefined,
): point is ForbiddenIndexerPoint =>
  Boolean(point && Number.isFinite(point.x) && Number.isFinite(point.y));

const safePoint = (
  point: ForbiddenIndexerPoint | undefined,
  fallback: ForbiddenIndexerPoint = { x: 0, y: 0 },
): ForbiddenIndexerPoint => ({
  x: finiteCoordinate(point?.x ?? fallback.x, fallback.x),
  y: finiteCoordinate(point?.y ?? fallback.y, fallback.y),
});

export function normalizeForbiddenIndexerArena(
  arena: Partial<ForbiddenIndexerArena> | undefined,
): ForbiddenIndexerArena {
  const firstX = finiteCoordinate(arena?.minX ?? DEFAULT_ARENA.minX, DEFAULT_ARENA.minX);
  const secondX = finiteCoordinate(arena?.maxX ?? DEFAULT_ARENA.maxX, DEFAULT_ARENA.maxX);
  const firstY = finiteCoordinate(arena?.minY ?? DEFAULT_ARENA.minY, DEFAULT_ARENA.minY);
  const secondY = finiteCoordinate(arena?.maxY ?? DEFAULT_ARENA.maxY, DEFAULT_ARENA.maxY);
  const minX = Math.min(firstX, secondX);
  const maxX = Math.max(firstX, secondX);
  const minY = Math.min(firstY, secondY);
  const maxY = Math.max(firstY, secondY);
  return {
    minX,
    minY,
    maxX: maxX > minX ? maxX : minX + 1,
    maxY: maxY > minY ? maxY : minY + 1,
  };
}

export function clampForbiddenIndexerPointToArena(
  point: ForbiddenIndexerPoint,
  arena: Partial<ForbiddenIndexerArena> = DEFAULT_ARENA,
  entityRadius = FORBIDDEN_INDEXER_RADIUS,
  wallPadding = FORBIDDEN_INDEXER_WALL_PADDING,
): ForbiddenIndexerPoint {
  const bounds = normalizeForbiddenIndexerArena(arena);
  const requestedInset = nonNegative(entityRadius) + nonNegative(wallPadding);
  const insetX = Math.min(requestedInset, (bounds.maxX - bounds.minX) / 2);
  const insetY = Math.min(requestedInset, (bounds.maxY - bounds.minY) / 2);
  const candidate = safePoint(point, {
    x: (bounds.minX + bounds.maxX) / 2,
    y: (bounds.minY + bounds.maxY) / 2,
  });
  return {
    x: Math.max(bounds.minX + insetX, Math.min(bounds.maxX - insetX, candidate.x)),
    y: Math.max(bounds.minY + insetY, Math.min(bounds.maxY - insetY, candidate.y)),
  };
}

export function forbiddenIndexerPatternAt(
  completedPatternCount: number,
): ForbiddenIndexerPattern {
  const index = finiteInteger(completedPatternCount);
  return FORBIDDEN_INDEXER_PATTERN_SEQUENCE[
    index % FORBIDDEN_INDEXER_PATTERN_SEQUENCE.length
  ];
}

function seededUnit(seed: number, castIndex: number, salt: number): number {
  let value = (
    finiteInteger(seed) ^
    Math.imul(finiteInteger(castIndex) + 1, 0x9e3779b1) ^
    Math.imul(finiteInteger(salt) + 17, 0x85ebca6b)
  ) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b);
  value ^= value >>> 16;
  return (value >>> 0) / 0x1_0000_0000;
}

export function forbiddenIndexerMarginAxis(
  seed: number,
  castIndex: number,
): ForbiddenIndexerAxis {
  return seededUnit(seed, castIndex, 3) < 0.5 ? "vertical" : "horizontal";
}

export function forbiddenIndexerMarginSafeCenter(
  arena: Partial<ForbiddenIndexerArena> = DEFAULT_ARENA,
  axis: ForbiddenIndexerAxis = "vertical",
  seed = 0,
  castIndex = 0,
  safeHalfGap = FORBIDDEN_INDEXER_MARGIN_SAFE_HALF_GAP,
  wallPadding = FORBIDDEN_INDEXER_WALL_PADDING,
): number {
  const bounds = normalizeForbiddenIndexerArena(arena);
  const gap = nonNegative(safeHalfGap);
  const padding = nonNegative(wallPadding);
  const minimum = axis === "vertical" ? bounds.minX : bounds.minY;
  const maximum = axis === "vertical" ? bounds.maxX : bounds.maxY;
  const inset = Math.min(gap + padding, (maximum - minimum) / 2);
  const low = minimum + inset;
  const high = maximum - inset;
  return low + (high - low) * seededUnit(seed, castIndex, axis === "vertical" ? 11 : 19);
}

export type ForbiddenIndexerLance = Readonly<{
  start: ForbiddenIndexerPoint;
  end: ForbiddenIndexerPoint;
  angle: number;
}>;

export function forbiddenIndexerLanceSegment(
  origin: ForbiddenIndexerPoint,
  lockedTarget: ForbiddenIndexerPoint,
  strikeIndex: number,
  length = FORBIDDEN_INDEXER_LANCE_LENGTH,
  spreadRadians = FORBIDDEN_INDEXER_LANCE_SPREAD_RADIANS,
): ForbiddenIndexerLance {
  const start = safePoint(origin);
  const target = safePoint(lockedTarget, { x: start.x + 1, y: start.y });
  const baseAngle = Math.atan2(target.y - start.y, target.x - start.x);
  const safeIndex = Math.min(
    FORBIDDEN_INDEXER_LANCE_COUNT - 1,
    finiteInteger(strikeIndex),
  );
  const offset = (safeIndex - (FORBIDDEN_INDEXER_LANCE_COUNT - 1) / 2) *
    nonNegative(spreadRadians);
  const angle = baseAngle + offset;
  const safeLength = nonNegative(length);
  return {
    start,
    end: {
      x: finiteCoordinate(start.x + Math.cos(angle) * safeLength, start.x),
      y: finiteCoordinate(start.y + Math.sin(angle) * safeLength, start.y),
    },
    angle,
  };
}

function distanceToSegmentSquared(
  point: ForbiddenIndexerPoint,
  start: ForbiddenIndexerPoint,
  end: ForbiddenIndexerPoint,
): number {
  if (!isFinitePoint(point) || !isFinitePoint(start) || !isFinitePoint(end)) {
    return Number.MAX_VALUE;
  }
  const segmentX = end.x - start.x;
  const segmentY = end.y - start.y;
  const lengthSquared = segmentX * segmentX + segmentY * segmentY;
  if (!Number.isFinite(lengthSquared) || lengthSquared <= EPSILON) {
    const dx = point.x - start.x;
    const dy = point.y - start.y;
    return dx * dx + dy * dy;
  }
  const projection = Math.max(
    0,
    Math.min(
      1,
      ((point.x - start.x) * segmentX + (point.y - start.y) * segmentY) /
        lengthSquared,
    ),
  );
  const closestX = start.x + segmentX * projection;
  const closestY = start.y + segmentY * projection;
  const dx = point.x - closestX;
  const dy = point.y - closestY;
  return dx * dx + dy * dy;
}

export function forbiddenIndexerLanceHits(
  player: ForbiddenIndexerPoint,
  playerRadius: number,
  lance: ForbiddenIndexerLance,
  halfWidth = FORBIDDEN_INDEXER_LANCE_HALF_WIDTH,
): boolean {
  if (!isFinitePoint(player)) return false;
  const combinedRadius = nonNegative(playerRadius) + nonNegative(halfWidth);
  return distanceToSegmentSquared(player, lance.start, lance.end) <=
    combinedRadius * combinedRadius;
}

export type ForbiddenIndexerMarginFronts = Readonly<{
  first: number;
  second: number;
}>;

export function forbiddenIndexerMarginFronts(
  arena: Partial<ForbiddenIndexerArena>,
  axis: ForbiddenIndexerAxis,
  safeCenter: number,
  progress: number,
  safeHalfGap = FORBIDDEN_INDEXER_MARGIN_SAFE_HALF_GAP,
): ForbiddenIndexerMarginFronts {
  const bounds = normalizeForbiddenIndexerArena(arena);
  const minimum = axis === "vertical" ? bounds.minX : bounds.minY;
  const maximum = axis === "vertical" ? bounds.maxX : bounds.maxY;
  const center = Math.max(minimum, Math.min(maximum, finite(safeCenter, (minimum + maximum) / 2)));
  const gap = Math.min(nonNegative(safeHalfGap), (maximum - minimum) / 2);
  const amount = clamp01(progress);
  return {
    first: minimum + (center - gap - minimum) * amount,
    second: maximum - (maximum - center - gap) * amount,
  };
}

export function forbiddenIndexerMarginHits(
  player: ForbiddenIndexerPoint,
  playerRadius: number,
  arena: Partial<ForbiddenIndexerArena>,
  axis: ForbiddenIndexerAxis,
  safeCenter: number,
  progress: number,
  safeHalfGap = FORBIDDEN_INDEXER_MARGIN_SAFE_HALF_GAP,
): boolean {
  if (!isFinitePoint(player)) return false;
  const fronts = forbiddenIndexerMarginFronts(
    arena,
    axis,
    safeCenter,
    progress,
    safeHalfGap,
  );
  const coordinate = axis === "vertical" ? player.x : player.y;
  const radius = nonNegative(playerRadius);
  return coordinate - radius <= fronts.first || coordinate + radius >= fronts.second;
}

export function forbiddenIndexerEclipseSafeAngle(
  seed: number,
  castIndex: number,
  pulseIndex = 0,
): number {
  return normalizeAngle(
    seededUnit(seed, castIndex, 29) * TAU + finiteInteger(pulseIndex) * 1.37,
  );
}

function eclipsePointIsSafe(
  point: ForbiddenIndexerPoint,
  playerRadius: number,
  center: ForbiddenIndexerPoint,
  safeAngle: number,
  safeHalfAngle: number,
): boolean {
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  const distance = Math.hypot(dx, dy);
  const angularRadius = distance > EPSILON
    ? Math.asin(Math.min(1, nonNegative(playerRadius) / distance))
    : Math.PI;
  const fullySafeHalfAngle = Math.max(0, nonNegative(safeHalfAngle) - angularRadius);
  return angleDistance(Math.atan2(dy, dx), safeAngle) <= fullySafeHalfAngle;
}

export function forbiddenIndexerEclipseHits(
  previousPlayer: ForbiddenIndexerPoint,
  player: ForbiddenIndexerPoint,
  playerRadius: number,
  center: ForbiddenIndexerPoint,
  ringRadius: number,
  safeAngle: number,
  halfWidth = FORBIDDEN_INDEXER_ECLIPSE_HALF_WIDTH,
  safeHalfAngle = FORBIDDEN_INDEXER_ECLIPSE_SAFE_HALF_ANGLE,
): boolean {
  if (
    !isFinitePoint(previousPlayer) ||
    !isFinitePoint(player) ||
    !isFinitePoint(center)
  ) {
    return false;
  }
  const start = previousPlayer;
  const end = player;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const startX = start.x - center.x;
  const startY = start.y - center.y;
  const radius = nonNegative(ringRadius);
  const combined = nonNegative(playerRadius) + nonNegative(halfWidth);
  const candidates = [0, 1];
  const a = dx * dx + dy * dy;
  if (a > EPSILON && Number.isFinite(a)) {
    const b = 2 * (startX * dx + startY * dy);
    const c = startX * startX + startY * startY - radius * radius;
    const discriminant = b * b - 4 * a * c;
    if (discriminant >= 0 && Number.isFinite(discriminant)) {
      const root = Math.sqrt(discriminant);
      for (const value of [(-b - root) / (2 * a), (-b + root) / (2 * a)]) {
        if (value >= 0 && value <= 1) candidates.push(value);
      }
    }
    candidates.push(Math.max(0, Math.min(1, -b / (2 * a))));
  }
  for (const t of candidates) {
    const point = { x: start.x + dx * t, y: start.y + dy * t };
    const distance = Math.hypot(point.x - center.x, point.y - center.y);
    if (Math.abs(distance - radius) > combined) continue;
    if (!eclipsePointIsSafe(point, playerRadius, center, safeAngle, safeHalfAngle)) {
      return true;
    }
  }
  return false;
}

export type ForbiddenIndexerState = Readonly<{
  phase: ForbiddenIndexerPhase;
  pattern: ForbiddenIndexerPattern;
  phaseTimer: number;
  phaseElapsed: number;
  patternIndex: number;
  castIndex: number;
  strikeIndex: number;
  pulseIndex: number;
  origin: ForbiddenIndexerPoint;
  anchor: ForbiddenIndexerPoint;
  axis: ForbiddenIndexerAxis;
  safeCenter: number;
  safeAngle: number;
  hitTokens: readonly string[];
}>;

export type ForbiddenIndexerInput = Readonly<{
  dt: number;
  seed: number;
  castIndex: number;
  bossPosition: ForbiddenIndexerPoint;
  previousPlayerPosition?: ForbiddenIndexerPoint;
  playerPosition: ForbiddenIndexerPoint;
  playerRadius: number;
  arena?: Partial<ForbiddenIndexerArena>;
  wallPadding?: number;
}>;

export type ForbiddenIndexerCommand =
  | Readonly<{
      type: "telegraph";
      pattern: ForbiddenIndexerPattern;
      anchor: ForbiddenIndexerPoint;
      duration: number;
      axis: ForbiddenIndexerAxis;
      safeCenter: number;
      safeAngle: number;
    }>
  | Readonly<{
      type: "indexLance";
      strikeIndex: number;
      start: ForbiddenIndexerPoint;
      end: ForbiddenIndexerPoint;
      angle: number;
    }>
  | Readonly<{
      type: "marginPrison";
      axis: ForbiddenIndexerAxis;
      safeCenter: number;
      safeHalfGap: number;
    }>
  | Readonly<{
      type: "eclipseRing";
      center: ForbiddenIndexerPoint;
      radius: number;
      safeAngle: number;
      safeHalfAngle: number;
      pulseIndex: number;
    }>
  | Readonly<{ type: "damage"; multiplier: number; token: string }>;

export type ForbiddenIndexerStep = Readonly<{
  state: ForbiddenIndexerState;
  commands: readonly ForbiddenIndexerCommand[];
}>;

function phaseDuration(
  phase: ForbiddenIndexerPhase,
  pattern: ForbiddenIndexerPattern,
): number {
  switch (phase) {
    case "pursuit": return FORBIDDEN_INDEXER_PURSUIT_SECONDS;
    case "telegraph": return FORBIDDEN_INDEXER_TELEGRAPH_SECONDS[pattern];
    case "indexLances": return FORBIDDEN_INDEXER_LANCE_SECONDS;
    case "marginPrison": return FORBIDDEN_INDEXER_MARGIN_SECONDS;
    case "eclipseRing": return FORBIDDEN_INDEXER_ECLIPSE_PULSE_SECONDS;
    case "recovery": return FORBIDDEN_INDEXER_RECOVERY_SECONDS;
  }
}

export function createForbiddenIndexerState(
  overrides: Partial<ForbiddenIndexerState> = {},
): ForbiddenIndexerState {
  const patternIndex = finiteInteger(overrides.patternIndex ?? 0);
  const pattern = forbiddenIndexerPatternAt(patternIndex);
  const phase = PHASES.includes(overrides.phase as ForbiddenIndexerPhase)
    ? (overrides.phase as ForbiddenIndexerPhase)
    : "pursuit";
  const duration = phaseDuration(phase, pattern);
  const phaseElapsed = Math.min(duration, nonNegative(overrides.phaseElapsed ?? 0));
  const suppliedTimer = overrides.phaseTimer;
  const phaseTimer = Number.isFinite(suppliedTimer)
    ? Math.min(duration, nonNegative(suppliedTimer as number))
    : Math.max(0, duration - phaseElapsed);
  return {
    phase,
    pattern,
    phaseTimer,
    phaseElapsed,
    patternIndex,
    castIndex: finiteInteger(overrides.castIndex ?? 0),
    strikeIndex: Math.min(
      FORBIDDEN_INDEXER_LANCE_COUNT - 1,
      finiteInteger(overrides.strikeIndex ?? 0),
    ),
    pulseIndex: Math.min(
      FORBIDDEN_INDEXER_ECLIPSE_RADII.length - 1,
      finiteInteger(overrides.pulseIndex ?? 0),
    ),
    origin: safePoint(overrides.origin),
    anchor: safePoint(overrides.anchor),
    axis: overrides.axis === "horizontal" ? "horizontal" : "vertical",
    safeCenter: finiteCoordinate(overrides.safeCenter ?? 0),
    safeAngle: normalizeAngle(overrides.safeAngle ?? 0),
    hitTokens: Array.isArray(overrides.hitTokens)
      ? overrides.hitTokens
          .filter((token): token is string => typeof token === "string")
          .slice(-MAX_HIT_TOKENS)
      : [],
  };
}

function enterPhase(
  state: ForbiddenIndexerState,
  phase: ForbiddenIndexerPhase,
  overrides: Partial<ForbiddenIndexerState> = {},
): ForbiddenIndexerState {
  return createForbiddenIndexerState({
    ...state,
    ...overrides,
    phase,
    phaseElapsed: 0,
    phaseTimer: phaseDuration(phase, overrides.pattern ?? state.pattern),
  });
}

function appendCommand(
  commands: ForbiddenIndexerCommand[],
  command: ForbiddenIndexerCommand,
): void {
  if (commands.length < MAX_COMMANDS_PER_STEP) commands.push(command);
}

function appendDamage(
  state: ForbiddenIndexerState,
  commands: ForbiddenIndexerCommand[],
  token: string,
  multiplier: number,
): ForbiddenIndexerState {
  if (state.hitTokens.includes(token)) return state;
  appendCommand(commands, { type: "damage", multiplier, token });
  return {
    ...state,
    hitTokens: [...state.hitTokens, token].slice(-MAX_HIT_TOKENS),
  };
}

function emitLance(
  state: ForbiddenIndexerState,
  input: ForbiddenIndexerInput,
  commands: ForbiddenIndexerCommand[],
): ForbiddenIndexerState {
  const lance = forbiddenIndexerLanceSegment(
    state.origin,
    state.anchor,
    state.strikeIndex,
  );
  appendCommand(commands, {
    type: "indexLance",
    strikeIndex: state.strikeIndex,
    ...lance,
  });
  return forbiddenIndexerLanceHits(
    input.playerPosition,
    input.playerRadius,
    lance,
  )
    ? appendDamage(state, commands, `lance:${state.castIndex}`, 1.18)
    : state;
}

function emitEclipse(
  state: ForbiddenIndexerState,
  input: ForbiddenIndexerInput,
  commands: ForbiddenIndexerCommand[],
): ForbiddenIndexerState {
  const pulseIndex = Math.min(
    FORBIDDEN_INDEXER_ECLIPSE_RADII.length - 1,
    state.pulseIndex,
  );
  const radius = FORBIDDEN_INDEXER_ECLIPSE_RADII[pulseIndex];
  const safeAngle = forbiddenIndexerEclipseSafeAngle(
    input.seed,
    state.castIndex,
    pulseIndex,
  );
  appendCommand(commands, {
    type: "eclipseRing",
    center: state.origin,
    radius,
    safeAngle,
    safeHalfAngle: FORBIDDEN_INDEXER_ECLIPSE_SAFE_HALF_ANGLE,
    pulseIndex,
  });
  return forbiddenIndexerEclipseHits(
    input.previousPlayerPosition ?? input.playerPosition,
    input.playerPosition,
    input.playerRadius,
    state.origin,
    radius,
    safeAngle,
  )
    ? appendDamage(state, commands, `eclipse:${state.castIndex}:${pulseIndex}`, 0.76)
    : state;
}

function damageInMarginIfNeeded(
  state: ForbiddenIndexerState,
  input: ForbiddenIndexerInput,
  commands: ForbiddenIndexerCommand[],
): ForbiddenIndexerState {
  const progress = clamp01(state.phaseElapsed / FORBIDDEN_INDEXER_MARGIN_SECONDS);
  return forbiddenIndexerMarginHits(
    input.playerPosition,
    input.playerRadius,
    input.arena ?? DEFAULT_ARENA,
    state.axis,
    state.safeCenter,
    progress,
  )
    ? appendDamage(state, commands, `margin:${state.castIndex}`, 1.28)
    : state;
}

function transitionPhase(
  state: ForbiddenIndexerState,
  input: ForbiddenIndexerInput,
  commands: ForbiddenIndexerCommand[],
): ForbiddenIndexerState {
  const arena = normalizeForbiddenIndexerArena(input.arena);
  const wallPadding = nonNegative(
    input.wallPadding ?? FORBIDDEN_INDEXER_WALL_PADDING,
  );

  if (state.phase === "pursuit") {
    const castIndex = Math.max(state.castIndex, finiteInteger(input.castIndex));
    const origin = clampForbiddenIndexerPointToArena(
      input.bossPosition,
      arena,
      FORBIDDEN_INDEXER_RADIUS,
      wallPadding,
    );
    const anchor = clampForbiddenIndexerPointToArena(
      input.playerPosition,
      arena,
      nonNegative(input.playerRadius),
      wallPadding,
    );
    const axis = forbiddenIndexerMarginAxis(input.seed, castIndex);
    const safeCenter = forbiddenIndexerMarginSafeCenter(
      arena,
      axis,
      input.seed,
      castIndex,
      FORBIDDEN_INDEXER_MARGIN_SAFE_HALF_GAP,
      wallPadding,
    );
    const safeAngle = forbiddenIndexerEclipseSafeAngle(input.seed, castIndex);
    const next = enterPhase(state, "telegraph", {
      castIndex,
      origin,
      anchor,
      axis,
      safeCenter,
      safeAngle,
      strikeIndex: 0,
      pulseIndex: 0,
    });
    appendCommand(commands, {
      type: "telegraph",
      pattern: next.pattern,
      anchor,
      duration: FORBIDDEN_INDEXER_TELEGRAPH_SECONDS[next.pattern],
      axis,
      safeCenter,
      safeAngle,
    });
    return next;
  }

  if (state.phase === "telegraph") {
    if (state.pattern === "indexLances") {
      return emitLance(
        enterPhase(state, "indexLances", { strikeIndex: 0 }),
        input,
        commands,
      );
    }
    if (state.pattern === "marginPrison") {
      const next = enterPhase(state, "marginPrison");
      appendCommand(commands, {
        type: "marginPrison",
        axis: next.axis,
        safeCenter: next.safeCenter,
        safeHalfGap: FORBIDDEN_INDEXER_MARGIN_SAFE_HALF_GAP,
      });
      return next;
    }
    return emitEclipse(
      enterPhase(state, "eclipseRing", { pulseIndex: 0 }),
      input,
      commands,
    );
  }

  if (state.phase === "indexLances") {
    const nextStrike = state.strikeIndex + 1;
    if (nextStrike < FORBIDDEN_INDEXER_LANCE_COUNT) {
      return emitLance(
        enterPhase(state, "indexLances", { strikeIndex: nextStrike }),
        input,
        commands,
      );
    }
    return enterPhase(state, "recovery");
  }

  if (state.phase === "marginPrison") {
    return enterPhase(state, "recovery");
  }

  if (state.phase === "eclipseRing") {
    const nextPulse = state.pulseIndex + 1;
    if (nextPulse < FORBIDDEN_INDEXER_ECLIPSE_RADII.length) {
      return emitEclipse(
        enterPhase(state, "eclipseRing", { pulseIndex: nextPulse }),
        input,
        commands,
      );
    }
    return enterPhase(state, "recovery");
  }

  return enterPhase(state, "pursuit", {
    patternIndex: state.patternIndex + 1,
    castIndex: state.castIndex + 1,
    strikeIndex: 0,
    pulseIndex: 0,
    hitTokens: [],
  });
}

export function advanceForbiddenIndexer(
  state: ForbiddenIndexerState,
  input: ForbiddenIndexerInput,
): ForbiddenIndexerStep {
  let current = createForbiddenIndexerState(state);
  let remaining = Math.min(
    FORBIDDEN_INDEXER_MAX_REDUCER_DT,
    nonNegative(input.dt),
  );
  const commands: ForbiddenIndexerCommand[] = [];

  for (
    let transitionCount = 0;
    transitionCount < MAX_PHASE_TRANSITIONS_PER_STEP;
    transitionCount += 1
  ) {
    if (current.phaseTimer <= EPSILON) {
      current = transitionPhase(current, input, commands);
      if (remaining <= EPSILON) break;
      continue;
    }
    if (remaining <= EPSILON) break;

    const elapsed = Math.min(current.phaseTimer, remaining);
    current = createForbiddenIndexerState({
      ...current,
      phaseTimer: Math.max(0, current.phaseTimer - elapsed),
      phaseElapsed: current.phaseElapsed + elapsed,
    });
    remaining = Math.max(0, remaining - elapsed);
    if (current.phase === "marginPrison") {
      current = damageInMarginIfNeeded(current, input, commands);
    }
  }

  return { state: current, commands };
}
