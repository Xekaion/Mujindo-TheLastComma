export const SHOP_STORAGE_KEY = "mujindo:last-comma:shop-local-v1";
export const BASE_INVENTORY_CAPACITY = 24;
export const MAX_INVENTORY_CAPACITY = 48;
export const MAP_TELEPORT_PRODUCT_ID = "mujindo-wayfinder";

export const SHOP_PRODUCTS = [
  {
    id: "inventory-expansion-1",
    kind: "inventory-expansion",
    name: "방랑자의 가방 · 첫 번째 봉인",
    shortName: "제1 봉인",
    description: "연속 가방 목록에 장비 한 줄(6칸)을 영구적으로 해방합니다.",
    inventorySlots: 6,
    priceKrw: 2_900,
    requires: null,
  },
  {
    id: "inventory-expansion-2",
    kind: "inventory-expansion",
    name: "방랑자의 가방 · 두 번째 봉인",
    shortName: "제2 봉인",
    description: "가방 스크롤 영역에 장비 한 줄을 더 추가합니다.",
    inventorySlots: 6,
    priceKrw: 4_900,
    requires: "inventory-expansion-1",
  },
  {
    id: "inventory-expansion-3",
    kind: "inventory-expansion",
    name: "방랑자의 가방 · 세 번째 봉인",
    shortName: "제3 봉인",
    description: "깊은 원정을 위한 세 번째 확장 줄을 영구 해금합니다.",
    inventorySlots: 6,
    priceKrw: 6_900,
    requires: "inventory-expansion-2",
  },
  {
    id: "inventory-expansion-4",
    kind: "inventory-expansion",
    name: "방랑자의 가방 · 마지막 봉인",
    shortName: "최종 봉인",
    description: "방랑자의 가방을 최대 48칸까지 완성합니다.",
    inventorySlots: 6,
    priceKrw: 8_900,
    requires: "inventory-expansion-3",
  },
  {
    id: MAP_TELEPORT_PRODUCT_ID,
    kind: "map-teleport",
    name: "무진도의 길잡이",
    shortName: "좌표 도약",
    description:
      "무진도 탐사도에서 방문하고 정복한 좌표를 선택해 즉시 이동하는 계정 영구 나침반입니다.",
    inventorySlots: 0,
    priceKrw: 12_900,
    requires: null,
  },
] as const;

export type ShopProduct = (typeof SHOP_PRODUCTS)[number];
export type ShopProductId = ShopProduct["id"];
export type ShopCheckoutMode = "local-test" | "unconfigured";

export type ShopReceipt = {
  id: string;
  productId: ShopProductId;
  purchasedAt: number;
  priceKrw: number;
  currency: "KRW";
  provider: "local-test";
};

export type ShopEntitlements = {
  version: 1;
  purchasedProductIds: ShopProductId[];
  receipts: ShopReceipt[];
  updatedAt: number;
};

export type ShopStorage = Pick<Storage, "getItem" | "setItem">;

export type LocalShopPurchaseResult =
  | {
      status: "purchased";
      entitlements: ShopEntitlements;
      product: ShopProduct;
      receipt: ShopReceipt;
    }
  | {
      status: "already-owned";
      entitlements: ShopEntitlements;
      product: ShopProduct;
    }
  | {
      status: "locked";
      entitlements: ShopEntitlements;
      product: ShopProduct;
      requiredProductId: ShopProductId;
    }
  | {
      status: "invalid-product" | "write-failed";
      entitlements: ShopEntitlements;
    };

const PRODUCT_IDS = new Set<ShopProductId>(SHOP_PRODUCTS.map((product) => product.id));

function browserStorage(): ShopStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function resolveStorage(storage?: ShopStorage | null): ShopStorage | null {
  return storage === undefined ? browserStorage() : storage;
}

