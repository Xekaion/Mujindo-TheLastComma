/**
 * Pure deterministic encounter contract for the Inkbound Magistrate.
 *
 * Rendering, navigation, and projectile simulation remain runtime concerns.
 * This module owns the authored pattern order, phase transitions, wall-safe
 * anchors, and the immediate collision geometry used by encounter validation.
 */

export const INKBOUND_MAGISTRATE_KIND = 12 as const;
export const INKBOUND_MAGISTRATE_DISPLAY_NAME = "먹칠된 판관";
export const INKBOUND_MAGISTRATE_BASE_HP = 780;
export const INKBOUND_MAGISTRATE_BASE_SPEED = 39;
export const INKBOUND_MAGISTRATE_BASE_DAMAGE = 18;
export const INKBOUND_MAGISTRATE_RADIUS = 58;

export const INKBOUND_MAGISTRATE_PATTERN_SEQUENCE = [
  "chainCross",
  "inkDoubles",
  "finalVerdict",
] as const;

export type InkboundMagistratePattern =
  (typeof INKBOUND_MAGISTRATE_PATTERN_SEQUENCE)[number];

export type InkboundMagistratePhase =
  | "pursuit"
  | "telegraph"
  | "chainBind"
  | "crossWaves"
  | "cloneBarrage"
  | "executionWarning"
  | "verdictBurst"
  | "recovery";

export type InkboundPoint = Readonly<{ x: number; y: number }>;

export type InkboundArenaBounds = Readonly<{
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}>;

export const INKBOUND_MAGISTRATE_PATTERN_LABELS: Readonly<
  Record<InkboundMagistratePattern, string>
> = {
  chainCross: "쇄도하는 십자 사슬",
  inkDoubles: "먹물 분신 판결",
  finalVerdict: "최후 판결",
};

export const INKBOUND_MAGISTRATE_PHASE_LABELS: Readonly<
  Record<InkboundMagistratePhase, string>
> = {
  pursuit: "판결 대기",
  telegraph: "판결 예고",
  chainBind: "사슬 속박",
  crossWaves: "십자 파동",
  cloneBarrage: "먹물 분신 포화",
  executionWarning: "처형 구역 경고",
  verdictBurst: "최후 판결 집행",
  recovery: "먹물 회수",
};

export const INKBOUND_MAGISTRATE_PURSUIT_SECONDS = 0.68;
export const INKBOUND_MAGISTRATE_RECOVERY_SECONDS = 0.7;
export const INKBOUND_MAGISTRATE_CHAIN_BIND_SECONDS = 0.46;
export const INKBOUND_MAGISTRATE_CROSS_WAVE_SECONDS = 1.08;
export const INKBOUND_MAGISTRATE_CLONE_BARRAGE_SECONDS = 1.44;
export const INKBOUND_MAGISTRATE_EXECUTION_WARNING_SECONDS = 0.82;
export const INKBOUND_MAGISTRATE_VERDICT_BURST_SECONDS = 0.18;

export const INKBOUND_MAGISTRATE_TELEGRAPH_SECONDS: Readonly<
  Record<InkboundMagistratePattern, number>
> = {
  chainCross: 0.78,
  inkDoubles: 0.88,
  finalVerdict: 1.04,
};

export const INKBOUND_MAGISTRATE_CHAIN_HALF_WIDTH = 18;
export const INKBOUND_MAGISTRATE_CROSS_WAVE_COUNT = 3;
export const INKBOUND_MAGISTRATE_CROSS_WAVE_START_RADIUS = 82;
export const INKBOUND_MAGISTRATE_CROSS_WAVE_SPACING = 92;
export const INKBOUND_MAGISTRATE_CROSS_WAVE_HALF_WIDTH = 17;
export const INKBOUND_MAGISTRATE_CROSS_WAVE_HALF_LENGTH = 520;
export const INKBOUND_MAGISTRATE_CLONE_COUNT = 3;
export const INKBOUND_MAGISTRATE_CLONE_RADIUS = 188;
export const INKBOUND_MAGISTRATE_BARRAGE_VOLLEYS = 4;
export const INKBOUND_MAGISTRATE_BARRAGE_HALF_WIDTH = 12;
export const INKBOUND_MAGISTRATE_VERDICT_SAFE_RADIUS = 112;
export const INKBOUND_MAGISTRATE_WALL_PADDING = 22;
export const INKBOUND_MAGISTRATE_MAX_REDUCER_DT = 8;

