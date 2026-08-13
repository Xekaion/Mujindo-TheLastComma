import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import { readFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const modulePath = "app/palimpsest-archivist.ts";

async function importTypeScriptModule(relativePath) {
  const source = await readFile(path.join(root, relativePath), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: relativePath,
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
}

const close = (actual, expected, epsilon = 1e-7) =>
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `${actual} must be within ${epsilon} of ${expected}`,
  );

const assertFiniteState = (state) => {
  for (const value of [
    state.phaseTimer,
    state.patternIndex,
    state.castIndex,
    state.traceCarry,
    state.previousHeadProgress,
    state.runeIndex,
  ]) {
    assert.ok(Number.isFinite(value), `${value} must be finite`);
  }
  for (const point of [...state.trace, ...state.runes]) {
    assert.ok(Number.isFinite(point.x));
    assert.ok(Number.isFinite(point.y));
  }
};

test("the Archivist owns a stable kind, budget, and complete deterministic cycle", async () => {
  const boss = await importTypeScriptModule(modulePath);
  assert.equal(boss.PALIMPSEST_ARCHIVIST_KIND, 11);
  assert.equal(boss.PALIMPSEST_ARCHIVIST_BASE_HP, 620);
  assert.equal(boss.PALIMPSEST_ARCHIVIST_BASE_SPEED, 34);
  assert.equal(boss.PALIMPSEST_ARCHIVIST_BASE_DAMAGE, 15);
  assert.equal(boss.PALIMPSEST_ARCHIVIST_RADIUS, 56);
  assert.deepEqual(boss.PALIMPSEST_PATTERN_SEQUENCE, [
    "redactTrace",
    "restoreTrace",
    "proofRoute",
  ]);
  for (let index = 0; index < 15; index += 1) {
    assert.equal(
      boss.palimpsestPatternAt(index),
      boss.PALIMPSEST_PATTERN_SEQUENCE[index % 3],
    );
  }
  assert.equal(boss.palimpsestPatternAt(Number.NaN), "redactTrace");
  assert.equal(boss.palimpsestPatternAt(Number.POSITIVE_INFINITY), "redactTrace");
});

test("trace sampling is split invariant, finite, and capped at 24 points", async () => {
  const boss = await importTypeScriptModule(modulePath);
  const whole = boss.appendTraceSamples([], { x: 0, y: 4 }, { x: 35, y: 4 }, 0.35, 0);
  let split = boss.appendTraceSamples([], { x: 0, y: 4 }, { x: 12, y: 4 }, 0.12, 0);
  split = boss.appendTraceSamples(
    split.trace,
    { x: 12, y: 4 },
    { x: 23, y: 4 },
    0.11,
    split.traceCarry,
  );
  split = boss.appendTraceSamples(
    split.trace,
    { x: 23, y: 4 },
    { x: 35, y: 4 },
    0.12,
    split.traceCarry,
  );
  assert.deepEqual(split, whole);
  assert.deepEqual(whole.trace, [
    { x: 0, y: 4 },
    { x: 10, y: 4 },
    { x: 20, y: 4 },
    { x: 30, y: 4 },
  ]);

  let capped = { trace: [], traceCarry: 0 };
  for (let index = 0; index < 100; index += 1) {
    capped = boss.appendTraceSamples(
      capped.trace,
      { x: index, y: index % 3 },
      { x: index + 1, y: Number.NaN },
      0.1,
      capped.traceCarry,
    );
  }
  assert.equal(capped.trace.length, boss.PALIMPSEST_TRACE_POINT_CAP);
  assert.ok(capped.trace.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y)));
  assert.ok(Number.isFinite(capped.traceCarry));
});

test("arc interpolation and trace geometry cover vertices and a swept head", async () => {
  const boss = await importTypeScriptModule(modulePath);
  const trace = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
  ];
  assert.deepEqual(boss.tracePointAtArcProgress(trace, 0.25), { x: 50, y: 0 });
  assert.deepEqual(boss.tracePointAtArcProgress(trace, 0.75), { x: 100, y: 50 });
  close(boss.distanceToTraceSquared({ x: 92, y: 35 }, trace), 64);
  assert.equal(boss.outsideSafeTrace({ x: 92, y: 35 }, trace, 9), false);
  assert.equal(boss.outsideSafeTrace({ x: 92, y: 35 }, trace, 7), true);

  // Neither endpoint is near the target; the head crosses it during this large step.
  assert.equal(
    boss.sweptTraceHeadHits(trace, 0.05, 0.95, { x: 100, y: 42 }, 4),
    true,
  );
  assert.equal(
    boss.sweptTraceHeadHits(trace, 0.05, 0.42, { x: 100, y: 42 }, 4),
    false,
  );
  assert.ok(Number.isFinite(boss.distanceToTraceSquared({ x: Number.NaN, y: 0 }, [])));
});

