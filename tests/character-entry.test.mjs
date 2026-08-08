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

  assert.match(
    canvas,
    /type GameCanvasProps = \{\s*initialSaveSlot\?: SaveSlotId;\s*onReturnToPlaza\?: \(\) => void;\s*\};/,
  );
  assert.match(canvas, /const initialSaveSlotHandledRef = useRef\(false\);/);
  assert.match(
    canvas,
    /if \(initialSaveSlot === undefined \|\| initialSaveSlotHandledRef\.current\) return;[\s\S]{0,180}?initialSaveSlotHandledRef\.current = true;[\s\S]{0,180}?if \(!loadSave\(initialSaveSlot\)\) startNewRun\(initialSaveSlot\);/,
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
