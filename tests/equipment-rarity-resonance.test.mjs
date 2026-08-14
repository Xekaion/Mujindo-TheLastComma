import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

const root = process.cwd();

async function importTypeScriptModule(relativePath) {
  const source = await readFile(path.join(root, relativePath), "utf8");
  const javascript = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: relativePath,
  }).outputText;
  return import(
    `data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`
  );
}

const equipmentPromise = importTypeScriptModule("app/equipment.ts");

const EXPECTED_HIGH_TIER_RESONANCE = [
  [15, 15, 0],
  [25, 25, 15],
  [35, 35, 25],
  [45, 45, 35],
  [55, 55, 45],
  [65, 65, 55],
  [75, 75, 65],
  [85, 85, 75],
  [95, 95, 85],
  [105, 105, 95],
].map(([damagePercent, attackSpeedPercent, bossDamagePercent], index) => ({
  count: index + 1,
  damagePercent,
  attackSpeedPercent,
  bossDamagePercent,
}));

const EXPECTED_COSMIC_TRANSCENDENCE = [
  [10, 3],
  [12, 4],
  [14, 5],
  [16, 6],
  [18, 7],
  [20, 8],
  [22, 9],
  [24, 10],
  [27, 11],
  [30, 12],
].map(([finalDamagePercent, actionSpeedPercent], index) => ({
  count: index + 1,
  finalDamagePercent,
  actionSpeedPercent,
}));

function makeLoadout(equipment, rarityBySlot = {}) {
  const loadout = equipment.createEmptyEquipment();
  for (const [slot, rarity] of Object.entries(rarityBySlot)) {
    loadout[slot] = equipment.rollGear(`resonance-${slot}-${rarity}`, {
      slot,
      rarity,
      level: 70,
    });
  }
  return loadout;
}

function rawEquipmentStats(equipment, loadout) {
  const totals = equipment.createEmptyGearStatTotals();
  for (const slot of equipment.EQUIPMENT_SLOTS) {
    const item = loadout[slot];
    if (!item) continue;
    const itemStats = equipment.resolveGearItemStats(item);
    for (const stat of equipment.GEAR_STAT_KEYS) {
      totals[stat] += itemStats[stat];
    }
  }
  for (const stat of equipment.GEAR_STAT_KEYS) {
    totals[stat] = Math.round(totals[stat] * 100) / 100;
  }
  return totals;
}

function expectedEquipmentPower(equipment, loadout) {
  const resonantStats = equipment.applyEquipmentRarityResonance(
    rawEquipmentStats(equipment, loadout),
    loadout,
  );
  return equipment.calculateCombatPowerFromEquipmentStats(
    resonantStats,
    equipment.equippedLegendaryPowers(loadout),
  ).total;
}

test("rarity resonance exports the exact cumulative H1-H10 and C1-C10 tables", async () => {
  const equipment = await equipmentPromise;
  assert.deepEqual(
    equipment.HIGH_TIER_RESONANCE_THRESHOLDS,
    EXPECTED_HIGH_TIER_RESONANCE,
    "high-tier rows are cumulative totals, not per-step additions",
  );
  assert.deepEqual(
    equipment.COSMIC_TRANSCENDENCE_THRESHOLDS,
    EXPECTED_COSMIC_TRANSCENDENCE,
    "cosmic rows are cumulative totals, not per-step additions",
  );
  for (let index = 2; index < EXPECTED_HIGH_TIER_RESONANCE.length; index += 1) {
    const previous = EXPECTED_HIGH_TIER_RESONANCE[index - 1];
    const current = EXPECTED_HIGH_TIER_RESONANCE[index];
    assert.equal(current.damagePercent - previous.damagePercent, 10);
    assert.equal(current.attackSpeedPercent - previous.attackSpeedPercent, 10);
    assert.equal(current.bossDamagePercent - previous.bossDamagePercent, 10);
  }
});

