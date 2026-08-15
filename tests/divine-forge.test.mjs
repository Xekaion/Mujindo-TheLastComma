import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

const root = process.cwd();

async function typeScriptModuleUrl(relativePath, dependencyUrls = {}) {
  let source = await readFile(path.join(root, relativePath), "utf8");
  for (const [specifier, dependencyUrl] of Object.entries(dependencyUrls)) {
    source = source
      .replaceAll(`"${specifier}"`, `"${dependencyUrl}"`)
      .replaceAll(`'${specifier}'`, `'${dependencyUrl}'`);
  }
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: relativePath,
  }).outputText;
  return `data:text/javascript;base64,${Buffer.from(output).toString("base64")}`;
}

const modulesPromise = (async () => {
  const equipmentUrl = await typeScriptModuleUrl("app/equipment.ts");
  const equipment = await import(equipmentUrl);
  const forge = await import(
    await typeScriptModuleUrl("app/divine-forge.ts", {
      "./equipment": equipmentUrl,
    })
  );
  return { equipment, forge };
})();

function gear(equipment, seed, rarity, level, slot = "weapon") {
  return equipment.rollGear(seed, { rarity, level, slot });
}

function affixSignature(item) {
  return item.affixes
    .map((affix) => `${affix.stat}:${affix.value}:${affix.rollPercent}:${affix.label}`)
    .join("|");
}

test("divine forge recipes match the requested mythic and cosmic economy", async () => {
  const { forge } = await modulesPromise;
  assert.deepEqual(forge.DIVINE_FORGE_RULES.mythic, {
    targetRarity: "mythic",
    materialRarity: "legendary",
    materialCount: 5,
    ashCost: 150_000,
  });
  assert.deepEqual(forge.DIVINE_FORGE_RULES.cosmic, {
    targetRarity: "cosmic",
    materialRarity: "mythic",
    materialCount: 5,
    ashCost: 1_000_000,
  });
  assert.equal(forge.MAX_DIVINE_FORGE_REROLLS, 3);
});

test("materials require the exact rarity, five distinct inventory items, and strictly higher levels", async () => {
  const { equipment, forge } = await modulesPromise;
  const target = gear(equipment, "mythic-target", "mythic", 50);
  const valid = Array.from({ length: 5 }, (_, index) =>
    gear(equipment, `legendary-${index}`, "legendary", 51 + index, equipment.EQUIPMENT_SLOTS[index]),
  );
  assert.ok(valid.every((item) => forge.isDivineForgeMaterialEligible(target, item)));
  assert.equal(forge.validateDivineForgeAttempt(target, valid, 150_000).code, "ready");
  assert.equal(forge.validateDivineForgeAttempt(target, valid, 149_999).code, "insufficient-ash");
  assert.equal(forge.validateDivineForgeAttempt(target, valid.slice(0, 4), 150_000).code, "material-count");
  assert.equal(forge.validateDivineForgeAttempt(target, [...valid.slice(0, 4), valid[0]], 150_000).code, "duplicate-material");

  const sameLevel = gear(equipment, "same-level", "legendary", 50, "relic");
  const wrongRarity = gear(equipment, "wrong-rarity", "mythic", 99, "relic");
  assert.equal(forge.isDivineForgeMaterialEligible(target, sameLevel), false, "equal level must not qualify");
  assert.equal(forge.isDivineForgeMaterialEligible(target, wrongRarity), false, "mythic cannot pay a mythic recipe");
  assert.equal(
    forge.validateDivineForgeAttempt(target, [...valid.slice(0, 4), sameLevel], 150_000).code,
    "invalid-material",
  );

  const targetCloneAsMaterial = { ...target };
  assert.equal(
    forge.validateDivineForgeAttempt(target, [...valid.slice(0, 4), targetCloneAsMaterial], 150_000).code,
    "target-as-material",
  );

  const sorted = forge.sortDivineForgeMaterials([
    { ...valid[0], level: 70, enhancement: 2, powerScore: 9999 },
    { ...valid[1], level: 60, enhancement: 4, powerScore: 4000 },
    { ...valid[2], level: 60, enhancement: 0, powerScore: 5000 },
  ]);
  assert.deepEqual(sorted.map((item) => [item.level, item.enhancement]), [[60, 0], [60, 4], [70, 2]]);
});

