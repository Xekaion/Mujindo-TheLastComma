import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

const root = process.cwd();

const toDataUrl = (source) =>
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;

async function transpileStandalone(relativePath) {
  const source = await readFile(path.join(root, relativePath), "utf8");
  return ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: relativePath,
  }).outputText;
}

let modulePromise;

async function loadPlayerStatsModules() {
  if (!modulePromise) {
    modulePromise = (async () => {
      const dependencies = {
        "./augment-balance": "app/augment-balance.ts",
        "./combat-balance": "app/combat-balance.ts",
        "./combat-evaluation": "app/combat-evaluation.ts",
        "./equipment": "app/equipment.ts",
        "./professions": "app/professions.ts",
      };
      const urls = Object.fromEntries(
        await Promise.all(
          Object.entries(dependencies).map(async ([specifier, relativePath]) => [
            specifier,
            toDataUrl(await transpileStandalone(relativePath)),
          ]),
        ),
      );
      let playerStatsSource = await transpileStandalone("app/player-stats.ts");
      for (const [specifier, url] of Object.entries(urls)) {
        playerStatsSource = playerStatsSource.replaceAll(specifier, url);
      }
      const [playerStats, equipment] = await Promise.all([
        import(toDataUrl(playerStatsSource)),
        import(urls["./equipment"]),
      ]);
      return { playerStats, equipment };
    })();
  }
  return modulePromise;
}

const nearlyEqual = (actual, expected, epsilon = 1e-9) => {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `expected ${actual} to be within ${epsilon} of ${expected}`,
  );
};

const dormantLegendaryRuntime = {
  mirrorAegisHitCount: 0,
  mirrorAegisBarrierTime: 0,
  starfallMantleTime: 0,
  bloodwovenCriticalHits: 0,
  bloodwovenBurstReady: false,
  ashboundPickupCount: 0,
  ashboundShieldRemaining: 0,
  ashboundShieldTime: 0,
  phantomMarchMoveTime: 0,
};

test("the character sheet baseline matches the live combat constants exactly", async () => {
  const { playerStats, equipment } = await loadPlayerStatsModules();
  const snapshot = playerStats.calculatePlayerStatSnapshot({
    level: 1,
    hp: 100,
    maxHp: 100,
    shield: 0,
    shotCounter: 0,
    augments: {},
    profession: null,
    equipment: equipment.createEmptyEquipment(),
    synergies: [],
    legendaryArmorReady: true,
    ...dormantLegendaryRuntime,
  });

  assert.equal(snapshot.offense.baseAttack, 14);
  assert.equal(snapshot.offense.normalProjectileDamage, 14);
  assert.equal(snapshot.offense.theoreticalProjectileCount, 1);
  assert.equal(snapshot.offense.renderedProjectileCount, 1);
  assert.equal(snapshot.offense.theoreticalFireRate, 1.4);
  assert.equal(snapshot.offense.renderedFireRate, 1.4);
  assert.equal(snapshot.offense.critChance, 0.05);
  assert.equal(snapshot.offense.critMultiplier, 1.7);
  nearlyEqual(snapshot.offense.expectedProjectileDamage, 14.49);
  nearlyEqual(snapshot.offense.expectedPrimaryDps, 20.286);
  assert.equal(snapshot.ratings.sheetAttackPower, 14);
  nearlyEqual(snapshot.ratings.statAttackDps, 20.286);
  nearlyEqual(snapshot.ratings.standardBossDps, snapshot.ratings.statAttackDps);
  assert.equal(snapshot.ratings.hitRate, 1);
  nearlyEqual(
    snapshot.ratings.standardBossDamage60,
    snapshot.ratings.standardBossDps * 60,
  );
  assert.equal(snapshot.ratings.combatPower, 1_000);
  assert.equal(snapshot.ratings.version, 3);
  assert.match(snapshot.ratings.conversionLabel, /전탄 적중 지속 DPS/);

  assert.equal(snapshot.resources.maxHp, 100);
  assert.equal(snapshot.resources.roomEntryShield, 10);
  assert.equal(snapshot.defense.currentDamageReduction, 0);
  assert.equal(snapshot.defense.currentEffectiveHp, 100);
  assert.equal(snapshot.defense.rawHitCap, 40);

  assert.equal(snapshot.mobility.baseMoveSpeed, 245);
  assert.equal(snapshot.mobility.moveSpeed, 245);
  assert.equal(snapshot.mobility.dashSpeed, 900);
  assert.equal(snapshot.mobility.dashDuration, 0.17);
  assert.equal(snapshot.mobility.dashDistance, 153);
  assert.equal(snapshot.mobility.dashCooldown, 1.35);

  assert.equal(snapshot.projectile.speed, 660);
  assert.equal(snapshot.projectile.lifetime, 1.15);
  nearlyEqual(snapshot.projectile.approximateRange, 759);
  assert.equal(snapshot.projectile.radius, 5);
  assert.equal(snapshot.projectile.diameter, 10);
  assert.equal(snapshot.utility.xpMultiplier, 1);
  assert.equal(snapshot.utility.memoryPickupRadius, 38);
  assert.equal(snapshot.utility.memoryAttractionRadius, 91.2);
  assert.equal(snapshot.utility.gearPickupRadius, 44);
  assert.equal(snapshot.utility.normalGearDropChance, 0.19);
  assert.equal(snapshot.utility.eliteGearDropChance, 0.68);
  assert.equal(snapshot.utility.bossGearDropChance, 1);
  assert.equal(snapshot.utility.bossGearRolls, 2);
});