test("cosmic equipment counts toward both H and C while legendary counts toward neither", async () => {
  const equipment = await equipmentPromise;
  const empty = equipment.resolveEquipmentRarityResonance(
    equipment.createEmptyEquipment(),
  );
  assert.deepEqual(empty.highTierBonus, {
    count: 0,
    damagePercent: 0,
    attackSpeedPercent: 0,
    bossDamagePercent: 0,
  });
  assert.deepEqual(empty.cosmicBonus, {
    count: 0,
    finalDamagePercent: 0,
    actionSpeedPercent: 0,
  });

  const loadout = makeLoadout(equipment, {
    weapon: "legendary",
    helm: "mythic",
    shoulders: "mythic",
    armor: "mythic",
    boots: "cosmic",
    relic: "cosmic",
  });
  const resolved = equipment.resolveEquipmentRarityResonance(loadout);
  assert.equal(resolved.highTierCount, 5, "three mythic plus two cosmic must activate H5");
  assert.equal(resolved.cosmicCount, 2, "only the two cosmic pieces must activate C2");
  assert.deepEqual(resolved.highTierBonus, EXPECTED_HIGH_TIER_RESONANCE[4]);
  assert.deepEqual(resolved.cosmicBonus, EXPECTED_COSMIC_TRANSCENDENCE[1]);

  const legendaryOnly = equipment.resolveEquipmentRarityResonance(
    makeLoadout(equipment, { weapon: "legendary", boots: "legendary" }),
  );
  assert.equal(legendaryOnly.highTierCount, 0);
  assert.equal(legendaryOnly.cosmicCount, 0);
});

test("threshold bonuses use the selected cumulative row and enter aggregate stats exactly once", async () => {
  const equipment = await equipmentPromise;
  const loadout = makeLoadout(equipment, {
    weapon: "mythic",
    offhand: "mythic",
    helm: "cosmic",
  });
  const raw = rawEquipmentStats(equipment, loadout);
  const aggregate = equipment.aggregateEquipmentStats(loadout);

  assert.equal(aggregate.damagePercent - raw.damagePercent, 35);
  assert.equal(aggregate.attackSpeedPercent - raw.attackSpeedPercent, 35);
  assert.equal(aggregate.bossDamagePercent - raw.bossDamagePercent, 25);
  assert.equal(aggregate.cosmicFinalDamagePercent - raw.cosmicFinalDamagePercent, 10);
  assert.equal(aggregate.cosmicActionSpeedPercent - raw.cosmicActionSpeedPercent, 3);
  assert.notEqual(
    aggregate.damagePercent - raw.damagePercent,
    15 + 25 + 35,
    "H3 is +35%, not H1 + H2 + H3",
  );

  const directlyApplied = equipment.applyEquipmentRarityResonance(raw, loadout);
  assert.deepEqual(aggregate, directlyApplied);
  assert.deepEqual(raw, rawEquipmentStats(equipment, loadout), "the input totals must not be mutated");
});

test("single-item score and contextual power deltas include resonance threshold changes", async () => {
  const equipment = await equipmentPromise;
  const first = equipment.rollGear("single-mythic-resonance", {
    slot: "weapon",
    rarity: "mythic",
    level: 70,
  });
  const onePiece = equipment.createEmptyEquipment();
  onePiece.weapon = first;
  const expectedSingle =
    expectedEquipmentPower(equipment, onePiece) - equipment.BASE_EQUIPMENT_COMBAT_POWER;
  assert.equal(equipment.calculateGearPowerScore(first), expectedSingle);

  const second = equipment.rollGear("second-mythic-resonance", {
    slot: "offhand",
    rarity: "mythic",
    level: 70,
  });
  const twoPieces = { ...onePiece, offhand: second };
  const expectedDelta =
    expectedEquipmentPower(equipment, twoPieces) - expectedEquipmentPower(equipment, onePiece);
  assert.equal(equipment.calculateEquipmentPowerDelta(onePiece, second), expectedDelta);
  assert.ok(expectedDelta > 0, "crossing H1 to H2 must visibly raise boss DPS power");

  assert.equal(
    equipment.calculateEquipmentCombatPower(onePiece),
    expectedEquipmentPower(equipment, onePiece),
    "loadout power must not omit or double-apply H1",
  );
  assert.equal(
    equipment.calculateEquipmentCombatPower(twoPieces),
    expectedEquipmentPower(equipment, twoPieces),
    "loadout power must not omit or double-apply H2",
  );
});

