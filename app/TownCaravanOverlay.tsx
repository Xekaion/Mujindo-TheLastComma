"use client";

import { useCallback, useMemo, useState } from "react";
import ShopOverlay from "./ShopOverlay";
import {
  completeLocalShopPurchase,
  inventoryCapacityFor,
  readShopEntitlements,
  shopCheckoutMode,
  type ShopCheckoutMode,
  type ShopEntitlements,
  type ShopProductId,
} from "./shop";

type TownCaravanOverlayProps = {
  open: boolean;
  inventoryCount: number;
  onClose: () => void;
  onOpenMarket: () => void;
};

type ShopNotice = {
  tone: "info" | "success" | "error";
  message: string;
};

export default function TownCaravanOverlay({
  open,
  inventoryCount,
  onClose,
  onOpenMarket,
}: TownCaravanOverlayProps) {
  const [entitlements, setEntitlements] = useState<ShopEntitlements>(() =>
    readShopEntitlements(),
  );
  const [checkoutMode] = useState<ShopCheckoutMode>(() => shopCheckoutMode());
  const [notice, setNotice] = useState<ShopNotice | null>(null);

  const inventoryCapacity = useMemo(
    () => inventoryCapacityFor(entitlements),
    [entitlements],
  );

  const purchase = useCallback(
    (productId: ShopProductId) => {
      if (checkoutMode !== "local-test") {
        setNotice({
          tone: "error",
          message:
            "운영 결제 영수증 검증이 아직 잠겨 있습니다. 상품 지급 없이 안전하게 중단했습니다.",
        });
        return;
      }

      const result = completeLocalShopPurchase(productId);
      setEntitlements(result.entitlements);
      if (result.status === "purchased") {
        setNotice({
          tone: "success",
          message: `${result.product.shortName} 계약이 계정 기록에 반영되었습니다.`,
        });
      } else if (result.status === "already-owned") {
        setNotice({ tone: "info", message: "이미 보유 중인 영구 상품입니다." });
      } else if (result.status === "locked") {
        setNotice({
          tone: "error",
          message: "앞 단계 가방 봉인을 먼저 해제해야 합니다.",
        });
      } else {
        setNotice({
          tone: "error",
          message:
            result.status === "write-failed"
              ? "구매 기록을 안전하게 저장하지 못해 상품을 지급하지 않았습니다."
              : "존재하지 않는 상품입니다.",
        });
      }
    },
    [checkoutMode],
  );

  const restore = useCallback(() => {
    const restored = readShopEntitlements();
    setEntitlements(restored);
    setNotice({
      tone: "info",
      message:
        restored.purchasedProductIds.length > 0
          ? `이 기기에서 영구 상품 ${restored.purchasedProductIds.length}개를 복구했습니다.`
          : "복구할 구매 기록이 없습니다.",
    });
  }, []);

  return (
    <ShopOverlay
      open={open}
      inventoryCount={inventoryCount}
      inventoryCapacity={inventoryCapacity}
      entitlements={entitlements}
      checkoutMode={checkoutMode}
      lastReceipt={entitlements.receipts.at(-1) ?? null}
      notice={notice}
      onClose={onClose}
      onPurchase={purchase}
      onRestore={restore}
      onMarketNavigate={onOpenMarket}
    />
  );
}