test("slot affixes feed the intended rating without contaminating other metrics", async () => {
  const { playerStats, equipment } = await loadPlayerStatsModules();
  const snapshotFor = (loadout) =>
    playerStats.calculatePlayerStatSnapshot({
      level: 60,
      hp: 100,
      maxHp: 100,
      shield: 0,
      shotCounter: 0,
      augments: {},
      profession: null,
      equipment: loadout,
      synergies: [],
      legendaryArmorReady: true,
      ...dormantLegendaryRuntime,
    });
  const withAffix = (item, stat, value) => ({
    ...item,
    affixes: [
      {
        stat,
        value,
        rollPercent: 50,
        label: equipment.formatGearAffix(stat, value),
      },
    ],
  });

  const baseWeapon = {
    ...equipment.rollGear("rating-speed-weapon", {
      level: 60,
      slot: "weapon",
      rarity: "common",
    }),
    affixes: [],
  };
  const normalWeaponLoadout = equipment.createEmptyEquipment();
  normalWeaponLoadout.weapon = baseWeapon;
  const fastWeaponLoadout = equipment.createEmptyEquipment();
  fastWeaponLoadout.weapon = withAffix(
    baseWeapon,
    "attackSpeedPercent",
    20,
  );
  const normalWeapon = snapshotFor(normalWeaponLoadout);
  const fastWeapon = snapshotFor(fastWeaponLoadout);
  assert.equal(
    fastWeapon.ratings.sheetAttackPower,
    normalWeapon.ratings.sheetAttackPower,
    "attack speed must not masquerade as one-shot sheet attack power",
  );
  assert.ok(fastWeapon.ratings.statAttackDps > normalWeapon.ratings.statAttackDps);
  assert.ok(fastWeapon.ratings.standardBossDps > normalWeapon.ratings.standardBossDps);
  assert.ok(fastWeapon.ratings.combatPower > normalWeapon.ratings.combatPower);

  const baseOffhand = {
    ...equipment.rollGear("rating-boss-offhand", {
      level: 60,
      slot: "offhand",
      rarity: "common",
    }),
    affixes: [],
  };
  const normalBossLoadout = equipment.createEmptyEquipment();
  normalBossLoadout.offhand = baseOffhand;
  const bossDamageLoadout = equipment.createEmptyEquipment();
  bossDamageLoadout.offhand = withAffix(
    baseOffhand,
    "bossDamagePercent",
    25,
  );
  const normalBoss = snapshotFor(normalBossLoadout);
  const bossDamage = snapshotFor(bossDamageLoadout);
  assert.equal(bossDamage.ratings.sheetAttackPower, normalBoss.ratings.sheetAttackPower);
  assert.equal(bossDamage.ratings.statAttackDps, normalBoss.ratings.statAttackDps);
  nearlyEqual(
    bossDamage.ratings.standardBossDps,
    normalBoss.ratings.standardBossDps * 1.25,
  );
  assert.ok(bossDamage.ratings.combatPower > normalBoss.ratings.combatPower);
});

