/**
 * Pure deterministic combat contract for the Palimpsest Archivist.
 *
 * The runtime owns rendering and movement. This module owns only the authored
 * pattern order, sampled player trace, collision geometry, proof-rune order,
 * and phase transitions. Keeping those decisions here makes replays and
 * server-side encounter validation independent of the render frame rate.
 */

export const PALIMPSEST_ARCHIVIST_KIND = 11 as const;
export const PALIMPSEST_ARCHIVIST_BASE_HP = 620;
export const PALIMPSEST_ARCHIVIST_BASE_SPEED = 34;
export const PALIMPSEST_ARCHIVIST_BASE_DAMAGE = 15;
export const PALIMPSEST_ARCHIVIST_RADIUS = 56;

export const PALIMPSEST_PATTERN_SEQUENCE = [
  "redactTrace",
  "restoreTrace",
  "proofRoute",
] as const;

/** Integration-facing alias used by HUD and contract tests. */
export const PALIMPSEST_ARCHIVIST_PATTERN_SEQUENCE = PALIMPSEST_PATTERN_SEQUENCE;

export type PalimpsestPattern = (typeof PALIMPSEST_PATTERN_SEQUENCE)[number];
export type PalimpsestPhase =
  | "pursuit"
  | "warning"
  | "record"
  | "execute"
  | "route"
  | "recovery";

/** Verbose aliases keep the GameCanvas integration self-documenting. */
export type PalimpsestArchivistPattern = PalimpsestPattern;
export type PalimpsestArchivistPhase = PalimpsestPhase;

export const PALIMPSEST_ARCHIVIST_PATTERN_LABELS: Readonly<
  Record<PalimpsestPattern, string>
> = {
  redactTrace: "삭제선 추적",
  restoreTrace: "복원선 역행",
  proofRoute: "교정 경로",
};

export const PALIMPSEST_ARCHIVIST_PHASE_LABELS: Readonly<
  Record<PalimpsestPhase, string>
> = {
  pursuit: "덧쓴 기록을 고르는 중",
  warning: "원고 경고",
  record: "발자취 기록",
  execute: "기록 재생",
  route: "교정 순서",
  recovery: "잉크 재정착",
};

export type TracePoint = Readonly<{ x: number; y: number }>;

export type ProofRune = TracePoint &
  Readonly<{
    /** Stable identity of the source anchor before it was permuted. */
    id: number;
  }>;

export type ProofRuneAdvance = Readonly<{
  runeIndex: number;
  outcome: "pending" | "success" | "failure";
  expectedRuneId: number | null;
}>;

export type PalimpsestRuntimeState = Readonly<{
  phase: PalimpsestPhase;
  pattern: PalimpsestPattern;
  phaseTimer: number;
  patternIndex: number;
  castIndex: number;
  trace: readonly TracePoint[];
  traceCarry: number;
  previousHeadProgress: number;
  hitTokens: readonly string[];
  runes: readonly ProofRune[];
  runeIndex: number;
}>;

export type PalimpsestArchivistRuntimeState = PalimpsestRuntimeState;

export type PalimpsestInput = Readonly<{
  dt: number;
  seed: number;
  /** External encounter serial; state never permits it to move backwards. */
  castIndex: number;
  hpRatio: number;
  lowHealth?: boolean;
  previousPlayerPosition: TracePoint;
  playerPosition: TracePoint;
  bossPosition: TracePoint;
  playerRadius: number;
  /** Four currently valid floor anchors. Defaults to a boss-centred diamond. */
  safeAnchors?: readonly TracePoint[];
}>;

export type PalimpsestArchivistInput = PalimpsestInput;

export type PalimpsestSfxKind =
  | "warning"
  | "traceRecord"
  | "traceStrike"
  | "proofRoute"
  | "proofSuccess"
  | "proofFailure";

export type PalimpsestCommand =
  | Readonly<{ type: "damage"; multiplier: number; token: string }>
  | Readonly<{ type: "sfx"; kind: PalimpsestSfxKind }>;

export type PalimpsestArchivistCommand = PalimpsestCommand;