test("full affix rerolls preserve item identity and canonical high-tier contracts", async () => {
  const { equipment, forge } = await modulesPromise;
  for (const [rarity, expectedAffixes] of [["mythic", 7], ["cosmic", 8]]) {
    const base = {
      ...gear(equipment, `${rarity}-reroll-target`, rarity, 88, "relic"),
      enhancement: 7,
    };
    base.powerScore = equipment.calculateGearPowerScore(base);
    const first = forge.rerollDivineForgeItem(base, `${rarity}-forge-seed`);
    const repeated = forge.rerollDivineForgeItem(base, `${rarity}-forge-seed`);

    assert.deepEqual(first, repeated, "the pure reroll must remain deterministic for tests and replay diagnostics");
    assert.notEqual(affixSignature(first), affixSignature(base));
    assert.equal(first.affixes.length, expectedAffixes);
    assert.equal(new Set(first.affixes.map((affix) => affix.stat)).size, expectedAffixes);
    for (const field of ["id", "slot", "rarity", "level", "baseName", "displayName", "iconIndex", "legendaryPowerId", "enhancement"]) {
      assert.equal(first[field], base[field], `${field} must survive a forge reroll`);
    }
    assert.equal(first.divineForgeRerolls, 1);
    assert.equal(first.qualityScore, equipment.calculateGearQualityScore(first.affixes));
    assert.equal(first.powerScore, equipment.calculateGearPowerScore(first));
    assert.equal(equipment.isGearItem(first), true);
    if (rarity === "cosmic") {
      const cosmicStats = new Set(equipment.GEAR_COSMIC_AFFIX_STATS);
      assert.equal(first.affixes.filter((affix) => cosmicStats.has(affix.stat)).length, 1);
    }
  }
});

test("pure transactions atomically consume exact donors for inventory and equipped targets", async () => {
  const { equipment, forge } = await modulesPromise;
  const mythicTarget = gear(equipment, "transaction-mythic", "mythic", 50, "weapon");
  const legendaryDonors = Array.from({ length: 5 }, (_, index) =>
    gear(equipment, `transaction-legendary-${index}`, "legendary", 51 + index, equipment.EQUIPMENT_SLOTS[index]),
  );
  const unrelated = gear(equipment, "transaction-unrelated", "legendary", 20, "relic");
  const inventory = [mythicTarget, ...legendaryDonors, unrelated];
  const loadout = equipment.createEmptyEquipment();
  const inventoryBefore = structuredClone(inventory);
  const loadoutBefore = structuredClone(loadout);
  const mythicTransaction = forge.applyDivineForgeTransaction({
    inventory,
    equipment: loadout,
    memoryAsh: 200_000,
    targetId: mythicTarget.id,
    materialIds: legendaryDonors.map((item) => item.id),
    seed: "transaction-mythic-seed",
  });

  assert.equal(mythicTransaction.ok, true);
  assert.equal(mythicTransaction.memoryAsh, 50_000);
  assert.equal(mythicTransaction.equippedSlot, null);
  assert.deepEqual(inventory, inventoryBefore, "the caller inventory must remain untouched");
  assert.deepEqual(loadout, loadoutBefore, "the caller equipment must remain untouched");
  assert.deepEqual(
    mythicTransaction.result.consumed.map((item) => item.id),
    legendaryDonors.map((item) => item.id),
  );
  assert.deepEqual(
    mythicTransaction.inventory.map((item) => item.id),
    [mythicTarget.id, unrelated.id],
  );
  const forgedMythic = mythicTransaction.inventory.find((item) => item.id === mythicTarget.id);
  assert.ok(forgedMythic);
  assert.equal(forgedMythic.divineForgeRerolls, 1);
  assert.notEqual(affixSignature(forgedMythic), affixSignature(mythicTarget));

  const cosmicTarget = {
    ...gear(equipment, "transaction-cosmic", "cosmic", 30, "relic"),
    enhancement: 4,
  };
  cosmicTarget.powerScore = equipment.calculateGearPowerScore(cosmicTarget);
  const mythicDonors = Array.from({ length: 5 }, (_, index) =>
    gear(equipment, `transaction-mythic-donor-${index}`, "mythic", 31 + index, equipment.EQUIPMENT_SLOTS[index]),
  );
  const equippedLoadout = equipment.createEmptyEquipment();
  equippedLoadout.relic = cosmicTarget;
  const equippedBefore = structuredClone(equippedLoadout);
  const donorsBefore = structuredClone(mythicDonors);
  const cosmicTransaction = forge.applyDivineForgeTransaction({
    inventory: mythicDonors,
    equipment: equippedLoadout,
    memoryAsh: 1_100_000,
    targetId: cosmicTarget.id,
    materialIds: mythicDonors.map((item) => item.id),
    seed: "transaction-cosmic-seed",
  });

  assert.equal(cosmicTransaction.ok, true);
  assert.equal(cosmicTransaction.memoryAsh, 100_000);
  assert.equal(cosmicTransaction.equippedSlot, "relic");
  assert.equal(cosmicTransaction.inventory.length, 0);
  assert.deepEqual(equippedLoadout, equippedBefore);
  assert.deepEqual(mythicDonors, donorsBefore);
  assert.equal(cosmicTransaction.equipment.relic.id, cosmicTarget.id);
  assert.equal(cosmicTransaction.equipment.relic.enhancement, 4);
  assert.equal(cosmicTransaction.equipment.relic.divineForgeRerolls, 1);
  assert.notEqual(cosmicTransaction.equipment.relic, cosmicTarget);

  const restored = equipment.reconcileEquipmentLevelRequirements(
    999,
    JSON.parse(JSON.stringify(cosmicTransaction.equipment)),
    JSON.parse(JSON.stringify(cosmicTransaction.inventory)),
  );
  assert.equal(restored.equipment.relic.divineForgeRerolls, 1);

  const invalidSix = forge.applyDivineForgeTransaction({
    inventory,
    equipment: loadout,
    memoryAsh: 200_000,
    targetId: mythicTarget.id,
    materialIds: [...legendaryDonors.map((item) => item.id), "missing-sixth-id"],
    seed: "invalid-six",
  });
  assert.equal(invalidSix.ok, false);
  assert.equal(invalidSix.code, "material-count");
  assert.deepEqual(inventory, inventoryBefore);
  assert.deepEqual(loadout, loadoutBefore);
});