test("cosmic pinnacle options feed live sheet formulas and the special-option ledger", async () => {
  const { playerStats, equipment } = await loadPlayerStatsModules();
  const baseItem = {
    ...equipment.rollGear("cosmic-runtime-contract", {
      level: 80,
      slot: "weapon",
      rarity: "cosmic",
    }),
    affixes: [],
  };
  const snapshotFor = (affix = null) => {
    const loadout = equipment.createEmptyEquipment();
    loadout.weapon = affix
      ? {
          ...baseItem,
          affixes: [{
            stat: affix.stat,
            value: affix.value,
            rollPercent: 100,
            label: equipment.formatGearAffix(affix.stat, affix.value),
          }],
        }
      : baseItem;
    return playerStats.calculatePlayerStatSnapshot({
      level: 80,
      hp: 100,
      maxHp: 100,
      shield: 0,
      shotCounter: 0,
      augments: {},
      profession: null,
      equipment: loadout,
      synergies: [],
      legendaryArmorReady: true,
      ...dormantLegendaryRuntime,
    });
  };

  const baseline = snapshotFor();
  const finalDamage = snapshotFor({ stat: "cosmicFinalDamagePercent", value: 12 });
  const finalDamageMultiplier =
    (1 + finalDamage.equipment.stats.cosmicFinalDamagePercent / 100) /
    (1 + baseline.equipment.stats.cosmicFinalDamagePercent / 100);
  nearlyEqual(
    finalDamage.offense.sheetAttackPower,
    baseline.offense.sheetAttackPower,
  );
  nearlyEqual(
    finalDamage.offense.normalProjectileDamage,
    baseline.offense.normalProjectileDamage * finalDamageMultiplier,
  );
  nearlyEqual(
    finalDamage.ratings.statAttackDps,
    baseline.ratings.statAttackDps * finalDamageMultiplier,
  );
  nearlyEqual(
    finalDamage.ratings.standardBossDps,
    baseline.ratings.standardBossDps * finalDamageMultiplier,
  );
  assert.ok(finalDamage.ratings.combatPower > baseline.ratings.combatPower);

  const aegis = snapshotFor({ stat: "cosmicAegisPercent", value: 10 });
  nearlyEqual(
    aegis.defense.currentIncomingMultiplier,
    baseline.defense.currentIncomingMultiplier * 0.9,
  );
  assert.equal(aegis.ratings.standardBossDps, baseline.ratings.standardBossDps);
  assert.equal(aegis.ratings.combatPower, baseline.ratings.combatPower);

  const actionSpeed = snapshotFor({ stat: "cosmicActionSpeedPercent", value: 10 });
  const actionSpeedMultiplier =
    (1 + actionSpeed.equipment.stats.cosmicActionSpeedPercent / 100) /
    (1 + baseline.equipment.stats.cosmicActionSpeedPercent / 100);
  nearlyEqual(
    actionSpeed.offense.theoreticalFireRate,
    baseline.offense.theoreticalFireRate * actionSpeedMultiplier,
  );
  nearlyEqual(
    actionSpeed.mobility.moveSpeed,
    baseline.mobility.moveSpeed * actionSpeedMultiplier,
  );
  assert.ok(actionSpeed.ratings.combatPower > baseline.ratings.combatPower);

  for (const [stat, snapshot] of [
    ["cosmicFinalDamagePercent", finalDamage],
    ["cosmicAegisPercent", aegis],
    ["cosmicActionSpeedPercent", actionSpeed],
  ]) {
    assert.ok(
      snapshot.specials.some((special) => special.id === stat),
      `${stat} must be visible in the live character sheet`,
    );
  }
});

