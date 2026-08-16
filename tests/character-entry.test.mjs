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
  assert.match(hydration, /readSaveSlotSummaries\(\)|refreshSummaries\(\)/);
  assert.match(gate, /setSummaries\(readSaveSlotSummaries\(\)\);/);
  assert.match(gate, /writeActiveSaveSlot\(selectedSlot\);/);
  assert.match(gate, /지하 \{summary\.dungeonFloor\}층/);
  assert.doesNotMatch(gate, /방 돌파 \{summary\.roomsCleared\}/);
  assert.match(gate, /if \(!removeSaveSlot\(deleteTarget\)\)/);
  assert.doesNotMatch(gate, /localStorage\.(?:clear|removeItem)/);
  assert.doesNotMatch(gate, /window\.(?:alert|confirm)\(/);
  assert.match(gate, /role="alertdialog"/);
  assert.match(gate, /마지막 보호본은 남습니다/);
  assert.match(gate, /다른 두 캐릭터의 저장\s*데이터에는\s*영향을 주지 않습니다/);
});

test("character selection exposes protected recovery cards and restores before entry", async () => {
  const gate = await readFile(path.join(root, "app/CharacterEntryGate.tsx"), "utf8");

  assert.match(gate, /readSaveRecoveryCandidates,/);
  assert.match(gate, /restoreSaveRecoveryCandidate,/);
  assert.match(
    gate,
    /setRecoveryCandidates\(readSaveRecoveryCandidates\(\)\);/,
    "refreshing slot summaries must discover protected saves",
  );
  assert.match(gate, /const recoveryBySlot = useMemo\(\(\) => \{/);
  assert.match(gate, /data-save-state=\{summary \? "occupied" : recovery \? "recoverable"/);
  assert.match(gate, /RECOVERY AVAILABLE · LV\.\{recovery\.summary\.level\}/);
  assert.match(gate, /삭제·덮어쓰기 전 마지막 보호본이 남아 있습니다\./);
  assert.match(
    gate,
    /restoreSaveRecoveryCandidate\(\s*candidate\.slot,\s*candidate\.generation,\s*candidate\.slot,?\s*\)/,
  );
  assert.match(
    gate,
    /if \(!restoreRecovery\(selectedRecovery\)\) return;\s*writeActiveSaveSlot\(selectedSlot\);\s*onEnter\(\{ slot: selectedSlot, occupied: true \}\);/,
    "entry must occur only after the byte-preserving restore succeeds",
  );
  assert.match(gate, /보호본 복구 후 입장/);
});

test("unreadable raw slots are protected from accidental character creation", async () => {
  const gate = await readFile(path.join(root, "app/CharacterEntryGate.tsx"), "utf8");

  assert.match(gate, /setSlotHasData\(SAVE_SLOT_IDS\.map\(\(slot\) => hasSaveSlotData\(slot\)\)\);/);
  assert.match(
    gate,
    /const selectedHasUnreadableData =\s*selectedSlot !== null &&\s*selectedSummary === null &&\s*slotHasData\[SAVE_SLOT_IDS\.indexOf\(selectedSlot\)\];/,
  );
  assert.match(gate, /if \(selectedHasUnreadableData\) return;/);
  assert.match(gate, /if \(unreadable\) return;/);
  assert.match(gate, /data-save-state=\{summary \? "occupied" : recovery \? "recoverable" : unreadable \? "unreadable"/);
  assert.match(gate, /원본 형식 확인이 필요해 새 캐릭터 생성을 차단했습니다\./);
  assert.match(
    gate,
    /disabled=\{!ready \|\| selectedSlot === null \|\| selectedHasUnreadableData\}/,
  );
  assert.match(gate, /원본 기록 보호 중/);
});

test("a selected save slot hydrates without creating a replacement on failure", async () => {
  const canvas = await readFile(path.join(root, "app/GameCanvas.tsx"), "utf8");

  const props = canvas.match(/type GameCanvasProps = \{([\s\S]*?)\n\};/);
  assert.ok(props, "GameCanvasProps is missing");
  assert.match(props[1], /initialSaveSlot\?: SaveSlotId;/);
  assert.match(props[1], /onReturnToPlaza\?: \(\) => void;/);
  assert.match(props[1], /localEnemyVfxShowcase\?: LocalEnemyVfxShowcaseMode;/);
  assert.match(props[1], /localLootVfxShowcase\?: LocalLootVfxShowcaseMode;/);
  assert.match(canvas, /const initialSaveSlotHandledRef = useRef\(false\);/);

  const initialHydrationStart = canvas.indexOf(
    "if (initialSaveSlot === undefined || initialSaveSlotHandledRef.current) return;",
  );
  const initialHydrationEnd = canvas.indexOf("\n  }, [", initialHydrationStart);
  assert.ok(initialHydrationStart >= 0 && initialHydrationEnd > initialHydrationStart);
  const initialHydration = canvas.slice(initialHydrationStart, initialHydrationEnd);
  assert.match(initialHydration, /loadSave\(initialSaveSlot\)/);
  assert.doesNotMatch(
    initialHydration,
    /if \(!loadSave\(initialSaveSlot\)\)\s*startNewRun\s*\(/,
    "a load failure must not unconditionally become a fresh run",
  );
  assert.match(
    initialHydration,
    /if \(!hasSaveSlotData\(initialSaveSlot\)\) \{\s*startNewRun\(initialSaveSlot\);\s*return;\s*\}/,
    "only a genuinely absent raw slot may enter the fresh-run path",
  );
});

test("new-run initialization never removes an owned checkpoint", async () => {
  const canvas = await readFile(path.join(root, "app/GameCanvas.tsx"), "utf8");
  const startNewRunStart = canvas.indexOf("const startNewRun = useCallback");
  const startNewRunEnd = canvas.indexOf("\n  useEffect(() => {", startNewRunStart);
  assert.ok(startNewRunStart >= 0 && startNewRunEnd > startNewRunStart);
  const startNewRun = canvas.slice(startNewRunStart, startNewRunEnd);
  assert.doesNotMatch(
    startNewRun,
    /removeSaveSlot\s*\(/,
    "starting an in-memory expedition must never delete an owned checkpoint",
  );
});

test("shelter retry never turns a load failure into a fresh run", async () => {
  const canvas = await readFile(path.join(root, "app/GameCanvas.tsx"), "utf8");
  const retryStart = canvas.indexOf("const retryFromShelter = useCallback");
  const retryEnd = canvas.indexOf("const deleteSaveSlot = useCallback", retryStart);
  assert.ok(retryStart >= 0 && retryEnd > retryStart);
  const retryFromShelter = canvas.slice(retryStart, retryEnd);
  assert.match(retryFromShelter, /loadSave\(\)/);
  assert.doesNotMatch(retryFromShelter, /startNewRun\s*\(/);
});

test("the death modal cannot erase a checkpoint by starting a new memory", async () => {
  const canvas = await readFile(path.join(root, "app/GameCanvas.tsx"), "utf8");
  const deathModalStart = canvas.indexOf('{mode === "dead" && (');
  const deathModalEnd = canvas.indexOf('{mode === "ending" && (', deathModalStart);
  assert.ok(deathModalStart >= 0 && deathModalEnd > deathModalStart);
  const deathModal = canvas.slice(deathModalStart, deathModalEnd);
  assert.match(deathModal, /onClick=\{retryFromShelter\}/);
  assert.doesNotMatch(deathModal, /새 기억으로 시작/);
  assert.doesNotMatch(deathModal, /startNewRun\s*\(/);
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
  assert.match(
    directBlock,
    /appearance:\s*LOCAL_PLAZA_SKILL_SHOWCASE_APPEARANCE/,
  );
  assert.match(directBlock, /connectionState="offline"/);
  assert.doesNotMatch(
    directBlock,
    /getMemoryPlazaClient|readSaveSlot|writeSaveSlot|removeSaveSlot|migrateLegacySave|localStorage|sessionStorage/,
  );
  assert.match(
    flow,
    /const LOCAL_PLAZA_SKILL_SHOWCASE_EQUIPMENT\s*=\s*createPlazaSkillShowcaseEquipment\(\);/,
  );
  assert.match(
    flow,
    /const LOCAL_PLAZA_SKILL_SHOWCASE_APPEARANCE\s*=\s*\{[\s\S]{0,260}?hubAppearanceFromLoadout\(\s*LOCAL_PLAZA_SKILL_SHOWCASE_EQUIPMENT,[\s\S]{0,100}?equipped:\s*true/,
  );
});

test("the character portrait asset and responsive entry treatment are present", async () => {
  const css = await readFile(path.join(root, "app/character-entry.css"), "utf8");
  await access(path.join(root, "public/assets/ui/inventory-paperdoll-figure.png"));

  assert.match(css, /url\("\/assets\/ui\/inventory-paperdoll-figure\.png"\)/);
  assert.match(css, /\.character-entry-card\.is-selected/);
  assert.match(css, /@container game-viewport \(max-width: 700px\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});