test("reroll count migrates legacy saves and hard-stops each item after three uses", async () => {
  const { equipment, forge } = await modulesPromise;
  const legacy = gear(equipment, "legacy-forge-count", "mythic", 60);
  delete legacy.divineForgeRerolls;
  const migrated = equipment.normalizeGearItem(legacy);
  assert.ok(migrated);
  assert.equal(migrated.divineForgeRerolls, 0);
  assert.equal(equipment.isGearItem(legacy), false);
  for (const invalid of [-1, 4, 1.5, "2"]) {
    assert.equal(equipment.normalizeGearItem({ ...migrated, divineForgeRerolls: invalid }), null);
  }

  let current = migrated;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    current = forge.rerollDivineForgeItem(current, `attempt-${attempt}`);
    assert.equal(current.divineForgeRerolls, attempt + 1);
  }
  assert.equal(forge.getDivineForgeRerollsRemaining(current), 0);
  assert.throws(() => forge.rerollDivineForgeItem(current, "fourth"), /limit/i);

  const materials = Array.from({ length: 5 }, (_, index) =>
    gear(equipment, `limit-material-${index}`, "legendary", 61 + index, equipment.EQUIPMENT_SLOTS[index]),
  );
  assert.equal(forge.validateDivineForgeAttempt(current, materials, 150_000).code, "reroll-limit");
  assert.equal(equipment.normalizeGearItem({ ...current, divineForgeRerolls: 3 }).divineForgeRerolls, 3);
});