test("cosmic final damage multiplies every flat and periodic conversion source exactly once", async () => {
  const { playerStats, equipment } = await loadPlayerStatsModules();
  const baseItem = {
    ...equipment.rollGear("cosmic-global-final-damage", {
      level: 80,
      slot: "weapon",
      rarity: "cosmic",
    }),
    affixes: [],
  };
  const snapshotFor = (finalDamagePercent) => {
    const loadout = equipment.createEmptyEquipment();
    loadout.weapon = finalDamagePercent > 0
      ? {
          ...baseItem,
          affixes: [{
            stat: "cosmicFinalDamagePercent",
            value: finalDamagePercent,
            rollPercent: 100,
            label: equipment.formatGearAffix(
              "cosmicFinalDamagePercent",
              finalDamagePercent,
            ),
          }],
        }
      : baseItem;
    return playerStats.calculatePlayerStatSnapshot({
      level: 80,
      hp: 100,
      maxHp: 100,
      shield: 0,
      shotCounter: 0,
      augments: { poison: 10, orbit: 10, void: 10 },
      profession: null,
      equipment: loadout,
      synergies: [],
      legendaryArmorReady: true,
      ...dormantLegendaryRuntime,
    });
  };

  const baseline = snapshotFor(0);
  const boosted = snapshotFor(12);
  const multiplier =
    (1 + boosted.equipment.stats.cosmicFinalDamagePercent / 100) /
    (1 + baseline.equipment.stats.cosmicFinalDamagePercent / 100);
  nearlyEqual(
    boosted.ratings.bossBreakdown.primaryDps,
    baseline.ratings.bossBreakdown.primaryDps * multiplier,
  );
  nearlyEqual(
    boosted.ratings.bossBreakdown.poisonDps,
    baseline.ratings.bossBreakdown.poisonDps * multiplier,
  );
  nearlyEqual(
    boosted.ratings.bossBreakdown.legendaryProcDps,
    baseline.ratings.bossBreakdown.legendaryProcDps * multiplier,
  );
  nearlyEqual(
    boosted.ratings.threeTargetDps,
    baseline.ratings.threeTargetDps * multiplier,
  );
  nearlyEqual(
    boosted.ratings.standardBossDps,
    baseline.ratings.standardBossDps * multiplier,
  );
});

test("the standard HP profile and rendered hit budget keep conversion honest", async () => {
  const { playerStats, equipment } = await loadPlayerStatsModules();
  const snapshotFor = (augments) =>
    playerStats.calculatePlayerStatSnapshot({
      level: 60,
      hp: 50,
      maxHp: 100,
      shield: 0,
      shotCounter: 0,
      augments,
      profession: null,
      equipment: equipment.createEmptyEquipment(),
      synergies: [],
      legendaryArmorReady: true,
      ...dormantLegendaryRuntime,
    });

  const blood = snapshotFor({ blood: 20 });
  const stableBloodDps =
    blood.ratings.sheetAttackPower * 1.4 * (1 + 0.05 * (1.7 - 1));
  const expectedBloodProfileMultiplier =
    1 + 0.2 * ((0.65 * 20 * 0.2) / (1 + 20 * 0.14));
  nearlyEqual(
    blood.ratings.statAttackDps,
    stableBloodDps * expectedBloodProfileMultiplier,
  );

  const nineRendered = snapshotFor({ split: 8, leech: 1 });
  const overflowRendered = snapshotFor({ split: 20, leech: 1 });
  assert.equal(nineRendered.offense.renderedProjectileCount, 9);
  assert.equal(overflowRendered.offense.renderedProjectileCount, 9);
  assert.ok(
    overflowRendered.ratings.statAttackDps > nineRendered.ratings.statAttackDps,
    "damage throughput must preserve theoretical overflow",
  );
  nearlyEqual(
    overflowRendered.ratings.survivalBudget,
    nineRendered.ratings.survivalBudget,
  );
  assert.match(overflowRendered.ratings.conversionLabel, /전탄 적중 지속 DPS/);
});

