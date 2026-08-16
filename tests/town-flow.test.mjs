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

test("the plaza binds selected save visuals and keeps floor claims inside character profiles", async () => {
  const [flow, plaza] = await Promise.all([
    source("app/GameEntryFlow.tsx"),
    source("app/PlazaHub.tsx"),
  ]);

  assert.match(flow, /readSaveSlot\(selection\.slot\)/);
  assert.match(
    flow,
    /reconcileEquipmentLevelRequirements\(\s*savedCharacter\?\.player\.level \?\? 1,\s*savedCharacter\?\.player\.equipment,\s*savedCharacter\?\.player\.inventory/,
  );
  assert.match(flow, /client\.enter\(\{/);
  assert.match(flow, /characterSlot: selection\.slot/);
  assert.match(flow, /savedCharacter\?\.world\?\.dungeonFloor/);
  assert.match(flow, /dungeonFloor,/);
  assert.match(flow, /dungeonFloor: self\?\.dungeonFloor \?\? dungeonFloor/);
  assert.match(flow, /appearance: publishedProfile\.appearance/);
  assert.match(
    flow,
    /getMemoryPlazaClient\(\)\.updateAppearance\(\s*hubAppearance,\s*level,\s*dungeonFloor,\s*publicEquipment/,
    "equipment profile changes must patch the live plaza session",
  );
  assert.match(
    flow,
    /\}, \[arrival, displayName, selection, view\]\);/,
    "equipment profile changes must not tear down and recreate the plaza session",
  );
  assert.match(flow, /snapshot\.nearbyPlayers|hubSnapshot\?\.nearbyPlayers/);
  assert.match(flow, /localAuthoritativePosition=/);
  assert.match(flow, /getMemoryPlazaClient\(\)\.setMoveIntent/);
  assert.match(flow, /equipment=\{equipment\}/);
  assert.match(flow, /getMemoryPlazaClient\(\)\.queueDash\(\)/);
  assert.match(flow, /onDashIntent=\{dashInPlaza\}/);
  assert.doesNotMatch(flow, /setMoveIntent\(\{[^}]*\b(?:x|y|speed|teleport)\s*:/s);
  assert.doesNotMatch(
    flow,
    /client\.enter\(\{[\s\S]{0,500}?legendaryPowerId/,
    "local legendary powers must not be published in the shared hub profile",
  );
  assert.match(plaza, /`\$\{player\.displayName\} · LV\.\$\{player\.level\}`/);
  const drawPlayerBlock = plaza.slice(
    plaza.indexOf("function drawPlayer("),
    plaza.indexOf("function connectionLabel("),
  );
  assert.doesNotMatch(drawPlayerBlock, /dungeonFloor|기록 심도|지하/);
  assert.match(plaza, /onContextMenu=\{handleCanvasContextMenu\}/);
  assert.match(plaza, /onPlayerInspectRef\.current\?\.\(player\)/);
});

test("right-click character inspection publishes only canonical equipped gear", async () => {
  const [flow, profile, protocol, server] = await Promise.all([
    source("app/GameEntryFlow.tsx"),
    source("app/PlazaCharacterProfile.tsx"),
    source("app/hub-protocol.ts"),
    source("worker/hub-d1.ts"),
  ]);

  assert.match(flow, /hubPublicEquipmentFromLoadout\(equipment\)/);
  assert.match(flow, /publicEquipment,/);
  assert.match(flow, /inspectCharacterProfile\(player\.characterId\)/);
  assert.match(flow, /onPlayerInspect=\{inspectRemoteCharacter\}/);
  assert.match(flow, /onSelfInspect=\{inspectSelfCharacter\}/);
  assert.match(flow, /<PlazaCharacterProfile/);
  assert.match(profile, /지하 \{dungeonFloor\.toLocaleString\("ko-KR"\)\}층/);
  assert.match(profile, /EQUIPMENT_SLOTS\.map\(\(slot\) =>/);
  assert.match(profile, /InventoryPaperdollFigure equipment=\{equipment\}/);
  assert.match(profile, /getGearRequiredLevel\(item\)/);
  assert.match(
    profile,
    /아이템 레벨 \{item\.level\} · 착용 필요 레벨 \{getGearRequiredLevel\(item\)\}/,
  );
  assert.match(profile, /reconcileEquipmentLevelRequirements\(\s*profile\?\.level \?\? 1/);
  assert.match(profile, /role="dialog"/);
  assert.match(profile, /aria-modal="true"/);
  assert.match(protocol, /type HubPublicGearItem = \{/);
  assert.doesNotMatch(
    protocol.slice(
      protocol.indexOf("export type HubPublicGearItem"),
      protocol.indexOf("export type HubPublicEquipment"),
    ),
    /\bid:|trade|owner|account/,
  );
  assert.match(server, /route === "\/api\/hub\/profile"/);
  assert.match(server, /HUB_NEARBY_RADIUS \* HUB_NEARBY_RADIUS/);
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
  assert.match(flow, /paused=\{shopOpen \|\| inventoryOpen \|\| profileState !== null\}/);
  assert.match(plaza, /pausedRef\.current/);
  assert.match(plaza, /inert=\{paused\}/);
});

test("I opens the selected plaza character inventory in manage mode", async () => {
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
    /reconcileEquipmentLevelRequirements\(\s*savedCharacter\?\.player\.level \?\? 1,\s*savedCharacter\?\.player\.equipment,\s*savedCharacter\?\.player\.inventory/,
    "plaza inventory entries must be normalized from the selected save",
  );
  assert.match(flow, /inventoryCapacityFor\(readShopEntitlements\(\)\)/);
  assert.match(flow, /calculateEquipmentCombatPower\(equipment\)/);
  assert.match(
    flow,
    /\{inventoryOpen && \(\s*<InventoryOverlay\s+open\s+equipment=/,
    "the plaza must mount the production inventory surface only while it is open",
  );
  const overlayProps = flow.match(/<InventoryOverlay([\s\S]*?)\/>/);
  assert.ok(overlayProps, "the plaza inventory component must be rendered");
  assert.doesNotMatch(
    overlayProps[1],
    /\breadOnly\b/,
    "the selected plaza character must open inventory in manage mode",
  );
  assert.match(overlayProps[1], /equipment=\{equipment\}/);
  assert.match(overlayProps[1], /inventory=\{inventory\}/);
  assert.match(overlayProps[1], /inventoryCapacity=\{inventoryCapacity\}/);
  assert.match(overlayProps[1], /selectedGearId=\{selectedGearId\}/);
  assert.match(overlayProps[1], /memoryAsh=\{memoryAsh\}/);
  assert.match(overlayProps[1], /equippedPower=\{equippedPower\}/);
  assert.match(
    overlayProps[1],
    /autoSalvageMaxRarity=\{autoSalvageMaxRarity\}/,
  );
  assert.match(overlayProps[1], /operationNotice=\{plazaInventoryNotice\}/);

  for (const prop of [
    "onEquip",
    "onUnequip",
    "onSalvage",
    "onSalvageMany",
    "onAutoSalvageMaxRarityChange",
    "onEnhance",
    "onDivineForgeReroll",
  ]) {
    assert.match(
      overlayProps[1],
      new RegExp(`\\b${prop}=\\{[A-Za-z_$][\\w$]*\\}`),
      `${prop} must use a concrete save-backed plaza callback`,
    );
  }
  assert.doesNotMatch(
    overlayProps[1],
    /\b(?:onEquip|onUnequip|onEnhance|onSalvage|onSalvageMany|onDivineForgeReroll)=\{\([^)]*\)\s*=>\s*(?:undefined|null)\}/,
    "plaza inventory callbacks must never be no-op placeholders",
  );

  assert.match(
    flow,
    /const commitPlazaEquipment = useCallback\([\s\S]{0,1200}?writeSaveSlot\(selection\.slot, nextSave\)[\s\S]{0,500}?setSaveRevision\(\(revision\) => revision \+ 1\)/,
    "plaza equipment mutations must commit to the selected save slot before refreshing the view",
  );
  assert.match(
    flow,
    /const nextSave: SaveRunPayload = \{[\s\S]{0,420}?expeditionPowerRatingVersion:\s*undefined/,
    "plaza equipment mutations must invalidate the cached expedition combat rating",
  );
  assert.match(flow, /writeAutoSalvagePreference\(selection\.slot, normalized\)/);
  assert.match(flow, /className="game-confirmation-dialog is-danger"/);
  assert.doesNotMatch(flow, /window\.(?:alert|confirm|prompt)\s*\(/);

  assert.match(plaza, /onInventoryOpen\?: \(\) => void;/);
  assert.match(plaza, /onClick=\{onInventoryOpen\}/);
  assert.match(plaza, /<kbd>I<\/kbd>/);
  assert.match(flow, /onInventoryOpen=\{openInventory\}/);
  assert.match(flow, /const openInventory = useCallback\([\s\S]{0,320}?setInventoryOpen\(true\)/);
  assert.match(flow, /paused=\{shopOpen \|\| inventoryOpen \|\| profileState !== null\}/);
});

test("plaza inventory keyboard handling is repeat-safe, shop-safe, and bubble-phase", async () => {
  const flow = await source("app/GameEntryFlow.tsx");
  const keyHandlerMatch = flow.match(
    /const (?:onKeyDown|handleKeyDown|handlePlazaKeyDown|handlePlazaInventoryKeyDown|handlePlazaInventoryKey) = \(event: KeyboardEvent\) => \{([\s\S]*?)\n\s*\};[\s\S]{0,420}?window\.addEventListener\(["']keydown["'],\s*\w+\);/,
  );
  assert.ok(keyHandlerMatch, "the plaza inventory needs one ordinary window keydown listener");
  const keyHandler = keyHandlerMatch[1];

  assert.match(keyHandler, /event\.repeat/, "repeated key presses must be ignored");
  assert.match(keyHandler, /shopOpen/, "the shop must block inventory toggles");
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
  const guardedDetailActions = overlay.match(
    /\{!readOnly && \(\s*(<div className="inventory-screen-detail-actions-column">[\s\S]*?<\/div>)\s*\)\}\s*<\/div>\s*<\/div>\s*\)\s*:\s*\(/,
  );
  assert.ok(
    guardedDetailActions,
    "inspection mode must place the entire detail-action column behind one read-only guard",
  );
  for (const mutationSurface of [
    /className="inventory-screen-enhancement"/,
    /onClick=\{\(\) => onEnhance\(selectedItem\.id\)\}/,
    /selectedIsEquipped \? \(/,
    /onClick=\{\(\) => unequipItem\(selectedItem\.slot\)\}/,
    /onClick=\{\(\) => equipItem\(selectedItem\.id\)\}/,
    /onClick=\{\(\) => requestSalvageOne\(selectedItem\.id\)\}/,
  ]) {
    assert.match(
      guardedDetailActions[1],
      mutationSurface,
      "inspection mode must hide enhancement, equip, unequip, and single-salvage actions together",
    );
  }
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