test("runtime transaction and inventory UI keep costs atomic and use generated forge chrome", async () => {
  const gameCanvas = await readFile(path.join(root, "app/GameCanvas.tsx"), "utf8");
  const inventoryOverlay = await readFile(path.join(root, "app/InventoryOverlay.tsx"), "utf8");
  const css = await readFile(path.join(root, "app/game.css"), "utf8");

  assert.match(gameCanvas, /applyDivineForgeTransaction\(\{[\s\S]{0,500}?materialIds,[\s\S]{0,200}?seed:/);
  assert.match(gameCanvas, /if \(!transaction\.ok\)[\s\S]{0,900}?return null;/);
  assert.match(gameCanvas, /player\.memoryAsh = transaction\.memoryAsh/);
  assert.match(gameCanvas, /player\.inventory = transaction\.inventory/);
  assert.match(gameCanvas, /player\.equipment = transaction\.equipment/);
  assert.match(gameCanvas, /previousMaxHp[\s\S]{0,1200}?aggregateEquipmentStats\(player\.equipment\)\.maxHpFlat/);
  assert.match(gameCanvas, /onDivineForgeReroll=\{performDivineForgeReroll\}/);

  assert.match(inventoryOverlay, /sortDivineForgeMaterials\([\s\S]{0,160}?inventory\.filter/);
  assert.match(inventoryOverlay, /eligibleMaterials\.slice\(0, rule\.materialCount\)/);
  assert.match(inventoryOverlay, /targets\.find\([\s\S]{0,100}?\?\? targets\[0\] \?\? null/);
  assert.match(inventoryOverlay, /const dialogRef = useRef<HTMLElement>\(null\)/);
  assert.match(inventoryOverlay, /event\.key !== "Tab"/);
  assert.match(inventoryOverlay, /tabIndex=\{-1\}/);
  assert.match(inventoryOverlay, /inert=\{divineForgeOpen \? true : undefined\}/);
  assert.match(inventoryOverlay, /aria-hidden=\{divineForgeOpen \? true : undefined\}/);
  assert.match(inventoryOverlay, /ref=\{divineForgeTriggerRef\}/);
  assert.match(inventoryOverlay, /role=\{step === "confirm" \? "alertdialog" : "dialog"\}/);
  assert.match(inventoryOverlay, /변경 전[\s\S]{0,1000}?변경 후/);
  assert.doesNotMatch(inventoryOverlay, /window\.(?:confirm|prompt)\s*\(/);
  for (const asset of ["crest", "title", "socket", "button"]) {
    assert.match(css, new RegExp(`/assets/ui/divine-forge-${asset}-v1\\.png`));
  }
  assert.match(css, /@container game-viewport \(max-width: 900px\) \{[\s\S]{0,300}?inventory-screen:not\(\.inventory-screen--read-only\)[\s\S]{0,180}?auto auto 98px 38px[\s\S]{0,220}?inventory-screen--read-only[\s\S]{0,150}?auto auto 38px/);
  assert.match(css, /@container game-viewport \(max-width: 620px\) \{[\s\S]{0,400}?inventory-screen--read-only[\s\S]{0,160}?minmax\(0, 1fr\) auto 36px/);
  assert.match(css, /prefers-reduced-motion:[\s\S]{0,500}?inventory-screen-divine-forge/);
});

test("ImageGen forge assets preserve provenance, RGBA output, gutters, and CSS consumers", async () => {
  const manifestPath = path.join(root, "public/assets/ui/divine-forge-ui-v1.build.json");
  const promptPath = path.join(root, "asset-sources/imagegen/divine-forge-ui-v1.prompt.json");
  const [manifest, prompt, builder] = await Promise.all([
    readFile(manifestPath, "utf8").then(JSON.parse),
    readFile(promptPath, "utf8").then(JSON.parse),
    readFile(path.join(root, "scripts/build_divine_forge_ui_v1.py"), "utf8"),
  ]);
  assert.equal(prompt.tool, "image_gen.imagegen built-in");
  assert.equal(prompt.mode, "original-create");
  assert.equal(manifest.pipeline.nativeTransparentImageGenSource, true);
  assert.equal(manifest.pipeline.zeroAlphaRgbCleared, true);
  assert.match(builder, /premultiplied-alpha Lanczos/);
  assert.equal(manifest.outputs.length, 4);

  for (const record of [...manifest.inputs, ...manifest.outputs]) {
    const buffer = await readFile(path.join(root, record.path));
    assert.equal(createHash("sha256").update(buffer).digest("hex"), record.sha256, record.path);
    assert.equal(buffer.length, record.bytes, record.path);
    if (!record.path.endsWith(".png")) continue;
    assert.equal(buffer.subarray(1, 4).toString("ascii"), "PNG");
    assert.equal(buffer.readUInt32BE(16), record.size[0]);
    assert.equal(buffer.readUInt32BE(20), record.size[1]);
    assert.equal(buffer[24], 8, `${record.path} must be 8-bit`);
    assert.equal(buffer[25], 6, `${record.path} must be RGBA`);
  }
  for (const output of manifest.outputs) {
    const [left, top, right, bottom] = output.productionAlphaBox;
    assert.ok(left >= 6 && top >= 6, `${output.name} needs transparent top/left gutter`);
    assert.ok(output.size[0] - right >= 6, `${output.name} needs transparent right gutter`);
    assert.ok(output.size[1] - bottom >= 6, `${output.name} needs transparent bottom gutter`);
    assert.match(output.cssConsumer, /^\.inventory-screen-divine-forge/);
  }
});
