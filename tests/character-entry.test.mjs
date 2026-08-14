import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = process.cwd();

test("the root route requires an explicit three-slot character selection", async () => {
  const [page, gate, flow] = await Promise.all([
    readFile(path.join(root, "app/page.tsx"), "utf8"),
    readFile(path.join(root, "app/CharacterEntryGate.tsx"), "utf8"),
    readFile(path.join(root, "app/GameEntryFlow.tsx"), "utf8"),
  ]);

  assert.match(page, /<GameEntryFlow\s+accountName=/);
  assert.doesNotMatch(page, /<GameCanvas\s*\/>/);
  assert.match(gate, /SAVE_SLOT_IDS\.map\(\(slot, index\) =>/);
  assert.match(gate, /aria-label="캐릭터 저장 슬롯"/);
  assert.match(gate, /onEnter\(\{ slot: selectedSlot, occupied: selectedSummary !== null \}\)/);
  assert.match(flow, /selection === null[\s\S]*?<CharacterEntryGate[\s\S]*?onEnter=\{enterCharacter\}/);
  assert.match(flow, /data-entry-save-slot=\{selection\.slot\}/);
});

test("character selection preserves migration and isolates destructive slot actions", async () => {
  const gate = await readFile(path.join(root, "app/CharacterEntryGate.tsx"), "utf8");

  const hydration = gate.slice(gate.indexOf("migrateLegacySave();"), gate.indexOf("useEffect(() => {", gate.indexOf("migrateLegacySave();")));
  assert.match(hydration, /migrateLegacySave\(\);/);
  assert.match(hydration, /readActiveSaveSlot\(\)/);
  assert.match(hydration, /readSaveSlotSummaries\(\)/);
  assert.match(gate, /writeActiveSaveSlot\(selectedSlot\);/);
  assert.match(gate, /지하 \{summary\.dungeonFloor\}층/);
  assert.doesNotMatch(gate, /방 돌파 \{summary\.roomsCleared\}/);
  assert.match(gate, /if \(!removeSaveSlot\(deleteTarget\)\)/);
  assert.doesNotMatch(gate, /localStorage\.(?:clear|removeItem)/);
  assert.doesNotMatch(gate, /window\.(?:alert|confirm)\(/);
  assert.match(gate, /role="alertdialog"/);
  assert.match(gate, /다른 두 캐릭터의 저장 데이터에는\s*영향을 주지 않습니다/);
});

test("a selected save slot enters GameCanvas exactly once and resumes before creating", async () => {
  const canvas = await readFile(path.join(root, "app/GameCanvas.tsx"), "utf8");

  const props = canvas.match(/type GameCanvasProps = \{([\s\S]*?)\n\};/);
  assert.ok(props, "GameCanvasProps is missing");
  assert.match(props[1], /initialSaveSlot\?: SaveSlotId;/);
  assert.match(props[1], /onReturnToPlaza\?: \(\) => void;/);
  assert.match(props[1], /localEnemyVfxShowcase\?: LocalEnemyVfxShowcaseMode;/);
  assert.match(props[1], /localLootVfxShowcase\?: LocalLootVfxShowcaseMode;/);
  assert.match(canvas, /const initialSaveSlotHandledRef = useRef\(false\);/);
  assert.match(
    canvas,
    /if \(isLocalVfxShowcase\) return;\s*if \(initialSaveSlot === undefined \|\| initialSaveSlotHandledRef\.current\) return;[\s\S]{0,180}?initialSaveSlotHandledRef\.current = true;[\s\S]{0,180}?if \(!loadSave\(initialSaveSlot\)\) startNewRun\(initialSaveSlot\);/,
  );
});

test("localhost loot VFX QA bypasses slot hydration and remains memory-only", async () => {
  const [page, flow, canvas] = await Promise.all([
    readFile(path.join(root, "app/page.tsx"), "utf8"),
    readFile(path.join(root, "app/GameEntryFlow.tsx"), "utf8"),
    readFile(path.join(root, "app/GameCanvas.tsx"), "utf8"),
  ]);

  assert.match(
    canvas,
    /export type LocalLootVfxShowcaseMode =[\s\S]{0,240}?\| "common"[\s\S]{0,240}?\| "cosmic"[\s\S]{0,60}?\| "all";/,
  );
  assert.match(page, /query\.enemyVfxShowcase !== undefined \|\| query\.lootVfxShowcase !== undefined/);
  assert.match(page, /localVfxShowcaseRequested=\{localVfxShowcaseRequested\}/);
  assert.match(
    flow,
    /const \[localVfxShowcaseChecked, setLocalVfxShowcaseChecked\] = useState\(\s*!localVfxShowcaseRequested,?\s*\);/,
  );
  assert.match(flow, /const requestedLootMode = search\.get\("lootVfxShowcase"\);/);
  assert.match(flow, /isLocalLootVfxShowcaseMode\(requestedLootMode\)/);
  assert.match(flow, /setLocalVfxShowcaseChecked\(true\);/);
  assert.match(flow, /data-entry-view="local-vfx-showcase-checking"/);

  const directEntry = flow.indexOf(
    "if (localEnemyVfxShowcase || localLootVfxShowcase)",
  );
  const characterEntry = flow.indexOf("if (selection === null)", directEntry);
  assert.ok(
    directEntry >= 0 && characterEntry > directEntry,
    "the validated local showcase must render before CharacterEntryGate",
  );
  const directBlock = flow.slice(directEntry, characterEntry);
  assert.match(directBlock, /"local-loot-vfx-showcase"/);
  assert.match(directBlock, /localLootVfxShowcase=\{localLootVfxShowcase \?\? undefined\}/);
  assert.doesNotMatch(
    directBlock,
    /readSaveSlot|writeSaveSlot|removeSaveSlot|migrateLegacySave|localStorage|sessionStorage/,
  );

  assert.match(
    canvas,
    /const isLocalVfxShowcase = Boolean\(\s*localEnemyVfxShowcase \|\| localLootVfxShowcase,?\s*\);/,
  );
  const transientStart = canvas.indexOf(
    "if (!isLocalVfxShowcase || initialSaveSlotHandledRef.current) return;",
  );
  const normalHydration = canvas.indexOf(
    "if (isLocalVfxShowcase) return;",
    transientStart,
  );
  assert.ok(transientStart >= 0 && normalHydration > transientStart);
  const transientBoot = canvas.slice(transientStart, normalHydration);
  assert.match(transientBoot, /playerRef\.current = makePlayer\(\);/);
  assert.match(transientBoot, /worldRef\.current = makeWorld\(/);
  assert.doesNotMatch(
    transientBoot,
    /loadSave|startNewRun|writeSaveSlot|removeSaveSlot|migrateLegacySave|localStorage|sessionStorage/,
  );
  assert.match(
    canvas,
    /const saveCheck = isLocalVfxShowcase\s*\? null\s*:\s*window\.setTimeout/,
  );
  assert.match(canvas, /readShopEntitlements\(null\)/);
});

test("localhost plaza motion QA renders directly without touching a save or hub session", async () => {
  const [page, flow] = await Promise.all([
    readFile(path.join(root, "app/page.tsx"), "utf8"),
    readFile(path.join(root, "app/GameEntryFlow.tsx"), "utf8"),
  ]);

  assert.match(page, /query\.plazaMotionShowcase !== undefined/);
  assert.match(flow, /const requestedPlazaMotionShowcase = search\.get\("plazaMotionShowcase"\);/);
  assert.match(flow, /requestedPlazaMotionShowcase === "1"/);
  const directEntry = flow.indexOf("if (localPlazaMotionShowcase)");
  const characterEntry = flow.indexOf("if (selection === null)", directEntry);
  assert.ok(directEntry >= 0 && characterEntry > directEntry);
  const directBlock = flow.slice(directEntry, characterEntry);
  assert.match(directBlock, /data-entry-view="local-plaza-motion-showcase"/);
  assert.match(directBlock, /<PlazaHub/);
  assert.match(directBlock, /equipment=\{LOCAL_PLAZA_SKILL_SHOWCASE_EQUIPMENT\}/);
  assert.match(directBlock, /connectionState="offline"/);
  assert.doesNotMatch(
    directBlock,
    /getMemoryPlazaClient|readSaveSlot|writeSaveSlot|removeSaveSlot|migrateLegacySave|localStorage|sessionStorage/,
  );
  assert.match(
    flow,
    /const LOCAL_PLAZA_SKILL_SHOWCASE_EQUIPMENT\s*=\s*createPlazaSkillShowcaseEquipment\(\);/,
  );
});

test("the character portrait asset and responsive entry treatment are present", async () => {
  const css = await readFile(path.join(root, "app/character-entry.css"), "utf8");
  await access(path.join(root, "public/assets/ui/inventory-paperdoll-figure.png"));

  assert.match(css, /url\("\/assets\/ui\/inventory-paperdoll-figure\.png"\)/);
  assert.match(css, /\.character-entry-card\.is-selected/);
  assert.match(css, /@media \(max-width: 700px\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});