export type PalimpsestStep = Readonly<{
  state: PalimpsestRuntimeState;
  commands: readonly PalimpsestCommand[];
}>;

export const PALIMPSEST_TRACE_SAMPLE_SECONDS = 0.1;
export const PALIMPSEST_TRACE_POINT_CAP = 24;
export const PALIMPSEST_PURSUIT_SECONDS = 0.72;
export const PALIMPSEST_TRACE_RECORD_SECONDS = 1.4;
export const PALIMPSEST_TRACE_EXECUTE_SECONDS = 1.15;
export const PALIMPSEST_PROOF_ROUTE_SECONDS = 5.2;
export const PALIMPSEST_RECOVERY_SECONDS = 0.78;
export const PALIMPSEST_PROOF_SUCCESS_RECOVERY_SECONDS = 1.9;
export const PALIMPSEST_PROOF_RUNE_TRIGGER_RADIUS = 36;
export const PALIMPSEST_MAX_COMMANDS_PER_STEP = 8;
export const PALIMPSEST_MAX_REDUCER_DT = 8;

export const PALIMPSEST_TELEGRAPH_SECONDS: Readonly<
  Record<PalimpsestPattern, number>
> = {
  redactTrace: 0.82,
  restoreTrace: 0.9,
  proofRoute: 1.02,
};

const PHASES: readonly PalimpsestPhase[] = [
  "pursuit",
  "warning",
  "record",
  "execute",
  "route",
  "recovery",
];
const EPSILON = 1e-9;
const SAMPLE_CLOCK_EPSILON = 1e-7;
const MAX_PHASE_TRANSITIONS_PER_STEP = 24;
const MAX_HIT_TOKENS = 8;
const MAX_FINITE_DISTANCE_SQUARED = Number.MAX_VALUE;

const finite = (value: number, fallback = 0) =>
  Number.isFinite(value) ? value : fallback;
const nonNegative = (value: number, fallback = 0) =>
  Math.max(0, finite(value, fallback));
const finiteInteger = (value: number, fallback = 0) =>
  Math.max(0, Math.floor(finite(value, fallback)));
const clamp01 = (value: number) => Math.max(0, Math.min(1, finite(value)));
const quantize = (value: number) => Math.round(finite(value) * 1e10) / 1e10;
const safePoint = (point: TracePoint | undefined, fallback: TracePoint = { x: 0, y: 0 }) => ({
  x: finite(point?.x ?? fallback.x, fallback.x),
  y: finite(point?.y ?? fallback.y, fallback.y),
});

const sanitizeTrace = (trace: readonly TracePoint[] | undefined) => {
  const points = Array.isArray(trace) ? trace : [];
  const start = Math.max(0, points.length - PALIMPSEST_TRACE_POINT_CAP);
  const sanitized: TracePoint[] = [];
  let fallback: TracePoint = { x: 0, y: 0 };
  for (let index = start; index < points.length; index += 1) {
    fallback = safePoint(points[index], fallback);
    sanitized.push(fallback);
  }
  return sanitized;
};

const sanitizeRunes = (runes: readonly ProofRune[] | undefined) => {
  if (!Array.isArray(runes)) return [];
  return runes.slice(0, 4).map((rune, index) => ({
    ...safePoint(rune),
    id: finiteInteger(rune?.id, index),
  }));
};

const sanitizeState = (state: PalimpsestRuntimeState): PalimpsestRuntimeState => {
  const patternIndex = finiteInteger(state.patternIndex);
  const phase = PHASES.includes(state.phase) ? state.phase : "pursuit";
  const pattern = PALIMPSEST_PATTERN_SEQUENCE.includes(state.pattern)
    ? state.pattern
    : palimpsestPatternAt(patternIndex);
  const runes = sanitizeRunes(state.runes);
  return {
    phase,
    pattern,
    phaseTimer: nonNegative(state.phaseTimer),
    patternIndex,
    castIndex: finiteInteger(state.castIndex),
    trace: sanitizeTrace(state.trace),
    traceCarry: Math.min(
      PALIMPSEST_TRACE_SAMPLE_SECONDS - EPSILON,
      nonNegative(state.traceCarry) % PALIMPSEST_TRACE_SAMPLE_SECONDS,
    ),
    previousHeadProgress: clamp01(state.previousHeadProgress),
    hitTokens: Array.isArray(state.hitTokens)
      ? state.hitTokens.filter((token): token is string => typeof token === "string").slice(-MAX_HIT_TOKENS)
      : [],
    runes,
    runeIndex: Math.min(runes.length, finiteInteger(state.runeIndex)),
  };
};

