"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import Link from "next/link";
import {
  LEGENDARY_POWERS,
  formatEnhancedGearAffix,
  formatGearDisplayName,
  getGearImplicitDisplay,
  getGearRequiredLevel,
  normalizeGearEnhancement,
  type GearItem,
} from "../equipment";
import {
  ECONOMY_POLL_INTERVAL_MS,
  MARKET_RARITIES,
  MARKET_SLOTS,
  EconomyClientError,
  createEconomyIdempotencyKey,
  fetchEconomySnapshot,
  fetchMarketListings,
  finalizeSteamGoldPurchase,
  formatEconomyAmount,
  initializeSteamGoldPurchase,
  isLocalEconomySandbox,
  sendEconomyCommand,
  steamLinkUrl,
  type EconomyCommand,
  type EconomySnapshot,
  type GoldOrder,
  type MarketListing,
  type MarketRarity,
  type MarketSearch,
  type MarketSlot,
  type MarketVaultItem,
} from "../economy-client";
import {
  gearItemToEconomyPayload,
  readCharacterMarketInventory,
  reconcileImportedCharacterItems,
  removeCharacterMarketItem,
  resolveCharacterMarketSlot,
  type CharacterMarketInventory,
} from "./character-market";

type MarketTab = "auction" | "gold" | "charge" | "security";
type AuctionView = "search" | "price" | "favorites" | "sell" | "complete";
type SellSource = "all" | "character" | "vault";
type DemoUser = "A" | "B";
type MarketViewportDensity = "default" | "scaled" | "compact";
type Notice = { tone: "info" | "success" | "error"; message: string };
type FatalMarketError = { status: number; code: string };
type SellCandidate =
  | {
      key: string;
      source: "vault";
      view: MarketVaultItem;
    }
  | {
      key: string;
      source: "character";
      view: MarketVaultItem;
      gear: GearItem;
      saveSlot: 1 | 2 | 3;
    };

type ConfirmationIntent =
  | { kind: "buy"; listing: MarketListing }
  | { kind: "cancel-listing"; listing: MarketListing }
  | { kind: "sell"; candidate: SellCandidate; priceAsh: number }
  | {
      kind: "order";
      side: "buy" | "sell";
      priceAshPerGold: number;
      goldAmount: number;
    }
  | { kind: "fill-order"; order: GoldOrder; goldAmount: number }
  | { kind: "cancel-order"; order: GoldOrder }
  | { kind: "charge"; packId: string; goldAmount: number; priceKrw: number };

type Confirmation = ConfirmationIntent & { intentKey: string; serverItemId?: string };

const TABS: ReadonlyArray<{ id: MarketTab; label: string; eyebrow: string }> = [
  { id: "auction", label: "장비 경매장", eyebrow: "EQUIPMENT" },
  { id: "gold", label: "금괴 교환소", eyebrow: "GOLD EXCHANGE" },
  { id: "charge", label: "금괴 충전", eyebrow: "STEAM WALLET" },
  { id: "security", label: "보안센터", eyebrow: "ACCOUNT GUARD" },
];

const AUCTION_VIEWS: ReadonlyArray<{ id: AuctionView; label: string; eyebrow: string }> = [
  { id: "search", label: "장비 검색", eyebrow: "SEARCH" },
  { id: "price", label: "시세 조회", eyebrow: "MARKET PRICE" },
  { id: "favorites", label: "관심 목록", eyebrow: "WATCH LIST" },
  { id: "sell", label: "판매 등록", eyebrow: "SELL" },
  { id: "complete", label: "거래 완료", eyebrow: "HISTORY" },
];

const MARKET_FAVORITES_STORAGE_KEY = "mujindo:market:favorites:v1";
const MARKET_DESIGN_WIDTH = 1920;
const MARKET_DESIGN_HEIGHT = 1080;
const MARKET_SCALED_VIEWPORT_RATIO = 1440 / MARKET_DESIGN_WIDTH;
const MARKET_COMPACT_VIEWPORT_RATIO = 1100 / MARKET_DESIGN_WIDTH;

function subscribeMarketViewportDensity(onStoreChange: () => void): () => void {
  const initialFrame = window.requestAnimationFrame(onStoreChange);
  window.addEventListener("resize", onStoreChange);
  window.visualViewport?.addEventListener("resize", onStoreChange);
  return () => {
    window.cancelAnimationFrame(initialFrame);
    window.removeEventListener("resize", onStoreChange);
    window.visualViewport?.removeEventListener("resize", onStoreChange);
  };
}

function readMarketViewportDensity(): MarketViewportDensity {
  const viewportScale = Math.min(
    window.innerWidth / MARKET_DESIGN_WIDTH,
    window.innerHeight / MARKET_DESIGN_HEIGHT,
  );
  if (viewportScale <= MARKET_COMPACT_VIEWPORT_RATIO) return "compact";
  if (viewportScale <= MARKET_SCALED_VIEWPORT_RATIO) return "scaled";
  return "default";
}

function readServerMarketViewportDensity(): MarketViewportDensity {
  return "default";
}

function marketFavoritesStorageKey(ownerKey: string): string {
  return `${MARKET_FAVORITES_STORAGE_KEY}:${ownerKey}`;
}

function readMarketFavorites(ownerKey: string): string[] {
  if (typeof window === "undefined") return [];
  try {
    const stored = JSON.parse(window.localStorage.getItem(marketFavoritesStorageKey(ownerKey)) ?? "[]");
    return Array.isArray(stored)
      ? stored.filter((value): value is string => typeof value === "string").slice(0, 10)
      : [];
  } catch {
    return [];
  }
}

const MODAL_FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

const RARITY_LABELS: Readonly<Record<MarketRarity, string>> = {
  common: "일반",
  magic: "마법",
  superior: "고급",
  rare: "희귀",
  epic: "영웅",
  legendary: "전설",
  mythic: "신화",
  cosmic: "우주",
};

const RARITY_COLORS: Readonly<Record<MarketRarity, string>> = {
  common: "#c7c2b5",
  magic: "#63a6ff",
  superior: "#4ed29b",
  rare: "#e7c65b",
  epic: "#bc70ff",
  legendary: "#ef9a43",
  mythic: "#ff536f",
  cosmic: "#65f4ff",
};

const SLOT_LABELS: Readonly<Record<MarketSlot, string>> = {
  weapon: "무기",
  offhand: "보조 장비",
  helm: "투구",
  shoulders: "어깨",
  armor: "갑옷",
  gloves: "장갑",
  belt: "허리띠",
  legs: "각반",
  boots: "장화",
  relic: "유물",
};

const ORDER_STATUS_LABELS: Readonly<Record<GoldOrder["status"], string>> = {
  open: "대기 중",
  partial: "일부 체결",
  filled: "체결 완료",
  cancelled: "취소됨",
};

const TRUST_LABELS: Readonly<Record<EconomySnapshot["account"]["trustTier"], string>> = {
  unverified: "확인 필요",
  standard: "일반",
  trusted: "보호됨",
  restricted: "거래 제한",
};

const GOLD_PACKS = [
  { id: "gold-10", gold: 10, priceKrw: 1_100, label: "작은 금고" },
  { id: "gold-55", gold: 55, priceKrw: 5_500, label: "기록자의 금고" },
  { id: "gold-120", gold: 120, priceKrw: 11_000, label: "원정대 금고" },
  { id: "gold-390", gold: 390, priceKrw: 33_000, label: "왕실 봉인고" },
] as const;

const DATE_TIME_FORMAT = new Intl.DateTimeFormat("ko-KR", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

function initialTab(): MarketTab {
  if (typeof window === "undefined") return "auction";
  const value = new URLSearchParams(window.location.search).get("tab");
  return TABS.some((tab) => tab.id === value) ? (value as MarketTab) : "auction";
}

function initialAuctionView(): AuctionView {
  if (typeof window === "undefined") return "search";
  const value = new URLSearchParams(window.location.search).get("view");
  return AUCTION_VIEWS.some((view) => view.id === value)
    ? (value as AuctionView)
    : "search";
}

function formatDate(value: string | null): string {
  if (!value) return "기록 없음";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "기록 없음" : DATE_TIME_FORMAT.format(date);
}

function remainingLabel(expiresAt: string): string {
  const remaining = new Date(expiresAt).getTime() - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) return "종료 임박";
  const hours = Math.floor(remaining / 3_600_000);
  const minutes = Math.floor((remaining % 3_600_000) / 60_000);
  return hours > 0 ? `${hours}시간 ${minutes}분` : `${Math.max(1, minutes)}분`;
}

function marketEventLabel(category: string): string {
  if (category === "list_item") return "판매 등록";
  if (category === "buy_listing") return "장비 거래 완료";
  if (category === "cancel_listing") return "등록 취소";
  if (category === "expire_listing") return "판매 만료";
  return "거래 기록";
}

function marketEventDescription(category: string): string {
  if (category === "list_item") return "장비가 판매 목록에 등록되었습니다.";
  if (category === "buy_listing") return "장비 소유권과 대금 정산이 반영되었습니다.";
  if (category === "cancel_listing") return "취소한 장비가 거래 금고로 돌아왔습니다.";
  if (category === "expire_listing") return "판매 기간이 끝난 장비가 거래 금고로 돌아왔습니다.";
  return "계정의 거래 상태가 변경되었습니다.";
}

function accountActivityLabel(category: string): string {
  if (/login|session/.test(category)) return "계정 로그인";
  if (/steam|ownership/.test(category)) return "Steam 계정 확인";
  if (/list_item|buy_listing|cancel_listing|expire_listing/.test(category)) return marketEventLabel(category);
  if (/payment|charge/.test(category)) return "결제 상태 확인";
  return "계정 활동";
}

function accountActivityDescription(category: string): string {
  if (/login|session/.test(category)) return "새 로그인 또는 접속 상태가 확인되었습니다.";
  if (/steam|ownership/.test(category)) return "연결된 Steam 계정 상태가 확인되었습니다.";
  if (/list_item|buy_listing|cancel_listing|expire_listing/.test(category)) return marketEventDescription(category);
  if (/payment|charge/.test(category)) return "결제 또는 충전 결과가 확인되었습니다.";
  return "계정 보호와 관련된 상태가 변경되었습니다.";
}

function marketRequestErrorCopy(
  error: unknown,
  area: "snapshot" | "search" | "trade" | "payment",
): string {
  if (!(error instanceof EconomyClientError)) {
    if (area === "search") return "검색 결과를 불러오지 못했습니다. 조건을 유지한 채 다시 검색해 주세요.";
    if (area === "payment") return "결제 결과를 확인하지 못했습니다. 잠시 뒤 다시 시도해 주세요.";
    if (area === "trade") return "거래를 마치지 못했습니다. 최신 상태를 확인한 뒤 다시 시도해 주세요.";
    return "거래 정보를 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.";
  }
  if (error.status === 401) return "Steam 계정 연결이 필요합니다.";
  if (error.status === 429) return "요청이 많습니다. 잠시 기다린 뒤 다시 시도해 주세요.";
  if (error.code === "SECURE_INVENTORY_REQUIRED") return "거래 금고에서 확인된 장비만 판매할 수 있습니다.";
  if (error.code === "COUNTERPARTY_CAPACITY_EXCEEDED") return "상대 계정의 보유 한도 때문에 지금은 체결할 수 없습니다.";
  if (/WALLET_CAPACITY|OVERFLOW/.test(error.code)) return "보유 한도에 도달했습니다. 재화를 정리한 뒤 같은 거래를 다시 확인해 주세요.";
  if (/INSUFFICIENT|WALLET|BALANCE/.test(error.code)) return "보유 재화가 부족하거나 사용 가능한 잔액이 달라졌습니다.";
  if (/PRICE|VERSION|UNAVAILABLE|EXPIRED|CONFLICT/.test(error.code) || error.status === 409) {
    return "가격이나 거래 상태가 바뀌었습니다. 최신 정보를 확인해 다시 시도해 주세요.";
  }
  if (error.status === 403) return "현재 계정에서는 이 거래를 이용할 수 없습니다.";
  if (error.status >= 500 || error.status === 0) return "거래소 연결이 원활하지 않습니다. 잠시 뒤 다시 시도해 주세요.";
  if (area === "search") return "검색 결과를 불러오지 못했습니다. 조건을 유지한 채 다시 검색해 주세요.";
  if (area === "payment") return "결제를 확인하지 못했습니다. Steam 결제 내역을 확인한 뒤 다시 시도해 주세요.";
  return "거래를 마치지 못했습니다. 최신 상태를 확인한 뒤 다시 시도해 주세요.";
}