test("defense, mobility, utility, and projectile handling never inflate combat power", async () => {
  const { playerStats, equipment } = await loadPlayerStatsModules();
  const baseItem = {
    ...equipment.rollGear("combat-power-non-offense-contract", {
      level: 80,
      slot: "weapon",
      rarity: "common",
    }),
    affixes: [],
  };
  const snapshotFor = (stat = null, value = 0) => {
    const loadout = equipment.createEmptyEquipment();
    loadout.weapon = stat
      ? {
          ...baseItem,
          affixes: [{
            stat,
            value,
            rollPercent: 100,
            label: equipment.formatGearAffix(stat, value),
          }],
        }
      : baseItem;
    return playerStats.calculatePlayerStatSnapshot({
      level: 80,
      hp: 100,
      maxHp: 100,
      shield: 0,
      shotCounter: 0,
      augments: {},
      profession: null,
      equipment: loadout,
      synergies: [],
      legendaryArmorReady: true,
      ...dormantLegendaryRuntime,
    });
  };
  const baseline = snapshotFor();
  const nonOffenseStats = [
    ["maxHpFlat", 1_000],
    ["damageReductionPercent", 50],
    ["lifeOnHitFlat", 50],
    ["hpRegenPerSecondFlat", 100],
    ["roomClearHealFlat", 1_000],
    ["roomEntryShieldFlat", 1_000],
    ["moveSpeedPercent", 200],
    ["projectileSpeedPercent", 500],
    ["projectileSizePercent", 150],
    ["projectileLifetimePercent", 500],
    ["homingStrengthFlat", 14],
    ["pierceFlat", 10],
    ["pickupRadiusPercent", 1_000],
    ["xpGainPercent", 500],
    ["gearFindPercent", 200],
    ["cosmicAegisPercent", 20],
  ];

  for (const [stat, value] of nonOffenseStats) {
    const snapshot = snapshotFor(stat, value);
    assert.equal(snapshot.ratings.hitRate, 1, `${stat} must preserve perfect hit`);
    assert.equal(
      snapshot.ratings.standardBossDps,
      baseline.ratings.standardBossDps,
      `${stat} must not alter boss DPS`,
    );
    assert.equal(
      snapshot.ratings.combatPower,
      baseline.ratings.combatPower,
      `${stat} must not alter combat power`,
    );
  }
});

test("equipment and character sheets share the same standard legendary proc cadences", async () => {
  const { playerStats, equipment } = await loadPlayerStatsModules();
  const snapshotFor = (legendaryPowerId = null) => {
    const loadout = equipment.createEmptyEquipment();
    if (legendaryPowerId) {
      const slot = equipment.LEGENDARY_POWERS[legendaryPowerId].slot;
      loadout[slot] = {
        ...equipment.rollGear(`proc-cadence-${legendaryPowerId}`, {
          level: 1,
          slot,
          rarity: "common",
        }),
        affixes: [],
        legendaryPowerId,
      };
    }
    return {
      loadout,
      snapshot: playerStats.calculatePlayerStatSnapshot({
        level: 1,
        hp: 100,
        maxHp: 100,
        shield: 0,
        shotCounter: 0,
        augments: {},
        profession: null,
        equipment: loadout,
        synergies: [],
        legendaryArmorReady: true,
        ...dormantLegendaryRuntime,
      }),
    };
  };
  const baseline = snapshotFor();
  const offensivePowers = [
    "crescentEcho",
    "mirrorAegis",
    "hunterSigil",
    "starfallMantle",
    "bloodwovenGrip",
    "phantomMarch",
    "riftStride",
    "commaResonance",
  ];

  for (const powerId of offensivePowers) {
    const candidate = snapshotFor(powerId);
    const characterGain =
      candidate.snapshot.ratings.combatPower - baseline.snapshot.ratings.combatPower;
    const equipmentGain =
      equipment.calculateEquipmentCombatPower(candidate.loadout) -
      equipment.calculateEquipmentCombatPower(baseline.loadout);
    assert.equal(
      characterGain,
      equipmentGain,
      `${powerId} must use the same standard sustained proc cadence in both ratings`,
    );
  }

  for (const powerId of ["lastMemory", "ashboundGirdle"]) {
    const candidate = snapshotFor(powerId);
    assert.equal(
      candidate.snapshot.ratings.combatPower,
      baseline.snapshot.ratings.combatPower,
      `${powerId} must add no character combat power`,
    );
    assert.equal(
      equipment.calculateEquipmentCombatPower(candidate.loadout),
      equipment.calculateEquipmentCombatPower(baseline.loadout),
      `${powerId} must add no equipment combat power`,
    );
  }
});