const DEFAULT_ARENA: InkboundArenaBounds = {
  minX: 0,
  minY: 0,
  maxX: 1280,
  maxY: 720,
};
const PHASES: readonly InkboundMagistratePhase[] = [
  "pursuit",
  "telegraph",
  "chainBind",
  "crossWaves",
  "cloneBarrage",
  "executionWarning",
  "verdictBurst",
  "recovery",
];
const EPSILON = 1e-9;
const MAX_COORDINATE = 1_000_000;
const MAX_PHASE_TRANSITIONS_PER_STEP = 32;
const MAX_HIT_TOKENS = 24;
const MAX_COMMANDS_PER_STEP = 32;

const finite = (value: number, fallback = 0): number =>
  Number.isFinite(value) ? value : fallback;

const finiteCoordinate = (value: number, fallback = 0): number =>
  Math.max(-MAX_COORDINATE, Math.min(MAX_COORDINATE, finite(value, fallback)));

const nonNegative = (value: number, fallback = 0): number =>
  Math.max(0, finite(value, fallback));

const finiteInteger = (value: number, fallback = 0): number =>
  Math.max(0, Math.floor(finite(value, fallback)));

const isFinitePoint = (point: InkboundPoint | undefined): point is InkboundPoint =>
  Boolean(point && Number.isFinite(point.x) && Number.isFinite(point.y));

const safePoint = (
  point: InkboundPoint | undefined,
  fallback: InkboundPoint = { x: 0, y: 0 },
): InkboundPoint => ({
  x: finiteCoordinate(point?.x ?? fallback.x, fallback.x),
  y: finiteCoordinate(point?.y ?? fallback.y, fallback.y),
});

