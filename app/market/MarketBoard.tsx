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
  formatGearDisplayName,
  getGearRequiredLevel,
  normalizeGearEnhancement,
  type GearItem,
} from "../equipment";
import {
  ECONOMY_POLL_INTERVAL_MS,
  MARKET_RARITIES,
  MARKET_SLOTS,
  EconomyClientError,
  fetchEconomySnapshot,
  fetchExchangeOrders,
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
  type OrderBookLevel,
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
type DemoUser = "A" | "B";
type Notice = { tone: "info" | "success" | "error"; message: string };
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

type Confirmation =
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
  | { kind: "charge"; packId: string; goldAmount: number; priceKrw: number }
  | { kind: "sandbox"; currency: "memoryAsh" | "goldBars"; amount: number };

const TABS: ReadonlyArray<{ id: MarketTab; label: string; eyebrow: string }> = [
  { id: "auction", label: "장비 경매장", eyebrow: "EQUIPMENT" },
  { id: "gold", label: "금괴 교환소", eyebrow: "GOLD EXCHANGE" },
  { id: "charge", label: "금괴 충전", eyebrow: "STEAM WALLET" },
  { id: "security", label: "보안센터", eyebrow: "ACCOUNT GUARD" },
];

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

function aggregateBook(orders: GoldOrder[], side: "buy" | "sell"): OrderBookLevel[] {
  const levels = new Map<number, OrderBookLevel>();
  for (const order of orders) {
    if (order.status !== "open" && order.status !== "partial") continue;
    const current = levels.get(order.priceAshPerGold) ?? {
      priceAshPerGold: order.priceAshPerGold,
      goldAmount: 0,
      orderCount: 0,
    };
    current.goldAmount += order.remainingGold;
    current.orderCount += 1;
    levels.set(order.priceAshPerGold, current);
  }
  return [...levels.values()].sort((left, right) =>
    side === "buy"
      ? right.priceAshPerGold - left.priceAshPerGold
      : left.priceAshPerGold - right.priceAshPerGold,
  );
}

function readDemoUser(): DemoUser {
  if (typeof window === "undefined") return "A";
  return new URLSearchParams(window.location.search).get("demo") === "B" ? "B" : "A";
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
    powerScore: item.powerScore,
    qualityScore: item.qualityScore,
    iconIndex: item.iconIndex,
    affixes: item.affixes.map((affix) => ({
      label: affix.label,
      value: String(affix.value),
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
  const ready =
    !account.restricted &&
    capabilities.canTrade &&
    ((account.steamLinked && account.gameOwned) ||
      (local && capabilities.localSandbox));
  return (
    <section
      className={`market-launch-gate ${ready ? "is-ready" : "is-locked"}`}
      role={ready ? "status" : "alert"}
      aria-label="거래소 운영 상태"
    >
      <span className="market-launch-gate-icon" aria-hidden="true">{ready ? "◆" : "◇"}</span>
      <div>
        <small>{snapshot.featureMode.toUpperCase()} · {snapshot.paymentMode.toUpperCase()}</small>
        <strong>{ready ? "서버 원장이 거래를 승인했습니다" : "거래 기능이 잠겨 있습니다"}</strong>
        <p>
          {snapshot.launchGateReason ??
            (account.restricted
              ? account.restrictionReason ?? "이 계정에는 거래 제한이 적용되어 있습니다."
              : !account.steamLinked
                ? "Steam 계정을 연결해야 합니다."
                : !account.gameOwned
                  ? "Steam 게임 소유권 확인이 필요합니다."
                  : "운영자가 실거래 기능을 활성화하기 전까지 조회만 가능합니다.")}
        </p>
      </div>
      {local && capabilities.localSandbox && <b>LOCAL SANDBOX</b>}
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

export default function MarketBoard({ suggestedName }: { suggestedName?: string | null }) {
  const [tab, setTab] = useState<MarketTab>(initialTab);
  const [snapshot, setSnapshot] = useState<EconomySnapshot | null>(null);
  const [listings, setListings] = useState<MarketListing[]>([]);
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
  const [demoUser, setDemoUser] = useState<DemoUser>(readDemoUser);
  const [search, setSearch] = useState("");
  const [rarity, setRarity] = useState<MarketRarity | "all">("all");
  const [slot, setSlot] = useState<MarketSlot | "all">("all");
  const [sort, setSort] = useState<NonNullable<MarketSearch["sort"]>>("recent");
  const [characterInventory, setCharacterInventory] = useState<CharacterMarketInventory>({
    slot: 1,
    items: [],
    equippedCount: 0,
    invalidCount: 0,
  });
  const [selectedSellCandidateKey, setSelectedSellCandidateKey] = useState<string | null>(null);
  const [sellPrice, setSellPrice] = useState("");
  const [orderSide, setOrderSide] = useState<"buy" | "sell">("buy");
  const [orderPrice, setOrderPrice] = useState("");
  const [orderAmount, setOrderAmount] = useState("");
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const pollingRef = useRef<AbortController | null>(null);
  const firstLoadRef = useRef(true);
  const paymentReturnRef = useRef<string | null>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const confirmationDialogRef = useRef<HTMLElement>(null);
  const confirmationOpenerRef = useRef<HTMLElement | null>(null);
  const pendingFocusRestoreRef = useRef<HTMLElement | null>(null);

  const query = useMemo<MarketSearch>(() => ({ search, rarity, slot, sort }), [rarity, search, slot, sort]);

  const syncCharacterInventory = useCallback(() => {
    const activeSlot = resolveCharacterMarketSlot(window.location.search);
    const nextInventory = readCharacterMarketInventory(activeSlot);
    setCharacterInventory(nextInventory);
    return nextInventory;
  }, []);

  const refresh = useCallback(async (quiet = false) => {
    pollingRef.current?.abort();
    const controller = new AbortController();
    pollingRef.current = controller;
    if (!quiet) setRefreshing(true);
    try {
      const [snapshotResult, listingsResult, ordersResult] = await Promise.allSettled([
        fetchEconomySnapshot({ signal: controller.signal, demoUser }),
        fetchMarketListings(query, { signal: controller.signal, demoUser }),
        fetchExchangeOrders({ signal: controller.signal, demoUser }),
      ]);
      if (snapshotResult.status === "rejected") throw snapshotResult.reason;
      const nextSnapshot = snapshotResult.value;
      const nextListings =
        listingsResult.status === "fulfilled"
          ? listingsResult.value
          : nextSnapshot.listings;
      const exchangeOrders =
        ordersResult.status === "fulfilled"
          ? ordersResult.value
          : nextSnapshot.goldExchange.myOrders;
      const reconciliation = reconcileImportedCharacterItems(
        nextSnapshot.importedCharacterItemIds,
      );
      syncCharacterInventory();
      const ownListingIds = new Set(nextSnapshot.listings.filter((listing) => listing.mine).map((listing) => listing.listingId));
      const ownOrderIds = new Set(nextSnapshot.goldExchange.myOrders.map((order) => order.orderId));
      for (const listing of nextListings) listing.mine = ownListingIds.has(listing.listingId);
      for (const order of exchangeOrders) order.mine = ownOrderIds.has(order.orderId);
      nextSnapshot.goldExchange.orders = exchangeOrders;
      nextSnapshot.goldExchange.bids = aggregateBook(exchangeOrders.filter((order) => order.side === "buy"), "buy");
      nextSnapshot.goldExchange.asks = aggregateBook(exchangeOrders.filter((order) => order.side === "sell"), "sell");
      nextSnapshot.goldExchange.bestBid = nextSnapshot.goldExchange.bids[0]?.priceAshPerGold ?? null;
      nextSnapshot.goldExchange.bestAsk = nextSnapshot.goldExchange.asks[0]?.priceAshPerGold ?? null;
      setSnapshot(nextSnapshot);
      setListings(nextListings.length > 0 || nextSnapshot.listings.length === 0 ? nextListings : nextSnapshot.listings);
      setLastSyncAt(new Date());
      if (reconciliation.failedSlots.length > 0) {
        setNotice({
          tone: "error",
          message: `서버로 이관된 장비의 로컬 정리가 실패했습니다. 슬롯 ${reconciliation.failedSlots.join(", ")} 저장 공간을 확인해 주세요.`,
        });
      } else if (reconciliation.removedItemIds.length > 0) {
        setNotice({
          tone: "success",
          message: `거래소로 이관된 장비 ${reconciliation.removedItemIds.length}개를 캐릭터 가방에서 안전하게 정리했습니다.`,
        });
      } else if (firstLoadRef.current) {
        setNotice({ tone: "info", message: "서버 원장과 캐릭터 가방 동기화를 시작했습니다." });
      }
      firstLoadRef.current = false;
    } catch (error) {
      if ((error as Error).name !== "AbortError") {
        setNotice({
          tone: "error",
          message: error instanceof EconomyClientError ? error.message : "거래 서버와 동기화하지 못했습니다.",
        });
      }
    } finally {
      setLoading(false);
      if (!quiet) setRefreshing(false);
    }
  }, [demoUser, query, syncCharacterInventory]);

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
    setWorking(true);
    void finalizeSteamGoldPurchase(paymentOrderId, { demoUser })
      .then((nextSnapshot) => {
        setSnapshot(nextSnapshot);
        setLastSyncAt(new Date());
        setNotice({
          tone: "success",
          message: "Steam 승인 거래를 서버에서 검증했습니다. 금괴는 72시간 보호 잠금 후 거래할 수 있습니다.",
        });
      })
      .catch((error) => {
        const retryable = error instanceof EconomyClientError && (error.status === 429 || error.status >= 500);
        clearPaymentReturn = !retryable;
        if (retryable) paymentReturnRef.current = null;
        setNotice({
          tone: "error",
          message: error instanceof EconomyClientError
            ? `${error.message}${retryable ? " 결제 반환 주소를 유지했습니다. 잠시 뒤 페이지를 새로고침해 다시 검증해 주세요." : ""}`
            : "Steam 결제 승인 상태를 확인하지 못했습니다.",
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
        setWorking(false);
      });
  }, [demoUser]);

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

  const openConfirmation = useCallback((next: Confirmation) => {
    confirmationOpenerRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setConfirmation(next);
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

  const switchDemoUser = (next: DemoUser) => {
    if (!local) return;
    setDemoUser(next);
    setSelectedSellCandidateKey(null);
    const params = new URLSearchParams(window.location.search);
    params.set("demo", next);
    window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
  };

  const executeCommand = useCallback(async (command: EconomyCommand, success: string) => {
    if (!snapshot) return;
    setWorking(true);
    try {
      const next = await sendEconomyCommand(command, snapshot, { demoUser });
      setSnapshot(next);
      setNotice({ tone: "success", message: success });
      setConfirmation(null);
      setSelectedSellCandidateKey(null);
      setSellPrice("");
      setOrderAmount("");
      await refresh(true);
    } catch (error) {
      setNotice({
        tone: "error",
        message: error instanceof EconomyClientError ? error.message : "거래 명령을 완료하지 못했습니다.",
      });
    } finally {
      setWorking(false);
    }
  }, [demoUser, refresh, snapshot]);

  const sellCandidates = useMemo<SellCandidate[]>(() => {
    const importedIds = new Set(snapshot?.importedCharacterItemIds ?? []);
    const characterCandidates: SellCandidate[] = characterInventory.items
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
  }, [characterInventory, snapshot]);
  const selectedSellCandidate =
    sellCandidates.find((candidate) => candidate.key === selectedSellCandidateKey) ?? null;
  const executeCharacterListing = useCallback(async (
    candidate: Extract<SellCandidate, { source: "character" }>,
    priceAsh: number,
  ) => {
    if (!snapshot) return;
    setWorking(true);
    try {
      const next = await sendEconomyCommand(
        {
          action: "list_item",
          itemId: crypto.randomUUID(),
          priceAsh,
          expiresInSeconds: 7 * 24 * 60 * 60,
          expectedItemVersion: 0,
          sourceSaveSlot: candidate.saveSlot,
          characterItem: gearItemToEconomyPayload(candidate.gear),
        },
        snapshot,
        { demoUser },
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
      await refresh(true);
    } catch (error) {
      await refresh(true);
      const current = syncCharacterInventory();
      const transferred = !current.items.some(
        (item) => item.id === candidate.gear.id,
      );
      setNotice(
        transferred
          ? {
              tone: "success",
              message: `${formatMarketGearName(candidate.view)}의 이전 등록을 확인해 캐릭터 가방을 동기화했습니다.`,
            }
          : {
              tone: "error",
              message: error instanceof EconomyClientError
                ? error.message
                : "캐릭터 장비를 거래소에 등록하지 못했습니다. 가방의 장비는 그대로 보존했습니다.",
            },
      );
    } finally {
      setWorking(false);
    }
  }, [demoUser, refresh, snapshot, syncCharacterInventory]);
  const localSandbox = Boolean(local && snapshot?.capabilities.localSandbox);
  const accountReady = Boolean(
    snapshot &&
      !snapshot.account.restricted &&
      snapshot.account.steamLinked &&
      snapshot.account.gameOwned,
  );
  const tradeEnabled = Boolean(snapshot?.capabilities.canTrade && (accountReady || localSandbox));
  const goldEnabled = Boolean(snapshot?.capabilities.canUseGoldExchange && (accountReady || localSandbox));
  const chargeEnabled = Boolean(snapshot?.capabilities.canTopUp && accountReady && snapshot.paymentMode === "steam");
  const orderPriceNumber = Math.max(0, Math.trunc(Number(orderPrice) || 0));
  const orderAmountNumber = Math.max(0, Math.trunc(Number(orderAmount) || 0));

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
        );
        return;
      case "cancel-listing":
        await executeCommand(
          { action: "cancel_listing", listingId: confirmation.listing.listingId, expectedListingVersion: confirmation.listing.version },
          "판매 등록을 취소하고 장비를 서버 금고로 반환했습니다.",
        );
        return;
      case "sell":
        if (confirmation.candidate.source === "character") {
          await executeCharacterListing(
            confirmation.candidate,
            confirmation.priceAsh,
          );
          return;
        }
        await executeCommand(
          { action: "list_item", itemId: confirmation.candidate.view.itemId, priceAsh: confirmation.priceAsh, expiresInSeconds: 7 * 24 * 60 * 60, expectedItemVersion: confirmation.candidate.view.version },
          `${formatMarketGearName(confirmation.candidate.view)} 판매 등록을 완료했습니다.`,
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
        );
        return;
      case "cancel-order":
        await executeCommand(
          { action: "cancel_exchange", orderId: confirmation.order.orderId, expectedOrderVersion: confirmation.order.version },
          "미체결 주문을 취소하고 보관 재화를 반환했습니다.",
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
        );
        return;
      case "sandbox":
        await executeCommand(
          { action: "sandbox_topup", currency: confirmation.currency === "memoryAsh" ? "ash" : "gold", amount: confirmation.amount },
          "로컬 샌드박스 재화를 지급했습니다.",
        );
        return;
      case "charge": {
        setWorking(true);
        try {
          const result = await initializeSteamGoldPurchase(confirmation.packId, snapshot, { demoUser });
          if (result.snapshot) setSnapshot(result.snapshot);
          if (result.redirectUrl) window.location.assign(result.redirectUrl);
          else setNotice({ tone: "success", message: "Steam 결제 승인을 요청했습니다." });
          setConfirmation(null);
        } catch (error) {
          setNotice({ tone: "error", message: error instanceof Error ? error.message : "Steam 결제를 시작하지 못했습니다." });
        } finally {
          setWorking(false);
        }
      }
    }
  };

  const confirmationCopy = confirmation ? getConfirmationCopy(confirmation) : null;

  return (
    <main className="market-screen">
      <div className="market-backdrop" aria-hidden="true" />
      <header className="market-topbar">
        <Link href="/?town=1" className="market-back-link">← 기억 광장으로</Link>
        <div className="market-brand">
          <span className="market-brand-seal" aria-hidden="true">記</span>
          <div>
            <small>MUJINDO SECURE ECONOMY</small>
            <strong>기억 거래소</strong>
          </div>
        </div>
        <div className="market-sync-state" data-state={notice?.tone === "error" ? "error" : "online"}>
          <i aria-hidden="true" />
          <span>{refreshing ? "원장 대조 중" : "서버 원장 연결"}</span>
          <b>{lastSyncAt ? `${lastSyncAt.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}` : "대기"}</b>
          <button type="button" onClick={() => void refresh(false)} disabled={refreshing} aria-label="거래소 새로고침">↻</button>
        </div>
      </header>

      {loading && !snapshot ? (
        <section className="market-loading" aria-live="polite">
          <i aria-hidden="true" />
          <strong>서버 원장을 봉인 해제하는 중</strong>
          <span>계정, 금고, 매물의 서명을 대조합니다.</span>
        </section>
      ) : snapshot ? (
        <>
          <section className="market-account-bar">
            <div className="market-account-identity">
              <span aria-hidden="true">{snapshot.account.displayName.slice(0, 1)}</span>
              <div>
                <small>{snapshot.account.steamLinked ? "STEAM VERIFIED" : "STEAM LINK REQUIRED"}</small>
                <strong>{snapshot.account.displayName || suggestedName || "미연동 방랑자"}</strong>
              </div>
              <b data-tier={snapshot.account.trustTier}>{snapshot.account.trustTier}</b>
            </div>
            <BalanceCard symbol="✦" label="기억의 재" {...snapshot.wallet.memoryAsh} locked={snapshot.wallet.memoryAsh.locked72h} tone="ash" />
            <BalanceCard symbol="▰" label="금괴" {...snapshot.wallet.goldBars} locked={snapshot.wallet.goldBars.locked72h} tone="gold" />
            {local && (
              <div className="market-demo-switch" aria-label="로컬 데모 계정 선택">
                <small>LOCAL LEDGER</small>
                <div>
                  {(["A", "B"] as const).map((user) => (
                    <button key={user} type="button" className={demoUser === user ? "is-active" : ""} onClick={() => switchDemoUser(user)} aria-pressed={demoUser === user}>유저 {user}</button>
                  ))}
                </div>
              </div>
            )}
          </section>

          <AccountGate snapshot={snapshot} local={local} />

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
            <section className="market-panel market-auction" id="market-panel-auction" role="tabpanel" aria-labelledby="market-tab-auction">
              <div className="market-panel-heading">
                <div><small>SERVER-SEALED EQUIPMENT</small><h1>장비 경매장</h1></div>
                <p>캐릭터 가방 장비는 등록과 동시에 서버 금고로 이관됩니다. 구매 즉시 소유권 원장이 원자적으로 이전됩니다.</p>
              </div>
              <form className="market-filters" onSubmit={(event) => event.preventDefault()} aria-label="경매장 검색 필터">
                <label className="market-search"><span>장비 검색</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="장비 이름을 입력하세요" /><i aria-hidden="true">⌕</i></label>
                <label><span>등급</span><select value={rarity} onChange={(event) => setRarity(event.target.value as MarketRarity | "all")}><option value="all">전체 등급</option>{MARKET_RARITIES.map((value) => <option key={value} value={value}>{RARITY_LABELS[value]}</option>)}</select></label>
                <label><span>부위</span><select value={slot} onChange={(event) => setSlot(event.target.value as MarketSlot | "all")}><option value="all">전체 부위</option>{MARKET_SLOTS.map((value) => <option key={value} value={value}>{SLOT_LABELS[value]}</option>)}</select></label>
                <label><span>정렬</span><select value={sort} onChange={(event) => setSort(event.target.value as NonNullable<MarketSearch["sort"]>)}><option value="recent">최근 등록순</option><option value="price-low">낮은 가격순</option><option value="price-high">높은 가격순</option><option value="power">보스 화력순</option><option value="level">레벨순</option></select></label>
              </form>
              <div className="market-auction-layout">
                <section className="market-listings" aria-label="판매 장비 목록">
                  <header><span>장비 정보</span><span>판매자</span><span>남은 시간</span><span>판매가</span><span>거래</span></header>
                  {listings.length === 0 ? <EmptyState title="조건에 맞는 매물이 없습니다" body="검색 조건을 바꾸거나 다음 실시간 갱신을 기다려 주세요." /> : listings.map((listing) => (
                    <article key={listing.listingId} className={`market-listing is-${listing.item.rarity}`} style={{ "--rarity-color": RARITY_COLORS[listing.item.rarity] } as CSSProperties}>
                      <div className="market-listing-item"><ItemIcon item={listing.item} compact /><div><small>{formatMarketGearLevel(listing.item)} · {SLOT_LABELS[listing.item.slot]}</small><strong>{formatMarketGearName(listing.item)}</strong><span>{RARITY_LABELS[listing.item.rarity]} · 보스 화력 {formatEconomyAmount(listing.item.powerScore)} · 품질 {listing.item.qualityScore}</span></div></div>
                      <div className="market-listing-seller"><small>판매자</small><strong>{listing.sellerName}</strong><span>{listing.mine ? "내 매물" : "서버 인증"}</span></div>
                      <div className="market-listing-time"><small>만료까지</small><strong>{remainingLabel(listing.expiresAt)}</strong><span>{formatDate(listing.listedAt)} 등록</span></div>
                      <div className="market-listing-price"><small>기억의 재</small><strong><i>✦</i>{formatEconomyAmount(listing.priceAsh)}</strong><span>고정가</span></div>
                      <button type="button" className={listing.mine ? "is-cancel" : "is-buy"} disabled={!tradeEnabled || working} onClick={() => openConfirmation(listing.mine ? { kind: "cancel-listing", listing } : { kind: "buy", listing })}>{listing.mine ? "등록 취소" : "즉시 구매"}</button>
                    </article>
                  ))}
                </section>
                <aside className="market-vault" aria-labelledby="market-vault-title">
                  <header><div><small>CHARACTER BAG · SERVER VAULT</small><h2 id="market-vault-title">판매할 장비</h2></div><b>{sellCandidates.length}</b></header>
                  <div className="market-local-warning"><span aria-hidden="true">↗</span><p><strong>캐릭터 가방 연동 · 슬롯 {characterInventory.slot}</strong>가방 장비를 등록하면 서버 금고로 안전하게 이관된 뒤 판매됩니다. 서버 등록이 끝난 경우에만 가방에서 제거됩니다.{characterInventory.equippedCount > 0 ? ` 장착 중인 장비 ${characterInventory.equippedCount}개는 먼저 해제해 주세요.` : ""}</p></div>
                  <div className="market-vault-list">
                    {sellCandidates.length === 0 ? <EmptyState title="판매 가능한 장비가 없습니다" body="원정에서 획득한 장비를 가방에 보관하거나 장착 장비를 해제하면 이곳에 나타납니다." /> : sellCandidates.map((candidate) => (
                      <button key={candidate.key} type="button" className={selectedSellCandidateKey === candidate.key ? "is-selected" : ""} style={{ "--rarity-color": RARITY_COLORS[candidate.view.rarity] } as CSSProperties} aria-pressed={selectedSellCandidateKey === candidate.key} onClick={() => setSelectedSellCandidateKey(candidate.key)}><ItemIcon item={candidate.view} compact /><span><small>{candidate.source === "character" ? `캐릭터 가방 ${candidate.saveSlot}번` : "서버 금고"} · {formatMarketGearLevel(candidate.view)} · {RARITY_LABELS[candidate.view.rarity]}</small><strong>{formatMarketGearName(candidate.view)}</strong><em>보스 화력 {formatEconomyAmount(candidate.view.powerScore)}</em></span><i aria-hidden="true">›</i></button>
                    ))}
                  </div>
                  <form className="market-sell-form" onSubmit={(event) => { event.preventDefault(); const price = Math.max(0, Math.trunc(Number(sellPrice) || 0)); if (selectedSellCandidate && price > 0 && tradeEnabled) openConfirmation({ kind: "sell", candidate: selectedSellCandidate, priceAsh: price }); }}>
                    <label><span>판매 희망가 · 기억의 재</span><input type="number" min="1" step="1" inputMode="numeric" value={sellPrice} onChange={(event) => setSellPrice(event.target.value)} placeholder="가격 입력" /></label>
                    <button type="submit" disabled={!tradeEnabled || !selectedSellCandidate || Number(sellPrice) <= 0 || working}>선택 장비 판매 등록</button>
                  </form>
                </aside>
              </div>
            </section>
          )}

          {tab === "gold" && (
            <section className="market-panel market-exchange" id="market-panel-gold" role="tabpanel" aria-labelledby="market-tab-gold">
              <div className="market-panel-heading"><div><small>PLAYER-TO-PLAYER EXCHANGE</small><h1>금괴 교환소</h1></div><p>유저가 가격과 수량을 지정합니다. 서버는 양쪽 재화를 먼저 보관한 뒤 체결과 정산을 한 원장 트랜잭션으로 처리합니다.</p></div>
              <div className="market-ticker">
                <div><small>최근 체결가</small><strong>{snapshot.goldExchange.lastPrice === null ? "—" : `✦ ${formatEconomyAmount(snapshot.goldExchange.lastPrice)}`}</strong><span>금괴 1개당 기억의 재</span></div>
                <div><small>최우선 매수</small><strong>{snapshot.goldExchange.bestBid === null ? "—" : formatEconomyAmount(snapshot.goldExchange.bestBid)}</strong><span>BID</span></div>
                <div><small>최우선 매도</small><strong>{snapshot.goldExchange.bestAsk === null ? "—" : formatEconomyAmount(snapshot.goldExchange.bestAsk)}</strong><span>ASK</span></div>
                <div><small>가격 차이</small><strong>{snapshot.goldExchange.bestBid !== null && snapshot.goldExchange.bestAsk !== null ? formatEconomyAmount(Math.max(0, snapshot.goldExchange.bestAsk - snapshot.goldExchange.bestBid)) : "—"}</strong><span>SPREAD</span></div>
              </div>
              <div className="market-exchange-layout">
                <section className="market-orderbook" aria-labelledby="orderbook-title">
                  <header><div><small>LIVE ORDER BOOK</small><h2 id="orderbook-title">실시간 호가</h2></div><span>3초 자동 갱신</span></header>
                  <div className="market-orderbook-head"><span>구분</span><span>금괴 1개 가격</span><span>잔량</span><span>주문</span></div>
                  <div className="market-book-side is-ask"><small>매도 호가</small>{snapshot.goldExchange.asks.length === 0 ? <p>대기 매도 주문 없음</p> : [...snapshot.goldExchange.asks].reverse().slice(0, 8).map((level, index) => <div key={`ask-${level.priceAshPerGold}-${index}`}><b>매도</b><strong>✦ {formatEconomyAmount(level.priceAshPerGold)}</strong><span>▰ {formatEconomyAmount(level.goldAmount)}</span><em>{level.orderCount}건</em></div>)}</div>
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
                  {snapshot.goldExchange.myOrders.length === 0 ? <EmptyState title="열린 주문이 없습니다" body="매수 또는 매도 주문을 등록하면 체결 상황을 확인할 수 있습니다." /> : snapshot.goldExchange.myOrders.map((order) => <article key={order.orderId} className={`is-${order.side}`}><span><small>{order.side === "buy" ? "금괴 매수" : "금괴 매도"} · {order.status}</small><strong>▰ {formatEconomyAmount(order.remainingGold)} / {formatEconomyAmount(order.goldAmount)}</strong></span><span><small>금괴 1개당</small><strong>✦ {formatEconomyAmount(order.priceAshPerGold)}</strong></span><button type="button" disabled={working || !(order.status === "open" || order.status === "partial")} onClick={() => openConfirmation({ kind: "cancel-order", order })}>주문 취소</button></article>)}
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
              <div className="market-panel-heading"><div><small>STEAM MICROTRANSACTION</small><h1>금괴 충전</h1></div><p>금괴는 Steam 결제 승인과 서버 영수증 검증이 모두 끝난 뒤에만 지급됩니다.</p></div>
              <section className="market-charge-hero"><span className="market-gold-stack" aria-hidden="true"><i /><i /><i /></span><div><small>PREMIUM EXCHANGE TOKEN</small><h2>금괴</h2><p>편의 상품과 유저 간 기억의 재 교환에 사용하는 서버 재화입니다. 게임 장비를 직접 판매하지 않습니다.</p></div><dl><div><dt>사용 가능</dt><dd>▰ {formatEconomyAmount(snapshot.wallet.goldBars.available)}</dd></div><div><dt>72시간 잠금</dt><dd>▰ {formatEconomyAmount(snapshot.wallet.goldBars.locked72h)}</dd></div></dl></section>
              <div className="market-pack-grid">{GOLD_PACKS.map((pack) => <article key={pack.id}><span aria-hidden="true">▰</span><small>{pack.label}</small><strong>{pack.gold}<i> 금괴</i></strong><b>{pack.priceKrw.toLocaleString("ko-KR")}원</b><button type="button" disabled={!chargeEnabled || working} onClick={() => openConfirmation({ kind: "charge", packId: pack.id, goldAmount: pack.gold, priceKrw: pack.priceKrw })}>{chargeEnabled ? "Steam으로 충전" : "결제 잠김"}</button></article>)}</div>
              <section className="market-charge-policy"><div><strong>72시간 교환 잠금</strong><p>새로 충전한 금괴는 결제 취소·도난 결제 위험을 검증하는 동안 교환소에서 사용할 수 없습니다. 잠금 해제 시각은 서버 원장이 결정합니다.</p></div><div><strong>서버 영수증 검증</strong><p>클라이언트의 성공 화면만으로 지급하지 않습니다. Steam 서버 콜백과 주문 금액이 일치할 때만 금괴 원장에 반영됩니다.</p></div><div><strong>환불·청약 정보</strong><p>구매 전 Steam 결제창에서 최종 금액과 환불 조건을 확인하세요. 사용 또는 교환된 금괴는 별도 정책이 적용될 수 있습니다.</p></div></section>
              {localSandbox && <section className="market-sandbox-tools"><div><small>LOCALHOST ONLY</small><h2>경제 샌드박스</h2><p>이 도구는 로컬 개발 환경에서만 보이며 실제 결제나 운영 원장과 연결되지 않습니다.</p></div><button type="button" onClick={() => openConfirmation({ kind: "sandbox", currency: "memoryAsh", amount: 100_000 })}>기억의 재 100,000 지급</button><button type="button" onClick={() => openConfirmation({ kind: "sandbox", currency: "goldBars", amount: 100 })}>금괴 100 지급</button></section>}
            </section>
          )}

          {tab === "security" && (
            <section className="market-panel market-security" id="market-panel-security" role="tabpanel" aria-labelledby="market-tab-security">
              <div className="market-panel-heading"><div><small>IDENTITY · LEDGER · ENFORCEMENT</small><h1>보안센터</h1></div><p>Steam은 로그인 증명이고, 제재와 자산 소유권은 변하지 않는 내부 사용자 ID와 감사 원장을 기준으로 집행합니다.</p></div>
              {snapshot.account.restricted && <div className="market-sanction"><span aria-hidden="true">!</span><div><small>ACCOUNT RESTRICTED · {snapshot.account.sanctionCode ?? "REVIEW"}</small><strong>거래 기능이 제한되었습니다</strong><p>{snapshot.account.restrictionReason ?? "보안 검토가 끝날 때까지 모든 경제 명령이 거절됩니다."}</p></div></div>}
              <div className="market-security-grid">
                <section className="market-verification"><header><small>ACCOUNT CHAIN</small><h2>계정 검증</h2></header><ol><li className={snapshot.account.steamLinked ? "is-complete" : ""}><span>1</span><div><strong>Steam 계정 연결</strong><p>{snapshot.account.steamLinked ? `연결됨 · ${snapshot.account.steamId ? `…${snapshot.account.steamId.slice(-6)}` : "서버 티켓 확인"}` : "Steam 로그인 티켓을 서버에서 직접 검증합니다."}</p></div>{!snapshot.account.steamLinked && <a href={steamLinkUrl("/market?tab=security")}>Steam 연결</a>}</li><li className={snapshot.account.gameOwned ? "is-complete" : ""}><span>2</span><div><strong>게임 소유권 확인</strong><p>{snapshot.account.gameOwned ? "소유권 확인 완료" : "연결 계정의 게임 라이선스 확인이 필요합니다."}</p></div></li><li className={snapshot.capabilities.canTrade ? "is-complete" : ""}><span>3</span><div><strong>거래 권한 승인</strong><p>{snapshot.capabilities.canTrade ? "거래 명령 가능" : "운영 게이트 또는 계정 상태로 잠겨 있습니다."}</p></div></li><li className={!snapshot.account.restricted ? "is-complete" : ""}><span>4</span><div><strong>제재 상태 검사</strong><p>{snapshot.account.restricted ? "제한 조치 적용 중" : "활성 제재 없음"}</p></div></li></ol></section>
                <section className="market-security-status"><header><small>LIVE SECURITY STATE</small><h2>현재 보호 상태</h2></header><dl><div><dt>내부 사용자 ID</dt><dd>{snapshot.account.userId ?? "미발급"}</dd></div><div><dt>활성 세션</dt><dd>{snapshot.security.activeSessions}개</dd></div><div><dt>최근 로그인</dt><dd>{formatDate(snapshot.security.lastLoginAt)}</dd></div><div><dt>Steam 티켓 검증</dt><dd>{formatDate(snapshot.security.lastSteamTicketVerifiedAt)}</dd></div><div><dt>교환 잠금 해제</dt><dd>{formatDate(snapshot.security.withdrawalLockUntil)}</dd></div><div><dt>신뢰 등급</dt><dd>{snapshot.account.trustTier}</dd></div></dl></section>
                <section className="market-security-rules"><header><small>SERVER AUTHORITY</small><h2>서버 강제 원칙</h2></header><ul><li><strong>클라이언트 잔액 불신</strong><span>가격·잔액·아이템을 요청값으로 인정하지 않고 서버 DB에서 다시 조회합니다.</span></li><li><strong>원자적 이중 정산</strong><span>구매자 차감과 판매자 지급, 아이템 이전을 하나의 트랜잭션으로 완료합니다.</span></li><li><strong>재전송 안전</strong><span>모든 쓰기 명령에 단일 사용 키를 부여해 중복 결제와 이중 체결을 막습니다.</span></li><li><strong>즉시 동결·추적</strong><span>내부 사용자 ID, Steam ID, 요청 ID와 원장 변경을 연결해 조사와 제재에 사용합니다.</span></li></ul></section>
                <section className="market-audit"><header><small>RECENT AUDIT</small><h2>내 계정 보안 기록</h2></header>{snapshot.security.auditTrail.length === 0 ? <EmptyState title="표시할 보안 기록이 없습니다" body="로그인과 주요 거래가 발생하면 서버 감사 ID가 남습니다." /> : <div>{snapshot.security.auditTrail.slice(0, 8).map((entry) => <article key={entry.id}><span>{entry.category}</span><p><strong>{entry.message}</strong><small>{formatDate(entry.createdAt)}{entry.ipHint ? ` · ${entry.ipHint}` : ""}</small></p><code>{entry.id}</code></article>)}</div>}</section>
              </div>
              <div className="market-legal-review"><span aria-hidden="true">§</span><p><strong>한국 정식 출시 전 필수 검토</strong>유료 금괴와 유저 간 재화 교환은 법률·게임물 등급분류·청소년 보호·전자상거래·환불 정책 검토가 끝나기 전에는 운영 모드로 열지 않습니다.</p></div>
            </section>
          )}
        </>
      ) : (
        <section className="market-fatal" role="alert"><strong>거래 서버에 접속할 수 없습니다</strong><p>잠시 후 다시 시도하거나 기억 광장으로 돌아가 주세요.</p><button type="button" onClick={() => void refresh(false)}>다시 연결</button></section>
      )}

      {confirmation && confirmationCopy && (
        <div className="market-confirm-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !working) setConfirmation(null); }}>
          <section ref={confirmationDialogRef} className="market-confirm" role="alertdialog" aria-modal="true" aria-labelledby="market-confirm-title" aria-describedby="market-confirm-body" tabIndex={-1}>
            <span className="market-confirm-sigil" aria-hidden="true">◇</span><small>AUTHORITATIVE LEDGER COMMAND</small><h2 id="market-confirm-title">{confirmationCopy.title}</h2><p id="market-confirm-body">{confirmationCopy.body}</p><dl>{confirmationCopy.rows.map((row) => <div key={row[0]}><dt>{row[0]}</dt><dd>{row[1]}</dd></div>)}</dl><div><button type="button" autoFocus disabled={working} onClick={() => setConfirmation(null)}>취소</button><button type="button" className="is-confirm" disabled={working} onClick={() => void confirmAction()}>{working ? "서버 원장 확인 중…" : confirmationCopy.confirmLabel}</button></div><small className="market-confirm-footnote">최종 가격·소유권·잔액은 서버가 다시 검증합니다. 조건이 달라졌다면 명령은 자동 거절됩니다.</small>
          </section>
        </div>
      )}
    </main>
  );
}

function getConfirmationCopy(confirmation: Confirmation): { title: string; body: string; confirmLabel: string; rows: Array<[string, string]> } {
  switch (confirmation.kind) {
    case "buy": return { title: `${formatMarketGearName(confirmation.listing.item)}을 구매할까요?`, body: "구매가 완료되면 장비는 서버 금고로 이동하고 판매 대금은 판매자에게 정산됩니다.", confirmLabel: "기억의 재로 구매", rows: [["구매 가격", `✦ ${formatEconomyAmount(confirmation.listing.priceAsh)}`], ["판매자", confirmation.listing.sellerName], ["장비", `${formatMarketGearLevel(confirmation.listing.item)} · ${RARITY_LABELS[confirmation.listing.item.rarity]}`]] };
    case "cancel-listing": return { title: "판매 등록을 취소할까요?", body: "아직 체결되지 않은 매물만 취소할 수 있으며 장비는 서버 금고로 반환됩니다.", confirmLabel: "등록 취소", rows: [["장비", formatMarketGearName(confirmation.listing.item)], ["등록가", `✦ ${formatEconomyAmount(confirmation.listing.priceAsh)}`]] };
    case "sell": {
      const item = confirmation.candidate.view;
      const characterTransfer = confirmation.candidate.source === "character";
      return {
        title: `${formatMarketGearName(item)}을 판매할까요?`,
        body: characterTransfer
          ? "서버 등록이 완료되면 장비가 캐릭터 가방에서 빠지고 거래 보관 상태로 이동합니다. 실패하면 가방 장비는 그대로 유지됩니다."
          : "등록되는 순간 장비는 거래 보관 상태가 되며 다른 거래에 사용할 수 없습니다.",
        confirmLabel: characterTransfer ? "이관 후 판매 등록" : "판매 등록",
        rows: [
          ["보관 위치", confirmation.candidate.source === "character" ? `캐릭터 가방 ${confirmation.candidate.saveSlot}번` : "서버 금고"],
          ["판매 가격", `✦ ${formatEconomyAmount(confirmation.priceAsh)}`],
          ["착용 조건", formatMarketGearLevel(item)],
          ["아이템 보스 화력", formatEconomyAmount(item.powerScore)],
          ["등급", RARITY_LABELS[item.rarity]],
        ],
      };
    }
    case "order": return { title: `금괴 ${confirmation.side === "buy" ? "매수" : "매도"} 주문을 등록할까요?`, body: "주문에 필요한 재화는 즉시 거래 보관 잔액으로 이동하며 상대 주문과 가격이 맞으면 자동 체결됩니다.", confirmLabel: `${confirmation.side === "buy" ? "매수" : "매도"} 주문 등록`, rows: [["금괴 수량", `▰ ${formatEconomyAmount(confirmation.goldAmount)}`], ["개당 가격", `✦ ${formatEconomyAmount(confirmation.priceAshPerGold)}`], ["주문 총액", `✦ ${formatEconomyAmount(confirmation.goldAmount * confirmation.priceAshPerGold)}`]] };
    case "fill-order": return { title: "이 호가를 즉시 체결할까요?", body: "서버가 남은 수량과 가격을 다시 확인한 뒤 가능한 수량만 원자적으로 체결합니다.", confirmLabel: "즉시 체결", rows: [["금괴 수량", `▰ ${formatEconomyAmount(confirmation.goldAmount)}`], ["개당 가격", `✦ ${formatEconomyAmount(confirmation.order.priceAshPerGold)}`]] };
    case "cancel-order": return { title: "미체결 주문을 취소할까요?", body: "이미 체결된 수량은 되돌릴 수 없으며 미체결분의 거래 보관 재화만 반환됩니다.", confirmLabel: "주문 취소", rows: [["잔여 금괴", `▰ ${formatEconomyAmount(confirmation.order.remainingGold)}`], ["개당 가격", `✦ ${formatEconomyAmount(confirmation.order.priceAshPerGold)}`]] };
    case "charge": return { title: `${confirmation.goldAmount} 금괴를 충전할까요?`, body: "Steam 결제창에서 최종 금액을 확인합니다. 서버 영수증 검증 후 지급되며 교환에는 72시간 잠금이 적용됩니다.", confirmLabel: "Steam 결제로 이동", rows: [["충전 금괴", `▰ ${formatEconomyAmount(confirmation.goldAmount)}`], ["결제 예정", `${confirmation.priceKrw.toLocaleString("ko-KR")}원`], ["교환 잠금", "72시간"]] };
    case "sandbox": return { title: "로컬 샌드박스 재화를 지급할까요?", body: "localhost 데모 원장에만 반영되며 실제 결제·운영 계정과 완전히 분리됩니다.", confirmLabel: "샌드박스 지급", rows: [["재화", confirmation.currency === "memoryAsh" ? "기억의 재" : "금괴"], ["수량", formatEconomyAmount(confirmation.amount)]] };
  }
}