function readDemoUser(): DemoUser {
  if (typeof window === "undefined") return "A";
  return new URLSearchParams(window.location.search).get("demo") === "B" ? "B" : "A";
}

function readSteamMarketReturnTo(): string {
  if (typeof window === "undefined") return "/market";
  const paymentReturn = new URLSearchParams(window.location.search).get("payment_return");
  if (!paymentReturn) return "/market";
  const params = new URLSearchParams({ payment_return: paymentReturn });
  return `/market?${params.toString()}`;
}

function readSteamLinkError(): string | null {
  if (typeof window === "undefined") return null;
  const code = new URLSearchParams(window.location.search).get("steam_error");
  if (!code) return null;
  if (code === "STEAM_ALREADY_LINKED") return "이 Steam 계정은 이미 다른 게임 계정에 연결되어 있습니다.";
  if (code === "STEAM_GAME_OWNERSHIP_REQUIRED" || code === "GAME_NOT_OWNED") return "게임 소유권을 확인할 수 없습니다. Steam 계정을 확인한 뒤 다시 시도해 주세요.";
  if (/STATE|OPENID|STEAM/.test(code)) return "Steam 계정 확인을 마치지 못했습니다. 안전한 새 연결 요청으로 다시 시도해 주세요.";
  return "Steam 계정 연결을 마치지 못했습니다. 잠시 뒤 다시 시도해 주세요.";
}

function ItemIcon({ item, compact = false }: { item: MarketVaultItem; compact?: boolean }) {
  const column = Math.max(0, item.iconIndex % 10);
  const row = Math.max(0, Math.floor(item.iconIndex / 10));
  const enhancement = normalizeGearEnhancement(item.enhancement);
  return (
    <span
      className={`market-item-icon market-item-icon--${item.rarity} ${compact ? "is-compact" : ""}`}
      style={
        {
          "--rarity-color": RARITY_COLORS[item.rarity],
          "--icon-x": `${(column / 9) * 100}%`,
          "--icon-y": `${(row / 9) * 100}%`,
        } as CSSProperties
      }
      aria-hidden="true"
    >
      <i />
      <b className="market-item-enhancement">+{enhancement}</b>
    </span>
  );
}

function formatMarketGearName(item: MarketVaultItem): string {
  return formatGearDisplayName(item, { includeZero: true });
}

function formatMarketGearLevel(item: MarketVaultItem): string {
  return `아이템 레벨 ${item.level} · 착용 필요 레벨 ${getGearRequiredLevel(item)}`;
}

function characterGearView(item: GearItem, saveSlot: 1 | 2 | 3): MarketVaultItem {
  return {
    vaultItemId: `character:${saveSlot}:${item.id}`,
    itemId: item.id,
    displayName: item.displayName,
    baseName: item.baseName,
    rarity: item.rarity,
    slot: item.slot,
    level: item.level,
    enhancement: item.enhancement,
    legendaryPowerId: item.legendaryPowerId,
    enhancementRanks: [...item.enhancementRanks],
    divineForgeRerolls: item.divineForgeRerolls,
    powerScore: item.powerScore,
    qualityScore: item.qualityScore,
    iconIndex: item.iconIndex,
    affixes: item.affixes.map((affix) => ({
      stat: affix.stat,
      label: affix.label,
      value: affix.value,
      rollPercent: affix.rollPercent,
    })),
    tradeState: "available",
    lockedUntil: null,
    version: 0,
  };
}

function BalanceCard({
  symbol,
  label,
  available,
  escrow,
  locked,
  tone,
}: {
  symbol: string;
  label: string;
  available: number;
  escrow: number;
  locked: number;
  tone: "ash" | "gold";
}) {
  return (
    <article className={`market-balance market-balance--${tone}`}>
      <span className="market-balance-symbol" aria-hidden="true">{symbol}</span>
      <div>
        <small>{label} · 사용 가능</small>
        <strong>{formatEconomyAmount(available)}</strong>
      </div>
      <dl>
        <div><dt>거래 보관</dt><dd>{formatEconomyAmount(escrow)}</dd></div>
        <div><dt>72시간 잠금</dt><dd>{formatEconomyAmount(locked)}</dd></div>
      </dl>
    </article>
  );
}

function AccountGate({ snapshot, local }: { snapshot: EconomySnapshot; local: boolean }) {
  const { account, capabilities } = snapshot;
  const needsSteamVerification = !account.restricted && (
    !account.steamLinked ||
    !account.gameOwned ||
    !account.steamOwnershipFresh
  );
  const ready =
    !account.restricted &&
    capabilities.canTrade &&
    ((account.steamLinked && account.gameOwned) ||
      (local && capabilities.localSandbox));
  if (ready) return null;
  const guidance = account.restricted
    ? "계정 보호를 위해 거래가 잠시 제한되었습니다. 계정 상태에서 이용 가능 여부를 확인해 주세요."
    : !account.steamLinked
      ? "Steam 계정을 연결하면 장비 거래를 시작할 수 있습니다."
      : !account.gameOwned
        ? "연결한 Steam 계정의 게임 소유권을 확인해 주세요."
        : !account.steamOwnershipFresh
          ? "Steam 게임 소유권 확인 시간이 만료되었습니다. 다시 확인하면 거래 준비 상태가 갱신됩니다."
          : snapshot.featureMode === "read-only"
            ? "현재 거래소는 읽기 전용입니다. 등록 중인 내 매물과 주문은 판매·교환 화면에서 취소할 수 있습니다."
            : "현재 장비 거래를 이용할 수 없습니다. 잠시 후 다시 시도해 주세요.";
  return (
    <section
      className="market-launch-gate is-locked"
      role="alert"
      aria-label="거래소 이용 안내"
    >
      <span className="market-launch-gate-icon" aria-hidden="true">◇</span>
      <div>
        <small>거래소 이용 안내</small>
        <strong>장비 거래를 시작할 수 없습니다</strong>
        <p>{guidance}</p>
        {needsSteamVerification && <a href={steamLinkUrl("/market")}>{account.steamLinked ? "Steam 다시 확인" : "Steam으로 시작"}</a>}
      </div>
    </section>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="market-empty-state">
      <span aria-hidden="true">◇</span>
      <strong>{title}</strong>
      <p>{body}</p>
    </div>
  );
}

function MarketSearchErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="market-search-error" role="alert">
      <span aria-hidden="true">!</span>
      <strong>검색 결과를 불러오지 못했습니다</strong>
      <p>{message}</p>
      <button type="button" onClick={onRetry}>다시 검색</button>
    </div>
  );
}

function MarketItemDetails({ item }: { item: MarketVaultItem }) {
  const implicit = getGearImplicitDisplay(item);
  const legendaryPower = item.legendaryPowerId
    ? LEGENDARY_POWERS[item.legendaryPowerId]
    : null;
  const affixLines = item.affixes.map((affix, index) => {
    const rank = item.enhancementRanks[index + 1] ?? 0;
    return `${formatEnhancedGearAffix(item, affix)}${rank > 0 ? ` · 강화 ${rank}회` : ""}`;
  });
  return (
    <dl className="market-item-details" aria-label="선택 장비 상세 옵션">
      <div><dt>강화</dt><dd>+{normalizeGearEnhancement(item.enhancement)}</dd></div>
      <div><dt>품질</dt><dd>{item.qualityScore}</dd></div>
      <div><dt>요구 레벨</dt><dd>{getGearRequiredLevel(item)}</dd></div>
      <div><dt>보스 화력</dt><dd>{formatEconomyAmount(item.powerScore)}</dd></div>
      <div><dt>신의 대장간</dt><dd>재련 {item.divineForgeRerolls}/3</dd></div>
      {legendaryPower && (
        <div className="market-item-details-power">
          <dt>전설 고유 능력</dt>
          <dd><strong>{legendaryPower.name}</strong><span>{legendaryPower.description}</span></dd>
        </div>
      )}
      <div className="market-item-details-affixes">
        <dt>강화 옵션 배분</dt>
        <dd>{[implicit.totalLabel, ...affixLines].join(" · ")}</dd>
      </div>
    </dl>
  );
}

function marketItemOptionSummary(item: MarketVaultItem): string {
  const implicit = getGearImplicitDisplay(item);
  const legendaryDefinition = item.legendaryPowerId
    ? LEGENDARY_POWERS[item.legendaryPowerId]
    : null;
  const legendaryPower = legendaryDefinition
    ? `전설 고유: ${legendaryDefinition.name}`
    : null;
  const affixes = item.affixes.map((affix, index) => {
    const rank = item.enhancementRanks[index + 1] ?? 0;
    return `${formatEnhancedGearAffix(item, affix)}${rank > 0 ? ` (강화 ${rank}회)` : ""}`;
  });
  return [
    legendaryPower,
    implicit.totalLabel,
    ...affixes,
    `신의 대장간 재련 ${item.divineForgeRerolls}/3`,
  ].filter((line): line is string => Boolean(line)).join(" · ");
}

function marketItemFingerprint(item: MarketVaultItem): string {
  const rankedAffixes = item.affixes
    .map((affix, index) => `${affix.stat}:${affix.value}:q${affix.rollPercent}:r${item.enhancementRanks[index + 1] ?? 0}`)
    .sort()
    .join("|");
  return [
    item.baseName,
    item.slot,
    item.rarity,
    normalizeGearEnhancement(item.enhancement),
    item.level,
    item.qualityScore,
    item.powerScore,
    item.legendaryPowerId ?? "none",
    `implicit:r${item.enhancementRanks[0] ?? 0}`,
    rankedAffixes,
    `forge:r${item.divineForgeRerolls}`,
  ].join("::");
}

function ListingRow({
  listing,
  selected,
  onSelect,
}: {
  listing: MarketListing;
  selected: boolean;
  onSelect: (listing: MarketListing) => void;
}) {
  return (
    <button
      type="button"
      className={`market-listing is-${listing.item.rarity} ${selected ? "is-selected" : ""}`}
      style={{ "--rarity-color": RARITY_COLORS[listing.item.rarity] } as CSSProperties}
      aria-pressed={selected}
      onClick={() => onSelect(listing)}
    >
      <div className="market-listing-item"><ItemIcon item={listing.item} compact /><div><small>{formatMarketGearLevel(listing.item)} · {SLOT_LABELS[listing.item.slot]}</small><strong>{formatMarketGearName(listing.item)}</strong><span>{RARITY_LABELS[listing.item.rarity]} · 보스 화력 {formatEconomyAmount(listing.item.powerScore)} · 품질 {listing.item.qualityScore}</span></div></div>
      <div className="market-listing-seller"><small>판매자</small><strong>{listing.sellerName}</strong><span>{listing.mine ? "내 매물" : "거래 가능"}</span></div>
      <div className="market-listing-time"><small>만료까지</small><strong>{remainingLabel(listing.expiresAt)}</strong><span>{formatDate(listing.listedAt)} 등록</span></div>
      <div className="market-listing-price"><small>기억의 재</small><strong><i>✦</i>{formatEconomyAmount(listing.priceAsh)}</strong><span>고정가</span></div>
    </button>
  );
}