export function normalizeInkboundArena(
  arena: Partial<InkboundArenaBounds> | undefined,
): InkboundArenaBounds {
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

/** Clamps an entity centre far enough from every wall to keep its full radius on floor. */
export function clampInkboundPointToArena(
  point: InkboundPoint,
  arena: Partial<InkboundArenaBounds> = DEFAULT_ARENA,
  entityRadius = INKBOUND_MAGISTRATE_RADIUS,
  wallPadding = INKBOUND_MAGISTRATE_WALL_PADDING,
): InkboundPoint {
  const bounds = normalizeInkboundArena(arena);
  const requestedInset = nonNegative(entityRadius) + nonNegative(wallPadding);
  const halfWidth = (bounds.maxX - bounds.minX) / 2;
  const halfHeight = (bounds.maxY - bounds.minY) / 2;
  const insetX = Math.min(requestedInset, halfWidth);
  const insetY = Math.min(requestedInset, halfHeight);
  const minimumX = bounds.minX + insetX;
  const maximumX = bounds.maxX - insetX;
  const minimumY = bounds.minY + insetY;
  const maximumY = bounds.maxY - insetY;
  const candidate = safePoint(point, {
    x: (bounds.minX + bounds.maxX) / 2,
    y: (bounds.minY + bounds.maxY) / 2,
  });
  return {
    x: Math.max(minimumX, Math.min(maximumX, candidate.x)),
    y: Math.max(minimumY, Math.min(maximumY, candidate.y)),
  };
}

export function inkboundMagistratePatternAt(
  completedPatternCount: number,
): InkboundMagistratePattern {
  const index = finiteInteger(completedPatternCount);
  return INKBOUND_MAGISTRATE_PATTERN_SEQUENCE[
    index % INKBOUND_MAGISTRATE_PATTERN_SEQUENCE.length
  ];
}

function distanceToSegmentSquared(
  point: InkboundPoint,
  start: InkboundPoint,
  end: InkboundPoint,
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
    const result = dx * dx + dy * dy;
    return Number.isFinite(result) ? result : Number.MAX_VALUE;
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
  const result = dx * dx + dy * dy;
  return Number.isFinite(result) ? result : Number.MAX_VALUE;
}

export function inkboundSegmentHitsCircle(
  start: InkboundPoint,
  end: InkboundPoint,
  circleCenter: InkboundPoint,
  circleRadius: number,
  halfWidth = 0,
): boolean {
  if (!isFinitePoint(start) || !isFinitePoint(end) || !isFinitePoint(circleCenter)) {
    return false;
  }
  const combinedRadius = nonNegative(circleRadius) + nonNegative(halfWidth);
  return distanceToSegmentSquared(circleCenter, start, end) <= combinedRadius * combinedRadius;
}

export function inkboundChainBindHits(
  player: InkboundPoint,
  playerRadius: number,
  boss: InkboundPoint,
  target: InkboundPoint,
  chainHalfWidth = INKBOUND_MAGISTRATE_CHAIN_HALF_WIDTH,
): boolean {
  return inkboundSegmentHitsCircle(
    boss,
    target,
    player,
    playerRadius,
    chainHalfWidth,
  );
}

/** Tests the four outward-moving arms of one cross-wave pulse. */
export function inkboundCrossWaveHits(
  player: InkboundPoint,
  playerRadius: number,
  center: InkboundPoint,
  waveDistance: number,
  halfWidth = INKBOUND_MAGISTRATE_CROSS_WAVE_HALF_WIDTH,
  halfLength = INKBOUND_MAGISTRATE_CROSS_WAVE_HALF_LENGTH,
): boolean {
  if (!isFinitePoint(player) || !isFinitePoint(center)) return false;
  const distance = nonNegative(waveDistance);
  const width = nonNegative(halfWidth) + nonNegative(playerRadius);
  const length = nonNegative(halfLength) + nonNegative(playerRadius);
  const dx = Math.abs(player.x - center.x);
  const dy = Math.abs(player.y - center.y);
  return (
    (Math.abs(dx - distance) <= width && dy <= length) ||
    (Math.abs(dy - distance) <= width && dx <= length)
  );
}

export function inkboundBarrageHits(
  player: InkboundPoint,
  playerRadius: number,
  cloneOrigins: readonly InkboundPoint[],
  target: InkboundPoint,
  projectileHalfWidth = INKBOUND_MAGISTRATE_BARRAGE_HALF_WIDTH,
): boolean {
  if (!Array.isArray(cloneOrigins) || !isFinitePoint(target)) return false;
  return cloneOrigins.some((origin) =>
    inkboundSegmentHitsCircle(
      origin,
      target,
      player,
      playerRadius,
      projectileHalfWidth,
    ),
  );
}

/** The execution burst covers the arena except for its pre-announced safe seal. */
export function inkboundVerdictHits(
  player: InkboundPoint,
  playerRadius: number,
  safeCenter: InkboundPoint,
  safeRadius = INKBOUND_MAGISTRATE_VERDICT_SAFE_RADIUS,
  arena: Partial<InkboundArenaBounds> = DEFAULT_ARENA,
): boolean {
  if (!isFinitePoint(player) || !isFinitePoint(safeCenter)) return false;
  const bounds = normalizeInkboundArena(arena);
  const radius = nonNegative(playerRadius);
  if (
    player.x + radius < bounds.minX ||
    player.x - radius > bounds.maxX ||
    player.y + radius < bounds.minY ||
    player.y - radius > bounds.maxY
  ) {
    return false;
  }
  const dx = player.x - safeCenter.x;
  const dy = player.y - safeCenter.y;
  const protectedRadius = Math.max(0, nonNegative(safeRadius) - radius);
  return dx * dx + dy * dy > protectedRadius * protectedRadius;
}

function seededUnit(seed: number, castIndex: number, salt: number): number {
  let value = (
    finiteInteger(seed) ^
    Math.imul(finiteInteger(castIndex) + 1, 0x9e3779b1) ^
    Math.imul(finiteInteger(salt) + 11, 0x85ebca6b)
  ) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b);
  value ^= value >>> 16;
  return (value >>> 0) / 0x1_0000_0000;
}