test("proof runes are a seeded permutation and advance only in authored order", async () => {
  const boss = await importTypeScriptModule(modulePath);
  const anchors = [
    { x: 100, y: 100 },
    { x: 300, y: 100 },
    { x: 300, y: 300 },
    { x: 100, y: 300 },
  ];
  const first = boss.proofRuneLayout(anchors, 7123, 4);
  const repeated = boss.proofRuneLayout(anchors, 7123, 4);
  const nextCast = boss.proofRuneLayout(anchors, 7123, 5);
  assert.deepEqual(first, repeated);
  assert.deepEqual([...first].map((rune) => rune.id).sort(), [0, 1, 2, 3]);
  assert.notDeepEqual(first.map((rune) => rune.id), nextCast.map((rune) => rune.id));

  let state = boss.createPalimpsestState({ runes: first, runeIndex: 0 });
  const wrongId = first[1].id;
  assert.equal(boss.advanceProofRune(state, wrongId).outcome, "failure");
  for (const rune of first) {
    const result = boss.advanceProofRune(state, rune.id);
    state = boss.createPalimpsestState({ ...state, runeIndex: result.runeIndex });
    assert.equal(
      result.outcome,
      result.runeIndex === first.length ? "success" : "pending",
    );
  }
});

const baseInput = (overrides = {}) => ({
  dt: 0,
  seed: 8128,
  castIndex: 0,
  hpRatio: 1,
  previousPlayerPosition: { x: 80, y: 100 },
  playerPosition: { x: 80, y: 100 },
  bossPosition: { x: 640, y: 360 },
  playerRadius: 14,
  safeAnchors: [
    { x: 320, y: 180 },
    { x: 960, y: 180 },
    { x: 960, y: 540 },
    { x: 320, y: 540 },
  ],
  ...overrides,
});

test("warning and record phases cannot deal damage", async () => {
  const boss = await importTypeScriptModule(modulePath);
  let state = boss.createPalimpsestState({
    phase: "warning",
    pattern: "redactTrace",
    phaseTimer: 0.5,
    patternIndex: 1,
  });
  let step = boss.advancePalimpsestArchivist(state, baseInput({ dt: 0.49 }));
  assert.equal(step.state.phase, "warning");
  assert.equal(step.commands.some((command) => command.type === "damage"), false);

  step = boss.advancePalimpsestArchivist(step.state, baseInput({ dt: 0.02 }));
  assert.equal(step.state.phase, "record");
  assert.equal(step.commands.some((command) => command.type === "damage"), false);
  state = step.state;
  step = boss.advancePalimpsestArchivist(
    state,
    baseInput({
      dt: 0.8,
      previousPlayerPosition: { x: 80, y: 100 },
      playerPosition: { x: 480, y: 100 },
    }),
  );
  assert.equal(step.state.phase, "record");
  assert.equal(step.commands.some((command) => command.type === "damage"), false);
});

test("a large execute step uses swept collision and still deals at most once per cast", async () => {
  const boss = await importTypeScriptModule(modulePath);
  const trace = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 200, y: 0 },
  ];
  let state = boss.createPalimpsestState({
    phase: "execute",
    pattern: "redactTrace",
    phaseTimer: boss.PALIMPSEST_TRACE_EXECUTE_SECONDS,
    patternIndex: 1,
    castIndex: 7,
    trace,
    previousHeadProgress: 0,
  });
  let step = boss.advancePalimpsestArchivist(
    state,
    baseInput({
      dt: boss.PALIMPSEST_TRACE_EXECUTE_SECONDS * 0.8,
      castIndex: 7,
      previousPlayerPosition: { x: 100, y: 0 },
      playerPosition: { x: 100, y: 0 },
      playerRadius: 5,
    }),
  );
  assert.equal(step.commands.filter((command) => command.type === "damage").length, 1);
  state = step.state;
  step = boss.advancePalimpsestArchivist(
    state,
    baseInput({
      dt: 0.2,
      castIndex: 7,
      previousPlayerPosition: { x: 100, y: 0 },
      playerPosition: { x: 100, y: 0 },
      playerRadius: 5,
    }),
  );
  assert.equal(step.commands.filter((command) => command.type === "damage").length, 0);
});

