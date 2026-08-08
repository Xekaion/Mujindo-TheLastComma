import { useEffect, useMemo, useRef, useState } from "react";
import {
  BASE_INVENTORY_CAPACITY,
  MAX_INVENTORY_CAPACITY,
  SHOP_PRODUCTS,
  findShopProduct,
  formatKrw,
  inventoryCapacityFor,
  type ShopCheckoutMode,
  type ShopEntitlements,
  type ShopProductId,
  type ShopReceipt,
} from "./shop";

export type ShopOverlayProps = {
  open: boolean;
  inventoryCount: number;
  inventoryCapacity: number;
  entitlements: ShopEntitlements;
  checkoutMode: ShopCheckoutMode;
  lastReceipt: ShopReceipt | null;
  notice: { tone: "info" | "success" | "error"; message: string } | null;
  preferredProductId?: ShopProductId | null;
  onClose: () => void;
  onPurchase: (productId: ShopProductId) => void;
  onRestore: () => void;
  onMarketNavigate?: () => void;
};

export default function ShopOverlay({
  open,
  inventoryCount,
  inventoryCapacity,
  entitlements,
  checkoutMode,
  lastReceipt,
  notice,
  preferredProductId = null,
  onClose,
  onPurchase,
  onRestore,
  onMarketNavigate,
}: ShopOverlayProps) {
  const firstUnowned = SHOP_PRODUCTS.find(
    (product) => !entitlements.purchasedProductIds.includes(product.id),
  );
  const [selectedProductId, setSelectedProductId] = useState<ShopProductId>(
    preferredProductId && findShopProduct(preferredProductId)
      ? preferredProductId
      : firstUnowned?.id ?? SHOP_PRODUCTS[SHOP_PRODUCTS.length - 1].id,
  );
  const [confirming, setConfirming] = useState(false);
  const panelRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const focusFrame = window.requestAnimationFrame(() => {
      panelRef.current?.querySelector<HTMLElement>(".shop-close")?.focus();
    });
    return () => {
      window.cancelAnimationFrame(focusFrame);
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (confirming) setConfirming(false);
        else {
          setConfirming(false);
          onClose();
        }
        return;
      }
      if (event.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const scope = confirming
        ? panel.querySelector<HTMLElement>(".shop-confirm") ?? panel
        : panel;
      const focusable = Array.from(
        scope.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => !element.hasAttribute("hidden"));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [confirming, onClose, open]);

  const selectedProduct = findShopProduct(selectedProductId) ?? SHOP_PRODUCTS[0];
  const owned = entitlements.purchasedProductIds.includes(selectedProduct.id);
  const prerequisiteOwned =
    selectedProduct.requires === null ||
    entitlements.purchasedProductIds.includes(selectedProduct.requires);
  const capacityAfterPurchase = useMemo(() => {
    if (owned) return inventoryCapacity;
    return inventoryCapacityFor({
      purchasedProductIds: [
        ...entitlements.purchasedProductIds,
        selectedProduct.id,
      ],
    });
  }, [entitlements.purchasedProductIds, inventoryCapacity, owned, selectedProduct.id]);
  const expansionProgress =
    ((inventoryCapacity - BASE_INVENTORY_CAPACITY) /
      (MAX_INVENTORY_CAPACITY - BASE_INVENTORY_CAPACITY)) *
    100;
  const receiptProduct = lastReceipt ? findShopProduct(lastReceipt.productId) : null;
  const selectedIsExpansion = selectedProduct.kind === "inventory-expansion";

  if (!open) return null;

  const checkoutDisabled =
    owned || !prerequisiteOwned || checkoutMode !== "local-test";

  return (
    <div className="shop-screen" role="presentation">
      <section
        ref={panelRef}
        className="shop-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shop-screen-title"
        aria-describedby="shop-screen-description"
      >
        <header className="shop-header">
          <div>
            <small>MEMORY CARAVAN · ACCOUNT SERVICE</small>
            <h2 id="shop-screen-title">기억 상단</h2>
            <p id="shop-screen-description">
              모든 기록 슬롯에 공통 적용되는 영구 편의 상품입니다.
            </p>
          </div>
          <div className="shop-header-capacity" aria-label={`현재 가방 ${inventoryCount} / ${inventoryCapacity}`}>
            <span>현재 가방</span>
            <strong>{inventoryCount} <i>/</i> {inventoryCapacity}</strong>
          </div>
          <a
            className="shop-header-market"
            href="/market?tab=gold"
            onClick={(event) => {
              if (!onMarketNavigate) return;
              event.preventDefault();
              onMarketNavigate();
            }}
          >
            거래소
          </a>
          <button
            type="button"
            className="shop-close"
            onClick={() => {
              setConfirming(false);
              onClose();
            }}
            aria-label="상점 닫기"
          >
            ×
          </button>
        </header>

        <div className="shop-test-banner" data-mode={checkoutMode} role="status">
          <strong>{checkoutMode === "local-test" ? "LOCAL PAYMENT DEMO" : "PAYMENT OFFLINE"}</strong>
          <span>
            {checkoutMode === "local-test"
              ? "실제 청구나 결제정보 입력 없이 구매 흐름과 영구 해금만 시험합니다."
              : "결제사와 서버 검증이 연결되기 전에는 실제 현금 결제가 차단됩니다."}
          </span>
        </div>

        {notice && (
          <div
            className={`shop-notice shop-notice--${notice.tone}`}
            role={notice.tone === "error" ? "alert" : "status"}
          >
            {notice.message}
          </div>
        )}

        <div className="shop-layout">
          <aside className="shop-category" aria-label="상점 분류">
            <button type="button" className="is-active" aria-current="page">
              <span aria-hidden="true">▦</span>
              <div>
                <strong>영구 편의</strong>
                <small>가방 · 좌표 이동</small>
              </div>
            </button>
            <a
              className="shop-market-entry"
              href="/market?tab=gold"
              onClick={(event) => {
                if (!onMarketNavigate) return;
                event.preventDefault();
                onMarketNavigate();
              }}
            >
              <span aria-hidden="true">◇</span>
              <div>
                <strong>기억 거래소</strong>
                <small>금괴 교환 · 장비 경매</small>
              </div>
              <b>이동</b>
            </a>
            <div className="shop-account-note">
              <small>적용 범위</small>
              <strong>이 기기의 3개 기록 슬롯</strong>
              <span>새 원정이나 저장 삭제 후에도 유지됩니다.</span>
            </div>
            <button type="button" className="shop-restore" onClick={onRestore}>
              구매 기록 복구
            </button>
          </aside>

          <section className="shop-catalog" aria-labelledby="shop-catalog-title">
            <div className="shop-section-heading">
              <div>
                <small>PERMANENT SERVICES</small>
                <h3 id="shop-catalog-title">상단의 영구 계약</h3>
              </div>
              <span>{entitlements.purchasedProductIds.length} / {SHOP_PRODUCTS.length}개 보유</span>
            </div>
            <div className="shop-capacity-track" aria-label={`가방 확장 진행도 ${Math.round(expansionProgress)}%`}>
              <i style={{ width: `${Math.max(0, Math.min(100, expansionProgress))}%` }} />
              {[24, 30, 36, 42, 48].map((capacity) => (
                <span key={capacity} className={inventoryCapacity >= capacity ? "is-reached" : ""}>
                  {capacity}
                </span>
              ))}
            </div>
            <div
              className="shop-product-grid"
              role="region"
              aria-label="상점 상품 목록 스크롤 영역"
              tabIndex={0}
            >
              {SHOP_PRODUCTS.map((product, index) => {
                const isExpansion = product.kind === "inventory-expansion";
                const productOwned = entitlements.purchasedProductIds.includes(product.id);
                const productUnlocked =
                  product.requires === null ||
                  entitlements.purchasedProductIds.includes(product.requires);
                const selected = product.id === selectedProductId;
                const resultingCapacity = isExpansion
                  ? Math.min(
                      MAX_INVENTORY_CAPACITY,
                      BASE_INVENTORY_CAPACITY + (index + 1) * product.inventorySlots,
                    )
                  : inventoryCapacity;
                return (
                  <button
                    type="button"
                    key={product.id}
                    className={`shop-product ${!isExpansion ? "shop-product--travel" : ""} ${selected ? "is-selected" : ""} ${productOwned ? "is-owned" : ""} ${!productUnlocked ? "is-locked" : ""}`}
                    onClick={() => {
                      setSelectedProductId(product.id);
                      setConfirming(false);
                    }}
                    aria-pressed={selected}
                  >
                    <span className="shop-product-seal" aria-hidden="true">
                      {isExpansion ? index + 1 : "⌖"}
                    </span>
                    <small>{product.shortName}</small>
                    <strong>{isExpansion ? `+${product.inventorySlots}칸` : "지도 순간이동"}</strong>
                    <em>{isExpansion ? `${resultingCapacity}칸 도달` : "방문·정복 좌표로 영구 도약"}</em>
                    <b>
                      {productOwned
                        ? "보유 중"
                        : productUnlocked
                          ? formatKrw(product.priceKrw)
                          : "선행 봉인 필요"}
                    </b>
                  </button>
                );
              })}
            </div>

            {lastReceipt && receiptProduct && (
              <div className="shop-receipt" aria-live="polite">
                <span aria-hidden="true">✓</span>
                <div>
                  <small>최근 로컬 영수증</small>
                  <strong>{receiptProduct.shortName} · {formatKrw(lastReceipt.priceKrw)}</strong>
                  <code>{lastReceipt.id}</code>
                </div>
              </div>
            )}
          </section>

          <aside
            className="shop-checkout"
            aria-labelledby="shop-checkout-title"
            tabIndex={0}
          >
            <small>SELECTED OFFER</small>
            <h3 id="shop-checkout-title">{selectedProduct.name}</h3>
            <p>{selectedProduct.description}</p>
            <div
              className={`shop-bag-illustration ${selectedIsExpansion ? "" : "is-wayfinder"}`}
              aria-hidden="true"
            >
              <span>{selectedIsExpansion ? `＋${selectedProduct.inventorySlots}` : "⌖"}</span>
              <i />
            </div>
            <dl>
              {selectedIsExpansion ? (
                <>
                  <div>
                    <dt>현재 가방</dt>
                    <dd>{inventoryCapacity}칸</dd>
                  </div>
                  <div>
                    <dt>구매 후</dt>
                    <dd>{capacityAfterPurchase}칸</dd>
                  </div>
                </>
              ) : (
                <>
                  <div>
                    <dt>현재 상태</dt>
                    <dd>{owned ? "사용 가능" : "미보유"}</dd>
                  </div>
                  <div>
                    <dt>해금 기능</dt>
                    <dd>탐사도 좌표 도약</dd>
                  </div>
                </>
              )}
              <div>
                <dt>적용</dt>
                <dd>영구 · 전체 기록</dd>
              </div>
            </dl>
            <div className="shop-price">
              <small>총 결제 금액</small>
              <strong>{formatKrw(selectedProduct.priceKrw)}</strong>
            </div>

            {!confirming ? (
              <button
                type="button"
                className="shop-buy"
                disabled={checkoutDisabled}
                onClick={() => setConfirming(true)}
              >
                {owned
                  ? "이미 보유한 상품"
                  : !prerequisiteOwned
                    ? "이전 봉인을 먼저 해방하세요"
                    : checkoutMode === "local-test"
                      ? "구매 내용 확인"
                      : "결제 시스템 준비 중"}
              </button>
            ) : (
              <div className="shop-confirm" role="alertdialog" aria-labelledby="shop-confirm-title">
                <strong id="shop-confirm-title">로컬 테스트 구매를 완료할까요?</strong>
                <p>실제 현금은 청구되지 않으며 이 기기에 해금 기록만 저장됩니다.</p>
                <div>
                  <button type="button" onClick={() => setConfirming(false)} autoFocus>
                    취소
                  </button>
                  <button
                    type="button"
                    className="is-confirm"
                    onClick={() => {
                      onPurchase(selectedProduct.id);
                      setConfirming(false);
                    }}
                  >
                    {formatKrw(selectedProduct.priceKrw)} 테스트 결제
                  </button>
                </div>
              </div>
            )}
            <p className="shop-legal-note">
              실제 결제 활성화 시에는 결제사 승인과 서버 영수증 검증 후에만 상품이 지급됩니다.
            </p>
          </aside>
        </div>

        <footer className="shop-footer">
          <span>무작위 장비나 전투력은 판매하지 않습니다 · 편의 기능만 영구 해금됩니다.</span>
          <span><kbd>P</kbd> 상점 · <kbd>ESC</kbd> 닫기</span>
        </footer>
      </section>
    </div>
  );
}