export function inkboundCloneLayout(
  center: InkboundPoint,
  arena: Partial<InkboundArenaBounds> = DEFAULT_ARENA,
  seed = 0,
  castIndex = 0,
  count = INKBOUND_MAGISTRATE_CLONE_COUNT,
  orbitRadius = INKBOUND_MAGISTRATE_CLONE_RADIUS,
  entityRadius = INKBOUND_MAGISTRATE_RADIUS,
  wallPadding = INKBOUND_MAGISTRATE_WALL_PADDING,
): readonly InkboundPoint[] {
  const safeCount = Math.min(8, finiteInteger(count));
  if (safeCount === 0) return [];
  const origin = safePoint(center);
  const radius = nonNegative(orbitRadius);
  const startAngle = seededUnit(seed, castIndex, 1) * Math.PI * 2;
  return Array.from({ length: safeCount }, (_, index) => {
    const angle = startAngle + (index / safeCount) * Math.PI * 2;
    return clampInkboundPointToArena(
      {
        x: origin.x + Math.cos(angle) * radius,
        y: origin.y + Math.sin(angle) * radius,
      },
      arena,
      entityRadius,
      wallPadding,
    );
  });
}

export function inkboundVerdictSafeCenter(
  arena: Partial<InkboundArenaBounds> = DEFAULT_ARENA,
  seed = 0,
  castIndex = 0,
  safeRadius = INKBOUND_MAGISTRATE_VERDICT_SAFE_RADIUS,
  wallPadding = INKBOUND_MAGISTRATE_WALL_PADDING,
): InkboundPoint {
  const bounds = normalizeInkboundArena(arena);
  const raw = {
    x: bounds.minX + (bounds.maxX - bounds.minX) * (0.2 + seededUnit(seed, castIndex, 7) * 0.6),
    y: bounds.minY + (bounds.maxY - bounds.minY) * (0.2 + seededUnit(seed, castIndex, 13) * 0.6),
  };
  return clampInkboundPointToArena(raw, bounds, safeRadius, wallPadding);
}

export type InkboundMagistrateState = Readonly<{
  phase: InkboundMagistratePhase;
  pattern: InkboundMagistratePattern;
  phaseTimer: number;
  phaseElapsed: number;
  patternIndex: number;
  castIndex: number;
  pulseIndex: number;
  origin: InkboundPoint;
  anchor: InkboundPoint;
  clones: readonly InkboundPoint[];
  hitTokens: readonly string[];
}>;

export type InkboundMagistrateInput = Readonly<{
  dt: number;
  seed: number;
  castIndex: number;
  bossPosition: InkboundPoint;
  playerPosition: InkboundPoint;
  playerRadius: number;
  arena?: Partial<InkboundArenaBounds>;
  wallPadding?: number;
}>;

export type InkboundMagistrateCommand =
  | Readonly<{
      type: "telegraph";
      pattern: InkboundMagistratePattern;
      anchor: InkboundPoint;
      duration: number;
    }>
  | Readonly<{ type: "chainBind"; start: InkboundPoint; end: InkboundPoint }>
  | Readonly<{
      type: "crossWave";
      center: InkboundPoint;
      waveIndex: number;
      distance: number;
    }>
  | Readonly<{ type: "spawnClones"; positions: readonly InkboundPoint[] }>
  | Readonly<{
      type: "inkBarrage";
      origins: readonly InkboundPoint[];
      target: InkboundPoint;
      volleyIndex: number;
    }>
  | Readonly<{
      type: "executionWarning";
      safeCenter: InkboundPoint;
      safeRadius: number;
    }>
  | Readonly<{
      type: "verdictBurst";
      safeCenter: InkboundPoint;
      safeRadius: number;
    }>
  | Readonly<{ type: "damage"; multiplier: number; token: string }>;

export type InkboundMagistrateStep = Readonly<{
  state: InkboundMagistrateState;
  commands: readonly InkboundMagistrateCommand[];
}>;