export function palimpsestPatternAt(completedPatternCount: number): PalimpsestPattern {
  const index = finiteInteger(completedPatternCount);
  return PALIMPSEST_PATTERN_SEQUENCE[index % PALIMPSEST_PATTERN_SEQUENCE.length];
}

export function createPalimpsestState(
  overrides: Partial<PalimpsestRuntimeState> = {},
): PalimpsestRuntimeState {
  return sanitizeState({
    phase: overrides.phase ?? "pursuit",
    pattern: overrides.pattern ?? palimpsestPatternAt(overrides.patternIndex ?? 0),
    phaseTimer: overrides.phaseTimer ?? PALIMPSEST_PURSUIT_SECONDS,
    patternIndex: overrides.patternIndex ?? 0,
    castIndex: overrides.castIndex ?? 0,
    trace: overrides.trace ?? [],
    traceCarry: overrides.traceCarry ?? 0,
    previousHeadProgress: overrides.previousHeadProgress ?? 0,
    hitTokens: overrides.hitTokens ?? [],
    runes: overrides.runes ?? [],
    runeIndex: overrides.runeIndex ?? 0,
  });
}

export type TraceAppendResult = Readonly<{
  trace: readonly TracePoint[];
  traceCarry: number;
}>;

/**
 * Adds points on one global 0.1 second clock. Interpolating at clock crossings,
 * rather than appending once per render frame, makes split and unsplit updates
 * produce the same authored trace.
 */
export function appendTraceSamples(
  trace: readonly TracePoint[],
  from: TracePoint,
  to: TracePoint,
  dt: number,
  traceCarry = 0,
): TraceAppendResult {
  const result = sanitizeTrace(trace);
  const fallback = result[result.length - 1] ?? { x: 0, y: 0 };
  const start = safePoint(from, fallback);
  const end = safePoint(to, start);
  const duration = nonNegative(dt);
  let carry = nonNegative(traceCarry) % PALIMPSEST_TRACE_SAMPLE_SECONDS;

  if (result.length === 0) result.push(start);
  if (duration <= EPSILON) {
    return { trace: result, traceCarry: quantize(carry) };
  }

  let sampleTime = PALIMPSEST_TRACE_SAMPLE_SECONDS - carry;
  while (sampleTime <= duration + SAMPLE_CLOCK_EPSILON) {
    const ratio = clamp01(sampleTime / duration);
    result.push({
      x: quantize(start.x + (end.x - start.x) * ratio),
      y: quantize(start.y + (end.y - start.y) * ratio),
    });
    if (result.length > PALIMPSEST_TRACE_POINT_CAP) result.shift();
    sampleTime += PALIMPSEST_TRACE_SAMPLE_SECONDS;
  }

  carry = (carry + duration) % PALIMPSEST_TRACE_SAMPLE_SECONDS;
  if (
    carry < SAMPLE_CLOCK_EPSILON ||
    PALIMPSEST_TRACE_SAMPLE_SECONDS - carry < SAMPLE_CLOCK_EPSILON
  ) {
    carry = 0;
  }
  return { trace: result, traceCarry: quantize(carry) };
}

const distanceSquared = (a: TracePoint, b: TracePoint) => {
  const dx = finite(a.x) - finite(b.x);
  const dy = finite(a.y) - finite(b.y);
  const result = dx * dx + dy * dy;
  return Number.isFinite(result) ? result : MAX_FINITE_DISTANCE_SQUARED;
};

