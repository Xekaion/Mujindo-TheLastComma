import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

const root = process.cwd();
const readSource = (file) => readFile(path.join(root, file), "utf8");

const asDataModule = (source) =>
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;

async function importCharacterMarketModules() {
  const compile = (source, fileName) => ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName,
  }).outputText;
  const [equipmentSource, saveSource, characterSource] = await Promise.all([
    readSource("app/equipment.ts"),
    readSource("app/save-slots.ts"),
    readSource("app/market/character-market.ts"),
  ]);
  const equipmentUrl = asDataModule(compile(equipmentSource, "app/equipment.ts"));
  const saveUrl = asDataModule(compile(saveSource, "app/save-slots.ts"));
  const characterOutput = compile(characterSource, "app/market/character-market.ts")
    .replaceAll('"../equipment"', JSON.stringify(equipmentUrl))
    .replaceAll('"../save-slots"', JSON.stringify(saveUrl));
  return Promise.all([
    import(equipmentUrl),
    import(saveUrl),
    import(asDataModule(characterOutput)),
  ]);
}

class MemoryStorage {
  values = new Map();
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

test("character market adapter reads the selected bag and removes only server-imported gear", async () => {
  const [equipment, saveSlots, characterMarket] = await importCharacterMarketModules();
  const storage = new MemoryStorage();
  const bagItem = equipment.rollGear("market-bag-item", {
    level: 70,
    slot: "weapon",
    rarity: "legendary",
  });
  const equippedItem = equipment.rollGear("market-equipped-item", {
    level: 70,
    slot: "helm",
    rarity: "epic",
  });
  const makeSave = (inventory) => ({
    savedAt: 1,
    player: {
      level: 90,
      augments: {},
      inventory,
      equipment: { weapon: null, helm: equippedItem },
    },
  });

  storage.setItem(saveSlots.ACTIVE_SAVE_SLOT_KEY, "2");
  storage.setItem(
    saveSlots.saveSlotKey(2),
    JSON.stringify(makeSave([bagItem, bagItem, { id: "broken" }])),
  );
  assert.equal(characterMarket.resolveCharacterMarketSlot("?slot=2", storage), 2);
  assert.equal(characterMarket.resolveCharacterMarketSlot("?slot=99", storage), 2);

  const inventory = characterMarket.readCharacterMarketInventory(2, storage);
  assert.deepEqual(inventory.items.map((item) => item.id), [bagItem.id]);
  assert.equal(inventory.equippedCount, 1);
  assert.equal(inventory.invalidCount, 2);
  assert.equal(
    characterMarket.removeCharacterMarketItem(2, "gear-not-present", storage),
    "missing",
  );
  assert.equal(
    characterMarket.removeCharacterMarketItem(2, bagItem.id, storage),
    "removed",
  );
  assert.equal(
    characterMarket.readCharacterMarketInventory(2, storage).items.length,
    0,
  );

  storage.setItem(saveSlots.saveSlotKey(1), JSON.stringify(makeSave([bagItem])));
  storage.setItem(saveSlots.saveSlotKey(2), JSON.stringify(makeSave([bagItem])));
  storage.setItem(
    saveSlots.saveSlotKey(3),
    JSON.stringify({
      ...makeSave([]),
      player: { ...makeSave([]).player, equipment: { weapon: bagItem } },
    }),
  );
  const reconciliation = characterMarket.reconcileImportedCharacterItems(
    [bagItem.id],
    storage,
  );
  assert.deepEqual(reconciliation.removedItemIds, [bagItem.id]);
  assert.deepEqual(reconciliation.failedSlots, []);
  assert.equal(characterMarket.readCharacterMarketInventory(1, storage).items.length, 0);
  assert.equal(characterMarket.readCharacterMarketInventory(2, storage).items.length, 0);
  assert.equal(saveSlots.readSaveSlot(3, storage).player.equipment.weapon, null);
});

test("memory market exposes all four server-backed economy surfaces", async () => {
  const [page, board, css] = await Promise.all([
    readSource("app/market/page.tsx"),
    readSource("app/market/MarketBoard.tsx"),
    readSource("app/market/market.css"),
  ]);

  assert.match(page, /<MarketBoard/);
  for (const label of ["장비 경매장", "금괴 교환소", "금괴 충전", "보안센터"]) {
    assert.match(board, new RegExp(label));
  }
  assert.match(board, /role="tablist"/);
  assert.match(board, /role="tabpanel"/);
  assert.match(board, /role="alertdialog"/);
  assert.match(board, /aria-modal="true"/);
  assert.doesNotMatch(board, /window\.(?:alert|confirm)\s*\(/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /@container game-viewport \(max-width: 840px\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});

test("market tabs and trade confirmations are fully keyboard contained", async () => {
  const board = await readSource("app/market/MarketBoard.tsx");

  assert.match(board, /tabIndex=\{tab === entry\.id \? 0 : -1\}/);
  assert.match(board, /onKeyDown=\{\(event\) => handleTabKeyDown\(event, index\)\}/);
  assert.match(board, /event\.key === "ArrowRight"[\s\S]{0,120}?currentIndex \+ 1/);
  assert.match(board, /event\.key === "ArrowLeft"[\s\S]{0,140}?currentIndex - 1 \+ TABS\.length/);
  assert.match(board, /event\.key === "Home"[\s\S]{0,80}?nextIndex = 0/);
  assert.match(board, /event\.key === "End"[\s\S]{0,100}?nextIndex = TABS\.length - 1/);
  assert.match(board, /changeTab\(nextTab\.id\)/);
  assert.match(board, /tabRefs\.current\[nextIndex\]\?\.focus\(\{ preventScroll: true \}\)/);

  assert.match(board, /const MODAL_FOCUSABLE_SELECTOR/);
  assert.match(board, /confirmationOpenerRef\.current = document\.activeElement instanceof HTMLElement/);
  assert.match(board, /ref=\{confirmationDialogRef\}[\s\S]{0,180}?role="alertdialog"[\s\S]{0,180}?tabIndex=\{-1\}/);
  assert.match(board, /event\.key !== "Tab"/);
  assert.match(board, /event\.shiftKey && \(active === first \|\| !dialog\.contains\(active\)\)/);
  assert.match(board, /!event\.shiftKey && \(active === last \|\| !dialog\.contains\(active\)\)/);
  assert.match(board, /window\.addEventListener\("keydown", handleDialogKey, true\)/);
  assert.match(board, /pendingFocusRestoreRef\.current = confirmationOpenerRef\.current/);
  assert.match(board, /if \(confirmation \|\| working \|\| !pendingFocusRestoreRef\.current\) return/);
  assert.match(board, /opener\?\.isConnected && !openerDisabled[\s\S]{0,100}?opener\.focus\(\{ preventScroll: true \}\)/);
  assert.match(board, /tabRefs\.current\[activeTabIndex\]\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(board, /event\.key === "Escape"[\s\S]{0,100}?setConfirmation\(null\)/);
});

test("market polling and write commands follow the authoritative protocol", async () => {
  const [client, protocol, board] = await Promise.all([
    readSource("app/economy-client.ts"),
    readSource("app/economy-protocol.ts"),
    readSource("app/market/MarketBoard.tsx"),
  ]);

  assert.match(client, /ECONOMY_POLL_INTERVAL_MS = 5_000/);
  for (const endpoint of [
    "/api/economy/snapshot",
    "/api/economy/market",
    "/api/economy/command",
    "/api/economy/auth/steam/start",
    "/api/economy/payments/steam/init",
    "/api/economy/payments/steam/finalize",
  ]) {
    assert.match(client, new RegExp(endpoint.replaceAll("/", "\\/")));
  }
  assert.match(client, /"x-mujindo-dev-user"/);
  assert.match(client, /computeEconomyCommandHash/);
  assert.match(client, /computeCanonicalRequestHash/);
  for (const action of [
    "list_item",
    "buy_listing",
    "cancel_listing",
    "place_exchange",
    "fill_exchange",
    "cancel_exchange",
    "sandbox_topup",
  ]) {
    assert.match(client, new RegExp(`action: "${action}"`));
    assert.match(protocol, new RegExp(`"${action}"`));
  }
  assert.match(board, /expectedItemVersion/);
  assert.match(board, /expectedListingVersion/);
  assert.match(board, /expectedOrderVersion/);
  assert.match(board, /expiresInSeconds/);
  assert.match(board, /nextSnapshot\.listings\.filter\(\(listing\) => listing\.mine\)/);
  assert.match(client, /export async function finalizeSteamGoldPurchase/);
  assert.match(board, /params\.get\("payment_return"\)/);
  assert.match(board, /finalizeSteamGoldPurchase\(paymentOrderId/);
  assert.match(board, /error\.status === 429 \|\| error\.status >= 500/);
  assert.match(board, /if \(clearPaymentReturn && current\.get\("payment_return"\) === paymentOrderId\)/);
  assert.match(board, /current\.delete\("payment_return"\)/);
  assert.match(board, /Steam 승인 거래를 서버에서 검증했습니다/);
});

test("market equipment names show enhancement without mutating trade commands", async () => {
  const board = await readSource("app/market/MarketBoard.tsx");

  assert.match(board, /formatGearDisplayName,[\s\S]{0,80}?getGearRequiredLevel,[\s\S]{0,80}?normalizeGearEnhancement/);
  assert.match(
    board,
    /function formatMarketGearName\(item: MarketVaultItem\)[\s\S]{0,180}?formatGearDisplayName\(item, \{ includeZero: true \}\)/,
    "market names must show the exact enhancement stage from +0 onward",
  );
  assert.match(
    board,
    /function formatMarketGearLevel\(item: MarketVaultItem\)[\s\S]{0,160}?getGearRequiredLevel\(item\)/,
    "auction rows and confirmations must expose the shared -20 equip requirement",
  );
  assert.match(
    board,
    /아이템 레벨 \$\{item\.level\} · 착용 필요 레벨 \$\{getGearRequiredLevel\(item\)\}/,
    "market item descriptions must use the canonical requirement label",
  );
  assert.match(
    board,
    /market-listing-item[\s\S]{0,500}?formatMarketGearName\(listing\.item\)/,
    "auction rows must append the enhancement stage to the visible item name",
  );
  assert.match(
    board,
    /market-vault-list[\s\S]{0,1600}?formatMarketGearName\(candidate\.view\)/,
    "vault rows must use the same display-only name formatter",
  );
  assert.match(
    board,
    /const enhancement = normalizeGearEnhancement\(item\.enhancement\)[\s\S]{0,500}?className="market-item-enhancement">\+\{enhancement\}<\/b>/,
    "auction and vault icons must expose the normalized enhancement stage, including +0",
  );
  assert.match(
    board,
    /<ItemIcon item=\{listing\.item\} compact \/>[\s\S]{0,250}?formatMarketGearName\(listing\.item\)/,
    "auction listings must show enhancement on both the icon and the item name",
  );
  assert.match(
    board,
    /<ItemIcon item=\{candidate\.view\} compact \/>[\s\S]{0,400}?formatMarketGearName\(candidate\.view\)/,
    "character-bag and vault sale entries must show enhancement on both the icon and the item name",
  );
  assert.match(
    board,
    /\{ action: "list_item", itemId: confirmation\.candidate\.view\.itemId, priceAsh: confirmation\.priceAsh,[\s\S]{0,180}?expectedItemVersion: confirmation\.candidate\.view\.version \}/,
    "listing writes must remain ID/version based instead of persisting a formatted name",
  );
  assert.doesNotMatch(
    board,
    /\{ action: "list_item"[^}]*displayName/,
    "presentation-only enhancement suffixes must never enter the trade command payload",
  );
});

test("trade UI atomically transfers active character inventory and gates live writes", async () => {
  const [client, board, characterMarket, protocol, worker] = await Promise.all([
    readSource("app/economy-client.ts"),
    readSource("app/market/MarketBoard.tsx"),
    readSource("app/market/character-market.ts"),
    readSource("app/economy-protocol.ts"),
    readSource("worker/economy-d1.ts"),
  ]);

  assert.match(client, /never reads or mutates a local save file itself/i);
  assert.doesNotMatch(client, /localStorage|readSaveSlot|readActiveSaveSlot/);
  assert.match(characterMarket, /resolveCharacterMarketSlot/);
  assert.match(characterMarket, /new URLSearchParams\(search\)\.get\("slot"\)/);
  assert.match(characterMarket, /readActiveSaveSlot\(storage\)/);
  assert.match(characterMarket, /readSaveSlot\(slot, storage\)/);
  assert.match(characterMarket, /normalizeGearItem\(value\)/);
  assert.match(characterMarket, /writeSaveSlot\(/);
  assert.match(characterMarket, /reconcileImportedCharacterItems/);
  assert.match(characterMarket, /SAVE_SLOT_IDS/);
  assert.match(board, /source: "character"/);
  assert.match(board, /characterItem: gearItemToEconomyPayload\(candidate\.gear\)/);
  assert.match(board, /sourceSaveSlot: candidate\.saveSlot/);
  assert.match(board, /removeCharacterMarketItem\([\s\S]{0,120}?candidate\.gear\.id/);
  assert.match(board, /reconcileImportedCharacterItems\([\s\S]{0,100}?nextSnapshot\.importedCharacterItemIds/);
  assert.match(board, /실패하면 가방 장비는 그대로 유지/);
  assert.match(board, /장착 중인 장비[\s\S]{0,100}?먼저 해제/);
  assert.match(protocol, /export type ListCharacterItemCommand/);
  assert.match(protocol, /value\.expectedItemVersion !== 0/);
  assert.match(worker, /normalizeGearItem\(command\.characterItem\)/);
  assert.match(worker, /await db\.batch\(\[[\s\S]{0,900}?INSERT INTO economy_items[\s\S]{0,900}?commandInsert/);
  assert.match(worker, /importedCharacterItemIds/);
  assert.match(board, /snapshot\.account\.steamLinked/);
  assert.match(board, /snapshot\.account\.gameOwned/);
  assert.match(board, /snapshot\.account\.restricted/);
  assert.match(board, /snapshot\.capabilities\.canTrade/);
  assert.match(board, /snapshot\.featureMode/);
  assert.match(board, /snapshot\.paymentMode/);
  assert.match(board, /localSandbox/);
  assert.match(board, /disabled=\{!tradeEnabled/);
  assert.match(board, /disabled=\{!goldEnabled/);
  assert.match(board, /disabled=\{!chargeEnabled/);
});

test("wallet, enforcement, legal review, and local A/B tooling are visible", async () => {
  const board = await readSource("app/market/MarketBoard.tsx");

  for (const copy of [
    "거래 보관",
    "72시간 잠금",
    "내부 사용자 ID",
    "즉시 동결·추적",
    "Steam은 로그인 증명",
    "한국 정식 출시 전 필수 검토",
    "법률·게임물 등급분류·청소년 보호·전자상거래·환불 정책 검토",
    "LOCALHOST ONLY",
  ]) {
    assert.match(board, new RegExp(copy.replaceAll("·", "\\·")));
  }
  assert.match(board, /\(\["A", "B"\] as const\)/);
  assert.match(board, />유저 \{user\}<\/button>/);
});

test("title and shop both link into the market", async () => {
  const [game, shop, css] = await Promise.all([
    readSource("app/GameCanvas.tsx"),
    readSource("app/ShopOverlay.tsx"),
    readSource("app/game.css"),
  ]);

  assert.match(game, /className="menu-market-action" href="\/market"/);
  assert.match(shop, /className="shop-market-entry"[\s\S]{0,80}?href="\/market\?tab=gold"/);
  assert.match(shop, /className="shop-header-market"[\s\S]{0,80}?href="\/market\?tab=gold"/);
  assert.match(css, /\.menu-market-action/);
  assert.match(css, /\.shop-market-entry/);
  assert.match(css, /\.shop-header-market/);
});