function phaseDuration(
  phase: InkboundMagistratePhase,
  pattern: InkboundMagistratePattern,
): number {
  switch (phase) {
    case "pursuit": return INKBOUND_MAGISTRATE_PURSUIT_SECONDS;
    case "telegraph": return INKBOUND_MAGISTRATE_TELEGRAPH_SECONDS[pattern];
    case "chainBind": return INKBOUND_MAGISTRATE_CHAIN_BIND_SECONDS;
    case "crossWaves": return INKBOUND_MAGISTRATE_CROSS_WAVE_SECONDS;
    case "cloneBarrage": return INKBOUND_MAGISTRATE_CLONE_BARRAGE_SECONDS;
    case "executionWarning": return INKBOUND_MAGISTRATE_EXECUTION_WARNING_SECONDS;
    case "verdictBurst": return INKBOUND_MAGISTRATE_VERDICT_BURST_SECONDS;
    case "recovery": return INKBOUND_MAGISTRATE_RECOVERY_SECONDS;
  }
}

export function createInkboundMagistrateState(
  overrides: Partial<InkboundMagistrateState> = {},
): InkboundMagistrateState {
  const patternIndex = finiteInteger(overrides.patternIndex ?? 0);
  const pattern = inkboundMagistratePatternAt(patternIndex);
  const phase = PHASES.includes(overrides.phase as InkboundMagistratePhase)
    ? (overrides.phase as InkboundMagistratePhase)
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
    pulseIndex: finiteInteger(overrides.pulseIndex ?? 0),
    origin: safePoint(overrides.origin),
    anchor: safePoint(overrides.anchor),
    clones: Array.isArray(overrides.clones)
      ? overrides.clones.slice(0, 8).map((point) => safePoint(point))
      : [],
    hitTokens: Array.isArray(overrides.hitTokens)
      ? overrides.hitTokens
          .filter((token): token is string => typeof token === "string")
          .slice(-MAX_HIT_TOKENS)
      : [],
  };
}

function enterPhase(
  state: InkboundMagistrateState,
  phase: InkboundMagistratePhase,
  overrides: Partial<InkboundMagistrateState> = {},
): InkboundMagistrateState {
  return createInkboundMagistrateState({
    ...state,
    ...overrides,
    phase,
    phaseElapsed: 0,
    phaseTimer: phaseDuration(phase, overrides.pattern ?? state.pattern),
  });
}

function appendCommand(
  commands: InkboundMagistrateCommand[],
  command: InkboundMagistrateCommand,
): void {
  if (commands.length < MAX_COMMANDS_PER_STEP) commands.push(command);
}

function appendDamage(
  state: InkboundMagistrateState,
  commands: InkboundMagistrateCommand[],
  token: string,
  multiplier: number,
): InkboundMagistrateState {
  if (state.hitTokens.includes(token)) return state;
  appendCommand(commands, { type: "damage", multiplier, token });
  return {
    ...state,
    hitTokens: [...state.hitTokens, token].slice(-MAX_HIT_TOKENS),
  };
}

function emitCrossWave(
  state: InkboundMagistrateState,
  input: InkboundMagistrateInput,
  commands: InkboundMagistrateCommand[],
  waveIndex: number,
): InkboundMagistrateState {
  const distance =
    INKBOUND_MAGISTRATE_CROSS_WAVE_START_RADIUS +
    waveIndex * INKBOUND_MAGISTRATE_CROSS_WAVE_SPACING;
  appendCommand(commands, {
    type: "crossWave",
    center: state.origin,
    waveIndex,
    distance,
  });
  const token = `cross:${state.castIndex}:${waveIndex}`;
  return inkboundCrossWaveHits(
    input.playerPosition,
    input.playerRadius,
    state.origin,
    distance,
  )
    ? appendDamage(state, commands, token, 1.12)
    : state;
}