test("proof-route success grants long recovery while a wrong rune causes exactly one hit", async () => {
  const boss = await importTypeScriptModule(modulePath);
  const runes = boss.proofRuneLayout(baseInput().safeAnchors, 8128, 3);
  let successState = boss.createPalimpsestState({
    phase: "route",
    pattern: "proofRoute",
    phaseTimer: 5,
    patternIndex: 3,
    castIndex: 3,
    runes,
    runeIndex: 0,
  });
  for (const rune of runes) {
    const from = { x: rune.x - 100, y: rune.y };
    const step = boss.advancePalimpsestArchivist(
      successState,
      baseInput({
        dt: 0.1,
        castIndex: 3,
        previousPlayerPosition: from,
        playerPosition: rune,
      }),
    );
    assert.equal(step.commands.some((command) => command.type === "damage"), false);
    successState = step.state;
  }
  assert.equal(successState.phase, "recovery");
  close(successState.phaseTimer, boss.PALIMPSEST_PROOF_SUCCESS_RECOVERY_SECONDS);

  const failureState = boss.createPalimpsestState({
    phase: "route",
    pattern: "proofRoute",
    phaseTimer: 5,
    patternIndex: 3,
    castIndex: 3,
    runes,
    runeIndex: 0,
  });
  const wrong = runes[1];
  const failed = boss.advancePalimpsestArchivist(
    failureState,
    baseInput({
      dt: 0.2,
      castIndex: 3,
      previousPlayerPosition: { x: wrong.x - 100, y: wrong.y },
      playerPosition: wrong,
    }),
  );
  assert.equal(failed.state.phase, "recovery");
  assert.equal(failed.commands.filter((command) => command.type === "damage").length, 1);
  assert.equal(failed.commands.find((command) => command.type === "damage").multiplier, 1);
});

const simulate = async (boss, hz) => {
  let state = boss.createPalimpsestState({
    phase: "warning",
    pattern: "redactTrace",
    phaseTimer: 0.4,
    patternIndex: 1,
    castIndex: 0,
  });
  const commands = [];
  const dt = 1 / hz;
  const seconds = 3.6;
  for (let frame = 0; frame < Math.round(seconds * hz); frame += 1) {
    const previousTime = frame * dt;
    const time = (frame + 1) * dt;
    const step = boss.advancePalimpsestArchivist(
      state,
      baseInput({
        dt,
        previousPlayerPosition: { x: 180 + previousTime * 36, y: 260 },
        playerPosition: { x: 180 + time * 36, y: 260 },
      }),
    );
    state = step.state;
    commands.push(...step.commands.map((command) =>
      command.type === "damage" ? [command.type, command.multiplier] : [command.type, command.kind],
    ));
  }
  return { state, commands };
};

test("30 Hz and 60 Hz updates preserve the same encounter state and trace", async () => {
  const boss = await importTypeScriptModule(modulePath);
  const thirty = await simulate(boss, 30);
  const sixty = await simulate(boss, 60);
  assert.equal(thirty.state.phase, sixty.state.phase);
  assert.equal(thirty.state.pattern, sixty.state.pattern);
  assert.equal(thirty.state.patternIndex, sixty.state.patternIndex);
  assert.equal(thirty.state.castIndex, sixty.state.castIndex);
  assert.equal(thirty.state.runeIndex, sixty.state.runeIndex);
  close(thirty.state.phaseTimer, sixty.state.phaseTimer, 1e-6);
  close(thirty.state.traceCarry, sixty.state.traceCarry, 1e-6);
  assert.equal(thirty.state.trace.length, sixty.state.trace.length);
  for (let index = 0; index < thirty.state.trace.length; index += 1) {
    close(thirty.state.trace[index].x, sixty.state.trace[index].x, 1e-6);
    close(thirty.state.trace[index].y, sixty.state.trace[index].y, 1e-6);
  }
  assert.deepEqual(thirty.commands, sixty.commands);
});

test("malformed and huge inputs remain finite with bounded commands", async () => {
  const [boss, source] = await Promise.all([
    importTypeScriptModule(modulePath),
    readFile(path.join(root, modulePath), "utf8"),
  ]);
  const malformed = boss.createPalimpsestState({
    phase: "route",
    pattern: "proofRoute",
    phaseTimer: Number.NaN,
    patternIndex: Number.POSITIVE_INFINITY,
    castIndex: Number.NaN,
    trace: [{ x: Number.NaN, y: Number.POSITIVE_INFINITY }],
    traceCarry: Number.NaN,
    previousHeadProgress: Number.NaN,
    runes: [{ id: Number.NaN, x: Number.NaN, y: Number.NaN }],
    runeIndex: Number.POSITIVE_INFINITY,
  });
  const step = boss.advancePalimpsestArchivist(
    malformed,
    baseInput({
      dt: 999,
      seed: Number.NaN,
      castIndex: Number.POSITIVE_INFINITY,
      hpRatio: Number.NaN,
      previousPlayerPosition: { x: Number.NaN, y: Number.NaN },
      playerPosition: { x: Number.POSITIVE_INFINITY, y: Number.NaN },
      bossPosition: { x: Number.NaN, y: Number.NaN },
      playerRadius: Number.NaN,
      safeAnchors: [{ x: Number.NaN, y: Number.NaN }],
    }),
  );
  assertFiniteState(step.state);
  assert.ok(step.commands.length <= boss.PALIMPSEST_MAX_COMMANDS_PER_STEP);
  for (const command of step.commands) {
    if (command.type === "damage") assert.ok(Number.isFinite(command.multiplier));
  }
  assert.doesNotMatch(source, /Math\.random|performance\.now/);
});