const pointSegmentDistanceSquared = (
  point: TracePoint,
  start: TracePoint,
  end: TracePoint,
) => {
  const segmentX = end.x - start.x;
  const segmentY = end.y - start.y;
  const lengthSquared = segmentX * segmentX + segmentY * segmentY;
  if (!Number.isFinite(lengthSquared) || lengthSquared <= EPSILON) {
    return distanceSquared(point, start);
  }
  const projection = clamp01(
    ((point.x - start.x) * segmentX + (point.y - start.y) * segmentY) /
      lengthSquared,
  );
  return distanceSquared(point, {
    x: start.x + segmentX * projection,
    y: start.y + segmentY * projection,
  });
};

const traceArcLengths = (trace: readonly TracePoint[]) => {
  const lengths = [0];
  let total = 0;
  for (let index = 1; index < trace.length; index += 1) {
    total += Math.sqrt(distanceSquared(trace[index - 1], trace[index]));
    lengths.push(Number.isFinite(total) ? total : lengths[lengths.length - 1]);
  }
  return { lengths, total };
};

export function tracePointAtArcProgress(
  traceInput: readonly TracePoint[],
  progress: number,
): TracePoint {
  const trace = sanitizeTrace(traceInput);
  if (trace.length === 0) return { x: 0, y: 0 };
  if (trace.length === 1) return { ...trace[0] };
  const { lengths, total } = traceArcLengths(trace);
  if (total <= EPSILON) return { ...trace[0] };
  const target = total * clamp01(progress);
  for (let index = 1; index < trace.length; index += 1) {
    if (target > lengths[index] + EPSILON) continue;
    const segmentLength = lengths[index] - lengths[index - 1];
    const ratio = segmentLength <= EPSILON ? 0 : (target - lengths[index - 1]) / segmentLength;
    return {
      x: quantize(trace[index - 1].x + (trace[index].x - trace[index - 1].x) * ratio),
      y: quantize(trace[index - 1].y + (trace[index].y - trace[index - 1].y) * ratio),
    };
  }
  return { ...trace[trace.length - 1] };
}

export function distanceToTraceSquared(
  pointInput: TracePoint,
  traceInput: readonly TracePoint[],
): number {
  const point = safePoint(pointInput);
  const trace = sanitizeTrace(traceInput);
  if (trace.length === 0) return MAX_FINITE_DISTANCE_SQUARED;
  if (trace.length === 1) return distanceSquared(point, trace[0]);
  let minimum = MAX_FINITE_DISTANCE_SQUARED;
  for (let index = 1; index < trace.length; index += 1) {
    minimum = Math.min(
      minimum,
      pointSegmentDistanceSquared(point, trace[index - 1], trace[index]),
    );
  }
  return Number.isFinite(minimum) ? minimum : MAX_FINITE_DISTANCE_SQUARED;
}

const traceSliceBetweenProgress = (
  traceInput: readonly TracePoint[],
  fromProgress: number,
  toProgress: number,
) => {
  const trace = sanitizeTrace(traceInput);
  if (trace.length <= 1) return trace;
  const startProgress = Math.min(clamp01(fromProgress), clamp01(toProgress));
  const endProgress = Math.max(clamp01(fromProgress), clamp01(toProgress));
  const { lengths, total } = traceArcLengths(trace);
  if (total <= EPSILON) return [trace[0]];
  const startArc = total * startProgress;
  const endArc = total * endProgress;
  const slice: TracePoint[] = [tracePointAtArcProgress(trace, startProgress)];
  for (let index = 1; index < trace.length - 1; index += 1) {
    if (lengths[index] > startArc + EPSILON && lengths[index] < endArc - EPSILON) {
      slice.push(trace[index]);
    }
  }
  slice.push(tracePointAtArcProgress(trace, endProgress));
  return slice;
};

/** Tests the complete arc swept by a trace head, not just its two endpoints. */
export function sweptTraceHeadHits(
  trace: readonly TracePoint[],
  fromProgress: number,
  toProgress: number,
  target: TracePoint,
  targetRadius: number,
): boolean {
  const radius = nonNegative(targetRadius);
  return (
    distanceToTraceSquared(target, traceSliceBetweenProgress(trace, fromProgress, toProgress)) <=
    radius * radius
  );
}