function emitBarrage(
  state: InkboundMagistrateState,
  input: InkboundMagistrateInput,
  commands: InkboundMagistrateCommand[],
  volleyIndex: number,
): InkboundMagistrateState {
  appendCommand(commands, {
    type: "inkBarrage",
    origins: state.clones,
    target: state.anchor,
    volleyIndex,
  });
  const token = `barrage:${state.castIndex}:${volleyIndex}`;
  return inkboundBarrageHits(
    input.playerPosition,
    input.playerRadius,
    state.clones,
    state.anchor,
  )
    ? appendDamage(state, commands, token, 0.82)
    : state;
}

function transitionPhase(
  state: InkboundMagistrateState,
  input: InkboundMagistrateInput,
  commands: InkboundMagistrateCommand[],
): InkboundMagistrateState {
  const arena = normalizeInkboundArena(input.arena);
  const wallPadding = nonNegative(
    input.wallPadding ?? INKBOUND_MAGISTRATE_WALL_PADDING,
  );

  if (state.phase === "pursuit") {
    const origin = clampInkboundPointToArena(
      input.bossPosition,
      arena,
      INKBOUND_MAGISTRATE_RADIUS,
      wallPadding,
    );
    const castIndex = Math.max(state.castIndex, finiteInteger(input.castIndex));
    let anchor = clampInkboundPointToArena(
      input.playerPosition,
      arena,
      nonNegative(input.playerRadius),
      wallPadding,
    );
    let clones: readonly InkboundPoint[] = [];
    if (state.pattern === "inkDoubles") {
      clones = inkboundCloneLayout(
        origin,
        arena,
        input.seed,
        castIndex,
        INKBOUND_MAGISTRATE_CLONE_COUNT,
        INKBOUND_MAGISTRATE_CLONE_RADIUS,
        INKBOUND_MAGISTRATE_RADIUS,
        wallPadding,
      );
    } else if (state.pattern === "finalVerdict") {
      anchor = inkboundVerdictSafeCenter(
        arena,
        input.seed,
        castIndex,
        INKBOUND_MAGISTRATE_VERDICT_SAFE_RADIUS,
        wallPadding,
      );
    }
    const next = enterPhase(state, "telegraph", {
      origin,
      anchor,
      clones,
      castIndex,
      pulseIndex: 0,
    });
    appendCommand(commands, {
      type: "telegraph",
      pattern: next.pattern,
      anchor: next.anchor,
      duration: INKBOUND_MAGISTRATE_TELEGRAPH_SECONDS[next.pattern],
    });
    return next;
  }

  if (state.phase === "telegraph") {
    if (state.pattern === "chainCross") {
      let next = enterPhase(state, "chainBind");
      appendCommand(commands, { type: "chainBind", start: next.origin, end: next.anchor });
      if (
        inkboundChainBindHits(
          input.playerPosition,
          input.playerRadius,
          next.origin,
          next.anchor,
        )
      ) {
        next = appendDamage(next, commands, `chain:${next.castIndex}`, 0.76);
      }
      return next;
    }
    if (state.pattern === "inkDoubles") {
      let next = enterPhase(state, "cloneBarrage", { pulseIndex: 1 });
      appendCommand(commands, { type: "spawnClones", positions: next.clones });
      next = emitBarrage(next, input, commands, 0);
      return next;
    }
    const next = enterPhase(state, "executionWarning");
    appendCommand(commands, {
      type: "executionWarning",
      safeCenter: next.anchor,
      safeRadius: INKBOUND_MAGISTRATE_VERDICT_SAFE_RADIUS,
    });
    return next;
  }

  if (state.phase === "chainBind") {
    let next = enterPhase(state, "crossWaves", { pulseIndex: 1 });
    next = emitCrossWave(next, input, commands, 0);
    return next;
  }

  if (state.phase === "executionWarning") {
    let next = enterPhase(state, "verdictBurst");
    appendCommand(commands, {
      type: "verdictBurst",
      safeCenter: next.anchor,
      safeRadius: INKBOUND_MAGISTRATE_VERDICT_SAFE_RADIUS,
    });
    if (
      inkboundVerdictHits(
        input.playerPosition,
        input.playerRadius,
        next.anchor,
        INKBOUND_MAGISTRATE_VERDICT_SAFE_RADIUS,
        arena,
      )
    ) {
      next = appendDamage(next, commands, `verdict:${next.castIndex}`, 1.85);
    }
    return next;
  }

  if (
    state.phase === "crossWaves" ||
    state.phase === "cloneBarrage" ||
    state.phase === "verdictBurst"
  ) {
    return enterPhase(state, "recovery");
  }

  const patternIndex = state.patternIndex + 1;
  return enterPhase(state, "pursuit", {
    patternIndex,
    pattern: inkboundMagistratePatternAt(patternIndex),
    castIndex: state.castIndex + 1,
    pulseIndex: 0,
    clones: [],
    hitTokens: state.hitTokens,
  });
}