test("the character sheet preserves caps, overflow throughput, and live conditional defense", async () => {
  const { playerStats, equipment } = await loadPlayerStatsModules();
  const loadout = equipment.createEmptyEquipment();
  loadout.armor = equipment.rollGear("stats-last-memory", {
    level: 80,
    slot: "armor",
    rarity: "legendary",
  });
  const snapshot = playerStats.calculatePlayerStatSnapshot({
    level: 80,
    hp: 30,
    maxHp: 120,
    shield: 18,
    shotCounter: 3,
    augments: {
      split: 20,
      haste: 20,
      rapidfire: 20,
      frenzy: 20,
      eye: 20,
      defense: 8,
      armor: 7,
      resolve: 6,
      bulwark: 5,
      boots: 6,
      momentum: 8,
      reflex: 7,
      overcharge: 1,
      scavenger: 20,
      regeneration: 4,
      leech: 3,
      conquest: 2,
      recovery: 2,
    },
    profession: "split",
    equipment: loadout,
    synergies: [
      { name: "달빛 봉화", tier: 2 },
      { name: "혈침 순환", tier: 1 },
    ],
    legendaryArmorReady: true,
    ...dormantLegendaryRuntime,
  });

  assert.equal(snapshot.offense.theoreticalProjectileCount, 31);
  assert.equal(snapshot.offense.renderedProjectileCount, 9);
  nearlyEqual(snapshot.offense.projectileOverflowFactor, 31 / 9);
  assert.equal(snapshot.offense.renderedFireRate, 12);
  assert.ok(snapshot.offense.theoreticalFireRate > 12);
  assert.ok(snapshot.offense.fireRateOverflowFactor > 1);
  assert.ok(snapshot.offense.critChance <= 0.75);
  assert.equal(snapshot.offense.overchargePeriod, 7);
  assert.equal(snapshot.offense.shotsUntilOvercharge, 4);

  assert.equal(snapshot.defense.lowHpActive, true);
  assert.equal(snapshot.defense.shieldDefenseActive, true);
  assert.ok(snapshot.defense.currentDamageReduction > snapshot.defense.alwaysDamageReduction);
  assert.equal(snapshot.defense.lastMemoryEquipped, true);
  assert.equal(snapshot.defense.lastMemoryReady, true);
  assert.ok(snapshot.defense.currentEffectiveHp > 48);

  assert.ok(snapshot.mobility.moveSpeed > 245);
  assert.ok(snapshot.mobility.dashSpeed > 900);
  assert.ok(snapshot.mobility.dashCooldown < 1.35);
  assert.ok(snapshot.sustain.regenerationPerSecond > 0);
  assert.ok(snapshot.sustain.leechHealPerHit > 0);
  assert.ok(snapshot.sustain.roomClearHeal > 0);
  assert.equal(snapshot.utility.normalGearDropChance >= 0.35, true);
  assert.ok(snapshot.specials.some((special) => special.id === "overcharge"));
});

test("five new legendary powers expose live progress and conditional sheet multipliers", async () => {
  const { playerStats, equipment } = await loadPlayerStatsModules();
  const loadout = equipment.createEmptyEquipment();
  for (const slot of ["offhand", "shoulders", "gloves", "belt", "legs"]) {
    loadout[slot] = equipment.rollGear(`stats-new-power-${slot}`, {
      level: 70,
      slot,
      rarity: "legendary",
    });
  }
  const activeRuntime = {
    mirrorAegisHitCount: 11,
    mirrorAegisBarrierTime: 1.5,
    starfallMantleTime: 2.5,
    bloodwovenCriticalHits: 5,
    bloodwovenBurstReady: true,
    ashboundPickupCount: 11,
    ashboundShieldRemaining: 8,
    ashboundShieldTime: 4.25,
    phantomMarchMoveTime: 3.2,
  };
  const makeSnapshot = (runtime) =>
    playerStats.calculatePlayerStatSnapshot({
      level: 70,
      hp: 100,
      maxHp: 100,
      shield: runtime.ashboundShieldRemaining,
      shotCounter: 0,
      augments: {},
      profession: null,
      equipment: loadout,
      synergies: [],
      legendaryArmorReady: true,
      ...runtime,
    });
  const inactive = makeSnapshot({
    ...activeRuntime,
    mirrorAegisBarrierTime: 0,
    starfallMantleTime: 0,
    bloodwovenBurstReady: false,
    ashboundShieldRemaining: 0,
    ashboundShieldTime: 0,
    phantomMarchMoveTime: 0,
  });
  const active = makeSnapshot(activeRuntime);

  nearlyEqual(
    active.offense.normalProjectileDamage,
    inactive.offense.normalProjectileDamage * 1.2,
  );
  nearlyEqual(
    active.defense.currentIncomingMultiplier,
    inactive.defense.currentIncomingMultiplier * 0.9,
  );
  nearlyEqual(active.mobility.moveSpeed, inactive.mobility.moveSpeed * 1.12);
  assert.equal(active.resources.ashboundPickupCount, 11);
  assert.equal(active.resources.ashboundShieldRemaining, 8);
  assert.equal(active.resources.ashboundShieldTime, 4.25);
  for (const powerId of [
    "mirrorAegis",
    "starfallMantle",
    "bloodwovenGrip",
    "ashboundGirdle",
    "phantomMarch",
  ]) {
    assert.ok(
      active.specials.some((special) => special.id === powerId),
      `${powerId} must expose its live status in the character sheet`,
    );
  }
  assert.match(
    active.specials.find((special) => special.id === "mirrorAegis").value,
    /1\.50/,
  );
  assert.match(
    active.specials.find((special) => special.id === "bloodwovenGrip").condition,
    /준비 완료/,
  );
});

