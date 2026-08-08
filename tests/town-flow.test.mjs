import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const source = (relativePath) => readFile(path.join(root, relativePath), "utf8");

test("character selection enters the shared plaza before every service", async () => {
  const [flow, canvas] = await Promise.all([
    source("app/GameEntryFlow.tsx"),
    source("app/GameCanvas.tsx"),
  ]);

  assert.match(flow, /selection === null[\s\S]*<CharacterEntryGate/);
  assert.match(flow, /data-entry-view="plaza"[\s\S]*<PlazaHub/);
  assert.match(flow, /portal\.id === "expedition"[\s\S]*setView\("expedition"\)/);
  assert.match(flow, /portal\.id === "caravan"[\s\S]*setShopOpen\(true\)/);
  assert.match(flow, /destination\.searchParams\.set\("from", "plaza"\)/);
  assert.match(flow, /<TownCaravanOverlay/);
  assert.match(flow, /<GameCanvas[\s\S]*initialSaveSlot=\{selection\.slot\}[\s\S]*onReturnToPlaza=/);
  assert.match(canvas, /onReturnToPlaza\?: \(\) => void/);
  assert.match(canvas, /onReturnToPlaza\?\.\(\)/);
});

test("the plaza binds selected save visuals and allowlisted floor claims to presence", async () => {
  const [flow, plaza] = await Promise.all([
    source("app/GameEntryFlow.tsx"),
    source("app/PlazaHub.tsx"),
  ]);

  assert.match(flow, /readSaveSlot\(selection\.slot\)/);
  assert.match(flow, /normalizeEquipment\(savedCharacter\?\.player\.equipment\)/);
  assert.match(flow, /client\.enter\(\{/);
  assert.match(flow, /characterSlot: selection\.slot/);
  assert.match(flow, /savedCharacter\?\.world\?\.dungeonFloor/);
  assert.match(flow, /dungeonFloor,/);
  assert.match(flow, /dungeonFloor: self\?\.dungeonFloor \?\? dungeonFloor/);
  assert.match(flow, /appearance: hubAppearance/);
  assert.match(flow, /snapshot\.nearbyPlayers|hubSnapshot\?\.nearbyPlayers/);
  assert.match(flow, /localAuthoritativePosition=/);
  assert.match(flow, /getMemoryPlazaClient\(\)\.setMoveIntent/);
  assert.doesNotMatch(flow, /setMoveIntent\(\{[^}]*\b(?:x|y|speed|teleport)\s*:/s);
  assert.match(plaza, /지하 \$\{player\.dungeonFloor\}층/);
  assert.match(plaza, /지하 \{normalizedCharacter\.dungeonFloor\}층/);
});

test("duel and exchange return to the already selected town character", async () => {
  const [page, pvp, market] = await Promise.all([
    source("app/page.tsx"),
    source("app/pvp/PvpArena.tsx"),
    source("app/market/MarketBoard.tsx"),
  ]);

  assert.match(page, /returnToTown=\{query\.town === "1"\}/);
  assert.match(page + (await source("app/GameEntryFlow.tsx")), /TOWN_RETURN_SESSION_KEY/);
  assert.match(pvp, /href="\/\?town=1"[^>]*>← 기억 광장으로/);
  assert.match(market, /href="\/\?town=1"[^>]*>← 기억 광장으로/);
});

test("the authored plaza map keeps its exact 16:9 production canvas", async () => {
  const png = await readFile(
    path.join(root, "public/assets/maps/memory-plaza-v1.png"),
  );
  assert.equal(png.subarray(1, 4).toString("ascii"), "PNG");
  assert.equal(png.readUInt32BE(16), 1_672);
  assert.equal(png.readUInt32BE(20), 941);
  assert.ok(Math.abs(1_672 / 941 - 16 / 9) < 0.001);
});

test("the town caravan reuses the account entitlement safety contract", async () => {
  const [caravan, shop, flow, plaza] = await Promise.all([
    source("app/TownCaravanOverlay.tsx"),
    source("app/ShopOverlay.tsx"),
    source("app/GameEntryFlow.tsx"),
    source("app/PlazaHub.tsx"),
  ]);
  assert.match(caravan, /readShopEntitlements\(\)/);
  assert.match(caravan, /shopCheckoutMode\(\)/);
  assert.match(caravan, /completeLocalShopPurchase\(productId\)/);
  assert.match(caravan, /checkoutMode !== "local-test"/);
  assert.match(caravan, /<ShopOverlay/);
  assert.doesNotMatch(caravan, /window\.(?:alert|confirm)\(/);
  assert.match(shop, /panelRef/);
  assert.match(shop, /event\.key !== "Tab"/);
  assert.match(flow, /paused=\{shopOpen \|\| inventoryOpen\}/);
  assert.match(plaza, /pausedRef\.current/);
  assert.match(plaza, /inert=\{paused\}/);
});

test("I opens a read-only inventory for the selected plaza character", async () => {
  const [flow, plaza] = await Promise.all([
    source("app/GameEntryFlow.tsx"),
    source("app/PlazaHub.tsx"),
  ]);

  assert.match(flow, /import InventoryOverlay from ["']\.\/InventoryOverlay["'];/);
  assert.match(flow, /const \[inventoryOpen, setInventoryOpen\] = useState\(false\);/);
  assert.match(
    flow,
    /const \[selectedGearId, setSelectedGearId\] = useState<string \| null>\(null\);/,
  );
  assert.match(
    flow,
    /savedCharacter\?\.player\.inventory[\s\S]{0,420}?normalizeGearItem/,
    "plaza inventory entries must be normalized from the selected save",
  );
  assert.match(flow, /inventoryCapacityFor\(readShopEntitlements\(\)\)/);
  assert.match(flow, /calculateEquipmentCombatPower\(equipment\)/);
  assert.match(
    flow,
    /\{inventoryOpen && \(\s*<InventoryOverlay\s+open\s+readOnly/,
    "the plaza must mount the production inventory surface only while it is open",
  );
  const overlayProps = flow.match(/<InventoryOverlay([\s\S]*?)\/>/);
  assert.ok(overlayProps, "the plaza inventory component must be rendered");
  assert.match(
    overlayProps[1],
    /\breadOnly\b/,
    "the plaza must reuse the production inventory surface in inspection mode",
  );
  assert.match(overlayProps[1], /equipment=\{equipment\}/);
  assert.match(overlayProps[1], /inventory=\{inventory\}/);
  assert.match(overlayProps[1], /inventoryCapacity=\{inventoryCapacity\}/);
  assert.match(overlayProps[1], /selectedGearId=\{selectedGearId\}/);
  assert.match(overlayProps[1], /memoryAsh=\{memoryAsh\}/);
  assert.match(overlayProps[1], /equippedPower=\{equippedPower\}/);

  assert.match(plaza, /onInventoryOpen\?: \(\) => void;/);
  assert.match(plaza, /onClick=\{onInventoryOpen\}/);
  assert.match(plaza, /<kbd>I<\/kbd>/);
  assert.match(flow, /onInventoryOpen=\{openInventory\}/);
  assert.match(flow, /const openInventory = useCallback\([\s\S]{0,180}?setInventoryOpen\(true\)/);
  assert.match(flow, /paused=\{shopOpen \|\| inventoryOpen\}/);
});

test("plaza inventory keyboard handling is repeat-safe, shop-safe, and bubble-phase", async () => {
  const flow = await source("app/GameEntryFlow.tsx");
  const keyHandlerMatch = flow.match(
    /const (?:onKeyDown|handleKeyDown|handlePlazaKeyDown|handlePlazaInventoryKeyDown|handlePlazaInventoryKey) = \(event: KeyboardEvent\) => \{([\s\S]*?)\n\s*\};[\s\S]{0,420}?window\.addEventListener\(["']keydown["'],\s*\w+\);/,
  );
  assert.ok(keyHandlerMatch, "the plaza inventory needs one ordinary window keydown listener");
  const keyHandler = keyHandlerMatch[1];

  assert.match(
    keyHandler,
    /(?:shopOpen[\s\S]{0,100}?event\.repeat|event\.repeat[\s\S]{0,100}?shopOpen)/,
    "shop and repeated key presses must not toggle the plaza inventory",
  );
  assert.match(
    keyHandler,
    /key === ["']i["'][\s\S]{0,220}?setInventoryOpen\(/,
    "I must toggle the plaza inventory",
  );
  assert.match(
    keyHandler,
    /key === ["'](?:escape|Escape)["'][\s\S]{0,180}?inventoryOpen[\s\S]{0,180}?setInventoryOpen\(false\)/,
    "Escape must close an open plaza inventory",
  );
  assert.doesNotMatch(
    flow,
    /window\.addEventListener\(["']keydown["'],\s*\w+,\s*true\)/,
    "the parent listener must remain in bubble phase so inventory dialogs can consume Escape first",
  );
  assert.match(
    flow,
    /setInventoryOpen\(false\)[\s\S]{0,500}?setSelection\(null\)/,
    "leaving the selected character must clear the plaza overlay",
  );
});

test("read-only inventory preserves inspection while hiding every mutation surface", async () => {
  const overlay = await source("app/InventoryOverlay.tsx");

  assert.match(overlay, /readOnly\?: boolean;/);
  assert.match(overlay, /readOnly = false,/);

  const doubleClickHandlers = [...overlay.matchAll(/onDoubleClick=\{\(\) => \{/g)];
  assert.equal(doubleClickHandlers.length, 2, "equipped and backpack items need explicit double-click handlers");
  for (const handler of doubleClickHandlers) {
    assert.match(
      overlay.slice(handler.index, handler.index + 240),
      /readOnly/,
      "read-only mode must block both equip and unequip double-click gestures",
    );
  }

  assert.match(
    overlay,
    /className="inventory-screen-capacity-actions"[\s\S]{0,420}?\{!readOnly && \(\s*<button type="button" onClick=\{onOpenShop\}>/,
    "inspection mode must hide the paid backpack-expansion action",
  );
  assert.match(
    overlay,
    /\{!readOnly && (?:\(|)\s*<div\s+className=\{`inventory-screen-batch-toolbar/,
    "inspection mode must hide batch and automatic salvage controls",
  );
  assert.match(
    overlay,
    /\{!readOnly && (?:\(|)\s*<div className="inventory-screen-detail-actions-column">[\s\S]{0,6000}?className="inventory-screen-enhancement"[\s\S]{0,6000}?selectedIsEquipped \? \(/,
    "inspection mode must hide enhancement, equip, unequip, and single-salvage actions together",
  );
  assert.match(
    overlay,
    /INVENTORY_SORT_OPTIONS\.map\(\(option\) =>/,
    "sorting must remain available while inspecting",
  );
  assert.match(
    overlay,
    /!salvageModeActive && hoveredItem[\s\S]{0,160}?createPortal\(/,
    "tooltips must remain available while inspecting",
  );
});