test("a full cosmic loadout is decisively stronger than the same full mythic loadout", async () => {
  const equipment = await equipmentPromise;
  const mythic = makeLoadout(
    equipment,
    Object.fromEntries(equipment.EQUIPMENT_SLOTS.map((slot) => [slot, "mythic"])),
  );
  const cosmic = makeLoadout(
    equipment,
    Object.fromEntries(equipment.EQUIPMENT_SLOTS.map((slot) => [slot, "cosmic"])),
  );
  const mythicPower = equipment.calculateEquipmentCombatPower(mythic);
  const cosmicPower = equipment.calculateEquipmentCombatPower(cosmic);

  assert.deepEqual(
    equipment.resolveEquipmentRarityResonance(mythic).highTierBonus,
    EXPECTED_HIGH_TIER_RESONANCE[9],
  );
  assert.deepEqual(
    equipment.resolveEquipmentRarityResonance(cosmic).cosmicBonus,
    EXPECTED_COSMIC_TRANSCENDENCE[9],
  );
  assert.ok(cosmicPower > mythicPower, `full cosmic ${cosmicPower} must exceed full mythic ${mythicPower}`);
});

function cssRuleBodies(css, selector) {
  const bodies = [];
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (match[1].includes(selector)) bodies.push(match[2]);
  }
  return bodies;
}

function assertReadableCss(css, selector) {
  const bodies = cssRuleBodies(css, selector);
  assert.ok(bodies.length > 0, `${selector} needs a CSS rule`);
  const body = bodies.join("\n");
  const sizes = [
    ...body.matchAll(
      /font-size\s*:\s*(?:clamp\([^,]+,\s*)?(\d+(?:\.\d+)?)(px|rem)/g,
    ),
  ].map((match) =>
    match[2] === "rem" ? Number(match[1]) * 16 : Number(match[1]),
  );
  assert.ok(
    sizes.some((size) => size >= 12),
    `${selector} must keep important copy at least 12px/.75rem`,
  );
  assert.match(
    body,
    /(?:min-width\s*:\s*0|overflow-wrap\s*:\s*(?:anywhere|break-word)|word-break\s*:\s*break-word)/,
    `${selector} must wrap safely instead of clipping`,
  );
}

test("inventory exposes current resonance chips and an equip/unequip threshold transition", async () => {
  const source = await readFile(path.join(root, "app/InventoryOverlay.tsx"), "utf8");
  assert.match(source, /resolveEquipmentRarityResonance\s*\(\s*equipment\s*\)/);
  assert.ok(
    [...source.matchAll(/resolveEquipmentRarityResonance\s*\(/g)].length >= 2,
    "inventory must resolve both the current and selected-item loadouts",
  );
  assert.match(source, /inventory-screen-resonance-summary/);
  assert.match(source, /inventory-screen-resonance-chip/);
  assert.match(source, /inventory-screen-resonance-transition/);
  assert.match(source, /고위 장비 공명/);
  assert.match(source, /신화 공명/);
  assert.match(source, /우주 초월/);
  assert.match(source, /(?:장착 시|해제 시)/);
  assert.match(source, /현재/);
  assert.match(source, /다음/);
});

test("stats overlay has a dedicated current/next rarity resonance section", async () => {
  const source = await readFile(path.join(root, "app/StatsOverlay.tsx"), "utf8");
  assert.match(source, /고위 장비 공명/);
  assert.match(source, /신화 공명/);
  assert.match(source, /우주 초월/);
  assert.match(source, /stats-resonance-grid/);
  assert.match(source, /stats-resonance-tier/);
  assert.match(source, /stats-resonance-next/);
  assert.match(source, /현재 단계/);
  assert.match(source, /다음 단계/);
});

test("inventory and stats resonance copy remains readable and clipping-safe", async () => {
  const [gameCss, statsCss] = await Promise.all([
    readFile(path.join(root, "app/game.css"), "utf8"),
    readFile(path.join(root, "app/stats-overlay.css"), "utf8"),
  ]);
  for (const selector of [
    ".inventory-screen-resonance-summary",
    ".inventory-screen-resonance-chip",
    ".inventory-screen-resonance-transition",
  ]) {
    assertReadableCss(gameCss, selector);
  }
  for (const selector of [
    ".stats-resonance-grid",
    ".stats-resonance-tier",
    ".stats-resonance-next",
  ]) {
    assertReadableCss(statsCss, selector);
  }
});