test("the detailed stats dialog is keyboard-safe, mutually exclusive, and complete", async () => {
  const [canvas, overlay, css, stats] = await Promise.all([
    readFile(path.join(root, "app/GameCanvas.tsx"), "utf8"),
    readFile(path.join(root, "app/StatsOverlay.tsx"), "utf8"),
    readFile(path.join(root, "app/stats-overlay.css"), "utf8"),
    readFile(path.join(root, "app/player-stats.ts"), "utf8"),
  ]);

  assert.match(canvas, /import StatsOverlay from ["']\.\/StatsOverlay["'];/);
  assert.match(canvas, /const statsOpenRef = useRef\(false\);/);
  assert.match(
    canvas,
    /const isSimulationRunning = useCallback\([\s\S]{0,360}?!statsOpenRef\.current/,
  );
  assert.match(canvas, /key === ["']c["'][\s\S]{0,140}?openStats\(\)/);
  assert.match(canvas, /data-stats-open=\{statsOpen\}/);
  assert.match(
    canvas,
    /<StatsOverlay[\s\S]{0,260}?open=\{statsOpen && started && mode === ["']playing["']\}/,
  );
  assert.match(canvas, /<kbd>C<\/kbd> 능력치/);
  assert.match(canvas, /setBuildPanelOpen\(false\)[\s\S]{0,120}?setInventoryScreenOpen\(false\)[\s\S]{0,140}?setStatsScreenOpen\(true\)/);

  assert.match(overlay, /role="dialog"/);
  assert.match(overlay, /aria-modal="true"/);
  assert.match(overlay, /event\.key !== "Tab"/);
  for (const section of [
    "공격",
    "생존",
    "투사체",
    "기동",
    "회복 · 성장",
    "장비 기여",
    "탐사 · 드랍",
  ]) {
    assert.ok(overlay.includes(section), `missing character-sheet section: ${section}`);
  }
  for (const statKey of [
    "attackPowerFlat",
    "damagePercent",
    "attackSpeedPercent",
    "projectileSpeedPercent",
    "maxHpFlat",
    "damageReductionPercent",
    "moveSpeedPercent",
    "dashCooldownPercent",
    "pickupRadiusPercent",
    "xpGainPercent",
    "critChancePercent",
    "critDamagePercent",
    "projectileSizePercent",
    "eliteDamagePercent",
    "lifeOnHitFlat",
    "gearFindPercent",
    "projectileCountFlat",
    "pierceFlat",
    "projectileLifetimePercent",
    "homingStrengthFlat",
    "hpRegenPerSecondFlat",
    "roomClearHealFlat",
    "roomEntryShieldFlat",
    "dashSpeedPercent",
    "bossDamagePercent",
    "executeDamagePercent",
  ]) {
    assert.ok(overlay.includes(statKey), `missing equipment contribution: ${statKey}`);
  }

  assert.match(css, /grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(css, /@container game-viewport \(max-width: 680px\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(stats, /currentIncomingMultiplier/);
  assert.match(stats, /expectedPrimaryDps/);
  assert.match(stats, /normalGearDropChance/);
  assert.match(stats, /calculateEquipmentCombatPowerBreakdown/);
  assert.match(stats, /calculateCombatEvaluation/);
  assert.match(overlay, /ratings\.standardBossDps/);
  assert.match(overlay, /ratings\.combatPower/);
});