export function outsideSafeTrace(
  point: TracePoint,
  trace: readonly TracePoint[],
  safeRadius: number,
): boolean {
  const radius = nonNegative(safeRadius);
  return distanceToTraceSquared(point, trace) > radius * radius;
}

const hash32 = (seed: number, castIndex: number, anchorIndex: number) => {
  let value = finiteInteger(seed) ^ Math.imul(finiteInteger(castIndex) + 1, 0x9e3779b1);
  value ^= Math.imul(anchorIndex + 1, 0x85ebca6b);
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b);
  value ^= value >>> 16;
  return value >>> 0;
};

const defaultSafeAnchors = (bossPosition: TracePoint = { x: 0, y: 0 }) => {
  const boss = safePoint(bossPosition);
  return [
    { x: boss.x, y: boss.y - 210 },
    { x: boss.x + 270, y: boss.y },
    { x: boss.x, y: boss.y + 210 },
    { x: boss.x - 270, y: boss.y },
  ];
};

/** Returns the four current safe anchors in a deterministic cast-specific order. */
export function proofRuneLayout(
  anchorsInput: readonly TracePoint[],
  seed: number,
  castIndex: number,
): readonly ProofRune[] {
  const defaults = defaultSafeAnchors();
  const anchors = Array.from({ length: 4 }, (_, index) =>
    safePoint(anchorsInput?.[index], defaults[index]),
  );
  return anchors
    .map((anchor, id) => ({ ...anchor, id, orderKey: hash32(seed, castIndex, id) }))
    .sort((a, b) => a.orderKey - b.orderKey || a.id - b.id)
    .map(({ x, y, id }) => ({ x, y, id }));
}

export function advanceProofRune(
  state: Pick<PalimpsestRuntimeState, "runes" | "runeIndex">,
  touchedRuneId: number,
): ProofRuneAdvance {
  const runes = sanitizeRunes(state.runes);
  const runeIndex = Math.min(runes.length, finiteInteger(state.runeIndex));
  const expected = runes[runeIndex];
  if (!expected || finiteInteger(touchedRuneId, -1) !== expected.id) {
    return {
      runeIndex,
      outcome: "failure",
      expectedRuneId: expected?.id ?? null,
    };
  }
  const nextIndex = runeIndex + 1;
  return {
    runeIndex: nextIndex,
    outcome: nextIndex >= runes.length ? "success" : "pending",
    expectedRuneId: runes[nextIndex]?.id ?? null,
  };
}

const segmentCircleEntry = (
  start: TracePoint,
  end: TracePoint,
  center: TracePoint,
  radius: number,
) => {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const offsetX = start.x - center.x;
  const offsetY = start.y - center.y;
  const radiusSquared = radius * radius;
  if (offsetX * offsetX + offsetY * offsetY <= radiusSquared) return 0;
  const a = dx * dx + dy * dy;
  if (a <= EPSILON) return null;
  const b = 2 * (offsetX * dx + offsetY * dy);
  const c = offsetX * offsetX + offsetY * offsetY - radiusSquared;
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0 || !Number.isFinite(discriminant)) return null;
  const root = Math.sqrt(discriminant);
  const first = (-b - root) / (2 * a);
  const second = (-b + root) / (2 * a);
  if (first >= 0 && first <= 1) return first;
  if (second >= 0 && second <= 1) return second;
  return null;
};

const lerpPoint = (from: TracePoint, to: TracePoint, ratio: number): TracePoint => ({
  x: from.x + (to.x - from.x) * clamp01(ratio),
  y: from.y + (to.y - from.y) * clamp01(ratio),
});

const damageToken = (state: PalimpsestRuntimeState) =>
  `${state.castIndex}:${state.pattern}`;

const hasDamageToken = (state: PalimpsestRuntimeState) =>
  state.hitTokens.includes(damageToken(state));

const addDamageToken = (state: PalimpsestRuntimeState): PalimpsestRuntimeState => ({
  ...state,
  hitTokens: [...state.hitTokens, damageToken(state)].slice(-MAX_HIT_TOKENS),
});

/**
 * Advances one boss step and emits only bounded semantic commands. Warning and
 * recording phases can never emit damage. Every execution cast owns one token,
 * so even a large dt or repeated overlap can apply damage at most once.
 */