export default function MarketBoard({ suggestedName }: { suggestedName?: string | null }) {
  const [tab, setTab] = useState<MarketTab>(initialTab);
  const [auctionView, setAuctionView] = useState<AuctionView>(initialAuctionView);
  const [snapshot, setSnapshot] = useState<EconomySnapshot | null>(null);
  const [listings, setListings] = useState<MarketListing[]>([]);
  const [marketSearchError, setMarketSearchError] = useState<string | null>(null);
  const [fatalError, setFatalError] = useState<FatalMarketError | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [lastSyncAt, setLastSyncAt] = useState<Date | null>(null);
  const local = useSyncExternalStore(
    () => () => undefined,
    () => isLocalEconomySandbox(),
    () => false,
  );
  const viewportDensity = useSyncExternalStore(
    subscribeMarketViewportDensity,
    readMarketViewportDensity,
    readServerMarketViewportDensity,
  );
  const [demoUser] = useState<DemoUser>(readDemoUser);
  const [steamReturnTo] = useState(readSteamMarketReturnTo);
  const [steamLinkError] = useState(readSteamLinkError);
  const [search, setSearch] = useState("");
  const [rarity, setRarity] = useState<MarketRarity | "all">("all");
  const [slot, setSlot] = useState<MarketSlot | "all">("all");
  const [sort, setSort] = useState<NonNullable<MarketSearch["sort"]>>("recent");
  const [query, setQuery] = useState<MarketSearch>({
    search: "",
    rarity: "all",
    slot: "all",
    sort: "recent",
  });
  const [selectedListingId, setSelectedListingId] = useState<string | null>(null);
  const [favoriteOverrides, setFavoriteOverrides] = useState<Record<string, string[]>>({});
  const [characterInventory, setCharacterInventory] = useState<CharacterMarketInventory>({
    slot: 1,
    items: [],
    equippedCount: 0,
    invalidCount: 0,
  });
  const [selectedSellCandidateKey, setSelectedSellCandidateKey] = useState<string | null>(null);
  const [sellSource, setSellSource] = useState<SellSource>("all");
  const [sellSlot, setSellSlot] = useState<MarketSlot | "all">("all");
  const [sellPrice, setSellPrice] = useState("");
  const [orderSide, setOrderSide] = useState<"buy" | "sell">("buy");
  const [orderPrice, setOrderPrice] = useState("");
  const [orderAmount, setOrderAmount] = useState("");
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [paymentRetryAvailable, setPaymentRetryAvailable] = useState(false);
  const [paymentRetryNonce, setPaymentRetryNonce] = useState(0);
  const pollingRef = useRef<AbortController | null>(null);
  const requestGenerationRef = useRef(0);
  const workingRef = useRef(false);
  const paymentReturnRef = useRef<string | null>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const auctionViewRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const confirmationDialogRef = useRef<HTMLElement>(null);
  const confirmationOpenerRef = useRef<HTMLElement | null>(null);
  const pendingFocusRestoreRef = useRef<HTMLElement | null>(null);
  const favoritesOwnerKey = snapshot?.account.userId ?? (local ? `local-${demoUser}` : "guest");
  const storedFavoriteListingIds = useMemo(
    () => readMarketFavorites(favoritesOwnerKey),
    [favoritesOwnerKey],
  );
  const favoriteListingIds = favoriteOverrides[favoritesOwnerKey] ?? storedFavoriteListingIds;

  const beginWorking = useCallback(() => {
    if (workingRef.current) return false;
    pollingRef.current?.abort();
    pollingRef.current = null;
    requestGenerationRef.current += 1;
    workingRef.current = true;
    setWorking(true);
    return true;
  }, []);

  const finishWorking = useCallback(() => {
    workingRef.current = false;
    setWorking(false);
  }, []);

  const handleUnauthorized = useCallback((error: unknown) => {
    if (!(error instanceof EconomyClientError) || error.status !== 401) return false;
    pollingRef.current?.abort();
    setConfirmation(null);
    setSnapshot(null);
    setListings([]);
    setSelectedListingId(null);
    setSelectedSellCandidateKey(null);
    setMarketSearchError(null);
    setFatalError({ status: 401, code: error.code });
    setNotice(null);
    setLoading(false);
    setRefreshing(false);
    return true;
  }, []);

  const syncCharacterInventory = useCallback(() => {
    const activeSlot = resolveCharacterMarketSlot(window.location.search);
    const nextInventory = readCharacterMarketInventory(activeSlot);
    setCharacterInventory(nextInventory);
    return nextInventory;
  }, []);

  const refresh = useCallback(async (quiet = false, allowWhileWorking = false) => {
    if (workingRef.current && !allowWhileWorking) return;
    pollingRef.current?.abort();
    const controller = new AbortController();
    pollingRef.current = controller;
    const generation = requestGenerationRef.current + 1;
    requestGenerationRef.current = generation;
    if (!quiet) setRefreshing(true);
    try {
      const [snapshotResult, listingsResult] = await Promise.allSettled([
        fetchEconomySnapshot({ signal: controller.signal, demoUser }),
        fetchMarketListings(query, { signal: controller.signal, demoUser }),
      ]);
      if (generation !== requestGenerationRef.current) return;
      if (snapshotResult.status === "rejected") throw snapshotResult.reason;
      const nextSnapshot = snapshotResult.value;
      const listingsFailure = listingsResult.status === "rejected"
        ? listingsResult.reason
        : null;
      if (listingsFailure instanceof EconomyClientError && listingsFailure.status === 401) {
        throw listingsFailure;
      }
      const nextListings = listingsResult.status === "fulfilled"
        ? listingsResult.value
        : [];
      const reconciliation = reconcileImportedCharacterItems(
        nextSnapshot.importedCharacterItemIds,
      );
      syncCharacterInventory();
      const ownListingIds = new Set(nextSnapshot.myListings.map((listing) => listing.listingId));
      for (const listing of nextListings) listing.mine = ownListingIds.has(listing.listingId);
      setSnapshot(nextSnapshot);
      setFatalError(null);
      setListings(nextListings);
      setSelectedListingId((current) => {
        if (!current) return null;
        const selectionSource = auctionView === "search"
          ? nextListings
          : auctionView === "favorites"
            ? [...nextSnapshot.listings, ...nextListings]
            : auctionView === "sell"
              ? nextSnapshot.myListings
              : [];
        return selectionSource.some((listing) => listing.listingId === current) ? current : null;
      });
      setMarketSearchError(listingsFailure
        ? marketRequestErrorCopy(listingsFailure, "search")
        : null);
      setLastSyncAt(new Date());
      if (listingsFailure) {
        setNotice({ tone: "error", message: "검색 결과를 갱신하지 못했습니다. 검색 조건은 그대로 유지됩니다." });
      } else if (reconciliation.failedSlots.length > 0) {
        setNotice({
          tone: "error",
          message: `거래소로 옮긴 장비를 가방에서 정리하지 못했습니다. 캐릭터 슬롯 ${reconciliation.failedSlots.join(", ")}의 저장 공간을 확인해 주세요.`,
        });
      } else if (reconciliation.removedItemIds.length > 0) {
        setNotice({
          tone: "success",
          message: `거래소로 이관된 장비 ${reconciliation.removedItemIds.length}개를 캐릭터 가방에서 안전하게 정리했습니다.`,
        });
      }
    } catch (error) {
      if (generation !== requestGenerationRef.current) return;
      if ((error as Error).name !== "AbortError") {
        if (!handleUnauthorized(error)) {
          setFatalError({
            status: error instanceof EconomyClientError ? error.status : 0,
            code: error instanceof EconomyClientError ? error.code : "ECONOMY_REQUEST_FAILED",
          });
          setNotice({
            tone: "error",
            message: marketRequestErrorCopy(error, "snapshot"),
          });
        }
      }
    } finally {
      if (generation === requestGenerationRef.current) {
        setLoading(false);
        if (!quiet) setRefreshing(false);
      }
    }
  }, [auctionView, demoUser, handleUnauthorized, query, syncCharacterInventory]);

  useEffect(() => {
    const initialSync = window.setTimeout(syncCharacterInventory, 0);
    const handleStorage = () => syncCharacterInventory();
    window.addEventListener("storage", handleStorage);
    return () => {
      window.clearTimeout(initialSync);
      window.removeEventListener("storage", handleStorage);
    };
  }, [syncCharacterInventory]);

  useEffect(() => {
    const initialRefresh = window.setTimeout(() => void refresh(false), 0);
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible" && !working && !confirmation) void refresh(true);
    }, ECONOMY_POLL_INTERVAL_MS);
    return () => {
      window.clearTimeout(initialRefresh);
      window.clearInterval(interval);
      pollingRef.current?.abort();
    };
  }, [confirmation, refresh, working]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const paymentOrderId = params.get("payment_return");
    if (!paymentOrderId || paymentReturnRef.current === paymentOrderId) return;
    paymentReturnRef.current = paymentOrderId;
    let clearPaymentReturn = true;
    if (!beginWorking()) {
      paymentReturnRef.current = null;
      const showRetry = window.setTimeout(() => setPaymentRetryAvailable(true), 0);
      return () => window.clearTimeout(showRetry);
    }
    void finalizeSteamGoldPurchase(paymentOrderId, { demoUser })
      .then((nextSnapshot) => {
        setPaymentRetryAvailable(false);
        setSnapshot(nextSnapshot);
        setLastSyncAt(new Date());
        setNotice({
          tone: "success",
          message: "금괴 충전이 완료되었습니다. 충전한 금괴는 72시간 뒤부터 교환할 수 있습니다.",
        });
      })
      .catch((error) => {
        if (handleUnauthorized(error)) {
          clearPaymentReturn = false;
          return;
        }
        const retryable = !(error instanceof EconomyClientError) ||
          error.retryable ||
          error.code === "STEAM_OWNERSHIP_STALE" ||
          error.status === 429 ||
          error.status >= 500;
        clearPaymentReturn = !retryable;
        if (retryable) {
          paymentReturnRef.current = null;
          setPaymentRetryAvailable(true);
        }
        setNotice({
          tone: "error",
          message: `${marketRequestErrorCopy(error, "payment")}${retryable ? " 결제 내역은 유지되므로 잠시 뒤 다시 확인해 주세요." : ""}`,
        });
      })
      .finally(() => {
        const current = new URLSearchParams(window.location.search);
        if (clearPaymentReturn && current.get("payment_return") === paymentOrderId) {
          current.delete("payment_return");
          const queryString = current.toString();
          window.history.replaceState(
            null,
            "",
            `${window.location.pathname}${queryString ? `?${queryString}` : ""}${window.location.hash}`,
          );
        }
        finishWorking();
      });
  }, [beginWorking, demoUser, finishWorking, handleUnauthorized, paymentRetryNonce]);

  useEffect(() => {
    if (!confirmation) return;

    const dialog = confirmationDialogRef.current;
    if (!dialog) return;

    const openingFocusFrame = window.requestAnimationFrame(() => {
      if (dialog.contains(document.activeElement)) return;
      const firstFocusable = dialog.querySelector<HTMLElement>(MODAL_FOCUSABLE_SELECTOR);
      (firstFocusable ?? dialog).focus({ preventScroll: true });
    });

    const handleDialogKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (workingRef.current) return;
        setConfirmation(null);
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(MODAL_FOCUSABLE_SELECTOR),
      ).filter((element) => element.getAttribute("aria-hidden") !== "true");
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus({ preventScroll: true });
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    };

    window.addEventListener("keydown", handleDialogKey, true);
    return () => {
      window.cancelAnimationFrame(openingFocusFrame);
      window.removeEventListener("keydown", handleDialogKey, true);
      pendingFocusRestoreRef.current = confirmationOpenerRef.current;
      confirmationOpenerRef.current = null;
    };
  }, [confirmation]);

  useEffect(() => {
    if (confirmation || working || !pendingFocusRestoreRef.current) return;
    const restoreFrame = window.requestAnimationFrame(() => {
      const opener = pendingFocusRestoreRef.current;
      pendingFocusRestoreRef.current = null;
      const openerDisabled = opener instanceof HTMLButtonElement && opener.disabled;
      if (opener?.isConnected && !openerDisabled) {
        opener.focus({ preventScroll: true });
        return;
      }
      const activeTabIndex = TABS.findIndex((entry) => entry.id === tab);
      tabRefs.current[activeTabIndex]?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(restoreFrame);
  }, [confirmation, tab, working]);

  const openConfirmation = useCallback((next: ConfirmationIntent) => {
    if (workingRef.current) return;
    confirmationOpenerRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setConfirmation({
      ...next,
      intentKey: createEconomyIdempotencyKey(`market-${next.kind}`),
      serverItemId: next.kind === "sell" && next.candidate.source === "character"
        ? crypto.randomUUID()
        : undefined,
    } as Confirmation);
  }, []);

  const changeTab = (next: MarketTab) => {
    setTab(next);
    setConfirmation(null);
    const params = new URLSearchParams(window.location.search);
    params.set("tab", next);
    if (local) params.set("demo", demoUser);
    window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
  };

  const handleTabKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    currentIndex: number,
  ) => {
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % TABS.length;
    if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + TABS.length) % TABS.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = TABS.length - 1;
    if (nextIndex === null) return;

    event.preventDefault();
    const nextTab = TABS[nextIndex];
    changeTab(nextTab.id);
    window.requestAnimationFrame(() => tabRefs.current[nextIndex]?.focus({ preventScroll: true }));
  };

  const changeAuctionView = (next: AuctionView) => {
    setAuctionView(next);
    setConfirmation(null);
    setSelectedListingId(null);
    const params = new URLSearchParams(window.location.search);
    params.set("tab", "auction");
    params.set("view", next);
    if (local) params.set("demo", demoUser);
    window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
  };

  const handleAuctionViewKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    currentIndex: number,
  ) => {
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % AUCTION_VIEWS.length;
    if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + AUCTION_VIEWS.length) % AUCTION_VIEWS.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = AUCTION_VIEWS.length - 1;
    if (nextIndex === null) return;

    event.preventDefault();
    changeAuctionView(AUCTION_VIEWS[nextIndex].id);
    window.requestAnimationFrame(() => auctionViewRefs.current[nextIndex]?.focus({ preventScroll: true }));
  };

  const applyAuctionSearch = (event: FormEvent) => {
    event.preventDefault();
    setQuery({ search: search.trim(), rarity, slot, sort });
    setSelectedListingId(null);
  };

  const resetAuctionSearch = () => {
    setSearch("");
    setRarity("all");
    setSlot("all");
    setSort("recent");
    setQuery({ search: "", rarity: "all", slot: "all", sort: "recent" });
    setSelectedListingId(null);
  };

  const toggleFavorite = (listingId: string) => {
    const exists = favoriteListingIds.includes(listingId);
    if (!exists && favoriteListingIds.length >= 10) {
      setNotice({ tone: "error", message: "관심 매물은 최대 10개까지 보관할 수 있습니다." });
      return;
    }
    const next = exists
      ? favoriteListingIds.filter((value) => value !== listingId)
      : [...favoriteListingIds, listingId];
    setFavoriteOverrides((current) => ({ ...current, [favoritesOwnerKey]: next }));
    try {
      window.localStorage.setItem(marketFavoritesStorageKey(favoritesOwnerKey), JSON.stringify(next));
    } catch {
      setNotice({ tone: "error", message: "관심 목록을 이 브라우저에 저장하지 못했습니다." });
    }
  };

  const clearUnresolvedFavorites = () => {
    const resolvedIds = new Set(favoriteListings.map((listing) => listing.listingId));
    const next = favoriteListingIds.filter((listingId) => resolvedIds.has(listingId));
    setFavoriteOverrides((current) => ({ ...current, [favoritesOwnerKey]: next }));
    try {
      window.localStorage.setItem(marketFavoritesStorageKey(favoritesOwnerKey), JSON.stringify(next));
    } catch {
      setNotice({ tone: "error", message: "관심 목록을 이 브라우저에 저장하지 못했습니다." });
    }
  };

  const executeCommand = useCallback(async (
    command: EconomyCommand,
    success: string,
    intentKey: string,
  ) => {
    if (!snapshot || !beginWorking()) return;
    try {
      const next = await sendEconomyCommand(command, snapshot, { demoUser, idempotencyKey: intentKey });
      setSnapshot(next);
      setNotice({ tone: "success", message: success });
      setConfirmation(null);
      setSelectedSellCandidateKey(null);
      setSellPrice("");
      setOrderAmount("");
      await refresh(true, true);
    } catch (error) {
      if (!handleUnauthorized(error)) {
        setNotice({
          tone: "error",
          message: marketRequestErrorCopy(error, "trade"),
        });
      }
    } finally {
      finishWorking();
    }
  }, [beginWorking, demoUser, finishWorking, handleUnauthorized, refresh, snapshot]);

  const localSandbox = Boolean(local && snapshot?.capabilities.localSandbox);
  const effectiveSellSource: SellSource = !localSandbox && sellSource === "character"
    ? "all"
    : sellSource;
  const sellCandidates = useMemo<SellCandidate[]>(() => {
    const importedIds = new Set(snapshot?.importedCharacterItemIds ?? []);
    const characterCandidates: SellCandidate[] = (localSandbox ? characterInventory.items : [])
      .filter((item) => !importedIds.has(item.id))
      .map((gear) => {
        const view = characterGearView(gear, characterInventory.slot);
        return {
          key: view.vaultItemId,
          source: "character",
          view,
          gear,
          saveSlot: characterInventory.slot,
        };
      });
    const vaultCandidates: SellCandidate[] = (snapshot?.vaultItems ?? [])
      .filter((item) => item.tradeState === "available")
      .map((view) => ({
        key: `vault:${view.vaultItemId}`,
        source: "vault",
        view,
      }));
    return [...characterCandidates, ...vaultCandidates];
  }, [characterInventory, localSandbox, snapshot]);
  const visibleSellCandidates = useMemo(
    () => sellCandidates.filter((candidate) =>
      (effectiveSellSource === "all" || candidate.source === effectiveSellSource) &&
      (sellSlot === "all" || candidate.view.slot === sellSlot),
    ),
    [effectiveSellSource, sellCandidates, sellSlot],
  );
  const selectedSellCandidate =
    visibleSellCandidates.find((candidate) => candidate.key === selectedSellCandidateKey) ?? null;
  const selectedListing = auctionView === "search"
    ? listings.find((listing) => listing.listingId === selectedListingId) ?? null
    : auctionView === "favorites" && favoriteListingIds.includes(selectedListingId ?? "")
      ? snapshot?.listings.find((listing) => listing.listingId === selectedListingId) ??
        listings.find((listing) => listing.listingId === selectedListingId) ??
        null
      : auctionView === "sell"
        ? snapshot?.myListings.find((listing) => listing.listingId === selectedListingId) ?? null
        : null;
  const favoriteListings = favoriteListingIds
    .map((listingId) =>
      snapshot?.listings.find((listing) => listing.listingId === listingId) ??
      listings.find((listing) => listing.listingId === listingId),
    )
    .filter((listing): listing is MarketListing => Boolean(listing));
  const unresolvedFavoriteCount = favoriteListingIds.length - favoriteListings.length;
  const ownListings = snapshot?.myListings ?? [];
  const priceSummaries = useMemo(() => {
    const groups = new Map<string, MarketListing[]>();
    for (const listing of listings) {
      const key = marketItemFingerprint(listing.item);
      const rows = groups.get(key) ?? [];
      rows.push(listing);
      groups.set(key, rows);
    }
    return [...groups.values()].map((rows) => {
      const sortedRows = [...rows].sort((left, right) => left.priceAsh - right.priceAsh);
      const prices = sortedRows.map((listing) => listing.priceAsh);
      const middle = Math.floor(prices.length / 2);
      const median = prices.length % 2 === 0
        ? Math.round((prices[middle - 1] + prices[middle]) / 2)
        : prices[middle];
      return {
        fingerprint: marketItemFingerprint(sortedRows[0].item),
        listing: sortedRows[0],
        count: sortedRows.length,
        lowest: prices[0],
        median,
        average: Math.round(prices.reduce((total, value) => total + value, 0) / prices.length),
      };
    }).sort((left, right) => left.lowest - right.lowest);
  }, [listings]);
  const executeCharacterListing = useCallback(async (
    candidate: Extract<SellCandidate, { source: "character" }>,
    priceAsh: number,
    intentKey: string,
    serverItemId: string,
  ) => {
    if (!snapshot || !beginWorking()) return;
    try {
      const next = await sendEconomyCommand(
        {
          action: "list_item",
          itemId: serverItemId,
          priceAsh,
          expiresInSeconds: 7 * 24 * 60 * 60,
          expectedItemVersion: 0,
          sourceSaveSlot: candidate.saveSlot,
          characterItem: gearItemToEconomyPayload(candidate.gear),
        },
        snapshot,
        { demoUser, idempotencyKey: intentKey },
      );
      const removal = removeCharacterMarketItem(
        candidate.saveSlot,
        candidate.gear.id,
      );
      setSnapshot(next);
      syncCharacterInventory();
      setConfirmation(null);
      setSelectedSellCandidateKey(null);
      setSellPrice("");
      setNotice(
        removal === "write-failed" || removal === "save-unavailable"
          ? {
              tone: "error",
              message: "판매 등록은 완료됐지만 캐릭터 가방 저장을 정리하지 못했습니다. 자동 동기화를 다시 시도합니다.",
            }
          : {
              tone: "success",
              message: `${formatMarketGearName(candidate.view)}을 캐릭터 가방에서 거래소로 이관해 판매 등록했습니다.`,
            },
      );
      await refresh(true, true);
    } catch (error) {
      if (handleUnauthorized(error)) return;
      await refresh(true, true);
      const current = syncCharacterInventory();
      const transferred = !current.items.some(
        (item) => item.id === candidate.gear.id,
      );
      if (transferred) {
        setConfirmation(null);
        setSelectedSellCandidateKey(null);
        setSellPrice("");
      }
      setNotice(
        transferred
          ? {
              tone: "success",
              message: `${formatMarketGearName(candidate.view)}의 이전 등록을 확인해 캐릭터 가방을 동기화했습니다.`,
            }
          : {
              tone: "error",
              message: `${marketRequestErrorCopy(error, "trade")} 가방의 장비는 그대로 보존했습니다.`,
            },
      );
    } finally {
      finishWorking();
    }
  }, [beginWorking, demoUser, finishWorking, handleUnauthorized, refresh, snapshot, syncCharacterInventory]);
  const accountReady = Boolean(
    snapshot &&
      !snapshot.account.restricted &&
      snapshot.account.steamLinked &&
      snapshot.account.gameOwned &&
      snapshot.account.steamOwnershipFresh,
  );
  const tradeEnabled = Boolean(snapshot?.capabilities.canTrade && (accountReady || localSandbox));
  const goldEnabled = Boolean(snapshot?.capabilities.canUseGoldExchange && (accountReady || localSandbox));
  const canCancelOwnEscrow = Boolean(snapshot && (snapshot.account.userId || localSandbox));
  const chargeEnabled = Boolean(snapshot?.capabilities.canTopUp && accountReady && snapshot.paymentMode === "steam");
  const orderPriceNumber = Math.max(0, Math.trunc(Number(orderPrice) || 0));
  const orderAmountNumber = Math.max(0, Math.trunc(Number(orderAmount) || 0));

  const activateListing = (listing: MarketListing) => {
    setSelectedListingId(listing.listingId);
    if (working || (listing.mine ? !canCancelOwnEscrow : !tradeEnabled)) return;
    openConfirmation(listing.mine
      ? { kind: "cancel-listing", listing }
      : { kind: "buy", listing });
  };

  const openOrderConfirmation = (event: FormEvent) => {
    event.preventDefault();
    if (!goldEnabled || orderPriceNumber <= 0 || orderAmountNumber <= 0) return;
    openConfirmation({
      kind: "order",
      side: orderSide,
      priceAshPerGold: orderPriceNumber,
      goldAmount: orderAmountNumber,
    });
  };

  const confirmAction = async () => {
    if (!confirmation || !snapshot) return;
    switch (confirmation.kind) {
      case "buy":
        await executeCommand(
          { action: "buy_listing", listingId: confirmation.listing.listingId, expectedListingVersion: confirmation.listing.version, expectedPriceAsh: confirmation.listing.priceAsh },
          `${formatMarketGearName(confirmation.listing.item)} 구매를 완료했습니다.`,
          confirmation.intentKey,
        );
        return;
      case "cancel-listing":
        await executeCommand(
          { action: "cancel_listing", listingId: confirmation.listing.listingId, expectedListingVersion: confirmation.listing.version },
          "판매 등록을 취소하고 장비를 거래 금고로 돌려보냈습니다.",
          confirmation.intentKey,
        );
        return;
      case "sell":
        if (confirmation.candidate.source === "character") {
          await executeCharacterListing(
            confirmation.candidate,
            confirmation.priceAsh,
            confirmation.intentKey,
            confirmation.serverItemId ?? "",
          );
          return;
        }
        await executeCommand(
          { action: "list_item", itemId: confirmation.candidate.view.itemId, priceAsh: confirmation.priceAsh, expiresInSeconds: 7 * 24 * 60 * 60, expectedItemVersion: confirmation.candidate.view.version },
          `${formatMarketGearName(confirmation.candidate.view)} 판매 등록을 완료했습니다.`,
          confirmation.intentKey,
        );
        return;
      case "order":
        await executeCommand(
          {
            action: "place_exchange",
            side: confirmation.side === "buy" ? "buy_gold" : "sell_gold",
            priceAshPerGold: confirmation.priceAshPerGold,
            goldAmount: confirmation.goldAmount,
          },
          `금괴 ${confirmation.side === "buy" ? "매수" : "매도"} 주문을 접수했습니다.`,
          confirmation.intentKey,
        );
        return;
      case "cancel-order":
        await executeCommand(
          { action: "cancel_exchange", orderId: confirmation.order.orderId, expectedOrderVersion: confirmation.order.version },
          "미체결 주문을 취소하고 보관 재화를 반환했습니다.",
          confirmation.intentKey,
        );
        return;
      case "fill-order":
        await executeCommand(
          {
            action: "fill_exchange",
            orderId: confirmation.order.orderId,
            goldAmount: confirmation.goldAmount,
            expectedOrderVersion: confirmation.order.version,
            expectedPriceAshPerGold: confirmation.order.priceAshPerGold,
          },
          "금괴 교환 체결을 완료했습니다.",
          confirmation.intentKey,
        );
        return;
      case "charge": {
        if (!beginWorking()) return;
        try {
          const result = await initializeSteamGoldPurchase(confirmation.packId, snapshot, { demoUser, idempotencyKey: confirmation.intentKey });
          if (result.snapshot) setSnapshot(result.snapshot);
          if (result.redirectUrl) window.location.assign(result.redirectUrl);
          else setNotice({ tone: "success", message: "Steam 결제창으로 이동합니다." });
          setConfirmation(null);
        } catch (error) {
          if (!handleUnauthorized(error)) {
            setNotice({ tone: "error", message: marketRequestErrorCopy(error, "payment") });
          }
        } finally {
          finishWorking();
        }
      }
    }
  };

  const confirmationCopy = confirmation ? getConfirmationCopy(confirmation) : null;

  return (
    <main className="market-screen" data-market-density={viewportDensity}>
      <div className="market-backdrop" aria-hidden="true" />
      <header className="market-topbar">
        <Link href="/?town=1" className="market-back-link">← 기억 광장으로</Link>
        <div className="market-brand">
          <span className="market-brand-seal" aria-hidden="true" />
          <div>
            <small>MUJINDO SECURE ECONOMY</small>
            <strong>기억 거래소</strong>
          </div>
        </div>
        <div className="market-sync-state" data-state={notice?.tone === "error" ? "error" : "online"}>
          <i aria-hidden="true" />
          <span>{refreshing ? "매물 갱신 중" : "실시간 갱신"}</span>
          <b>{lastSyncAt ? `${lastSyncAt.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}` : "대기"}</b>
          <button type="button" onClick={() => void refresh(false)} disabled={refreshing} aria-label="거래소 새로고침">↻</button>
        </div>
      </header>

      {fatalError?.status === 401 ? (
        <section className="market-fatal market-account-gate" role="alert">
          <strong>Steam 계정 연결이 필요합니다</strong>
          <p>{steamLinkError ?? "기억 거래소를 이용하려면 먼저 Steam으로 계정을 확인해 주세요. 연결을 마치면 이 화면으로 돌아옵니다."}</p>
          <a href={steamLinkUrl(steamReturnTo)}>Steam으로 시작</a>
        </section>
      ) : loading && !snapshot ? (
        <section className="market-loading" aria-live="polite">
          <i aria-hidden="true" />
          <strong>기억 거래소를 여는 중</strong>
          <span>내 장비와 최신 매물을 불러오고 있습니다.</span>
        </section>
      ) : snapshot ? (
        <>
          <section className="market-account-bar">
            <div className="market-account-identity">
              <span aria-hidden="true">{snapshot.account.displayName.slice(0, 1)}</span>
              <div>
                <small>{snapshot.account.steamLinked ? "STEAM 연결됨" : "STEAM 연결 필요"}</small>
                <strong>{snapshot.account.displayName || suggestedName || "미연동 방랑자"}</strong>
              </div>
              <b data-tier={snapshot.account.trustTier}>{TRUST_LABELS[snapshot.account.trustTier]}</b>
            </div>
            <BalanceCard symbol="✦" label="기억의 재" {...snapshot.wallet.memoryAsh} locked={snapshot.wallet.memoryAsh.locked72h} tone="ash" />
            <BalanceCard symbol="▰" label="금괴" {...snapshot.wallet.goldBars} locked={snapshot.wallet.goldBars.locked72h} tone="gold" />
          </section>

          <AccountGate snapshot={snapshot} local={local} />

          {steamLinkError && (
            <div className="market-notice market-notice--error market-steam-error" role="alert">
              <span>!</span>
              <p>{steamLinkError}</p>
              <a href={steamLinkUrl(steamReturnTo)}>Steam 다시 연결</a>
            </div>
          )}

          {paymentRetryAvailable && (
            <div className="market-payment-retry" role="alert">
              <p><strong>결제 결과를 다시 확인해 주세요</strong><span>승인된 주문 번호를 유지하고 있습니다. 새 결제를 만들지 않고 같은 주문을 다시 확인합니다.</span></p>
              <button type="button" disabled={working} onClick={() => { paymentReturnRef.current = null; setPaymentRetryAvailable(false); setPaymentRetryNonce((current) => current + 1); }}>결제 다시 확인</button>
            </div>
          )}

          {notice && (
            <div className={`market-notice market-notice--${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}>
              <span>{notice.tone === "success" ? "✓" : notice.tone === "error" ? "!" : "i"}</span>
              <p>{notice.message}</p>
              <button type="button" onClick={() => setNotice(null)} aria-label="알림 닫기">×</button>
            </div>
          )}

          <nav className="market-tabs" role="tablist" aria-label="기억 거래소 메뉴">
            {TABS.map((entry, index) => (
              <button
                key={entry.id}
                ref={(element) => { tabRefs.current[index] = element; }}
                type="button"
                role="tab"
                id={`market-tab-${entry.id}`}
                aria-controls={`market-panel-${entry.id}`}
                aria-selected={tab === entry.id}
                tabIndex={tab === entry.id ? 0 : -1}
                className={tab === entry.id ? "is-active" : ""}
                onClick={() => changeTab(entry.id)}
                onKeyDown={(event) => handleTabKeyDown(event, index)}
              >
                <small>{entry.eyebrow}</small>
                <strong>{entry.label}</strong>
              </button>
            ))}
          </nav>

          {tab === "auction" && (
            <section className="market-panel market-auction market-auction-window" id="market-panel-auction" role="tabpanel" aria-labelledby="market-tab-auction">
              <header className="market-auction-heading">
                <span className="market-auction-crest" aria-hidden="true" />
                <div><small>MUJINDO AUCTION REGISTRY</small><h1>기억 장비 옥션</h1><p>검색·시세·관심 목록·판매·완료 기록을 하나의 전면 작업창에서 관리합니다.</p></div>
                <dl><div><dt>공개 매물</dt><dd>{listings.length}</dd></div><div><dt>내 판매</dt><dd>{ownListings.length}</dd></div><div><dt>관심</dt><dd>{favoriteListingIds.length}/10</dd></div></dl>
              </header>

              <nav className="market-auction-tabs" role="tablist" aria-label="장비 옥션 작업 메뉴">
                {AUCTION_VIEWS.map((view, index) => (
                  <button
                    key={view.id}
                    ref={(element) => { auctionViewRefs.current[index] = element; }}
                    type="button"
                    role="tab"
                    id={`market-auction-tab-${view.id}`}
                    aria-controls={`market-auction-view-${view.id}`}
                    aria-selected={auctionView === view.id}
                    tabIndex={auctionView === view.id ? 0 : -1}
                    className={auctionView === view.id ? "is-active" : ""}
                    onClick={() => changeAuctionView(view.id)}
                    onKeyDown={(event) => handleAuctionViewKeyDown(event, index)}
                  >
                    <small>{view.eyebrow}</small>
                    <strong>{view.label}</strong>
                    {view.id === "favorites" && favoriteListingIds.length > 0 && <b>{favoriteListingIds.length}</b>}
                  </button>
                ))}
              </nav>

              {auctionView === "search" && (
                <div className="market-auction-workspace market-search-workspace" id="market-auction-view-search" role="tabpanel" aria-labelledby="market-auction-tab-search">
                  <form className="market-auction-search" onSubmit={applyAuctionSearch} aria-label="장비 상세 검색">
                    <header><small>ADVANCED SEARCH</small><h2>검색 조건</h2><p>원하는 장비 조건을 고른 뒤 검색을 시작하세요.</p></header>
                    <label className="market-search"><span>빠른 장비 검색</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="장비 이름" autoComplete="off" /><i aria-hidden="true">⌕</i></label>
                    <label><span>장비 등급</span><select value={rarity} onChange={(event) => setRarity(event.target.value as MarketRarity | "all")}><option value="all">전체 등급</option>{MARKET_RARITIES.map((value) => <option key={value} value={value}>{RARITY_LABELS[value]}</option>)}</select></label>
                    <label><span>장비 부위</span><select value={slot} onChange={(event) => setSlot(event.target.value as MarketSlot | "all")}><option value="all">전체 부위</option>{MARKET_SLOTS.map((value) => <option key={value} value={value}>{SLOT_LABELS[value]}</option>)}</select></label>
                    <label><span>결과 정렬</span><select value={sort} onChange={(event) => setSort(event.target.value as NonNullable<MarketSearch["sort"]>)}><option value="recent">최근 등록순</option><option value="price-low">낮은 가격순</option><option value="price-high">높은 가격순</option><option value="power">보스 화력순</option><option value="level">레벨순</option></select></label>
                    <div className="market-filter-actions"><button type="button" onClick={resetAuctionSearch}>조건 초기화</button><button type="submit">검색 시작</button></div>
                    <p className="market-filter-note">매물을 선택하면 아래 상세 영역에서 관심 등록이나 구매를 진행할 수 있습니다.</p>
                  </form>

                  <section className="market-search-results" aria-labelledby="market-search-results-title" aria-describedby="market-search-status" aria-busy={refreshing}>
                    <header className="market-workspace-heading"><div><small>LIVE LISTINGS</small><h2 id="market-search-results-title">검색 결과</h2></div><span id="market-search-status" role="status" aria-live="polite">{marketSearchError ? "검색 오류" : `${listings.length}개 · 최대 60개 표본 · ${refreshing ? "갱신 중" : "최신 매물"}`}</span></header>
                    <div className="market-listings game-scrollbar" aria-label="판매 장비 목록" aria-describedby="market-search-status">
                      <header><span>장비 정보</span><span>판매자</span><span>남은 시간</span><span>판매가</span></header>
                      {marketSearchError ? <MarketSearchErrorState message={marketSearchError} onRetry={() => void refresh(false)} /> : listings.length === 0 ? <EmptyState title="조건에 맞는 매물이 없습니다" body="검색 조건을 바꾸거나 잠시 뒤 다시 검색해 주세요." /> : listings.map((listing) => <ListingRow key={listing.listingId} listing={listing} selected={selectedListingId === listing.listingId} onSelect={(next) => setSelectedListingId(next.listingId)} />)}
                    </div>
                    <footer className={`market-selection-bar ${selectedListing ? "has-selection" : ""}`}>
                      {selectedListing ? <><ItemIcon item={selectedListing.item} compact /><div className="market-selection-summary"><small>선택 매물 · {selectedListing.sellerName}</small><strong>{formatMarketGearName(selectedListing.item)}</strong><span>✦ {formatEconomyAmount(selectedListing.priceAsh)} · {remainingLabel(selectedListing.expiresAt)}</span></div><MarketItemDetails item={selectedListing.item} /></> : <div><small>SELECT A LISTING</small><strong>매물을 선택해 상세 거래 명령을 활성화하세요</strong><span>가격과 장비 정보를 확인한 뒤 최종 확인창에서 거래합니다.</span></div>}
                      <div className="market-selection-actions"><button type="button" disabled={!selectedListing} className={selectedListing && favoriteListingIds.includes(selectedListing.listingId) ? "is-active" : ""} onClick={() => selectedListing && toggleFavorite(selectedListing.listingId)}>{selectedListing && favoriteListingIds.includes(selectedListing.listingId) ? "관심 해제" : "관심 등록"}</button><button type="button" disabled={!selectedListing || working || (selectedListing.mine ? !canCancelOwnEscrow : !tradeEnabled)} className={selectedListing?.mine ? "is-cancel" : "is-primary"} onClick={() => selectedListing && activateListing(selectedListing)}>{selectedListing?.mine ? "등록 취소" : "즉시 구매"}</button></div>
                    </footer>
                  </section>
                </div>
              )}

              {auctionView === "price" && (
                <section className="market-auction-workspace market-price-workspace" id="market-auction-view-price" role="tabpanel" aria-labelledby="market-auction-tab-price">
                  <header className="market-workspace-heading"><div><small>LIVE ASKING PRICES</small><h2>현재 매물 호가</h2></div><p>현재 검색 결과 최대 60개 표본에서 강화·레벨·품질·옵션이 같은 장비끼리만 묶습니다. 실제 체결가는 아래 거래 이력에서 따로 확인합니다.</p></header>
                  <div className="market-price-table game-scrollbar">
                    <header><span>장비</span><span>매물</span><span>최저가</span><span>중앙값</span><span>평균가</span><span>연결</span></header>
                    {marketSearchError ? <MarketSearchErrorState message={marketSearchError} onRetry={() => void refresh(false)} /> : priceSummaries.length === 0 ? <EmptyState title="집계할 매물이 없습니다" body="장비 검색에서 다른 조건으로 매물을 찾아보세요." /> : priceSummaries.map((summary) => (
                      <article key={summary.fingerprint} style={{ "--rarity-color": RARITY_COLORS[summary.listing.item.rarity] } as CSSProperties}>
                        <div><ItemIcon item={summary.listing.item} compact /><span><small>{SLOT_LABELS[summary.listing.item.slot]} · {RARITY_LABELS[summary.listing.item.rarity]}</small><strong>{summary.listing.item.baseName}</strong><em title={marketItemOptionSummary(summary.listing.item)}>강화 +{normalizeGearEnhancement(summary.listing.item.enhancement)} · 품질 {summary.listing.item.qualityScore} · 화력 {formatEconomyAmount(summary.listing.item.powerScore)}</em></span></div>
                        <b>{summary.count}건</b><strong>✦ {formatEconomyAmount(summary.lowest)}</strong><span>✦ {formatEconomyAmount(summary.median)}</span><span>✦ {formatEconomyAmount(summary.average)}</span>
                        <button type="button" aria-label={`${formatMarketGearName(summary.listing.item)} 최저가 매물 보기`} onClick={() => { changeAuctionView("search"); setSelectedListingId(summary.listing.listingId); }}>최저가 매물</button>
                      </article>
                    ))}
                  </div>
                  <section className="market-auction-trades" aria-labelledby="market-auction-trades-title">
                    <header className="market-workspace-heading"><div><small>COMPLETED SALES</small><h2 id="market-auction-trades-title">실제 체결 이력</h2></div><p>판매 희망가와 분리된 최근 실제 거래 가격입니다. 강화·품질·옵션을 함께 비교하세요.</p></header>
                    <div className="market-auction-trade-list game-scrollbar">
                      {snapshot.auctionTrades.length === 0 ? <EmptyState title="아직 체결된 장비가 없습니다" body="첫 장비 거래가 완료되면 실제 체결가가 이곳에 표시됩니다." /> : snapshot.auctionTrades.map((trade) => (
                        <article key={trade.tradeId} style={{ "--rarity-color": RARITY_COLORS[trade.item.rarity] } as CSSProperties}>
                          <div><ItemIcon item={trade.item} compact /><span><small>{SLOT_LABELS[trade.item.slot]} · {RARITY_LABELS[trade.item.rarity]}</small><strong>{formatMarketGearName(trade.item)}</strong><em>{marketItemOptionSummary(trade.item)}</em></span></div>
                          <dl><div><dt>강화</dt><dd>+{normalizeGearEnhancement(trade.item.enhancement)}</dd></div><div><dt>품질</dt><dd>{trade.item.qualityScore}</dd></div><div><dt>보스 화력</dt><dd>{formatEconomyAmount(trade.item.powerScore)}</dd></div></dl>
                          <strong>✦ {formatEconomyAmount(trade.priceAsh)}</strong>
                          <time dateTime={trade.executedAt}>{formatDate(trade.executedAt)}</time>
                        </article>
                      ))}
                    </div>
                  </section>
                </section>
              )}

              {auctionView === "favorites" && (
                <section className="market-auction-workspace market-favorites-workspace" id="market-auction-view-favorites" role="tabpanel" aria-labelledby="market-auction-tab-favorites">
                  <header className="market-workspace-heading"><div><small>WATCH LIST · 10 SLOTS</small><h2>관심 목록</h2></div><p>이 계정의 브라우저에 최대 10개를 보관하며, 서버의 최신 공개 매물 표본에서 확인되는 항목을 보여줍니다.</p></header>
                  <div className="market-listings game-scrollbar" aria-label="관심 매물 목록">
                    <header><span>장비 정보</span><span>판매자</span><span>남은 시간</span><span>판매가</span></header>
                    {favoriteListings.length === 0 ? favoriteListingIds.length > 0 ? <section className="market-favorites-unresolved"><EmptyState title="현재 공개 매물 표본에서 확인할 수 없습니다" body="종료된 것으로 단정하지 않습니다. 매물 다시 확인을 누르거나 장비 검색에서 같은 매물을 찾아 주세요." /><div><button type="button" disabled={refreshing} onClick={() => void refresh(false)}>매물 다시 확인</button></div></section> : <EmptyState title="관심 매물이 없습니다" body="장비 검색에서 매물을 고른 뒤 관심 등록을 눌러 주세요." /> : favoriteListings.map((listing) => <ListingRow key={listing.listingId} listing={listing} selected={selectedListingId === listing.listingId} onSelect={(next) => setSelectedListingId(next.listingId)} />)}
                  </div>
                  <footer className="market-selection-bar market-favorite-actions"><div><small>{unresolvedFavoriteCount > 0 ? `현재 표본에서 미확인 ${unresolvedFavoriteCount}개` : "WATCH LIST READY"}</small><strong>{selectedListing ? formatMarketGearName(selectedListing.item) : "거래할 관심 매물을 선택하세요"}</strong><span>{selectedListing ? `✦ ${formatEconomyAmount(selectedListing.priceAsh)}` : "선택한 매물은 중앙 확인창에서 구매합니다."}</span></div><div className="market-selection-actions">{unresolvedFavoriteCount > 0 && <button type="button" onClick={clearUnresolvedFavorites}>미확인 정리</button>}<button type="button" disabled={!selectedListing} onClick={() => selectedListing && toggleFavorite(selectedListing.listingId)}>목록에서 삭제</button><button type="button" className="is-primary" disabled={!tradeEnabled || !selectedListing || selectedListing.mine || working} onClick={() => selectedListing && activateListing(selectedListing)}>즉시 구매</button></div></footer>
                </section>
              )}

              {auctionView === "sell" && (
                <section className="market-auction-workspace market-sell-workspace" id="market-auction-view-sell" role="tabpanel" aria-labelledby="market-auction-tab-sell">
                  <header className="market-workspace-heading"><div><small>{localSandbox ? "CHARACTER BAG · TRADE VAULT" : "TRADE VAULT"}</small><h2 id="market-vault-title">판매 등록</h2></div><p>판매 전용 작업면입니다. 검색 화면을 가리지 않고 장비 선택부터 등록까지 이곳에서 처리합니다.</p></header>
                  {localSandbox ? <div className="market-local-warning"><span aria-hidden="true">↗</span><p><strong>캐릭터 가방 · 슬롯 {characterInventory.slot}</strong>등록한 장비는 거래 금고에 보관되며, 판매 등록이 완료된 뒤에만 가방에서 빠집니다.{characterInventory.equippedCount > 0 ? ` 장착 중인 장비 ${characterInventory.equippedCount}개는 먼저 해제해 주세요.` : ""}</p></div> : <div className="market-local-warning is-secure"><span aria-hidden="true">◇</span><p><strong>거래 금고 장비만 등록할 수 있습니다</strong>캐릭터 가방 장비 판매는 안전한 보관 확인 기능이 준비된 뒤 지원됩니다. 지금은 거래 금고에 있는 장비를 선택해 주세요.</p></div>}
                  <div className="market-sell-toolbar"><div role="group" aria-label="판매 장비 출처"><button type="button" className={effectiveSellSource === "all" ? "is-active" : ""} aria-pressed={effectiveSellSource === "all"} onClick={() => setSellSource("all")}>전체 {sellCandidates.length}</button>{localSandbox && <button type="button" className={effectiveSellSource === "character" ? "is-active" : ""} aria-pressed={effectiveSellSource === "character"} onClick={() => setSellSource("character")}>캐릭터 가방 {sellCandidates.filter((candidate) => candidate.source === "character").length}</button>}<button type="button" className={effectiveSellSource === "vault" ? "is-active" : ""} aria-pressed={effectiveSellSource === "vault"} onClick={() => setSellSource("vault")}>거래 금고 {sellCandidates.filter((candidate) => candidate.source === "vault").length}</button></div><label><span>장비 부위</span><select value={sellSlot} onChange={(event) => setSellSlot(event.target.value as MarketSlot | "all")}><option value="all">전체 부위</option>{MARKET_SLOTS.map((value) => <option key={value} value={value}>{SLOT_LABELS[value]}</option>)}</select></label></div>
                  <div className="market-vault-list game-scrollbar" aria-label="판매 가능한 장비 보관함">
                    {visibleSellCandidates.length === 0 ? <EmptyState title="판매 가능한 장비가 없습니다" body={localSandbox ? "원정에서 획득한 장비를 가방에 보관하거나 장착 장비를 해제하면 이곳에 나타납니다." : "거래 금고에 판매 가능한 장비가 들어오면 이곳에 표시됩니다."} /> : visibleSellCandidates.map((candidate) => (
                      <button key={candidate.key} type="button" className={selectedSellCandidateKey === candidate.key ? "is-selected" : ""} style={{ "--rarity-color": RARITY_COLORS[candidate.view.rarity] } as CSSProperties} aria-pressed={selectedSellCandidateKey === candidate.key} onClick={() => setSelectedSellCandidateKey(candidate.key)}><ItemIcon item={candidate.view} compact /><span><small>{candidate.source === "character" ? `캐릭터 가방 ${candidate.saveSlot}번` : "거래 금고"} · {formatMarketGearLevel(candidate.view)} · {RARITY_LABELS[candidate.view.rarity]}</small><strong>{formatMarketGearName(candidate.view)}</strong><em>보스 화력 {formatEconomyAmount(candidate.view.powerScore)}</em></span><i aria-hidden="true">›</i></button>
                    ))}
                  </div>
                  <form className="market-sell-form" onSubmit={(event) => { event.preventDefault(); const price = Math.max(0, Math.trunc(Number(sellPrice) || 0)); if (selectedSellCandidate && price > 0 && tradeEnabled) openConfirmation({ kind: "sell", candidate: selectedSellCandidate, priceAsh: price }); }}>
                    <div className="market-sell-selection">{selectedSellCandidate ? <><ItemIcon item={selectedSellCandidate.view} compact /><span><small>판매 선택 · {selectedSellCandidate.source === "character" ? "캐릭터 가방" : "거래 금고"}</small><strong>{formatMarketGearName(selectedSellCandidate.view)}</strong><em>{RARITY_LABELS[selectedSellCandidate.view.rarity]} · 보스 화력 {formatEconomyAmount(selectedSellCandidate.view.powerScore)}</em></span></> : <span><small>SELECT EQUIPMENT</small><strong>판매할 장비를 먼저 선택하세요</strong><em>선택 후 가격을 입력하면 중앙 확인창이 열립니다.</em></span>}</div>
                    <label><span>판매 희망가 · 기억의 재</span><input type="number" min="1" step="1" inputMode="numeric" value={sellPrice} onChange={(event) => setSellPrice(event.target.value)} placeholder="가격 입력" /></label>
                    <button type="submit" disabled={!tradeEnabled || !selectedSellCandidate || Number(sellPrice) <= 0 || working}>판매 등록 확인</button>
                  </form>
                  <section className="market-active-listings" aria-labelledby="market-active-listings-title"><header className="market-workspace-heading"><div><small>ACTIVE SALES</small><h2 id="market-active-listings-title">판매 중 목록</h2></div><span>{ownListings.length}개 사용 중</span></header><div className="market-listings">{ownListings.length === 0 ? <EmptyState title="판매 중인 장비가 없습니다" body="위 보관함에서 장비와 가격을 정해 등록해 주세요." /> : ownListings.map((listing) => <ListingRow key={listing.listingId} listing={listing} selected={selectedListingId === listing.listingId} onSelect={(next) => setSelectedListingId(next.listingId)} />)}</div>{ownListings.length > 0 && <button type="button" className="market-cancel-selected" disabled={!canCancelOwnEscrow || !selectedListing?.mine || working} onClick={() => selectedListing?.mine && activateListing(selectedListing)}>선택 매물 등록 취소</button>}</section>
                </section>
              )}

              {auctionView === "complete" && (
                <section className="market-auction-workspace market-complete-workspace" id="market-auction-view-complete" role="tabpanel" aria-labelledby="market-auction-tab-complete">
                  <header className="market-workspace-heading"><div><small>TRADE HISTORY</small><h2>거래 완료</h2></div><p>구매 장비와 판매 대금은 거래 금고와 지갑에 바로 정산됩니다. 최근 처리 내역을 이곳에서 확인하세요.</p></header>
                  <div className="market-complete-summary"><div><small>수령 대기</small><strong>0</strong><span>즉시 정산</span></div><div><small>활성 판매</small><strong>{ownListings.length}</strong><span>판매 탭에서 관리</span></div><div><small>최근 거래</small><strong>{snapshot.myAuctionTrades.length}</strong><span>체결 완료</span></div></div>
                  <div className="market-complete-list game-scrollbar">
                    {snapshot.myAuctionTrades.length === 0 ? <EmptyState title="완료된 거래 기록이 없습니다" body="장비 구매나 판매가 실제로 체결되면 최근 내역이 이곳에 표시됩니다." /> : snapshot.myAuctionTrades.map((trade) => <article key={trade.tradeId}><span aria-hidden="true">✓</span><div><small>{trade.role === "buyer" ? "구매 완료" : "판매 완료"}</small><strong>{formatMarketGearName(trade.item)}</strong><p>{trade.role === "buyer" ? `${trade.counterpartName}에게서 구매` : `${trade.counterpartName}에게 판매`} · ✦ {formatEconomyAmount(trade.priceAsh)}</p></div><time dateTime={trade.executedAt}>{formatDate(trade.executedAt)}</time><b>{trade.role === "buyer" ? "구매" : "판매"}</b></article>)}
                  </div>
                </section>
              )}
            </section>
          )}

          {tab === "gold" && (
            <section className="market-panel market-exchange" id="market-panel-gold" role="tabpanel" aria-labelledby="market-tab-gold">
              <div className="market-panel-heading"><div><small>PLAYER-TO-PLAYER EXCHANGE</small><h1>금괴 교환소</h1></div><p>원하는 가격과 수량으로 주문하거나 호가창의 상대 주문을 선택해 즉시 교환하세요. 미체결 주문의 재화는 안전하게 보관됩니다.</p></div>
              <div className="market-ticker">
                <div><small>최근 체결가</small><strong>{snapshot.goldExchange.lastPrice === null ? "—" : `✦ ${formatEconomyAmount(snapshot.goldExchange.lastPrice)}`}</strong><span>금괴 1개당 기억의 재</span></div>
                <div><small>최우선 매수</small><strong>{snapshot.goldExchange.bestBid === null ? "—" : formatEconomyAmount(snapshot.goldExchange.bestBid)}</strong><span>BID</span></div>
                <div><small>최우선 매도</small><strong>{snapshot.goldExchange.bestAsk === null ? "—" : formatEconomyAmount(snapshot.goldExchange.bestAsk)}</strong><span>ASK</span></div>
                <div><small>가격 차이</small><strong>{snapshot.goldExchange.bestBid !== null && snapshot.goldExchange.bestAsk !== null ? formatEconomyAmount(Math.max(0, snapshot.goldExchange.bestAsk - snapshot.goldExchange.bestBid)) : "—"}</strong><span>SPREAD</span></div>
              </div>
              <div className="market-exchange-layout">
                <section className="market-orderbook" aria-labelledby="orderbook-title">
                  <header><div><small>LIVE ORDER BOOK</small><h2 id="orderbook-title">실시간 호가</h2></div><span>자동 갱신</span></header>
                  <div className="market-orderbook-head"><span>구분</span><span>금괴 1개 가격</span><span>잔량</span><span>주문</span></div>
                  <div className="market-book-side is-ask"><small>매도 호가</small>{snapshot.goldExchange.asks.length === 0 ? <p>대기 매도 주문 없음</p> : snapshot.goldExchange.asks.slice(0, 8).reverse().map((level, index) => <div key={`ask-${level.priceAshPerGold}-${index}`}><b>매도</b><strong>✦ {formatEconomyAmount(level.priceAshPerGold)}</strong><span>▰ {formatEconomyAmount(level.goldAmount)}</span><em>{level.orderCount}건</em></div>)}</div>
                  <div className="market-book-mid"><span>MARKET PRICE</span><strong>{snapshot.goldExchange.lastPrice === null ? "체결 기록 없음" : `✦ ${formatEconomyAmount(snapshot.goldExchange.lastPrice)}`}</strong></div>
                  <div className="market-book-side is-bid"><small>매수 호가</small>{snapshot.goldExchange.bids.length === 0 ? <p>대기 매수 주문 없음</p> : snapshot.goldExchange.bids.slice(0, 8).map((level, index) => <div key={`bid-${level.priceAshPerGold}-${index}`}><b>매수</b><strong>✦ {formatEconomyAmount(level.priceAshPerGold)}</strong><span>▰ {formatEconomyAmount(level.goldAmount)}</span><em>{level.orderCount}건</em></div>)}</div>
                </section>

                <section className="market-order-entry" aria-labelledby="order-entry-title">
                  <header><small>PLACE ORDER</small><h2 id="order-entry-title">금괴 주문</h2></header>
                  <div className="market-order-side" role="group" aria-label="주문 종류"><button type="button" className={orderSide === "buy" ? "is-active" : ""} aria-pressed={orderSide === "buy"} onClick={() => setOrderSide("buy")}>금괴 매수</button><button type="button" className={orderSide === "sell" ? "is-active" : ""} aria-pressed={orderSide === "sell"} onClick={() => setOrderSide("sell")}>금괴 매도</button></div>
                  <form onSubmit={openOrderConfirmation}>
                    <label><span>금괴 1개 가격</span><div><i>✦</i><input type="number" min="1" step="1" inputMode="numeric" value={orderPrice} onChange={(event) => setOrderPrice(event.target.value)} placeholder="기억의 재" /></div></label>
                    <label><span>주문 수량</span><div><i>▰</i><input type="number" min="1" step="1" inputMode="numeric" value={orderAmount} onChange={(event) => setOrderAmount(event.target.value)} placeholder="금괴" /></div></label>
                    <dl><div><dt>주문 총액</dt><dd>✦ {formatEconomyAmount(orderPriceNumber * orderAmountNumber)}</dd></div><div><dt>보관될 재화</dt><dd>{orderSide === "buy" ? "기억의 재" : "금괴"}</dd></div></dl>
                    <button type="submit" disabled={!goldEnabled || orderPriceNumber <= 0 || orderAmountNumber <= 0 || working}>{orderSide === "buy" ? "매수 주문 확인" : "매도 주문 확인"}</button>
                  </form>
                  <div className="market-instant-orders">
                    <small>즉시 체결 가능한 상대 주문</small>
                    {snapshot.goldExchange.orders
                      .filter((order) => !order.mine && order.side !== orderSide && (order.status === "open" || order.status === "partial"))
                      .slice(0, 3)
                      .map((order) => (
                        <button
                          type="button"
                          key={order.orderId}
                          disabled={!goldEnabled || working}
                          onClick={() => openConfirmation({ kind: "fill-order", order, goldAmount: Math.min(order.remainingGold, Math.max(1, orderAmountNumber || order.remainingGold)) })}
                        >
                          <span>{order.side === "sell" ? "금괴 매수" : "금괴 매도"}</span>
                          <strong>✦ {formatEconomyAmount(order.priceAshPerGold)} · ▰ {formatEconomyAmount(order.remainingGold)}</strong>
                          <b>체결</b>
                        </button>
                      ))}
                  </div>
                  <p>주문 제출 즉시 필요한 재화가 거래 보관 잔액으로 이동합니다. 취소 시 미체결분만 반환됩니다.</p>
                </section>

                <section className="market-my-orders" aria-labelledby="my-orders-title">
                  <header><div><small>OPEN ORDERS</small><h2 id="my-orders-title">내 미체결 주문</h2></div><b>{snapshot.goldExchange.myOrders.filter((order) => order.status === "open" || order.status === "partial").length}</b></header>
                  {snapshot.goldExchange.myOrders.length === 0 ? <EmptyState title="열린 주문이 없습니다" body="매수 또는 매도 주문을 등록하면 체결 상황을 확인할 수 있습니다." /> : snapshot.goldExchange.myOrders.map((order) => <article key={order.orderId} className={`is-${order.side}`}><span><small>{order.side === "buy" ? "금괴 매수" : "금괴 매도"} · {ORDER_STATUS_LABELS[order.status]}</small><strong>▰ {formatEconomyAmount(order.remainingGold)} / {formatEconomyAmount(order.goldAmount)}</strong></span><span><small>금괴 1개당</small><strong>✦ {formatEconomyAmount(order.priceAshPerGold)}</strong></span><button type="button" aria-label={`${order.side === "buy" ? "금괴 매수" : "금괴 매도"} 주문 취소 · 미체결 ${formatEconomyAmount(order.remainingGold)}개`} disabled={working || !(order.status === "open" || order.status === "partial")} onClick={() => openConfirmation({ kind: "cancel-order", order })}>주문 취소</button></article>)}
                </section>

                <section className="market-trade-tape" aria-labelledby="trade-tape-title">
                  <header><small>MATCHED TRADES</small><h2 id="trade-tape-title">최근 체결</h2></header>
                  {snapshot.goldExchange.recentTrades.length === 0 ? <EmptyState title="아직 체결 기록이 없습니다" body="첫 교환이 성사되면 익명화된 시세가 표시됩니다." /> : snapshot.goldExchange.recentTrades.slice(0, 8).map((trade) => <div key={trade.tradeId}><time>{formatDate(trade.executedAt)}</time><strong>✦ {formatEconomyAmount(trade.priceAshPerGold)}</strong><span>▰ {formatEconomyAmount(trade.goldAmount)}</span></div>)}
                </section>
              </div>
            </section>
          )}

          {tab === "charge" && (
            <section className="market-panel market-charge" id="market-panel-charge" role="tabpanel" aria-labelledby="market-tab-charge">
              <div className="market-panel-heading"><div><small>STEAM WALLET</small><h1>금괴 충전</h1></div><p>Steam 결제를 마치면 금괴가 지급됩니다. 새로 충전한 금괴는 72시간 뒤부터 교환할 수 있습니다.</p></div>
              <section className="market-charge-hero"><span className="market-gold-stack" aria-hidden="true"><i /><i /><i /></span><div><small>PREMIUM EXCHANGE TOKEN</small><h2>금괴</h2><p>편의 상품 구매와 유저 간 기억의 재 교환에 사용하는 거래 재화입니다. 장비 성능을 직접 판매하지 않습니다.</p></div><dl><div><dt>사용 가능</dt><dd>▰ {formatEconomyAmount(snapshot.wallet.goldBars.available)}</dd></div><div><dt>72시간 잠금</dt><dd>▰ {formatEconomyAmount(snapshot.wallet.goldBars.locked72h)}</dd></div></dl></section>
              <div className="market-pack-grid">{GOLD_PACKS.map((pack) => <article key={pack.id}><span aria-hidden="true">▰</span><small>{pack.label}</small><strong>{pack.gold}<i> 금괴</i></strong><b>{pack.priceKrw.toLocaleString("ko-KR")}원</b><button type="button" disabled={!chargeEnabled || working} onClick={() => openConfirmation({ kind: "charge", packId: pack.id, goldAmount: pack.gold, priceKrw: pack.priceKrw })}>{chargeEnabled ? "Steam으로 충전" : "결제 잠김"}</button></article>)}</div>
              <section className="market-charge-policy"><div><strong>72시간 교환 잠금</strong><p>새로 충전한 금괴는 결제 보호 기간 동안 교환소에서 사용할 수 없습니다. 남은 시간은 보유 금괴 영역에서 확인할 수 있습니다.</p></div><div><strong>결제 결과 확인</strong><p>Steam 결제가 정상 완료된 주문에만 금괴가 지급됩니다. 문제가 생기면 결제 내역과 함께 다시 확인해 주세요.</p></div><div><strong>환불·청약 정보</strong><p>구매 전 Steam 결제창에서 최종 금액과 환불 조건을 확인하세요. 사용 또는 교환된 금괴는 별도 정책이 적용될 수 있습니다.</p></div></section>
            </section>
          )}

          {tab === "security" && (
            <section className="market-panel market-security" id="market-panel-security" role="tabpanel" aria-labelledby="market-tab-security">
              <div className="market-panel-heading"><div><small>ACCOUNT PROTECTION</small><h1>보안센터</h1></div><p>Steam 연결, 거래 이용 상태, 최근 계정 활동을 한곳에서 확인할 수 있습니다.</p></div>
              {snapshot.account.restricted && <div className="market-sanction"><span aria-hidden="true">!</span><div><small>ACCOUNT PROTECTION</small><strong>거래 기능이 제한되었습니다</strong><p>계정 보호를 위해 거래가 잠시 중단되었습니다. Steam 계정 상태를 확인한 뒤 다시 이용해 주세요.</p></div></div>}
              <div className="market-security-grid">
                <section className="market-verification"><header><small>ACCOUNT STATUS</small><h2>계정 상태</h2></header><ol><li className={snapshot.account.steamLinked ? "is-complete" : ""}><span>1</span><div><strong>Steam 계정 연결</strong><p>{snapshot.account.steamLinked ? `연결 완료${snapshot.account.steamId ? ` · …${snapshot.account.steamId.slice(-6)}` : ""}` : "장비 거래를 이용하려면 Steam 계정을 연결해 주세요."}</p></div>{!snapshot.account.steamLinked && <a href={steamLinkUrl("/market?tab=security")}>Steam 연결</a>}</li><li className={snapshot.account.gameOwned && snapshot.account.steamOwnershipFresh ? "is-complete" : ""}><span>2</span><div><strong>게임 소유권</strong><p>{snapshot.account.gameOwned && snapshot.account.steamOwnershipFresh ? "확인 완료" : snapshot.account.gameOwned ? "확인 시간이 만료되었습니다. 다시 확인해 주세요." : "연결한 계정의 게임 소유권을 확인해 주세요."}</p></div>{snapshot.account.steamLinked && !snapshot.account.restricted && (!snapshot.account.gameOwned || !snapshot.account.steamOwnershipFresh) && <a href={steamLinkUrl("/market?tab=security")}>Steam 다시 확인</a>}</li><li className={snapshot.capabilities.canTrade ? "is-complete" : ""}><span>3</span><div><strong>장비 거래</strong><p>{snapshot.capabilities.canTrade ? "이용 가능" : "현재 이용할 수 없습니다."}</p></div></li><li className={!snapshot.account.restricted ? "is-complete" : ""}><span>4</span><div><strong>계정 제한</strong><p>{snapshot.account.restricted ? "거래 제한 적용 중" : "적용된 제한 없음"}</p></div></li></ol></section>
                <section className="market-security-status"><header><small>LIVE SECURITY STATE</small><h2>현재 보호 상태</h2></header><dl><div><dt>계정 이름</dt><dd>{snapshot.account.displayName}</dd></div><div><dt>Steam 연결</dt><dd>{snapshot.account.steamLinked ? "연결됨" : "연결 필요"}</dd></div><div><dt>최근 로그인</dt><dd>{formatDate(snapshot.security.lastLoginAt)}</dd></div><div><dt>게임 소유권</dt><dd>{snapshot.account.gameOwned && snapshot.account.steamOwnershipFresh ? "확인됨" : snapshot.account.gameOwned ? "재확인 필요" : "확인 필요"}</dd></div><div><dt>교환 잠금 해제</dt><dd>{formatDate(snapshot.security.withdrawalLockUntil)}</dd></div><div><dt>장비 거래</dt><dd>{snapshot.capabilities.canTrade ? "이용 가능" : "이용 제한"}</dd></div></dl></section>
                <section className="market-security-rules"><header><small>TRADE PROTECTION</small><h2>거래 보호 안내</h2></header><ul><li><strong>잔액 확인</strong><span>구매 직전 가격과 사용 가능한 재화를 다시 확인합니다.</span></li><li><strong>거래 결과 확인</strong><span>장비와 대금이 모두 반영된 거래만 완료 내역에 표시됩니다.</span></li><li><strong>변경 상태 안내</strong><span>가격이나 수량이 달라지면 거래를 멈추고 최신 정보를 보여드립니다.</span></li><li><strong>계정 보호</strong><span>이상 거래가 감지되면 거래를 제한하고 계정 상태를 안내합니다.</span></li></ul></section>
                <section className="market-audit"><header><small>RECENT ACTIVITY</small><h2>최근 계정 활동</h2></header>{snapshot.security.auditTrail.length === 0 ? <EmptyState title="표시할 활동이 없습니다" body="로그인하거나 장비를 거래하면 최근 내역이 이곳에 표시됩니다." /> : <div>{snapshot.security.auditTrail.slice(0, 8).map((entry) => <article key={entry.id}><span aria-hidden="true">◇</span><p><strong>{accountActivityLabel(entry.category)}</strong><small>{accountActivityDescription(entry.category)} · {formatDate(entry.createdAt)}</small></p></article>)}</div>}</section>
              </div>
            </section>
          )}
        </>
      ) : (
        <section className="market-fatal" role="alert"><strong>거래 정보를 불러올 수 없습니다</strong><p>잠시 후 다시 시도하거나 기억 광장으로 돌아가 주세요.</p><button type="button" onClick={() => void refresh(false)}>다시 시도</button></section>
      )}

      {confirmation && confirmationCopy && (
        <div className="market-confirm-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !workingRef.current) setConfirmation(null); }}>
          <section ref={confirmationDialogRef} className="market-confirm" role="alertdialog" aria-modal="true" aria-labelledby="market-confirm-title" aria-describedby="market-confirm-body" tabIndex={-1}>
            <span className="market-confirm-sigil" aria-hidden="true">◇</span><small>TRADE CONFIRMATION</small><h2 id="market-confirm-title">{confirmationCopy.title}</h2><p id="market-confirm-body">{confirmationCopy.body}</p><dl>{confirmationCopy.rows.map((row) => <div key={row[0]}><dt>{row[0]}</dt><dd>{row[1]}</dd></div>)}</dl><div><button type="button" autoFocus disabled={working} onClick={() => { if (!workingRef.current) setConfirmation(null); }}>취소</button><button type="button" className="is-confirm" aria-busy={working} disabled={working} onClick={() => void confirmAction()}>{working ? "처리 중…" : confirmationCopy.confirmLabel}</button></div><small className="market-confirm-footnote">거래 중 가격이나 보유 재화가 달라지면 안전을 위해 자동으로 취소됩니다.</small>
          </section>
        </div>
      )}
    </main>
  );
}

function getConfirmationCopy(confirmation: Confirmation): { title: string; body: string; confirmLabel: string; rows: Array<[string, string]> } {
  switch (confirmation.kind) {
    case "buy": return { title: `${formatMarketGearName(confirmation.listing.item)}을 구매할까요?`, body: "구매가 완료되면 장비는 거래 금고에 보관되고 판매 대금은 판매자에게 정산됩니다.", confirmLabel: "기억의 재로 구매", rows: [["구매 가격", `✦ ${formatEconomyAmount(confirmation.listing.priceAsh)}`], ["판매자", confirmation.listing.sellerName], ["받는 위치", "거래 금고"], ["장비", `${formatMarketGearLevel(confirmation.listing.item)} · ${RARITY_LABELS[confirmation.listing.item.rarity]}`]] };
    case "cancel-listing": return { title: "판매 등록을 취소할까요?", body: "아직 거래되지 않은 매물만 취소할 수 있으며 장비는 거래 금고로 돌아옵니다.", confirmLabel: "등록 취소", rows: [["장비", formatMarketGearName(confirmation.listing.item)], ["등록가", `✦ ${formatEconomyAmount(confirmation.listing.priceAsh)}`], ["반환 위치", "거래 금고"]] };
    case "sell": {
      const item = confirmation.candidate.view;
      const characterTransfer = confirmation.candidate.source === "character";
      return {
        title: `${formatMarketGearName(item)}을 판매할까요?`,
        body: characterTransfer
          ? "판매 등록이 완료되면 장비가 캐릭터 가방에서 빠지고 거래 금고에 보관됩니다. 등록되지 않으면 가방 장비는 그대로 유지됩니다."
          : "등록되는 순간 장비는 판매 보관 상태가 되며 다른 곳에서 사용할 수 없습니다.",
        confirmLabel: characterTransfer ? "이관 후 판매 등록" : "판매 등록",
        rows: [
          ["현재 위치", confirmation.candidate.source === "character" ? `캐릭터 가방 ${confirmation.candidate.saveSlot}번` : "거래 금고"],
          ["판매 가격", `✦ ${formatEconomyAmount(confirmation.priceAsh)}`],
          ["등록 기간", "7일"],
          ["거래 수수료", "✦ 0"],
          ["판매 시 예상 수령", `✦ ${formatEconomyAmount(confirmation.priceAsh)}`],
          ["만료 시 반환", "거래 금고"],
        ],
      };
    }
    case "order": return { title: `금괴 ${confirmation.side === "buy" ? "매수" : "매도"} 주문을 등록할까요?`, body: "주문에 필요한 재화는 즉시 거래 보관 잔액으로 이동하며, 상대가 호가창에서 이 주문을 선택해 체결할 때까지 대기합니다.", confirmLabel: `${confirmation.side === "buy" ? "매수" : "매도"} 주문 등록`, rows: [["금괴 수량", `▰ ${formatEconomyAmount(confirmation.goldAmount)}`], ["개당 가격", `✦ ${formatEconomyAmount(confirmation.priceAshPerGold)}`], ["주문 총액", `✦ ${formatEconomyAmount(confirmation.goldAmount * confirmation.priceAshPerGold)}`]] };
    case "fill-order": {
      const buyingGold = confirmation.order.side === "sell";
      const actionLabel = buyingGold ? "금괴 매수" : "금괴 매도";
      const ashFlow = buyingGold ? "지출" : "수령";
      const totalAsh = confirmation.goldAmount * confirmation.order.priceAshPerGold;
      return {
        title: `${actionLabel}를 즉시 체결할까요?`,
        body: buyingGold
          ? "기억의 재를 지출하고 금괴를 받습니다. 남은 수량과 가격을 다시 확인해 주세요."
          : "금괴를 넘기고 기억의 재를 수령합니다. 남은 수량과 가격을 다시 확인해 주세요.",
        confirmLabel: `${actionLabel} 체결`,
        rows: [
          ["내 거래", actionLabel],
          ["금괴 수량", `▰ ${formatEconomyAmount(confirmation.goldAmount)}`],
          ["개당 가격", `✦ ${formatEconomyAmount(confirmation.order.priceAshPerGold)}`],
          ["총 기억의 재", `${ashFlow} · ✦ ${formatEconomyAmount(totalAsh)}`],
        ],
      };
    }
    case "cancel-order": return { title: "미체결 주문을 취소할까요?", body: "이미 체결된 수량은 되돌릴 수 없으며 미체결분의 거래 보관 재화만 반환됩니다.", confirmLabel: "주문 취소", rows: [["잔여 금괴", `▰ ${formatEconomyAmount(confirmation.order.remainingGold)}`], ["개당 가격", `✦ ${formatEconomyAmount(confirmation.order.priceAshPerGold)}`]] };
    case "charge": return { title: `${confirmation.goldAmount} 금괴를 충전할까요?`, body: "Steam 결제창에서 최종 금액을 확인합니다. 결제가 완료된 주문에만 금괴가 지급되며 교환에는 72시간 잠금이 적용됩니다.", confirmLabel: "Steam 결제로 이동", rows: [["충전 금괴", `▰ ${formatEconomyAmount(confirmation.goldAmount)}`], ["결제 예정", `${confirmation.priceKrw.toLocaleString("ko-KR")}원`], ["교환 잠금", "72시간"]] };
  }
}
