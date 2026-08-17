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

function sourceSlice(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `missing source marker: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `missing source marker: ${end}`);
  return source.slice(startIndex, endIndex);
}

async function importMarketItemFingerprint() {
  const board = await readSource("app/market/MarketBoard.tsx");
  const fingerprintSource = sourceSlice(
    board,
    "function marketItemFingerprint",
    "function ListingRow",
  ).replace(
    "function marketItemFingerprint",
    "export function marketItemFingerprint",
  );
  const output = ts.transpileModule(
    `function normalizeGearEnhancement(value: number): number { return Math.max(0, Math.trunc(value)); }\n${fingerprintSource}`,
    {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      fileName: "market-item-fingerprint.ts",
    },
  ).outputText;
  return import(asDataModule(output));
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

test("gold currency uses authored bitmap art instead of CSS bars or surrogate glyphs", async () => {
  const [board, css] = await Promise.all([
    readSource("app/market/MarketBoard.tsx"),
    readSource("app/market/market.css"),
  ]);

  assert.match(board, /MARKET_GOLD_INGOT_STACK_SRC = "\/assets\/ui\/market\/gold-ingot-stack-v1\.png"/);
  assert.match(board, /MARKET_GOLD_INGOT_TOKEN_SRC = "\/assets\/ui\/market\/gold-ingot-token-v1\.png"/);
  assert.match(board, /<img className="market-gold-stack" src=\{MARKET_GOLD_INGOT_STACK_SRC\}/);
  assert.match(board, /function GoldIngotIcon/);
  assert.match(board, /<GoldIngotIcon className="market-pack-ingot"/);
  assert.match(board, /<GoldAmount>/);
  assert.doesNotMatch(board, /▰/);
  assert.doesNotMatch(board, /className="market-gold-stack"[^>]*>\s*<i/);
  assert.match(css, /\.market-gold-stack\s*\{[^}]*object-fit:\s*contain/s);
  assert.match(css, /\.market-pack-ingot\s*\{[^}]*object-fit:\s*contain/s);
  assert.match(css, /\.market-balance-gold-icon\s*\{[^}]*object-fit:\s*contain/s);
  assert.doesNotMatch(css, /\.market-gold-stack\s+i\s*\{/);
  assert.doesNotMatch(css, /\.market-gold-stack[^}]*skewX/);
});

test("equipment auction uses one full-width five-view workspace instead of a browse-sell split", async () => {
  const [board, css] = await Promise.all([
    readSource("app/market/MarketBoard.tsx"),
    readSource("app/market/market.css"),
  ]);

  for (const [id, label] of [
    ["search", "장비 검색"],
    ["price", "시세 조회"],
    ["favorites", "관심 목록"],
    ["sell", "판매 등록"],
    ["complete", "거래 완료"],
  ]) {
    assert.match(board, new RegExp(`id: "${id}", label: "${label}"`));
    assert.match(board, new RegExp(`market-auction-view-${id}`));
  }
  assert.match(board, /AUCTION_VIEWS\.map\(\(view, index\) =>/);
  assert.match(css, /\.market-auction-tabs\s*\{[^}]*grid-template-columns:\s*repeat\(5,/s);
  assert.doesNotMatch(board, /<aside\b[^>]*className="market-vault/);
  assert.doesNotMatch(board, /className="market-auction-layout"/);
  assert.doesNotMatch(css, /\.market-auction-layout\s*\{[^}]*grid-template-columns/s);
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
  assert.match(board, /event\.key === "Escape"[\s\S]{0,100}?event\.preventDefault\(\)[\s\S]{0,100}?if \(workingRef\.current\) return[\s\S]{0,100}?setConfirmation\(null\)/);
  assert.match(board, /event\.target === event\.currentTarget && !workingRef\.current[\s\S]{0,80}?setConfirmation\(null\)/);
  assert.match(board, /if \(!workingRef\.current\) setConfirmation\(null\)/);
  assert.match(board, /aria-busy=\{working\}/);
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
  assert.match(board, /new Set\(nextSnapshot\.myListings\.map\(\(listing\) => listing\.listingId\)\)/);
  assert.match(client, /export async function finalizeSteamGoldPurchase/);
  assert.match(board, /params\.get\("payment_return"\)/);
  assert.match(board, /finalizeSteamGoldPurchase\(paymentOrderId/);
  assert.match(board, /error\.status === 429[\s\S]{0,80}?error\.status >= 500/);
  assert.match(board, /if \(clearPaymentReturn && current\.get\("payment_return"\) === paymentOrderId\)/);
  assert.match(board, /current\.delete\("payment_return"\)/);
  assert.doesNotMatch(board, /Steam 승인 거래를 서버에서 검증했습니다/);
  assert.match(board, /금괴 충전이 완료되었습니다/);
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

test("trade UI limits character-payload listing to local sandbox and gates live writes", async () => {
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
  assert.match(board, /등록되지 않으면 가방 장비는 그대로 유지|가방의 장비는 그대로 보존/);
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
  assert.match(board, /snapshot\.paymentMode/);
  assert.match(board, /const localSandbox = Boolean\(local && snapshot\?\.capabilities\.localSandbox\)/);
  assert.match(board, /const characterCandidates: SellCandidate\[\] = \(localSandbox \? characterInventory\.items : \[\]\)/);
  assert.match(board, /\{localSandbox && <button[\s\S]{0,300}?setSellSource\("character"\)/);
  assert.match(board, /거래 금고 장비만 등록할 수 있습니다/);
  assert.match(board, /안전한 보관 확인 기능이 준비된 뒤 지원/);
  assert.match(board, /disabled=\{!tradeEnabled/);
  assert.match(board, /disabled=\{!goldEnabled/);
  assert.match(board, /disabled=\{!chargeEnabled/);
});

test("release UI hides developer, approval, and local A/B copy while sandbox protocol remains guarded", async () => {
  const [board, client, protocol] = await Promise.all([
    readSource("app/market/MarketBoard.tsx"),
    readSource("app/economy-client.ts"),
    readSource("app/economy-protocol.ts"),
  ]);

  for (const copy of [
    "Steam 승인 거래를 서버에서 검증했습니다",
    "내부 사용자 ID",
    "한국 정식 출시 전 필수 검토",
    "법률·게임물 등급분류·청소년 보호·전자상거래·환불 정책 검토",
    "LOCALHOST ONLY",
    "A/B 스위치",
    "테스트용",
    "개발자",
    "서버 금고",
    "서버 등록",
    "서버가 남은 수량",
    "서버 영수증 검증",
  ]) {
    assert.doesNotMatch(board, new RegExp(copy.replaceAll("·", "\\·")));
  }
  assert.doesNotMatch(board, /\(\["A", "B"\] as const\)/);
  assert.doesNotMatch(board, />유저 \{user\}<\/button>/);
  assert.doesNotMatch(board, /sandbox_topup/);
  assert.doesNotMatch(board, /<span>\{entry\.category\}<\/span>/);
  assert.doesNotMatch(board, /<strong>\{entry\.message\}<\/strong>/);
  assert.doesNotMatch(board, /<code>\{entry\.id\}<\/code>/);

  assert.match(client, /"x-mujindo-dev-user"/);
  assert.match(client, /action: "sandbox_topup"/);
  assert.match(protocol, /"sandbox_topup"/);
  assert.match(board, /local && snapshot\?\.capabilities\.localSandbox/);
});

test("filtered market results preserve a successful empty response and expose endpoint failure separately", async () => {
  const [board, css] = await Promise.all([
    readSource("app/market/MarketBoard.tsx"),
    readSource("app/market/market.css"),
  ]);
  const refreshFlow = sourceSlice(
    board,
    "const [snapshotResult, listingsResult",
    "setLastSyncAt(new Date())",
  );

  assert.match(refreshFlow, /listingsResult\.status === "fulfilled"[\s\S]{0,120}?listingsResult\.value[\s\S]{0,80}?: \[\]/);
  assert.match(refreshFlow, /setListings\(nextListings\)/);
  assert.doesNotMatch(refreshFlow, /nextListings\.length\s*>\s*0/);
  assert.doesNotMatch(refreshFlow, /nextSnapshot\.listings\s*\)/);
  assert.match(refreshFlow, /setMarketSearchError\(listingsFailure/);
  assert.doesNotMatch(refreshFlow, /listingsFailure\.message/);

  assert.match(board, /function MarketSearchErrorState[\s\S]{0,500}?className="market-search-error"[\s\S]{0,500}?다시 검색/);
  assert.match(board, /marketSearchError\s*\?[\s\S]{0,300}?<MarketSearchErrorState[\s\S]{0,300}?: listings\.length === 0[\s\S]{0,300}?조건에 맞는 매물이 없습니다/);
  assert.match(css, /\.market-search-error\b/);
  assert.match(css, /\.market-search-error\s+button\b|\.market-search-error[^\n{]*button\b/);

  const priceView = sourceSlice(board, 'auctionView === "price"', 'auctionView === "favorites"');
  assert.match(priceView, /marketSearchError/);
  assert.match(priceView, /<MarketSearchErrorState message=\{marketSearchError\} onRetry=\{\(\) => void refresh\(false\)\}/);
});

test("market loading, result, empty, and retry states are announced accessibly", async () => {
  const board = await readSource("app/market/MarketBoard.tsx");
  const searchView = sourceSlice(
    board,
    'id="market-auction-view-search"',
    'auctionView === "price"',
  );

  assert.match(searchView, /aria-busy=\{refreshing\}/);
  assert.match(searchView, /aria-live="polite"/);
  assert.match(searchView, /role="status"/);
  assert.match(searchView, /listings\.length/);
  assert.match(searchView, /<MarketSearchErrorState message=\{marketSearchError\} onRetry=\{\(\) => void refresh\(false\)\}/);
  const errorState = sourceSlice(board, "function MarketSearchErrorState", "function MarketItemDetails");
  assert.match(errorState, /className="market-search-error"[^>]*role="alert"/);
  assert.match(errorState, /<button[^>]*type="button"[^>]*onClick=\{onRetry\}[^>]*>다시 검색<\/button>/);
});

test("unauthenticated snapshot failure offers a Steam account start path", async () => {
  const board = await readSource("app/market/MarketBoard.tsx");

  assert.match(board, /const handleUnauthorized = useCallback\([\s\S]{0,700}?setConfirmation\(null\)[\s\S]{0,300}?setSnapshot\(null\)[\s\S]{0,300}?setListings\(\[\]\)[\s\S]{0,300}?setFatalError\(\{ status: 401/);
  assert.match(board, /if \(!handleUnauthorized\(error\)\)/);
  assert.match(board, /if \(handleUnauthorized\(error\)\) return/);
  assert.match(board, /fatalError\?\.status === 401|fatalError && fatalError\.status === 401/);
  assert.match(board, /steamLinkUrl\(steamReturnTo\)/);
  assert.match(board, /<a[^>]*href=\{steamLinkUrl\(steamReturnTo\)\}[^>]*>[\s\S]{0,80}?Steam/);
  assert.match(board, /Steam 계정/);
});

test("payment retry and reauthentication preserve the pending Steam return intent", async () => {
  const board = await readSource("app/market/MarketBoard.tsx");
  const paymentFlow = sourceSlice(
    board,
    'const paymentOrderId = params.get("payment_return")',
    "}, [beginWorking, demoUser, finishWorking, handleUnauthorized, paymentRetryNonce]);",
  );

  assert.match(board, /function readSteamMarketReturnTo\(\)[\s\S]{0,320}?payment_return[\s\S]{0,180}?return `\/market\?\$\{params\.toString\(\)\}`/);
  assert.match(paymentFlow, /if \(handleUnauthorized\(error\)\) \{[\s\S]{0,100}?clearPaymentReturn = false/);
  assert.match(paymentFlow, /const retryable = !\(error instanceof EconomyClientError\)/);
  assert.match(paymentFlow, /error\.code === "STEAM_OWNERSHIP_STALE"/);
  assert.match(paymentFlow, /error\.retryable[\s\S]{0,100}?error\.status === 429[\s\S]{0,100}?error\.status >= 500/);
  assert.match(paymentFlow, /clearPaymentReturn = !retryable/);
  assert.match(paymentFlow, /if \(retryable\) \{[\s\S]{0,100}?paymentReturnRef\.current = null[\s\S]{0,100}?setPaymentRetryAvailable\(true\)/);
  assert.match(paymentFlow, /if \(clearPaymentReturn && current\.get\("payment_return"\) === paymentOrderId\)/);
  assert.match(board, /paymentRetryAvailable[\s\S]{0,600}?setPaymentRetryNonce\(\(current\) => current \+ 1\)/);
});

test("market commands are single-flight and keep one idempotency key for the confirmation intent", async () => {
  const [board, client] = await Promise.all([
    readSource("app/market/MarketBoard.tsx"),
    readSource("app/economy-client.ts"),
  ]);

  assert.match(board, /const workingRef = useRef\(false\)/);
  assert.match(board, /const beginWorking = useCallback\(\(\) => \{[\s\S]{0,160}?if \(workingRef\.current\) return false[\s\S]{0,120}?workingRef\.current = true[\s\S]{0,120}?setWorking\(true\)/);
  assert.match(board, /if \(!snapshot \|\| !beginWorking\(\)\) return/);
  assert.match(board, /type Confirmation = ConfirmationIntent & \{ intentKey: string; serverItemId\?: string \}/);
  assert.match(board, /setConfirmation\(\{[\s\S]{0,180}?\.\.\.next[\s\S]{0,180}?intentKey: createEconomyIdempotencyKey\(`market-\$\{next\.kind\}`\)/);
  assert.match(board, /sendEconomyCommand\([\s\S]{0,700}?idempotencyKey: intentKey/);
  assert.match(board, /confirmation\.intentKey/);

  assert.match(client, /idempotencyKey\?: string/);
  assert.match(client, /options\.idempotencyKey \?\? createEconomyIdempotencyKey/);
});

test("favorites and seller inventory stay account-scoped and independent of the current search", async () => {
  const board = await readSource("app/market/MarketBoard.tsx");

  assert.match(board, /function marketFavoritesStorageKey\(ownerKey: string\)[\s\S]{0,120}?MARKET_FAVORITES_STORAGE_KEY[^\n]*ownerKey/);
  assert.match(board, /favoritesOwnerKey = snapshot\?\.account\.userId/);
  assert.match(board, /function readMarketFavorites\(ownerKey: string\)[\s\S]{0,240}?localStorage\.getItem\(marketFavoritesStorageKey\(ownerKey\)\)/);
  assert.match(board, /useMemo\(\s*\(\) => readMarketFavorites\(favoritesOwnerKey\),\s*\[favoritesOwnerKey\],?\s*\)/);
  assert.match(board, /localStorage\.setItem\(marketFavoritesStorageKey\(favoritesOwnerKey\)/);
  assert.match(board, /favoriteListingIds[\s\S]{0,180}?snapshot\?\.listings\.find/);
  assert.match(board, /snapshot\?\.listings\.find[\s\S]{0,180}?listings\.find/);
  const favoriteSelection = sourceSlice(
    board,
    "const selectedListing =",
    "const favoriteListings =",
  );
  assert.match(favoriteSelection, /snapshot\?\.listings\.find[\s\S]{0,180}?listings\.find/);
  assert.match(board, /const ownListings = snapshot\?\.myListings \?\? \[\]/);
  assert.doesNotMatch(board, /const ownListings = useMemo\([\s\S]{0,180}?\blistings\.filter/);
  const refreshedSelection = sourceSlice(
    board,
    "setSelectedListingId((current) => {",
    "setMarketSearchError(",
  );
  assert.match(refreshedSelection, /auctionView === "search"[\s\S]{0,100}?nextListings/);
  assert.match(refreshedSelection, /auctionView === "favorites"[\s\S]{0,140}?\.\.\.nextSnapshot\.listings[\s\S]{0,80}?\.\.\.nextListings/);
  assert.match(refreshedSelection, /auctionView === "sell"[\s\S]{0,100}?nextSnapshot\.myListings/);
  assert.match(board, /selectionSource\.some\([\s\S]{0,120}?\? current : null/);
  assert.match(board, /현재 공개 매물 표본에서 확인할 수 없습니다/);
  assert.match(board, /현재 표본에서 미확인/);
  assert.match(board, />매물 다시 확인<\/button>/);
  assert.doesNotMatch(board, /종료된 관심 매물/);
});

test("selected listing and sale confirmation expose decision-critical equipment and settlement details", async () => {
  const board = await readSource("app/market/MarketBoard.tsx");
  const searchView = sourceSlice(
    board,
    'id="market-auction-view-search"',
    'auctionView === "price"',
  );
  const confirmationCopy = board.slice(board.indexOf("function getConfirmationCopy"));
  const sellConfirmation = sourceSlice(confirmationCopy, 'case "sell":', 'case "order":');
  const fillConfirmation = sourceSlice(confirmationCopy, 'case "fill-order":', 'case "cancel-order":');

  const itemDetails = sourceSlice(board, "function MarketItemDetails", "function ListingRow");
  assert.match(searchView, /<MarketItemDetails item=\{selectedListing\.item\}/);
  assert.match(itemDetails, /className="market-item-details"/);
  for (const label of ["강화 옵션 배분", "전설 고유 능력", "신의 대장간", "품질", "요구 레벨", "강화", "보스 화력"]) {
    assert.match(itemDetails, new RegExp(label));
  }
  assert.match(itemDetails, /item\.affixes/);
  assert.match(itemDetails, /item\.legendaryPowerId/);
  assert.match(itemDetails, /item\.enhancementRanks\[index \+ 1\]/);
  assert.match(itemDetails, /item\.divineForgeRerolls/);
  assert.match(itemDetails, /item\.qualityScore/);
  assert.match(itemDetails, /getGearRequiredLevel\(item\)/);
  assert.match(itemDetails, /normalizeGearEnhancement\(item\.enhancement\)/);
  assert.match(itemDetails, /item\.powerScore/);

  for (const label of ["등록 기간", "7일", "수수료", "예상 수령", "만료", "거래 금고"]) {
    assert.match(sellConfirmation, new RegExp(label));
  }
  for (const label of ["금괴 매수", "금괴 매도", "지출", "수령", "총 기억의 재"]) {
    assert.match(fillConfirmation, new RegExp(label));
  }
  assert.match(fillConfirmation, /confirmation\.order\.side === "sell"/);
  assert.match(fillConfirmation, /confirmation\.goldAmount \* confirmation\.order\.priceAshPerGold/);
});

test("market price view fingerprints exact gear and separates asking prices from completed trades", async () => {
  const [board, fingerprintModule] = await Promise.all([
    readSource("app/market/MarketBoard.tsx"),
    importMarketItemFingerprint(),
  ]);
  const priceGrouping = sourceSlice(board, "const priceSummaries = useMemo", "const executeCharacterListing");
  const fingerprintSource = sourceSlice(board, "function marketItemFingerprint", "function ListingRow");
  const priceView = sourceSlice(
    board,
    'auctionView === "price"',
    'auctionView === "favorites"',
  );

  for (const field of [
    "baseName",
    "slot",
    "rarity",
    "enhancement",
    "level",
    "qualityScore",
    "powerScore",
    "legendaryPowerId",
    "enhancementRanks",
    "divineForgeRerolls",
  ]) {
    assert.match(fingerprintSource, new RegExp(`item\\.${field}`));
  }
  assert.match(fingerprintSource, /affix\.stat/);
  assert.match(fingerprintSource, /affix\.value/);
  assert.match(fingerprintSource, /affix\.rollPercent/);
  assert.match(fingerprintSource, /item\.enhancementRanks\[index \+ 1\]/);
  assert.match(fingerprintSource, /\.map\(\(affix, index\) =>[\s\S]{0,180}?\)\s*\.sort\(\)/);
  assert.match(priceGrouping, /marketItemFingerprint\(listing\.item\)/);

  const baseItem = {
    baseName: "pairing blade",
    slot: "weapon",
    rarity: "legendary",
    enhancement: 5,
    level: 77,
    qualityScore: 91,
    powerScore: 12_345,
    legendaryPowerId: "crescentEcho",
    enhancementRanks: [1, 2, 3],
    divineForgeRerolls: 2,
    affixes: [
      { stat: "damagePercent", value: 12.5, rollPercent: 91 },
      { stat: "critChancePercent", value: 6, rollPercent: 74 },
    ],
  };
  const reorderedWithRanks = {
    ...baseItem,
    enhancementRanks: [1, 3, 2],
    affixes: [baseItem.affixes[1], baseItem.affixes[0]],
  };
  const reorderedWithoutRanks = {
    ...baseItem,
    affixes: [baseItem.affixes[1], baseItem.affixes[0]],
  };
  const fingerprint = fingerprintModule.marketItemFingerprint(baseItem);
  assert.equal(
    fingerprintModule.marketItemFingerprint(reorderedWithRanks),
    fingerprint,
    "reordering exact affix/rank pairs must not split one market price group",
  );
  assert.notEqual(
    fingerprintModule.marketItemFingerprint(reorderedWithoutRanks),
    fingerprint,
    "moving a rank onto a different affix must remain a distinct item",
  );
  assert.notEqual(
    fingerprintModule.marketItemFingerprint({ ...baseItem, legendaryPowerId: "otherPower" }),
    fingerprint,
  );
  assert.notEqual(
    fingerprintModule.marketItemFingerprint({ ...baseItem, divineForgeRerolls: 3 }),
    fingerprint,
  );
  assert.match(priceView, /현재 매물 호가/);
  assert.match(priceView, /실제 체결/);
  assert.match(priceView, /snapshot\?\.auctionTrades|snapshot\.auctionTrades/);
  assert.match(priceView, /trade\.item/);
  assert.match(priceView, /trade\.priceAsh/);
  assert.match(priceView, /trade\.executedAt/);
  assert.doesNotMatch(priceView, /auditTrail/);
  assert.match(priceView, /최대 60개 표본/);
});

test("completed auction tab uses player-facing history rather than raw audit codes and messages", async () => {
  const board = await readSource("app/market/MarketBoard.tsx");
  const completeView = sourceSlice(
    board,
    'auctionView === "complete"',
    'tab === "gold"',
  );

  assert.doesNotMatch(completeView, /\{entry\.category\}/);
  assert.doesNotMatch(completeView, /\{entry\.message\}/);
  assert.doesNotMatch(completeView, /toUpperCase\(\)/);
  assert.doesNotMatch(completeView, /<code>/);
  assert.match(completeView, /거래 완료/);
  assert.match(completeView, /snapshot\.myAuctionTrades/);
  assert.match(completeView, /trade\.role === "buyer"/);
  assert.match(completeView, /trade\.counterpartName/);
  assert.doesNotMatch(completeView, /security\.auditTrail/);
});

test("runtime density tiers compensate the letterboxed game plane at 1280 and 960 widths", async () => {
  const [board, css] = await Promise.all([
    readSource("app/market/MarketBoard.tsx"),
    readSource("app/market/market.css"),
  ]);

  assert.match(board, /Math\.min\([\s\S]{0,180}?window\.innerWidth \/ MARKET_DESIGN_WIDTH,[\s\S]{0,100}?window\.innerHeight \/ MARKET_DESIGN_HEIGHT/);
  assert.match(board, /requestAnimationFrame\(onStoreChange\)/);
  assert.match(board, /useSyncExternalStore\([\s\S]{0,120}?subscribeMarketViewportDensity,[\s\S]{0,120}?readMarketViewportDensity/);
  assert.match(board, /data-market-density=\{viewportDensity\}/);
  assert.match(css, /data-market-density="scaled"[\s\S]{0,8000}?font-size: 20px[\s\S]{0,8000}?min-height: 112px/);
  assert.match(css, /data-market-density="compact"[\s\S]{0,8000}?font-size: 28px[\s\S]{0,8000}?min-height: 132px/);
  assert.doesNotMatch(css, /@media[^\r\n{]*(?:min|max)-(?:width|height)/);
  assert.doesNotMatch(board, /onDoubleClick=/);
  assert.doesNotMatch(board, /캐릭터 가방과 거래소 매물을 불러왔습니다/);
  assert.doesNotMatch(board, /행을 두 번/);
});

test("public orderbook trusts the balanced snapshot and does not overwrite it with one mixed limit", async () => {
  const board = await readSource("app/market/MarketBoard.tsx");

  assert.doesNotMatch(board, /fetchExchangeOrders/);
  assert.doesNotMatch(board, /function aggregateBook/);
  assert.doesNotMatch(board, /nextSnapshot\.goldExchange\.(?:orders|bids|asks|bestBid|bestAsk)\s*=/);
  assert.doesNotMatch(board, /3초 자동 갱신/);
  assert.match(board, />자동 갱신<|자동 갱신/);
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