export function advancePalimpsestArchivist(
  stateInput: PalimpsestRuntimeState,
  input: PalimpsestInput,
): PalimpsestStep {
  let state = sanitizeState(stateInput);
  const previousPlayerPosition = safePoint(input.previousPlayerPosition);
  const playerPosition = safePoint(input.playerPosition, previousPlayerPosition);
  const bossPosition = safePoint(input.bossPosition);
  const playerRadius = nonNegative(input.playerRadius);
  const seed = finiteInteger(input.seed);
  const externalCastIndex = finiteInteger(input.castIndex);
  const hpRatio = clamp01(input.hpRatio);
  const lowHealth = input.lowHealth ?? hpRatio <= 0.4;
  const tempoMultiplier = lowHealth ? 0.82 : 1;
  const totalDt = Math.min(PALIMPSEST_MAX_REDUCER_DT, nonNegative(input.dt));
  let remaining = totalDt;
  let elapsed = 0;
  let transitions = 0;
  const commands: PalimpsestCommand[] = [];
  const pushCommand = (command: PalimpsestCommand) => {
    if (commands.length < PALIMPSEST_MAX_COMMANDS_PER_STEP) commands.push(command);
  };
  const enterRecovery = (duration: number) => {
    state = {
      ...state,
      phase: "recovery",
      phaseTimer: duration,
      previousHeadProgress: state.pattern === "restoreTrace" ? 1 : 0,
    };
  };
  const emitDamageOnce = (multiplier: number) => {
    if (hasDamageToken(state)) return false;
    const token = damageToken(state);
    state = addDamageToken(state);
    pushCommand({ type: "damage", multiplier: finite(multiplier, 1), token });
    return true;
  };

  while (
    transitions < MAX_PHASE_TRANSITIONS_PER_STEP &&
    (remaining > EPSILON || state.phaseTimer <= EPSILON)
  ) {
    const timer = nonNegative(state.phaseTimer);
    const stepDuration = Math.min(remaining, timer);
    const startRatio = totalDt <= EPSILON ? 0 : elapsed / totalDt;
    const endRatio = totalDt <= EPSILON ? 1 : (elapsed + stepDuration) / totalDt;
    const stepStart = lerpPoint(previousPlayerPosition, playerPosition, startRatio);
    const stepEnd = lerpPoint(previousPlayerPosition, playerPosition, endRatio);
    const oldTimer = timer;

    if (stepDuration > EPSILON) {
      state = { ...state, phaseTimer: Math.max(0, quantize(timer - stepDuration)) };

      if (state.phase === "record") {
        const appended = appendTraceSamples(
          state.trace,
          stepStart,
          stepEnd,
          stepDuration,
          state.traceCarry,
        );
        state = {
          ...state,
          trace: appended.trace,
          traceCarry: appended.traceCarry,
        };
      } else if (state.phase === "execute") {
        const consumedBefore =
          PALIMPSEST_TRACE_EXECUTE_SECONDS - oldTimer;
        const consumedAfter = consumedBefore + stepDuration;
        const rawPrevious = clamp01(consumedBefore / PALIMPSEST_TRACE_EXECUTE_SECONDS);
        const rawCurrent = clamp01(consumedAfter / PALIMPSEST_TRACE_EXECUTE_SECONDS);
        const previousProgress =
          state.pattern === "restoreTrace" ? 1 - rawPrevious : rawPrevious;
        const currentProgress =
          state.pattern === "restoreTrace" ? 1 - rawCurrent : rawCurrent;
        if (
          !hasDamageToken(state) &&
          (sweptTraceHeadHits(
            state.trace,
            previousProgress,
            currentProgress,
            stepStart,
            playerRadius,
          ) ||
            sweptTraceHeadHits(
              state.trace,
              previousProgress,
              currentProgress,
              stepEnd,
              playerRadius,
            ))
        ) {
          emitDamageOnce(state.pattern === "redactTrace" ? 1.18 : 1.08);
          pushCommand({ type: "sfx", kind: "traceStrike" });
        }
        state = { ...state, previousHeadProgress: quantize(currentProgress) };
      } else if (state.phase === "route") {
        const triggerRadius = PALIMPSEST_PROOF_RUNE_TRIGGER_RADIUS + playerRadius;
        const candidates = state.runes
          .map((rune, index) => ({
            index,
            id: rune.id,
            entry: segmentCircleEntry(stepStart, stepEnd, rune, triggerRadius),
          }))
          // Completed runes stay harmless when the player leaves their circle.
          .filter(
            (candidate): candidate is { index: number; id: number; entry: number } =>
              candidate.index >= state.runeIndex && candidate.entry !== null,
          )
          .sort((a, b) => a.entry - b.entry || a.index - b.index);

        for (const candidate of candidates) {
          if (state.phase !== "route") break;
          const advanced = advanceProofRune(state, candidate.id);
          state = { ...state, runeIndex: advanced.runeIndex };
          if (advanced.outcome === "failure") {
            emitDamageOnce(1);
            pushCommand({ type: "sfx", kind: "proofFailure" });
            enterRecovery(PALIMPSEST_RECOVERY_SECONDS * tempoMultiplier);
          } else if (advanced.outcome === "success") {
            pushCommand({ type: "sfx", kind: "proofSuccess" });
            enterRecovery(PALIMPSEST_PROOF_SUCCESS_RECOVERY_SECONDS);
          }
        }
      }

      remaining = Math.max(0, remaining - stepDuration);
      elapsed += stepDuration;
    }

    if (state.phaseTimer > EPSILON) break;
    transitions += 1;

    if (state.phase === "pursuit") {
      const pattern = palimpsestPatternAt(state.patternIndex);
      state = {
        ...state,
        phase: "warning",
        pattern,
        phaseTimer: PALIMPSEST_TELEGRAPH_SECONDS[pattern] * tempoMultiplier,
        patternIndex: state.patternIndex + 1,
        castIndex: Math.max(state.castIndex, externalCastIndex),
        trace: [],
        traceCarry: 0,
        previousHeadProgress: pattern === "restoreTrace" ? 1 : 0,
        hitTokens: [],
        runes: [],
        runeIndex: 0,
      };
      pushCommand({ type: "sfx", kind: "warning" });
    } else if (state.phase === "warning") {
      if (state.pattern === "proofRoute") {
        const anchors =
          input.safeAnchors && input.safeAnchors.length > 0
            ? input.safeAnchors
            : defaultSafeAnchors(bossPosition);
        state = {
          ...state,
          phase: "route",
          phaseTimer: PALIMPSEST_PROOF_ROUTE_SECONDS * tempoMultiplier,
          runes: proofRuneLayout(anchors, seed, state.castIndex),
          runeIndex: 0,
        };
        pushCommand({ type: "sfx", kind: "proofRoute" });
      } else {
        state = {
          ...state,
          phase: "record",
          phaseTimer: PALIMPSEST_TRACE_RECORD_SECONDS * tempoMultiplier,
          trace: [stepEnd],
          traceCarry: 0,
        };
        pushCommand({ type: "sfx", kind: "traceRecord" });
      }
    } else if (state.phase === "record") {
      state = {
        ...state,
        phase: "execute",
        phaseTimer: PALIMPSEST_TRACE_EXECUTE_SECONDS,
        previousHeadProgress: state.pattern === "restoreTrace" ? 1 : 0,
      };
    } else if (state.phase === "execute") {
      enterRecovery(PALIMPSEST_RECOVERY_SECONDS * tempoMultiplier);
    } else if (state.phase === "route") {
      emitDamageOnce(1);
      pushCommand({ type: "sfx", kind: "proofFailure" });
      enterRecovery(PALIMPSEST_RECOVERY_SECONDS * tempoMultiplier);
    } else {
      state = {
        ...state,
        phase: "pursuit",
        phaseTimer: PALIMPSEST_PURSUIT_SECONDS * tempoMultiplier,
        castIndex: state.castIndex + 1,
        trace: [],
        traceCarry: 0,
        runes: [],
        runeIndex: 0,
      };
    }
  }

  return { state: sanitizeState(state), commands };
}
