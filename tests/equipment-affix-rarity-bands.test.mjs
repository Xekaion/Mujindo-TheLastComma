import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

const root = process.cwd();

/**
 * The generated-value curve is deliberately kept private in production. Export
 * it only in this test module so the complete 1..100 roll interval can be
 * proven without relying on a probabilistic seed search.
 */
async function importEquipmentWithAffixCurve() {
  const relativePath = "app/equipment.ts";
  let source = await readFile(path.join(root, relativePath), "utf8");
  if (!/export function affixValueForRollPercent\s*\(/.test(source)) {
    source = source.replace(
      /function affixValueForRollPercent\s*\(/,
      "export function affixValueForRollPercent(",
    );
  }
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: relativePath,
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}

// These are the ordinary affixes that directly increase the current
// all-projectiles-hit standard-boss DPS formula and can roll at all three chase
// rarities. Handling, defense, sustain, pierce, and projectile geometry are
// intentionally absent.
const THREE_TIER_DIRECT_DPS_AFFIXES = [
  "damagePercent",
  "attackSpeedPercent",
  "critChancePercent",
  "critDamagePercent",
  "eliteDamagePercent",
  "bossDamagePercent",
  "executeDamagePercent",
];

const OLD_RARITY_AFFIX_MULTIPLIER = {
  legendary: 1.25,
  mythic: 1.45,
  cosmic: 1.7,
};

function oldAffixValue(definition, level, rarity, rollPercent) {
  const percentile = (Math.max(1, Math.min(100, Math.round(rollPercent))) - 1) / 99;
  const raw =
    definition.minValue +
    (definition.maxValue - definition.minValue) * percentile +
    Math.max(0, level - 1) * definition.perLevel;
  return Math.max(
    1,
    Math.round(
      Math.min(definition.cap, raw * OLD_RARITY_AFFIX_MULTIPLIER[rarity]),
    ),
  );
}

function savedWeaponWithAffix(equipment, rarity, stat, level, rollPercent) {
  let item = null;
  for (let seed = 0; seed < 100 && item === null; seed += 1) {
    const candidate = equipment.rollGear(
      `legacy-direct-dps-${rarity}-${stat}-${level}-${seed}`,
      { slot: "weapon", rarity, level },
    );
    const existingIndex = candidate.affixes.findIndex((affix) => affix.stat === stat);
    const replacementIndex = existingIndex >= 0
      ? existingIndex
      : candidate.affixes.findIndex(
          (affix, index) =>
            // Cosmic slot zero is its required pinnacle option. Keep it intact
            // while replacing one ordinary option with another legal weapon stat.
            !(rarity === "cosmic" && index === 0) &&
            affix.stat !== stat,
        );
    if (replacementIndex < 0) continue;
    const definition = equipment.GEAR_AFFIX_DEFINITIONS[stat];
    const value = oldAffixValue(definition, level, rarity, rollPercent);
    candidate.affixes[replacementIndex] = {
      stat,
      value,
      rollPercent,
      label: equipment.formatGearAffix(stat, value),
    };
    candidate.powerScore = -1;
    candidate.qualityScore = -1;
    item = candidate;
  }
  assert.ok(item, `could not construct a legacy ${rarity}/${stat} fixture`);
  return item;
}

function savedItemWithLegacyAffix(
  equipment,
  {
    slot,
    rarity = "legendary",
    level = 70,
    stat,
    rollPercent,
    requiredStats = [],
    forbiddenStats = [],
  },
) {
  for (let seed = 0; seed < 2_000; seed += 1) {
    const candidate = equipment.rollGear(
      `legacy-slot-affix-${slot}-${rarity}-${stat}-${seed}`,
      { slot, rarity, level },
    );
    const rolledStats = new Set(candidate.affixes.map((affix) => affix.stat));
    if (!requiredStats.every((required) => rolledStats.has(required))) continue;
    if (forbiddenStats.some((forbidden) => rolledStats.has(forbidden))) continue;

    const existingIndex = candidate.affixes.findIndex((affix) => affix.stat === stat);
    const replacementIndex = existingIndex >= 0
      ? existingIndex
      : candidate.affixes.findIndex(
          (affix, index) =>
            !(rarity === "cosmic" && index === 0) &&
            !requiredStats.includes(affix.stat),
        );
    if (replacementIndex < 0) continue;

    const value = oldAffixValue(
      equipment.GEAR_AFFIX_DEFINITIONS[stat],
      level,
      rarity,
      rollPercent,
    );
    candidate.affixes[replacementIndex] = {
      stat,
      value,
      rollPercent,
      label: equipment.formatGearAffix(stat, value),
    };
    candidate.powerScore = -1;
    candidate.qualityScore = -1;
    return candidate;
  }
  assert.fail(`could not construct a legacy ${slot}/${rarity}/${stat} fixture`);
}

test("every comparable direct-DPS affix uses disjoint legendary, mythic, and cosmic roll bands", async () => {
  const equipment = await importEquipmentWithAffixCurve();
  const levels = [1, 40, 70, 100, 999];

  for (const level of levels) {
    for (const stat of THREE_TIER_DIRECT_DPS_AFFIXES) {
      const legendaryMaximum = equipment.affixValueForRollPercent(
        stat,
        level,
        "legendary",
        100,
      );
      const mythicMinimum = equipment.affixValueForRollPercent(
        stat,
        level,
        "mythic",
        1,
      );
      const mythicMaximum = equipment.affixValueForRollPercent(
        stat,
        level,
        "mythic",
        100,
      );
      const cosmicMinimum = equipment.affixValueForRollPercent(
        stat,
        level,
        "cosmic",
        1,
      );

      assert.ok(
        mythicMinimum > legendaryMaximum,
        `${stat} level ${level}: even a 1% mythic roll must exceed a 100% legendary roll ` +
          `(${mythicMinimum} <= ${legendaryMaximum})`,
      );
      assert.ok(
        cosmicMinimum > mythicMaximum,
        `${stat} level ${level}: even a 1% cosmic roll must exceed a 100% mythic roll ` +
          `(${cosmicMinimum} <= ${mythicMaximum})`,
      );
    }

    // Additional projectiles begin at mythic, so only its mythic -> cosmic
    // boundary exists. Count-valued rounding must not collapse the two tiers.
    const mythicProjectileMaximum = equipment.affixValueForRollPercent(
      "projectileCountFlat",
      level,
      "mythic",
      100,
    );
    const cosmicProjectileMinimum = equipment.affixValueForRollPercent(
      "projectileCountFlat",
      level,
      "cosmic",
      1,
    );
    assert.ok(
      cosmicProjectileMinimum > mythicProjectileMaximum,
      `projectileCountFlat level ${level}: cosmic minimum must exceed mythic maximum ` +
        `(${cosmicProjectileMinimum} <= ${mythicProjectileMaximum})`,
    );
  }
});

test("legacy high-rarity direct-DPS rolls migrate by percentile instead of deleting the item", async () => {
  const equipment = await importEquipmentWithAffixCurve();
  const level = 70;
  const rollPercent = 37;

  for (const rarity of ["mythic", "cosmic"]) {
    for (const stat of THREE_TIER_DIRECT_DPS_AFFIXES) {
      const saved = savedWeaponWithAffix(
        equipment,
        rarity,
        stat,
        level,
        rollPercent,
      );
      const oldValue = oldAffixValue(
        equipment.GEAR_AFFIX_DEFINITIONS[stat],
        level,
        rarity,
        rollPercent,
      );
      const expectedValue = equipment.affixValueForRollPercent(
        stat,
        level,
        rarity,
        rollPercent,
      );
      const normalized = equipment.normalizeGearItem(saved);

      assert.ok(normalized, `${rarity}/${stat}: a valid legacy item must survive migration`);
      const migratedAffix = normalized.affixes.find((affix) => affix.stat === stat);
      assert.ok(migratedAffix, `${rarity}/${stat}: migration must preserve the affix kind`);
      assert.equal(
        migratedAffix.rollPercent,
        rollPercent,
        `${rarity}/${stat}: migration must preserve rolled quality`,
      );
      assert.equal(
        migratedAffix.value,
        expectedValue,
        `${rarity}/${stat}: old ${oldValue} must be revalued through the current rarity band`,
      );
      assert.deepEqual(
        equipment.normalizeGearItem(normalized),
        normalized,
        `${rarity}/${stat}: migration must be idempotent after the first load`,
      );
    }
  }
});

test("pre-percentile apex saves recover quality from the legacy curve before revaluation", async () => {
  const equipment = await importEquipmentWithAffixCurve();
  const level = 70;
  const rollPercent = 100;

  for (const rarity of ["mythic", "cosmic"]) {
    const saved = savedWeaponWithAffix(
      equipment,
      rarity,
      "damagePercent",
      level,
      rollPercent,
    );
    const legacyAffix = saved.affixes.find(
      (affix) => affix.stat === "damagePercent",
    );
    delete legacyAffix.rollPercent;

    const normalized = equipment.normalizeGearItem(saved);
    assert.ok(normalized, `${rarity}: a pre-percentile item must survive migration`);
    const migrated = normalized.affixes.find(
      (affix) => affix.stat === "damagePercent",
    );
    assert.ok(migrated);
    assert.equal(
      migrated.value,
      equipment.affixValueForRollPercent(
        "damagePercent",
        level,
        rarity,
        migrated.rollPercent,
      ),
      `${rarity}: recovered quality must be revalued on the current band`,
    );
    assert.ok(
      migrated.rollPercent >= 90,
      `${rarity}: an old perfect roll must remain near the top of its band`,
    );
  }
});

test("legacy boots attack speed migrates to a legal mobility option without losing its roll", async (t) => {
  const equipment = await importEquipmentWithAffixCurve();
  const level = 70;
  const rollPercent = 37;

  await t.test("move speed is the first replacement and the repair is idempotent", () => {
    const saved = savedItemWithLegacyAffix(equipment, {
      slot: "boots",
      stat: "attackSpeedPercent",
      level,
      rollPercent,
      forbiddenStats: ["moveSpeedPercent"],
    });
    const normalized = equipment.normalizeGearItem(saved);

    assert.ok(normalized, "a legacy pair of boots must not be deleted");
    assert.equal(normalized.id, saved.id, "migration must preserve item identity");
    assert.equal(
      normalized.affixes.some((affix) => affix.stat === "attackSpeedPercent"),
      false,
      "new weapon-only attack speed cannot remain on boots",
    );
    const replacement = normalized.affixes.find(
      (affix) => affix.stat === "moveSpeedPercent",
    );
    assert.ok(replacement, "boots should prefer movement speed as the compatible replacement");
    assert.equal(replacement.rollPercent, rollPercent, "rolled quality must not be rerolled");
    assert.equal(
      replacement.value,
      equipment.affixValueForRollPercent(
        "moveSpeedPercent",
        level,
        "legendary",
        rollPercent,
      ),
      "replacement magnitude must come from the same percentile on its own curve",
    );
    assert.deepEqual(
      equipment.normalizeGearItem(normalized),
      normalized,
      "the repaired item must be stable on every later load",
    );
  });

  await t.test("an existing move-speed roll falls through to dash speed", () => {
    const saved = savedItemWithLegacyAffix(equipment, {
      slot: "boots",
      stat: "attackSpeedPercent",
      level,
      rollPercent,
      requiredStats: ["moveSpeedPercent"],
      forbiddenStats: ["dashSpeedPercent"],
    });
    const originalMoveSpeed = saved.affixes.find(
      (affix) => affix.stat === "moveSpeedPercent",
    );
    const normalized = equipment.normalizeGearItem(saved);

    assert.ok(normalized, "duplicate fallback must not delete the boots");
    assert.equal(
      normalized.affixes.filter((affix) => affix.stat === "moveSpeedPercent").length,
      1,
      "the existing movement-speed option must not be duplicated or replaced",
    );
    assert.deepEqual(
      normalized.affixes.find((affix) => affix.stat === "moveSpeedPercent"),
      originalMoveSpeed,
      "the pre-existing movement-speed roll must remain byte-for-byte stable",
    );
    const replacement = normalized.affixes.find(
      (affix) => affix.stat === "dashSpeedPercent",
    );
    assert.ok(replacement, "the next compatible mobility option must be dash speed");
    assert.equal(replacement.rollPercent, rollPercent);
    assert.equal(
      replacement.value,
      equipment.affixValueForRollPercent(
        "dashSpeedPercent",
        level,
        "legendary",
        rollPercent,
      ),
    );
    assert.deepEqual(equipment.normalizeGearItem(normalized), normalized);
  });

  await t.test("weapon attack speed remains valid and unchanged", () => {
    const saved = savedItemWithLegacyAffix(equipment, {
      slot: "weapon",
      stat: "attackSpeedPercent",
      level,
      rollPercent,
    });
    const before = saved.affixes.find((affix) => affix.stat === "attackSpeedPercent");
    const normalized = equipment.normalizeGearItem(saved);

    assert.ok(normalized);
    assert.deepEqual(
      normalized.affixes.find((affix) => affix.stat === "attackSpeedPercent"),
      before,
      "the migration must not rewrite a legal weapon attack-speed roll",
    );
    assert.deepEqual(equipment.normalizeGearItem(normalized), normalized);
  });
});
