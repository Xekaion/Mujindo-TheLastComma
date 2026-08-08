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
  assert.match(flow, /paused=\{shopOpen\}/);
  assert.match(plaza, /pausedRef\.current/);
  assert.match(plaza, /inert=\{paused\}/);
});