function emitTimedPulses(
  state: InkboundMagistrateState,
  input: InkboundMagistrateInput,
  commands: InkboundMagistrateCommand[],
): InkboundMagistrateState {
  let next = state;
  if (state.phase === "crossWaves") {
    const interval =
      INKBOUND_MAGISTRATE_CROSS_WAVE_SECONDS /
      INKBOUND_MAGISTRATE_CROSS_WAVE_COUNT;
    const reached = Math.min(
      INKBOUND_MAGISTRATE_CROSS_WAVE_COUNT,
      Math.floor((state.phaseElapsed + EPSILON) / interval) + 1,
    );
    while (next.pulseIndex < reached) {
      next = emitCrossWave(next, input, commands, next.pulseIndex);
      next = { ...next, pulseIndex: next.pulseIndex + 1 };
    }
  } else if (state.phase === "cloneBarrage") {
    const interval =
      INKBOUND_MAGISTRATE_CLONE_BARRAGE_SECONDS /
      INKBOUND_MAGISTRATE_BARRAGE_VOLLEYS;
    const reached = Math.min(
      INKBOUND_MAGISTRATE_BARRAGE_VOLLEYS,
      Math.floor((state.phaseElapsed + EPSILON) / interval) + 1,
    );
    while (next.pulseIndex < reached) {
      next = emitBarrage(next, input, commands, next.pulseIndex);
      next = { ...next, pulseIndex: next.pulseIndex + 1 };
    }
  }
  return next;
}

export function advanceInkboundMagistrate(
  currentState: InkboundMagistrateState,
  rawInput: InkboundMagistrateInput,
): InkboundMagistrateStep {
  let state = createInkboundMagistrateState(currentState);
  const arena = normalizeInkboundArena(rawInput?.arena);
  const input: InkboundMagistrateInput = {
    dt: Math.min(INKBOUND_MAGISTRATE_MAX_REDUCER_DT, nonNegative(rawInput?.dt)),
    seed: finiteInteger(rawInput?.seed),
    castIndex: finiteInteger(rawInput?.castIndex),
    bossPosition: safePoint(rawInput?.bossPosition, state.origin),
    playerPosition: safePoint(rawInput?.playerPosition, state.anchor),
    playerRadius: nonNegative(rawInput?.playerRadius),
    arena,
    wallPadding: nonNegative(
      rawInput?.wallPadding ?? INKBOUND_MAGISTRATE_WALL_PADDING,
    ),
  };
  const commands: InkboundMagistrateCommand[] = [];
  let remaining = input.dt;
  let transitions = 0;

  while (transitions < MAX_PHASE_TRANSITIONS_PER_STEP) {
    if (state.phaseTimer <= EPSILON) {
      state = transitionPhase(state, input, commands);
      transitions += 1;
      continue;
    }
    if (remaining <= EPSILON) break;
    const consumed = Math.min(remaining, state.phaseTimer);
    state = {
      ...state,
      phaseTimer: Math.max(0, state.phaseTimer - consumed),
      phaseElapsed: state.phaseElapsed + consumed,
    };
    state = emitTimedPulses(state, input, commands);
    remaining = Math.max(0, remaining - consumed);
  }

  return { state: createInkboundMagistrateState(state), commands };
}

/** Integration-facing alias matching the other boss contract naming style. */
export const advanceInkboundMagistrateBoss = advanceInkboundMagistrate;