function emptyEntitlements(): ShopEntitlements {
  return {
    version: 1,
    purchasedProductIds: [],
    receipts: [],
    updatedAt: 0,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isShopProductId(value: unknown): value is ShopProductId {
  return typeof value === "string" && PRODUCT_IDS.has(value as ShopProductId);
}

function normalizeReceipt(value: unknown): ShopReceipt | null {
  if (!isRecord(value) || !isShopProductId(value.productId)) return null;
  if (typeof value.id !== "string" || value.id.length < 4) return null;
  if (!Number.isSafeInteger(value.purchasedAt) || Number(value.purchasedAt) < 0) return null;
  if (!Number.isSafeInteger(value.priceKrw) || Number(value.priceKrw) < 0) return null;
  if (value.currency !== "KRW" || value.provider !== "local-test") return null;
  return {
    id: value.id,
    productId: value.productId,
    purchasedAt: Number(value.purchasedAt),
    priceKrw: Number(value.priceKrw),
    currency: "KRW",
    provider: "local-test",
  };
}

export function normalizeShopEntitlements(value: unknown): ShopEntitlements {
  if (!isRecord(value)) return emptyEntitlements();
  const requestedIds = new Set(
    Array.isArray(value.purchasedProductIds)
      ? value.purchasedProductIds.filter(isShopProductId)
      : [],
  );

  // Validate the catalog in dependency order. Independent conveniences survive
  // without bag purchases, while forged later expansion tiers stay locked.
  const purchasedProductIds: ShopProductId[] = [];
  for (const product of SHOP_PRODUCTS) {
    if (!requestedIds.has(product.id)) continue;
    if (product.requires && !purchasedProductIds.includes(product.requires)) continue;
    purchasedProductIds.push(product.id);
  }

  const purchasedLookup = new Set(purchasedProductIds);
  const receipts = Array.isArray(value.receipts)
    ? value.receipts
        .map(normalizeReceipt)
        .filter(
          (receipt): receipt is ShopReceipt =>
            receipt !== null && purchasedLookup.has(receipt.productId),
        )
        .slice(-32)
    : [];
  const updatedAt = Number.isSafeInteger(value.updatedAt)
    ? Math.max(0, Number(value.updatedAt))
    : 0;

  return {
    version: 1,
    purchasedProductIds,
    receipts,
    updatedAt,
  };
}

export function readShopEntitlements(
  storage?: ShopStorage | null,
): ShopEntitlements {
  const target = resolveStorage(storage);
  if (!target) return emptyEntitlements();
  try {
    const raw = target.getItem(SHOP_STORAGE_KEY);
    if (raw === null) return emptyEntitlements();
    return normalizeShopEntitlements(JSON.parse(raw) as unknown);
  } catch {
    return emptyEntitlements();
  }
}

export function writeShopEntitlements(
  entitlements: ShopEntitlements,
  storage?: ShopStorage | null,
): boolean {
  const target = resolveStorage(storage);
  if (!target) return false;
  try {
    target.setItem(
      SHOP_STORAGE_KEY,
      JSON.stringify(normalizeShopEntitlements(entitlements)),
    );
    return true;
  } catch {
    return false;
  }
}

export function inventoryCapacityFor(
  entitlements: Pick<ShopEntitlements, "purchasedProductIds">,
): number {
  const purchased = new Set(entitlements.purchasedProductIds);
  const extraSlots = SHOP_PRODUCTS.reduce(
    (total, product) =>
      total +
      (product.kind === "inventory-expansion" && purchased.has(product.id)
        ? product.inventorySlots
        : 0),
    0,
  );
  return Math.min(MAX_INVENTORY_CAPACITY, BASE_INVENTORY_CAPACITY + extraSlots);
}

export function hasMapTeleportEntitlement(
  entitlements: Pick<ShopEntitlements, "purchasedProductIds">,
): boolean {
  return entitlements.purchasedProductIds.includes(MAP_TELEPORT_PRODUCT_ID);
}

export function findShopProduct(productId: string): ShopProduct | null {
  return SHOP_PRODUCTS.find((product) => product.id === productId) ?? null;
}

export function completeLocalShopPurchase(
  productId: string,
  storage?: ShopStorage | null,
  now = Date.now(),
): LocalShopPurchaseResult {
  const entitlements = readShopEntitlements(storage);
  const product = findShopProduct(productId);
  if (!product) return { status: "invalid-product", entitlements };
  if (entitlements.purchasedProductIds.includes(product.id)) {
    return { status: "already-owned", entitlements, product };
  }
  if (product.requires && !entitlements.purchasedProductIds.includes(product.requires)) {
    return {
      status: "locked",
      entitlements,
      product,
      requiredProductId: product.requires,
    };
  }

  const purchasedAt = Number.isSafeInteger(now) ? Math.max(0, now) : Date.now();
  const receipt: ShopReceipt = {
    id: `LOCAL-${product.id.toUpperCase()}-${purchasedAt.toString(36).toUpperCase()}`,
    productId: product.id,
    purchasedAt,
    priceKrw: product.priceKrw,
    currency: "KRW",
    provider: "local-test",
  };
  const next: ShopEntitlements = {
    version: 1,
    purchasedProductIds: [...entitlements.purchasedProductIds, product.id],
    receipts: [...entitlements.receipts, receipt].slice(-32),
    updatedAt: purchasedAt,
  };
  if (!writeShopEntitlements(next, storage)) {
    return { status: "write-failed", entitlements };
  }
  const verified = readShopEntitlements(storage);
  if (!verified.purchasedProductIds.includes(product.id)) {
    return { status: "write-failed", entitlements };
  }
  return { status: "purchased", entitlements: verified, product, receipt };
}

export function formatKrw(value: number): string {
  return `${Math.max(0, Math.round(value)).toLocaleString("ko-KR")}원`;
}

export function isLocalShopTestHost(hostname?: string): boolean {
  const candidate = (
    hostname ?? (typeof window !== "undefined" ? window.location.hostname : "")
  ).toLowerCase();
  return candidate === "localhost" || candidate === "127.0.0.1" || candidate === "::1";
}

export function shopCheckoutMode(hostname?: string): ShopCheckoutMode {
  return isLocalShopTestHost(hostname) ? "local-test" : "unconfigured";
}
