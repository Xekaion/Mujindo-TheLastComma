import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type FocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
  type SetStateAction,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  EQUIPMENT_SLOT_LABELS,
  EQUIPMENT_SLOTS,
  GEAR_RARITIES,
  GEAR_ICON_COLUMNS,
  GEAR_ICON_ROWS,
  GEAR_RARITY_META,
  LEGENDARY_POWERS,
  MAX_GEAR_ENHANCEMENT,
  applySuccessfulGearEnhancement,
  canEquipGearAtLevel,
  calculateEquipmentPowerDelta,
  formatCompactGearLabel,
  formatGearDisplayName,
  gearIconCell,
  getGearAffixDisplay,
  getGearImplicitDisplay,
  getGearEnhancementRule,
  getGearRequiredLevel,
  getGearSalvageAshBreakdown,
  resolveEquipmentRarityResonance,
  type EquipmentLoadout,
  type EquipmentSlot,
  type GearItem,
  type GearRarity,
} from "./equipment";
import {
  AUTO_SALVAGE_RARITIES,
  toggleRaritySalvageSelection,
  type AutoSalvageThreshold,
} from "./auto-salvage";
import {
  INVENTORY_SORT_OPTIONS,
  sortInventoryItems,
  type InventorySortMode,
} from "./inventory-sort";
import { BASE_INVENTORY_CAPACITY } from "./shop";
import InventoryPaperdollFigure from "./InventoryPaperdollFigure";
import InventoryTooltipChrome from "./InventoryTooltipChrome";
import {
  MAX_DIVINE_FORGE_REROLLS,
  getDivineForgeRerollsRemaining,
  getDivineForgeRule,
  isDivineForgeMaterialEligible,
  sortDivineForgeMaterials,
  validateDivineForgeAttempt,
  type DivineForgeResult,
} from "./divine-forge";
import {
  clientPointToGamePlane,
  clientRectSizeToGamePlane,
  readGamePlaneMetrics,
} from "./canonical-game-plane";

export type InventoryOverlayProps = {
  open: boolean;
  readOnly?: boolean;
  onClose: () => void;
  equipment: EquipmentLoadout;
  inventory: GearItem[];
  inventoryCapacity: number;
  playerLevel: number;
  onOpenShop: () => void;
  selectedGearId: string | null;
  onSelect: (gearId: string) => void;
  onEquip: (gearId: string) => void;
  onUnequip: (slot: EquipmentSlot) => void;
  onSalvage: (gearId: string) => void;
  onSalvageMany: (gearIds: string[]) => void;
  autoSalvageMaxRarity: AutoSalvageThreshold;
  onAutoSalvageMaxRarityChange: (threshold: AutoSalvageThreshold) => void;
  onGrantRarityShowcase?: () => void;
  memoryAsh: number;
  operationNotice?: string | null;
  onEnhance: (gearId: string) => void;
  onDivineForgeReroll: (
    gearId: string,
    materialIds: readonly string[],
  ) => DivineForgeResult | null;
  onGrantDivineForgeShowcase?: () => void;
  equippedPower: number;
};

const TOOLTIP_WIDTH = 390;
const TOOLTIP_MAX_HEIGHT = 720;
const TOOLTIP_GAP = 20;

type TooltipPosition = {
  x: number;
  y: number;
};

function rarityClass(item: GearItem) {
  return `inventory-screen-rarity--${item.rarity}`;
}

function powerDeltaClass(delta: number) {
  if (delta > 0) return "inventory-screen-grid-delta--positive";
  if (delta < 0) return "inventory-screen-grid-delta--negative";
  return "inventory-screen-grid-delta--neutral";
}

function formatPowerDelta(delta: number) {
  if (delta > 0) return `+${delta.toLocaleString("ko-KR")}`;
  if (delta < 0) return delta.toLocaleString("ko-KR");
  return "0";
}

function clampTooltipPositionInFrame(
  clientX: number,
  clientY: number,
  tooltipWidth: number,
  tooltipHeight: number,
  frame: ReturnType<typeof readGamePlaneMetrics>,
): TooltipPosition {
  const localPoint = clientPointToGamePlane(clientX, clientY, frame);
  const frameWidth = frame.width;
  const frameHeight = frame.height;
  const localX = localPoint.x;
  const localY = localPoint.y;
  const safeWidth = Math.min(tooltipWidth, Math.max(0, frameWidth - 24));
  const safeHeight = Math.min(tooltipHeight, Math.max(0, frameHeight - 24));
  const roomOnRight = localX + TOOLTIP_GAP + safeWidth <= frameWidth;
  const preferredX = roomOnRight
    ? localX + TOOLTIP_GAP
    : localX - safeWidth - TOOLTIP_GAP;

  return {
    x: Math.max(12, Math.min(preferredX, frameWidth - safeWidth - 12)),
    y: Math.max(12, Math.min(localY - 48, frameHeight - safeHeight - 12)),
  };
}

function clampTooltipPosition(
  clientX: number,
  clientY: number,
  tooltipWidth = TOOLTIP_WIDTH,
  tooltipHeight = TOOLTIP_MAX_HEIGHT,
): TooltipPosition {
  const frame = readGamePlaneMetrics();
  return clampTooltipPositionInFrame(
    clientX,
    clientY,
    tooltipWidth,
    tooltipHeight,
    frame,
  );
}

function focusTooltipAnchor(rect: DOMRect) {
  const frame = readGamePlaneMetrics();
  const logicalOffsetInClientPixels = 56 / frame.clientToPlaneScaleY;
  return {
    x: rect.right,
    y: rect.top + Math.min(rect.height / 2, logicalOffsetInClientPixels),
  };
}

function GearIcon({ item, size = 64 }: { item: GearItem; size?: number }) {
  const { column, row } = gearIconCell(item.iconIndex);
  const backgroundX = GEAR_ICON_COLUMNS > 1
    ? (column / (GEAR_ICON_COLUMNS - 1)) * 100
    : 0;
  const backgroundY = GEAR_ICON_ROWS > 1
    ? (row / (GEAR_ICON_ROWS - 1)) * 100
    : 0;
  const style = {
    width: size,
    height: size,
    backgroundImage: "url('/assets/equipment/equipment-types-v4.png')",
    backgroundRepeat: "no-repeat",
    backgroundSize: `${GEAR_ICON_COLUMNS * 100}% ${GEAR_ICON_ROWS * 100}%`,
    backgroundPosition: `${backgroundX}% ${backgroundY}%`,
  } satisfies CSSProperties;

  return (
    <span
      className="inventory-screen-gear-icon"
      style={style}
      role="img"
      aria-label={`${formatGearDisplayName(item)} 장비 아이콘`}
    />
  );
}

const SPARKLING_RARITIES: ReadonlySet<GearItem["rarity"]> = new Set([
  "rare",
  "epic",
  "legendary",
  "mythic",
  "cosmic",
]);

function RaritySparkles({ rarity }: { rarity: GearItem["rarity"] }) {
  if (!SPARKLING_RARITIES.has(rarity)) return null;
  return (
    <span
      className={`inventory-screen-rarity-sparkles inventory-screen-rarity-sparkles--${rarity}`}
      aria-hidden="true"
    >
      <i />
      <i />
      <i />
    </span>
  );
}

function RarityAura({ rarity }: { rarity: GearItem["rarity"] }) {
  if (!SPARKLING_RARITIES.has(rarity)) return null;
  return (
    <span
      className={`inventory-screen-rarity-aura inventory-screen-rarity-aura--${rarity}`}
      aria-hidden="true"
    />
  );
}

function RaritySpectacle({ rarity }: { rarity: GearItem["rarity"] }) {
  return (
    <span
      className={`inventory-screen-rarity-spectacle inventory-screen-rarity-spectacle--${rarity}`}
      aria-hidden="true"
    />
  );
}

function GearAffixBreakdown({
  item,
  affix,
  compact = false,
}: {
  item: GearItem;
  affix: GearItem["affixes"][number];
  compact?: boolean;
}) {
  const display = getGearAffixDisplay(affix, item);
  const optionLabel = formatCompactGearLabel(display.totalLabel);

  return (
    <div
      className={compact ? "inventory-screen-affix-breakdown inventory-screen-affix-breakdown--compact" : "inventory-screen-affix-breakdown"}
      aria-label={optionLabel}
    >
      <strong>{optionLabel}</strong>
    </div>
  );
}

function GearImplicitBreakdown({
  item,
  compact = false,
}: {
  item: GearItem;
  compact?: boolean;
}) {
  const display = getGearImplicitDisplay(item);
  const optionLabel = formatCompactGearLabel(display.totalLabel);

  return (
    <section
      className={`inventory-screen-implicit-option${compact ? " inventory-screen-implicit-option--compact" : ""}`}
      aria-label={optionLabel}
    >
      <strong>{optionLabel}</strong>
    </section>
  );
}

type EquipmentResonance = ReturnType<typeof resolveEquipmentRarityResonance>;

function formatHighTierResonance(
  bonus: EquipmentResonance["highTierBonus"],
) {
  if (bonus.count <= 0) return "효과 대기";
  return `공격력 +${bonus.damagePercent}% · 공속 +${bonus.attackSpeedPercent}% · 보스 +${bonus.bossDamagePercent}%`;
}

function formatCosmicResonance(
  bonus: EquipmentResonance["cosmicBonus"],
) {
  if (bonus.count <= 0) return "효과 대기";
  return `최종 피해 +${bonus.finalDamagePercent}% · 행동 속도 +${bonus.actionSpeedPercent}%`;
}

const RESONANCE_DETAIL_WIDTH = 286;
const RESONANCE_DETAIL_HEIGHT = 126;

type ResonanceSetTone = "mythic" | "cosmic";

type ResonanceSetDetail = {
  tone: ResonanceSetTone;
  source: "pointer" | "focus";
  label: string;
  count: number;
  current: string;
  next: string;
  position: TooltipPosition;
};

function ResonanceSetBadge({
  tone,
  label,
  count,
  current,
  next,
  active,
  onShow,
  onHide,
}: {
  tone: ResonanceSetTone;
  label: string;
  count: number;
  current: string;
  next: string;
  active: boolean;
  onShow: (detail: ResonanceSetDetail) => void;
  onHide: (tone: ResonanceSetTone, source: ResonanceSetDetail["source"]) => void;
}) {
  const detailId = `inventory-screen-${tone}-set-detail`;

  const showAt = (
    clientX: number,
    clientY: number,
    source: ResonanceSetDetail["source"],
  ) => {
    onShow({
      tone,
      source,
      label,
      count,
      current,
      next,
      position: clampTooltipPosition(
        clientX,
        clientY,
        RESONANCE_DETAIL_WIDTH,
        RESONANCE_DETAIL_HEIGHT,
      ),
    });
  };

  const showFromPointer = (event: MouseEvent<HTMLSpanElement>) => {
    showAt(
      event.clientX,
      event.clientY,
      document.activeElement === event.currentTarget ? "focus" : "pointer",
    );
  };

  const showFromFocus = (event: FocusEvent<HTMLSpanElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    showAt(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
      "focus",
    );
  };

  const hideFromPointer = (event: MouseEvent<HTMLSpanElement>) => {
    if (document.activeElement === event.currentTarget) {
      const rect = event.currentTarget.getBoundingClientRect();
      showAt(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
        "focus",
      );
      return;
    }
    onHide(tone, "pointer");
  };

  return (
    <span
      className={`inventory-screen-resonance-chip inventory-screen-resonance-chip--${tone}`}
      tabIndex={0}
      aria-label={`${label}, 장착 ${count}개`}
      aria-describedby={active ? detailId : undefined}
      onMouseEnter={showFromPointer}
      onMouseMove={showFromPointer}
      onMouseLeave={hideFromPointer}
      onFocus={showFromFocus}
      onBlur={() => onHide(tone, "focus")}
    >
      <strong>{label}</strong>
    </span>
  );
}

function ResonanceSetSummary({
  resonance,
  detail,
  setDetail,
  onOpenDetail,
}: {
  resonance: EquipmentResonance;
  detail: ResonanceSetDetail | null;
  setDetail: Dispatch<SetStateAction<ResonanceSetDetail | null>>;
  onOpenDetail: () => void;
}) {
  useEffect(() => {
    const hideWhenPointerLeavesBadges = (event: globalThis.MouseEvent) => {
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest(".inventory-screen-resonance-chip")
      ) return;
      setDetail((current) => current?.source === "pointer" ? null : current);
    };
    document.addEventListener("mousemove", hideWhenPointerLeavesBadges);
    return () => document.removeEventListener("mousemove", hideWhenPointerLeavesBadges);
  }, [setDetail]);

  const showDetail = (nextDetail: ResonanceSetDetail) => {
    onOpenDetail();
    setDetail(nextDetail);
  };
  const hideDetail = (
    tone: ResonanceSetTone,
    source: ResonanceSetDetail["source"],
  ) => {
    setDetail((current) =>
      current?.tone === tone && current.source === source ? null : current,
    );
  };
  const mythicNext = resonance.highTierNext
    ? `${resonance.highTierNext.count}개 ${formatHighTierResonance(resonance.highTierNext)}`
    : "최종 단계";
  const cosmicNext = resonance.cosmicNext
    ? `${resonance.cosmicNext.count}개 ${formatCosmicResonance(resonance.cosmicNext)}`
    : "최종 단계";

  return (
    <>
      <div
        className="inventory-screen-resonance-summary"
        role="group"
        aria-label={`세트 효과, 신화세트 ${resonance.highTierCount}개, 우주세트 ${resonance.cosmicCount}개`}
      >
        <ResonanceSetBadge
          tone="mythic"
          label="신화세트"
          count={resonance.highTierCount}
          current={formatHighTierResonance(resonance.highTierBonus)}
          next={mythicNext}
          active={detail?.tone === "mythic"}
          onShow={showDetail}
          onHide={hideDetail}
        />
        <ResonanceSetBadge
          tone="cosmic"
          label="우주세트"
          count={resonance.cosmicCount}
          current={formatCosmicResonance(resonance.cosmicBonus)}
          next={cosmicNext}
          active={detail?.tone === "cosmic"}
          onShow={showDetail}
          onHide={hideDetail}
        />
      </div>
      {detail && typeof document !== "undefined" && createPortal(
        <span
          id={`inventory-screen-${detail.tone}-set-detail`}
          className={`inventory-screen-resonance-detail inventory-screen-resonance-detail--${detail.tone}`}
          role="tooltip"
          style={{ left: detail.position.x, top: detail.position.y }}
        >
          <b>{detail.label} · 장착 {detail.count}개</b>
          <em>현재 · {detail.current}</em>
          <small>다음 · {detail.next}</small>
        </span>,
        document.body,
      )}
    </>
  );
}

function ResonanceTransition({
  equipment,
  item,
  equipped,
}: {
  equipment: EquipmentLoadout;
  item: GearItem;
  equipped: boolean;
}) {
  const before = resolveEquipmentRarityResonance(equipment);
  const after = resolveEquipmentRarityResonance({
    ...equipment,
    [item.slot]: equipped ? null : item,
  });
  const highTierChanged =
    before.highTierCount !== after.highTierCount ||
    before.highTierBonus.count !== after.highTierBonus.count;
  const cosmicChanged =
    before.cosmicCount !== after.cosmicCount ||
    before.cosmicBonus.count !== after.cosmicBonus.count;

  if (!highTierChanged && !cosmicChanged) return null;
  return (
    <div
      className="inventory-screen-resonance-transition"
      aria-label={equipped ? "해제 시 고위 장비 공명 변화" : "장착 시 고위 장비 공명 변화"}
    >
      <strong>{equipped ? "해제 시 공명 변화" : "장착 시 공명 변화"}</strong>
      {highTierChanged && (
        <span className="inventory-screen-resonance-transition__tier inventory-screen-resonance-transition__tier--mythic">
          <b>신화 공명 {before.highTierCount} → {after.highTierCount}</b>
          <small>{formatHighTierResonance(after.highTierBonus)}</small>
        </span>
      )}
      {cosmicChanged && (
        <span className="inventory-screen-resonance-transition__tier inventory-screen-resonance-transition__tier--cosmic">
          <b>우주 초월 {before.cosmicCount} → {after.cosmicCount}</b>
          <small>{formatCosmicResonance(after.cosmicBonus)}</small>
        </span>
      )}
    </div>
  );
}

function GearTooltip({
  item,
  comparisonItem,
  equipment,
  equipped,
  readOnly,
  playerLevel,
  position,
  powerDelta,
  tooltipRef,
  onMeasure,
}: {
  item: GearItem;
  comparisonItem: GearItem | null;
  equipment: EquipmentLoadout;
  equipped: boolean;
  readOnly: boolean;
  playerLevel: number;
  position: TooltipPosition;
  powerDelta: number;
  tooltipRef: { current: HTMLDivElement | null };
  onMeasure: (width: number, height: number) => void;
}) {
  const requiredLevel = getGearRequiredLevel(item);
  const levelLocked = !equipped && !canEquipGearAtLevel(playerLevel, item);

  useLayoutEffect(() => {
    const tooltip = tooltipRef.current;
    if (!tooltip) return;

    const reportSize = () => {
      const rect = tooltip.getBoundingClientRect();
      const size = clientRectSizeToGamePlane(rect);
      onMeasure(size.width, size.height);
    };
    reportSize();
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(reportSize);
    observer?.observe(tooltip);
    return () => observer?.disconnect();
  }, [item.id, onMeasure, tooltipRef]);

  return (
    <div
      ref={tooltipRef}
      id="inventory-screen-hover-tooltip"
      role="tooltip"
      className={`inventory-screen-tooltip ${rarityClass(item)} ${item.rarity === "rare" ? "inventory-screen-tooltip--rare" : ""} ${item.rarity === "epic" ? "inventory-screen-tooltip--epic" : ""} ${item.rarity === "legendary" ? "inventory-screen-tooltip--legendary" : ""} ${item.rarity === "mythic" ? "inventory-screen-tooltip--mythic" : ""} ${item.rarity === "cosmic" ? "inventory-screen-tooltip--cosmic" : ""}`}
      style={{ left: position.x, top: position.y }}
    >
      <InventoryTooltipChrome rarity={item.rarity} />
      <div className="inventory-screen-tooltip-crest" aria-hidden="true">
        <GearIcon item={item} size={88} />
      </div>
      <div className="inventory-screen-tooltip-scroll">
        <div className="inventory-screen-tooltip-heading">
          <small>
            {GEAR_RARITY_META[item.rarity].label} · {EQUIPMENT_SLOT_LABELS[item.slot]}
          </small>
          <h4>{formatGearDisplayName(item)}</h4>
          <span className={levelLocked ? "inventory-screen-level-requirement--locked" : undefined}>
            아이템 레벨 {item.level} · 착용 필요 레벨 {requiredLevel}
            {levelLocked && <b> · 레벨 부족</b>}
          </span>
        </div>
        <div className="inventory-screen-tooltip-power">
          <span>아이템 보스 화력</span>
          <strong>{item.powerScore.toLocaleString("ko-KR")}</strong>
          {!equipped && (
            <em className={powerDeltaClass(powerDelta)}>
              {formatPowerDelta(powerDelta)}
            </em>
          )}
        </div>
        <ResonanceTransition
          equipment={equipment}
          item={item}
          equipped={equipped}
        />
        <GearImplicitBreakdown item={item} compact />
        <div className="inventory-screen-tooltip-quality">
          <span>품질</span>
          <i aria-hidden="true">
            <b style={{ width: `${item.qualityScore}%` }} />
          </i>
          <strong aria-label={`장비 품질 ${item.qualityScore}점`}>
            품질 {item.qualityScore}/100
          </strong>
        </div>
        <div className="inventory-screen-tooltip-affixes">
          {item.affixes.map((affix) => (
            <GearAffixBreakdown item={item} affix={affix} compact key={affix.stat} />
          ))}
        </div>
        {item.legendaryPowerId && (
          <div className="inventory-screen-tooltip-legendary-power">
            <strong>{LEGENDARY_POWERS[item.legendaryPowerId].name}</strong>
            <p>{LEGENDARY_POWERS[item.legendaryPowerId].description}</p>
          </div>
        )}
        <footer>
          {equipped ? "현재 장착 중" : comparisonItem ? `${formatGearDisplayName(comparisonItem)}와 비교` : "빈 슬롯과 비교"}
          <span>
            {readOnly
              ? "클릭하여 상세 정보 확인"
              : equipped
                ? "클릭하여 선택 · 더블 클릭하여 장착 해제"
                : "클릭하여 선택 · 더블 클릭하여 장착"}
            {" · 휠·PageUp/Down 옵션 스크롤"}
          </span>
        </footer>
      </div>
    </div>
  );
}

type DivineForgeStep = "prepare" | "confirm" | "result";

function DivineForgeAffixList({ item }: { item: GearItem }) {
  return (
    <ul className="inventory-screen-divine-forge-affixes">
      {item.affixes.map((affix) => (
        <li key={affix.stat}>
          {formatCompactGearLabel(getGearAffixDisplay(affix, item).totalLabel)}
        </li>
      ))}
    </ul>
  );
}

function DivineForgeDialog({
  targets,
  targetId,
  inventory,
  memoryAsh,
  step,
  result,
  onTargetChange,
  onRequestConfirmation,
  onCancelConfirmation,
  onExecute,
  onClose,
  onGrantShowcase,
}: {
  targets: GearItem[];
  targetId: string | null;
  inventory: GearItem[];
  memoryAsh: number;
  step: DivineForgeStep;
  result: DivineForgeResult | null;
  onTargetChange: (targetId: string) => void;
  onRequestConfirmation: () => void;
  onCancelConfirmation: () => void;
  onExecute: (targetId: string, materialIds: readonly string[]) => void;
  onClose: () => void;
  onGrantShowcase?: () => void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const target =
    targets.find((item) => item.id === targetId) ?? targets[0] ?? null;
  const rule = target ? getDivineForgeRule(target) : null;
  const eligibleMaterials = target
    ? sortDivineForgeMaterials(
        inventory.filter((item) => isDivineForgeMaterialEligible(target, item)),
      )
    : [];
  const materials = rule
    ? eligibleMaterials.slice(0, rule.materialCount)
    : [];
  const validation = target
    ? validateDivineForgeAttempt(target, materials, memoryAsh)
    : null;
  const materialRarityLabel = rule
    ? GEAR_RARITY_META[rule.materialRarity].label
    : "전설/신화";
  const remaining = target ? getDivineForgeRerollsRemaining(target) : 0;
  const status = !target
    ? "가방이나 장착 장비에서 신화 또는 우주 장비를 먼저 준비하세요."
    : target.divineForgeRerolls >= MAX_DIVINE_FORGE_REROLLS
      ? "이 장비는 최대 재련 3회를 모두 사용했습니다."
      : materials.length < (rule?.materialCount ?? 5)
        ? `${materialRarityLabel} 재료가 ${(rule?.materialCount ?? 5) - materials.length}개 부족합니다. 대상보다 아이템 레벨이 높아야 합니다.`
        : memoryAsh < (rule?.ashCost ?? 0)
          ? `기억의 재가 ${((rule?.ashCost ?? 0) - memoryAsh).toLocaleString("ko-KR")}개 부족합니다.`
          : "헌납할 재료 5개와 비용을 확인했습니다. 모든 무작위 옵션을 새로 재련할 수 있습니다.";
  const shownBefore = result?.before ?? target;
  const shownAfter = result?.after ?? null;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const preferredSelector =
      step === "confirm"
        ? ".inventory-screen-divine-forge-cancel"
        : step === "result"
          ? ".inventory-screen-divine-forge-action--complete"
          : "#inventory-screen-divine-forge-target-select, .inventory-screen-divine-forge-close";
    const focusFrame = window.requestAnimationFrame(() => {
      const preferred = dialog.querySelector<HTMLElement>(preferredSelector);
      (preferred ?? dialog).focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(focusFrame);
  }, [step, targets.length]);

  const trapDialogFocus = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== "Tab") return;
    const focusable = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(
        'button:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((element) => element.getClientRects().length > 0);
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !event.currentTarget.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !event.currentTarget.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      className="inventory-screen-divine-forge-backdrop"
      onMouseDown={(event) => {
        event.stopPropagation();
        if (event.target !== event.currentTarget) return;
        if (step === "confirm") onCancelConfirmation();
        else onClose();
      }}
    >
      <section
        ref={dialogRef}
        className={`inventory-screen-divine-forge-dialog inventory-screen-divine-forge-dialog--${step}`}
        role={step === "confirm" ? "alertdialog" : "dialog"}
        aria-modal="true"
        aria-labelledby="inventory-screen-divine-forge-title"
        aria-describedby={step === "result" ? undefined : "inventory-screen-divine-forge-status"}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={trapDialogFocus}
      >
        <header className="inventory-screen-divine-forge-heading">
          <span className="inventory-screen-divine-forge-crest" aria-hidden="true" />
          <div>
            <small>DIVINE REFORGING</small>
            <h3 id="inventory-screen-divine-forge-title">
              {step === "result"
                ? "신의 대장간 · 재련 완료"
                : step === "confirm"
                  ? "신의 대장간 · 최종 헌납"
                  : "신의 대장간"}
            </h3>
            <p>
              신화와 우주 장비의 모든 무작위 옵션을 신의 불꽃으로 다시 새깁니다.
            </p>
          </div>
          <button
            type="button"
            className="inventory-screen-divine-forge-close"
            onClick={step === "confirm" ? onCancelConfirmation : onClose}
            aria-label={step === "confirm" ? "최종 헌납 확인 취소" : "신의 대장간 닫기"}
          >
            ×
          </button>
        </header>

        {step === "result" && result && shownBefore && shownAfter ? (
          <div className="inventory-screen-divine-forge-result">
            <div className="inventory-screen-divine-forge-result-summary">
              <GearIcon item={shownAfter} size={72} />
              <div>
                <small>{GEAR_RARITY_META[shownAfter.rarity].label} 재련 {shownAfter.divineForgeRerolls}/3</small>
                <strong>{formatGearDisplayName(shownAfter)}</strong>
                <span>
                  품질 {shownBefore.qualityScore} → {shownAfter.qualityScore} · 보스 화력 {shownBefore.powerScore.toLocaleString("ko-KR")} → {shownAfter.powerScore.toLocaleString("ko-KR")}
                </span>
              </div>
            </div>
            <div className="inventory-screen-divine-forge-result-columns">
              <section>
                <h4>변경 전</h4>
                <DivineForgeAffixList item={shownBefore} />
              </section>
              <span className="inventory-screen-divine-forge-result-arrow" aria-hidden="true">→</span>
              <section>
                <h4>변경 후</h4>
                <DivineForgeAffixList item={shownAfter} />
              </section>
            </div>
            <p className="inventory-screen-divine-forge-result-footnote">
              아이템 레벨·부위·등급·강화 단계·고유 효과는 그대로 유지되었습니다.
            </p>
            <button
              type="button"
              className="inventory-screen-divine-forge-action inventory-screen-divine-forge-action--complete"
              onClick={onClose}
              autoFocus
            >
              <span>재련 결과 확인 완료</span>
            </button>
          </div>
        ) : (
          <>
            <div className="inventory-screen-divine-forge-body">
              <section className="inventory-screen-divine-forge-target">
                <div className="inventory-screen-divine-forge-target-heading">
                  <label htmlFor="inventory-screen-divine-forge-target-select">재련 대상</label>
                  {onGrantShowcase && step === "prepare" && (
                    <button type="button" onClick={onGrantShowcase}>
                      로컬 검수 재료 지급
                    </button>
                  )}
                </div>
                {targets.length > 0 ? (
                  <select
                    id="inventory-screen-divine-forge-target-select"
                    value={target?.id ?? ""}
                    onChange={(event) => onTargetChange(event.target.value)}
                    disabled={step === "confirm"}
                  >
                    {targets.map((item) => (
                      <option value={item.id} key={item.id}>
                        {GEAR_RARITY_META[item.rarity].label} · LV.{item.level} · {formatGearDisplayName(item)} · 재련 {item.divineForgeRerolls}/3
                      </option>
                    ))}
                  </select>
                ) : (
                  <div className="inventory-screen-divine-forge-no-target">
                    신화 또는 우주 장비가 없습니다.
                  </div>
                )}

                {target && rule && (
                  <div className="inventory-screen-divine-forge-target-card">
                    <GearIcon item={target} size={74} />
                    <div>
                      <small>{GEAR_RARITY_META[target.rarity].label} · {EQUIPMENT_SLOT_LABELS[target.slot]} · 아이템 레벨 {target.level}</small>
                      <strong>{formatGearDisplayName(target)}</strong>
                      <span>무작위 옵션 {target.affixes.length}개 전체 변경</span>
                    </div>
                    <dl>
                      <div><dt>사용</dt><dd>{target.divineForgeRerolls}/3</dd></div>
                      <div><dt>남음</dt><dd>{remaining}회</dd></div>
                    </dl>
                  </div>
                )}
              </section>

              <section className="inventory-screen-divine-forge-offering">
                <div className="inventory-screen-divine-forge-offering-heading">
                  <div>
                    <small>SACRIFICE</small>
                    <h4>헌납 장비 5개</h4>
                  </div>
                  {rule && (
                    <span>
                      {materialRarityLabel} · 대상보다 높은 아이템 레벨
                    </span>
                  )}
                </div>
                <div className="inventory-screen-divine-forge-materials" role="list">
                  {Array.from({ length: 5 }, (_, index) => {
                    const material = materials[index] ?? null;
                    return (
                      <div
                        className={`inventory-screen-divine-forge-material ${material ? rarityClass(material) : "inventory-screen-divine-forge-material--empty"}`}
                        role="listitem"
                        aria-label={material
                          ? `재료 ${index + 1}, ${formatGearDisplayName(material)}, 아이템 레벨 ${material.level}, 강화 +${material.enhancement}`
                          : `재료 ${index + 1}, 미충족`}
                        key={material?.id ?? `empty-${index}`}
                      >
                        <span className="inventory-screen-divine-forge-material-art" aria-hidden="true" />
                        <b>{index + 1}</b>
                        {material ? (
                          <>
                            <GearIcon item={material} size={56} />
                            <span>LV.{material.level}</span>
                            <small>+{material.enhancement}</small>
                          </>
                        ) : (
                          <em>미충족</em>
                        )}
                      </div>
                    );
                  })}
                </div>
                {eligibleMaterials.length > 5 && step === "prepare" && (
                  <p className="inventory-screen-divine-forge-auto-note">
                    조건을 충족한 {eligibleMaterials.length}개 중 아이템 레벨·강화·화력이 낮은 순서로 5개를 자동 선택했습니다.
                  </p>
                )}
              </section>

              <aside className="inventory-screen-divine-forge-contract">
                <div>
                  <small>기억의 재</small>
                  <strong>{rule ? rule.ashCost.toLocaleString("ko-KR") : "—"}</strong>
                  <span>보유 {memoryAsh.toLocaleString("ko-KR")}</span>
                </div>
                <p>
                  모든 무작위 옵션만 변경됩니다. 아이템 레벨·부위·등급·강화 단계·고유 효과는 유지됩니다.
                </p>
              </aside>

              {step === "confirm" && target && (
                <section className="inventory-screen-divine-forge-confirm-options">
                  <h4>현재 무작위 옵션 {target.affixes.length}개</h4>
                  <DivineForgeAffixList item={target} />
                </section>
              )}
            </div>

            <footer className="inventory-screen-divine-forge-footer">
              <p
                id="inventory-screen-divine-forge-status"
                role="status"
                data-ready={validation?.ok ? "true" : "false"}
              >
                {step === "confirm"
                  ? "이 재련은 되돌릴 수 없습니다. 표시된 장비 5개와 기억의 재가 즉시 소모됩니다."
                  : status}
              </p>
              {step === "confirm" ? (
                <div className="inventory-screen-divine-forge-confirm-actions">
                  <button
                    type="button"
                    className="inventory-screen-divine-forge-cancel"
                    onClick={onCancelConfirmation}
                    autoFocus
                  >
                    취소
                  </button>
                  <button
                    type="button"
                    className="inventory-screen-divine-forge-action"
                    onClick={() => target && onExecute(target.id, materials.map((item) => item.id))}
                  >
                    <span>재료 5개를 바쳐 전체 옵션 재련</span>
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className="inventory-screen-divine-forge-action"
                  onClick={onRequestConfirmation}
                  disabled={!validation?.ok}
                  aria-describedby="inventory-screen-divine-forge-status"
                >
                  <span>신의 불꽃으로 재련</span>
                  <small>{rule ? `기억의 재 ${rule.ashCost.toLocaleString("ko-KR")} · 재료 5개` : "대상을 준비하세요"}</small>
                </button>
              )}
            </footer>
          </>
        )}
      </section>
    </div>
  );
}

export default function InventoryOverlay({
  open,
  readOnly = false,
  onClose,
  equipment,
  inventory,
  inventoryCapacity,
  playerLevel,
  onOpenShop,
  selectedGearId,
  onSelect,
  onEquip,
  onUnequip,
  onSalvage,
  onSalvageMany,
  autoSalvageMaxRarity,
  onAutoSalvageMaxRarityChange,
  onGrantRarityShowcase,
  memoryAsh,
  operationNotice = null,
  onEnhance,
  onDivineForgeReroll,
  onGrantDivineForgeShowcase,
  equippedPower,
}: InventoryOverlayProps) {
  const [hoveredItem, setHoveredItem] = useState<GearItem | null>(null);
  const [hoveredItemIsEquipped, setHoveredItemIsEquipped] = useState(false);
  const [resonanceDetail, setResonanceDetail] =
    useState<ResonanceSetDetail | null>(null);
  const [tooltipPosition, setTooltipPosition] = useState<TooltipPosition>({
    x: 12,
    y: 12,
  });
  const [salvageMode, setSalvageMode] = useState(false);
  const [salvageConfirmationOpen, setSalvageConfirmationOpen] = useState(false);
  const [pendingSingleSalvageId, setPendingSingleSalvageId] = useState<
    string | null
  >(null);
  const [selectedForSalvage, setSelectedForSalvage] = useState<Set<string>>(
    () => new Set(),
  );
  const [inventorySortMode, setInventorySortMode] =
    useState<InventorySortMode>("power");
  const [divineForgeOpen, setDivineForgeOpen] = useState(false);
  const [divineForgeTargetId, setDivineForgeTargetId] = useState<string | null>(null);
  const [divineForgeStep, setDivineForgeStep] =
    useState<DivineForgeStep>("prepare");
  const [divineForgeResult, setDivineForgeResult] =
    useState<DivineForgeResult | null>(null);
  const salvageModeActive = !readOnly && salvageMode;
  const inventoryViewportRef = useRef<HTMLDivElement>(null);
  const divineForgeTriggerRef = useRef<HTMLButtonElement>(null);
  const tooltipElementRef = useRef<HTMLDivElement>(null);
  const tooltipAnchorRef = useRef({ x: 12, y: 12 });
  const tooltipFrameRef = useRef<ReturnType<typeof readGamePlaneMetrics> | null>(
    null,
  );
  const tooltipSizeRef = useRef({
    width: TOOLTIP_WIDTH,
    height: TOOLTIP_MAX_HEIGHT,
  });
  const handleTooltipMeasure = useCallback(
    (width: number, height: number) => {
      const frame = tooltipFrameRef.current ?? readGamePlaneMetrics();
      tooltipFrameRef.current = frame;
      tooltipSizeRef.current = { width, height };
      const anchor = tooltipAnchorRef.current;
      setTooltipPosition(
        clampTooltipPosition(anchor.x, anchor.y, width, height),
      );
    },
    [],
  );
  const closeDivineForge = useCallback(() => {
    setDivineForgeOpen(false);
    setDivineForgeStep("prepare");
    setDivineForgeResult(null);
    window.requestAnimationFrame(() => {
      const trigger = divineForgeTriggerRef.current;
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    });
  }, []);
  const normalizedInventoryCapacity = Math.max(
    BASE_INVENTORY_CAPACITY,
    Math.floor(inventoryCapacity),
  );
  const sortedInventory = useMemo(
    () => sortInventoryItems(inventory, inventorySortMode),
    [inventory, inventorySortMode],
  );
  const inventorySourceIndexById = useMemo(
    () => new Map(inventory.map((item, index) => [item.id, index] as const)),
    [inventory],
  );
  const inventoryPowerDeltaById = useMemo(
    () => new Map(
      inventory.map((item) => [
        item.id,
        calculateEquipmentPowerDelta(equipment, item),
      ] as const),
    ),
    [equipment, inventory],
  );

  useEffect(() => {
    if (!open || !salvageConfirmationOpen) return undefined;

    const dismissConfirmation = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === "i") {
        setSalvageConfirmationOpen(false);
        setPendingSingleSalvageId(null);
        return;
      }
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setSalvageConfirmationOpen(false);
      setPendingSingleSalvageId(null);
    };

    window.addEventListener("keydown", dismissConfirmation, true);
    return () => window.removeEventListener("keydown", dismissConfirmation, true);
  }, [open, salvageConfirmationOpen]);

  useEffect(() => {
    if (!open || !divineForgeOpen) return undefined;
    const dismissForge = (event: KeyboardEvent) => {
      if (event.key !== "Escape" && event.key.toLowerCase() !== "i") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (divineForgeStep === "confirm") setDivineForgeStep("prepare");
      else closeDivineForge();
    };
    window.addEventListener("keydown", dismissForge, true);
    return () => window.removeEventListener("keydown", dismissForge, true);
  }, [closeDivineForge, divineForgeOpen, divineForgeStep, open]);

  useEffect(() => {
    if (!open) return undefined;
    return () => {
      setHoveredItem(null);
      setHoveredItemIsEquipped(false);
      setResonanceDetail(null);
    };
  }, [open]);

  if (!open) return null;

  const equippedItems = EQUIPMENT_SLOTS.flatMap((slot) => {
    const item = equipment[slot];
    return item ? [item] : [];
  });
  const selectedInventoryItem =
    inventory.find((item) => item.id === selectedGearId) ?? null;
  const selectedEquippedItem =
    equippedItems.find((item) => item.id === selectedGearId) ?? null;
  const selectedItem = selectedInventoryItem ?? selectedEquippedItem;
  const divineForgeTargets = [...inventory, ...equippedItems]
    .filter((item) => getDivineForgeRule(item) !== null)
    .sort(
      (left, right) =>
        (left.id === selectedGearId ? -1 : 0) -
          (right.id === selectedGearId ? -1 : 0) ||
        right.rarity.localeCompare(left.rarity) ||
        right.level - left.level ||
        left.id.localeCompare(right.id),
    );
  const selectedIsEquipped = selectedEquippedItem !== null;
  const selectedRequiredLevel = selectedItem
    ? getGearRequiredLevel(selectedItem)
    : 1;
  const selectedLevelLocked = selectedInventoryItem !== null
    && !canEquipGearAtLevel(playerLevel, selectedInventoryItem);
  const selectedSalvageAsh = selectedInventoryItem
    ? getGearSalvageAshBreakdown(selectedInventoryItem).total
    : 0;
  const comparisonItem = selectedInventoryItem
    ? equipment[selectedInventoryItem.slot]
    : null;
  const powerDelta = selectedInventoryItem
    ? inventoryPowerDeltaById.get(selectedInventoryItem.id) ?? 0
    : 0;
  const enhancementRule = selectedItem
    ? getGearEnhancementRule(selectedItem)
    : null;
  const selectedImplicitDisplay = selectedItem
    ? getGearImplicitDisplay(selectedItem)
    : null;
  const equipmentWithSelectedItem: EquipmentLoadout = selectedItem
    ? { ...equipment, [selectedItem.slot]: selectedItem }
    : equipment;
  const enhancementOptionPreviews = selectedItem && enhancementRule
    ? Array.from({ length: selectedItem.affixes.length + 1 }, (_, index) =>
        applySuccessfulGearEnhancement(
          selectedItem,
          (index + 0.5) / (selectedItem.affixes.length + 1),
        ),
      ).flatMap((result) => (result ? [result] : []))
    : [];
  const enhancementPowerGains = enhancementOptionPreviews.map(({ item }) =>
    Math.max(0, calculateEquipmentPowerDelta(equipmentWithSelectedItem, item)),
  );
  const minimumEnhancementPowerGain = enhancementPowerGains.length > 0
    ? Math.min(...enhancementPowerGains)
    : 0;
  const maximumEnhancementPowerGain = enhancementPowerGains.length > 0
    ? Math.max(...enhancementPowerGains)
    : 0;
  const enhancementPowerGainLabel = minimumEnhancementPowerGain === maximumEnhancementPowerGain
    ? `+${minimumEnhancementPowerGain.toLocaleString("ko-KR")}`
    : `+${minimumEnhancementPowerGain.toLocaleString("ko-KR")}~+${maximumEnhancementPowerGain.toLocaleString("ko-KR")}`;
  const canAffordEnhancement = enhancementRule
    ? memoryAsh >= enhancementRule.ashCost
    : false;
  const emptyCellCount = Math.max(
    0,
    normalizedInventoryCapacity - inventory.length,
  );
  const selectedSalvageItems = inventory.filter((item) =>
    selectedForSalvage.has(item.id),
  );
  const expectedSalvageAsh = selectedSalvageItems.reduce(
    (total, item) => total + getGearSalvageAshBreakdown(item).total,
    0,
  );
  const expectedEnhancementRefund = selectedSalvageItems.reduce(
    (total, item) =>
      total + getGearSalvageAshBreakdown(item).enhancementRefund,
    0,
  );
  const pendingSingleSalvageItem = pendingSingleSalvageId
    ? inventory.find((item) => item.id === pendingSingleSalvageId) ?? null
    : null;
  const confirmationSalvageItems = pendingSingleSalvageItem
    ? [pendingSingleSalvageItem]
    : selectedSalvageItems;
  const confirmationSalvageAsh = confirmationSalvageItems.reduce(
    (total, item) => total + getGearSalvageAshBreakdown(item).total,
    0,
  );
  const confirmationEnhancementRefund = confirmationSalvageItems.reduce(
    (total, item) =>
      total + getGearSalvageAshBreakdown(item).enhancementRefund,
    0,
  );
  const confirmationBaseSalvageAsh =
    confirmationSalvageAsh - confirmationEnhancementRefund;
  const hoveredComparisonItem = hoveredItemIsEquipped || !hoveredItem
    ? null
    : equipment[hoveredItem.slot];
  const equippedResonance = resolveEquipmentRarityResonance(equipment);

  const openDivineForge = () => {
    if (readOnly) return;
    const preferred =
      selectedItem && getDivineForgeRule(selectedItem)
        ? selectedItem
        : divineForgeTargets[0] ?? null;
    setSalvageMode(false);
    clearSalvageSelection();
    setHoveredItem(null);
    setDivineForgeTargetId(preferred?.id ?? null);
    setDivineForgeResult(null);
    setDivineForgeStep("prepare");
    setDivineForgeOpen(true);
  };

  const executeDivineForge = (
    targetId: string,
    materialIds: readonly string[],
  ) => {
    const forged = onDivineForgeReroll(targetId, materialIds);
    if (!forged) {
      setDivineForgeStep("prepare");
      return;
    }
    setDivineForgeResult(forged);
    setDivineForgeTargetId(forged.after.id);
    setDivineForgeStep("result");
  };

  const showPointerTooltip = (
    item: GearItem,
    equipped: boolean,
    event: MouseEvent<HTMLElement>,
  ) => {
    if (salvageModeActive) return;
    const frame = readGamePlaneMetrics();
    tooltipFrameRef.current = frame;
    setResonanceDetail(null);
    tooltipAnchorRef.current = { x: event.clientX, y: event.clientY };
    setHoveredItem(item);
    setHoveredItemIsEquipped(equipped);
    setTooltipPosition(
      clampTooltipPositionInFrame(
        event.clientX,
        event.clientY,
        tooltipSizeRef.current.width,
        tooltipSizeRef.current.height,
        frame,
      ),
    );
  };

  const movePointerTooltip = (event: MouseEvent<HTMLElement>) => {
    if (salvageModeActive) return;
    const frame = tooltipFrameRef.current;
    const tooltip = tooltipElementRef.current;
    if (!frame || !tooltip) return;
    tooltipAnchorRef.current = { x: event.clientX, y: event.clientY };
    const position = clampTooltipPositionInFrame(
      event.clientX,
      event.clientY,
      tooltipSizeRef.current.width,
      tooltipSizeRef.current.height,
      frame,
    );
    tooltip.style.left = `${position.x}px`;
    tooltip.style.top = `${position.y}px`;
  };

  const showFocusTooltip = (
    item: GearItem,
    equipped: boolean,
    event: FocusEvent<HTMLElement>,
  ) => {
    if (salvageModeActive) return;
    const frame = readGamePlaneMetrics();
    tooltipFrameRef.current = frame;
    setResonanceDetail(null);
    const rect = event.currentTarget.getBoundingClientRect();
    const anchor = focusTooltipAnchor(rect);
    tooltipAnchorRef.current = anchor;
    setHoveredItem(item);
    setHoveredItemIsEquipped(equipped);
    setTooltipPosition(
      clampTooltipPosition(
        anchor.x,
        anchor.y,
        tooltipSizeRef.current.width,
        tooltipSizeRef.current.height,
      ),
    );
  };

  const hidePointerTooltip = (event: MouseEvent<HTMLElement>) => {
    if (document.activeElement === event.currentTarget) {
      const frame = readGamePlaneMetrics();
      tooltipFrameRef.current = frame;
      const rect = event.currentTarget.getBoundingClientRect();
      const anchor = focusTooltipAnchor(rect);
      tooltipAnchorRef.current = anchor;
      setTooltipPosition(
        clampTooltipPosition(
          anchor.x,
          anchor.y,
          tooltipSizeRef.current.width,
          tooltipSizeRef.current.height,
        ),
      );
      return;
    }
    setHoveredItem(null);
  };

  const hideFocusTooltip = () => {
    setHoveredItem(null);
  };

  const scrollTooltipBy = (delta: number, edge?: "start" | "end") => {
    const scroller = document.querySelector<HTMLElement>(
      "#inventory-screen-hover-tooltip .inventory-screen-tooltip-scroll",
    );
    if (!scroller || scroller.scrollHeight <= scroller.clientHeight) return false;
    if (edge === "start") scroller.scrollTo({ top: 0 });
    else if (edge === "end") scroller.scrollTo({ top: scroller.scrollHeight });
    else scroller.scrollBy({ top: delta });
    return true;
  };

  const handleTooltipWheel = (event: ReactWheelEvent<HTMLElement>) => {
    if (!hoveredItem || !scrollTooltipBy(event.deltaY)) return;
    event.preventDefault();
    event.stopPropagation();
  };

  const handleTooltipKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    const command = event.key;
    const handled = command === "PageDown"
      ? scrollTooltipBy(180)
      : command === "PageUp"
        ? scrollTooltipBy(-180)
        : command === "Home"
          ? scrollTooltipBy(0, "start")
          : command === "End"
            ? scrollTooltipBy(0, "end")
            : false;
    if (!handled) return;
    event.preventDefault();
    event.stopPropagation();
  };

  const equipItem = (gearId: string) => {
    if (readOnly) return;
    const item = inventory.find((candidate) => candidate.id === gearId);
    if (!item || !canEquipGearAtLevel(playerLevel, item)) return;
    setHoveredItem(null);
    onEquip(gearId);
  };

  const unequipItem = (slot: EquipmentSlot) => {
    if (readOnly) return;
    setHoveredItem(null);
    setHoveredItemIsEquipped(false);
    onUnequip(slot);
  };

  const toggleSalvageSelection = (gearId: string) => {
    if (readOnly) return;
    setSelectedForSalvage((current) => {
      const next = new Set(current);
      if (next.has(gearId)) next.delete(gearId);
      else next.add(gearId);
      return next;
    });
  };

  const toggleRarityForSalvage = (rarity: GearRarity) => {
    if (readOnly) return;
    setSelectedForSalvage((current) =>
      toggleRaritySalvageSelection(inventory, current, rarity),
    );
  };

  const chooseAutoSalvageThreshold = (value: string) => {
    if (readOnly) return;
    const threshold =
      AUTO_SALVAGE_RARITIES.find((rarity) => rarity === value) ?? null;
    onAutoSalvageMaxRarityChange(threshold);
  };

  const selectAllForSalvage = () => {
    if (readOnly) return;
    setSelectedForSalvage(new Set(inventory.map((item) => item.id)));
  };

  const clearSalvageSelection = () => {
    setSelectedForSalvage(new Set());
  };

  const chooseInventorySortMode = (mode: InventorySortMode) => {
    setInventorySortMode(mode);
    setHoveredItem(null);
    if (inventoryViewportRef.current) {
      inventoryViewportRef.current.scrollTop = 0;
    }
  };

  const toggleSalvageMode = () => {
    if (readOnly) return;
    setSalvageMode((current) => !current);
    clearSalvageSelection();
    setHoveredItem(null);
  };

  const requestSalvageMany = () => {
    if (readOnly) return;
    if (selectedSalvageItems.length === 0) return;
    setHoveredItem(null);
    setPendingSingleSalvageId(null);
    setSalvageConfirmationOpen(true);
  };

  const requestSalvageOne = (gearId: string) => {
    if (readOnly) return;
    if (!inventory.some((item) => item.id === gearId)) return;
    setHoveredItem(null);
    setPendingSingleSalvageId(gearId);
    setSalvageConfirmationOpen(true);
  };

  const closeSalvageConfirmation = () => {
    setSalvageConfirmationOpen(false);
    setPendingSingleSalvageId(null);
  };

  const confirmSalvage = () => {
    if (readOnly) return;
    const gearIds = confirmationSalvageItems.map((item) => item.id);
    if (gearIds.length === 0) return;
    if (pendingSingleSalvageItem) onSalvage(pendingSingleSalvageItem.id);
    else {
      onSalvageMany(gearIds);
      clearSalvageSelection();
    }
    closeSalvageConfirmation();
  };

  const handleBackdropMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    closeSalvageConfirmation();
    closeDivineForge();
    setHoveredItem(null);
    setResonanceDetail(null);
    onClose();
  };

  const handleInventoryClose = () => {
    closeSalvageConfirmation();
    closeDivineForge();
    setHoveredItem(null);
    setResonanceDetail(null);
    onClose();
  };

  const handleInventoryScrollKeyDown = (
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) => {
    const viewport = event.currentTarget;
    const lineStep = Math.max(48, viewport.clientHeight * 0.14);
    const pageStep = Math.max(lineStep, viewport.clientHeight * 0.82);
    let nextTop: number | null = null;

    if (event.key === "ArrowDown") nextTop = viewport.scrollTop + lineStep;
    else if (event.key === "ArrowUp") nextTop = viewport.scrollTop - lineStep;
    else if (event.key === "PageDown") nextTop = viewport.scrollTop + pageStep;
    else if (event.key === "PageUp") nextTop = viewport.scrollTop - pageStep;
    else if (event.key === "Home") nextTop = 0;
    else if (event.key === "End") nextTop = viewport.scrollHeight;

    if (nextTop === null) return;
    event.preventDefault();
    event.stopPropagation();
    viewport.scrollTo({ top: nextTop, behavior: "auto" });
    setHoveredItem(null);
  };

  return (
    <div
      className={`inventory-screen${readOnly ? " inventory-screen--read-only" : ""}`}
      data-inventory-mode={readOnly ? "inspect" : "manage"}
      role={divineForgeOpen ? undefined : "dialog"}
      aria-modal={divineForgeOpen ? undefined : "true"}
      aria-labelledby={divineForgeOpen ? undefined : "inventory-screen-title"}
      onMouseDown={handleBackdropMouseDown}
    >
      <div
        className="inventory-screen-panel"
        inert={divineForgeOpen ? true : undefined}
        aria-hidden={divineForgeOpen ? true : undefined}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="inventory-screen-art" aria-hidden="true" />

        <header className="inventory-screen-header">
          <div>
            <span className="inventory-screen-kicker">방랑자의 성물고</span>
            <h2 className="inventory-screen-title" id="inventory-screen-title">
              기억의 무기고
            </h2>
          </div>
          <p className="inventory-screen-subtitle">
            {readOnly
              ? "광장에서 장착 장비와 가방의 모든 옵션을 안전하게 확인합니다."
              : "장비 위에 커서를 올리면 모든 접사와 비교 수치가 펼쳐집니다."}
          </p>
          <ResonanceSetSummary
            resonance={equippedResonance}
            detail={resonanceDetail}
            setDetail={setResonanceDetail}
            onOpenDetail={() => {
              setHoveredItem(null);
              setHoveredItemIsEquipped(false);
            }}
          />
          <div className="inventory-screen-header-resources">
            <span>기억의 재</span>
            <b>{memoryAsh.toLocaleString("ko-KR")}</b>
          </div>
          {!readOnly && (
            <button
              ref={divineForgeTriggerRef}
              type="button"
              className="inventory-screen-divine-forge-open"
              onClick={openDivineForge}
              aria-haspopup="dialog"
            >
              <span aria-hidden="true" />
              <small>DIVINE</small>
              <b>신의 대장간</b>
            </button>
          )}
          <button
            type="button"
            className="inventory-screen-close"
            onClick={handleInventoryClose}
            aria-label="인벤토리 닫기"
          >
            <span aria-hidden="true">×</span>
          </button>
        </header>

        <div className="inventory-screen-layout">
          <div className="inventory-screen-left-column">
            <section
              className="inventory-screen-equipment"
              aria-labelledby="inventory-screen-equipment-title"
            >
              <div className="inventory-screen-section-heading">
                <h3 id="inventory-screen-equipment-title">장착 장비</h3>
                <span className="inventory-screen-equipment-summary__power">
                  장비 보스 전투력 <b>{equippedPower.toLocaleString("ko-KR")}</b>
                </span>
              </div>

              <div className="inventory-screen-equipment-slots">
                <InventoryPaperdollFigure equipment={equipment} />
                {EQUIPMENT_SLOTS.map((slot) => {
                  const item = equipment[slot];
                  const selected = item?.id === selectedGearId;
                  return (
                    <button
                      type="button"
                      key={slot}
                      className={`inventory-screen-equipment-card inventory-screen-equipment-card--${slot} ${item ? rarityClass(item) : "inventory-screen-equipment-card--empty"} ${selected ? "inventory-screen-item--selected" : ""}`}
                      onClick={() => item && onSelect(item.id)}
                      onDoubleClick={() => {
                        if (item && !salvageModeActive && !readOnly) unequipItem(slot);
                      }}
                      onMouseEnter={(event) => item && showPointerTooltip(item, true, event)}
                      onMouseMove={(event) => item && movePointerTooltip(event)}
                      onMouseLeave={(event) => item && hidePointerTooltip(event)}
                      onFocus={(event) => item && showFocusTooltip(item, true, event)}
                      onBlur={hideFocusTooltip}
                      onWheel={handleTooltipWheel}
                      onKeyDown={handleTooltipKeyDown}
                      aria-label={
                        item
                          ? `${EQUIPMENT_SLOT_LABELS[slot]} 장착품 ${formatGearDisplayName(item, { includeZero: true })} 정보 보기`
                          : `${EQUIPMENT_SLOT_LABELS[slot]} 슬롯 비어 있음`
                      }
                      aria-describedby={item && !salvageModeActive && hoveredItem?.id === item.id ? "inventory-screen-hover-tooltip" : undefined}
                      aria-pressed={item ? selected : undefined}
                      disabled={!item}
                    >
                      {item && <RaritySpectacle rarity={item.rarity} />}
                      <span className="inventory-screen-slot-clip" aria-hidden="true">
                        {item ? (
                          <GearIcon item={item} size={88} />
                        ) : (
                          <span className="inventory-screen-empty-slot-icon">
                            ＋
                          </span>
                        )}
                      </span>
                      {item && <RarityAura rarity={item.rarity} />}
                      {item && <RaritySparkles rarity={item.rarity} />}
                      <small className="inventory-screen-slot-label">
                        {slot === "offhand" ? "보조" : EQUIPMENT_SLOT_LABELS[slot]}
                      </small>
                      {item && (
                        <strong
                          className="inventory-screen-equipment-enhancement"
                          aria-label={`강화 +${item.enhancement}`}
                        >
                          +{item.enhancement}
                        </strong>
                      )}
                    </button>
                  );
                })}
              </div>
            </section>

            <section
              className={`inventory-screen-details ${readOnly ? "inventory-screen-details--read-only" : ""} ${selectedItem ? rarityClass(selectedItem) : "inventory-screen-details--empty"}`}
              aria-labelledby="inventory-screen-details-title"
              aria-live="polite"
            >
              <div className="inventory-screen-section-heading">
                <h3 id="inventory-screen-details-title">
                  {readOnly ? "장비 상세" : "각인 작업대"}
                </h3>
                {selectedIsEquipped && (
                  <span className="inventory-screen-equipped-badge">장착 중</span>
                )}
              </div>

              {selectedItem ? (
                <div className="inventory-screen-detail-content">
                  <div className="inventory-screen-detail-identity">
                    <GearIcon item={selectedItem} size={74} />
                    <div className="inventory-screen-detail-copy">
                      <small className="inventory-screen-detail-rarity">
                        {GEAR_RARITY_META[selectedItem.rarity].label} · {EQUIPMENT_SLOT_LABELS[selectedItem.slot]}
                      </small>
                      <h4>{formatGearDisplayName(selectedItem)}</h4>
                      <span className={selectedLevelLocked ? "inventory-screen-level-requirement--locked" : undefined}>
                        아이템 레벨 {selectedItem.level} · 착용 필요 레벨 {selectedRequiredLevel} · 보스 화력 <b>{selectedItem.powerScore.toLocaleString("ko-KR")}</b>
                      </span>
                    </div>
                    {!selectedIsEquipped && (
                      <strong className={`inventory-screen-workbench-delta ${powerDeltaClass(powerDelta)}`}>
                        {formatPowerDelta(powerDelta)}
                      </strong>
                    )}
                  </div>

                  <div className={`inventory-screen-detail-columns${readOnly ? " inventory-screen-detail-columns--read-only" : ""}`}>
                    <div
                      className="inventory-screen-detail-stats"
                      role="region"
                      aria-label="장비 옵션 스크롤 영역"
                      tabIndex={0}
                    >
                      {!selectedIsEquipped && (
                        <div className="inventory-screen-comparison">
                          <span>{comparisonItem ? formatGearDisplayName(comparisonItem) : "빈 슬롯"} 대비</span>
                          <strong className={powerDeltaClass(powerDelta)}>
                            {formatPowerDelta(powerDelta)} 장착 보스 전투력
                          </strong>
                        </div>
                      )}
                      <ResonanceTransition
                        equipment={equipment}
                        item={selectedItem}
                        equipped={selectedIsEquipped}
                      />
                      <GearImplicitBreakdown item={selectedItem} />
                      <div className="inventory-screen-quality" aria-label={`장비 품질 ${selectedItem.qualityScore}점`}>
                        <span>품질</span>
                        <span className="inventory-screen-quality-track" aria-hidden="true">
                          <i
                            className="inventory-screen-quality-fill"
                            style={{ "--inventory-screen-quality": `${selectedItem.qualityScore}%` } as CSSProperties}
                          />
                        </span>
                        <b>품질 {selectedItem.qualityScore}/100</b>
                      </div>
                      <div className="inventory-screen-affixes">
                        {selectedItem.affixes.map((affix) => (
                          <GearAffixBreakdown item={selectedItem} affix={affix} key={affix.stat} />
                        ))}
                      </div>
                      {selectedItem.legendaryPowerId && (
                        <div className="inventory-screen-legendary-power">
                          <strong>{LEGENDARY_POWERS[selectedItem.legendaryPowerId].name}</strong>
                          <p>{LEGENDARY_POWERS[selectedItem.legendaryPowerId].description}</p>
                        </div>
                      )}
                    </div>

                    {!readOnly && (
                      <div className="inventory-screen-detail-actions-column">
                        <section
                          className="inventory-screen-enhancement"
                          aria-labelledby="inventory-screen-enhancement-title"
                        >
                          <div
                            className="inventory-screen-enhancement-scroll"
                            role="region"
                            aria-label="강화 정보 스크롤 영역"
                            tabIndex={0}
                          >
                            <div className="inventory-screen-enhancement-heading">
                              <div>
                                <small>기억 각인</small>
                                <h5 id="inventory-screen-enhancement-title">장비 강화</h5>
                              </div>
                              <div className="inventory-screen-ash" aria-label={`기억의 재 보유량 ${memoryAsh}`}>
                                <span className="inventory-screen-ash-icon" aria-hidden="true">✦</span>
                                <b>{memoryAsh.toLocaleString("ko-KR")}</b>
                              </div>
                            </div>

                            {enhancementRule ? (
                              <>
                                <div className="inventory-screen-enhancement-stages">
                                  <span>현재 <b>+{selectedItem.enhancement}</b></span>
                                  <i aria-hidden="true">→</i>
                                  <span>목표 <b>+{enhancementRule.target}</b></span>
                                  <em>
                                    성공 시 {selectedItem.affixes.length + 1}개 옵션 중 1개 균등 선택 · 중복 가능
                                  </em>
                                </div>
                                <div className="inventory-screen-enhancement-affix-gains">
                                  <strong>당첨 후보 · 각 1/{selectedItem.affixes.length + 1}</strong>
                                  <ul>
                                    <li>
                                      <span>{selectedImplicitDisplay ? formatCompactGearLabel(selectedImplicitDisplay.totalLabel) : ""}</span>
                                      <em>{selectedImplicitDisplay ? formatCompactGearLabel(selectedImplicitDisplay.nextStageGainLabel) : ""}</em>
                                    </li>
                                    {selectedItem.affixes.map((affix) => {
                                      const display = getGearAffixDisplay(affix, selectedItem);
                                      return (
                                        <li key={affix.stat}>
                                          <span>{formatCompactGearLabel(display.totalLabel)}</span>
                                          <em>{formatCompactGearLabel(display.nextStageGainLabel)}</em>
                                        </li>
                                      );
                                    })}
                                  </ul>
                                  <small>원래 옵션 수치는 유지되며, 당첨된 옵션 줄에 강화 횟수가 누적됩니다.</small>
                                </div>
                                <dl className="inventory-screen-enhancement-rates">
                                  <div className="inventory-screen-enhancement-rate--cost">
                                    <dt>재</dt>
                                    <dd>{enhancementRule.ashCost.toLocaleString("ko-KR")}</dd>
                                  </div>
                                  <div className="inventory-screen-enhancement-rate--success">
                                    <dt>성공</dt>
                                    <dd>{enhancementRule.successPercent}%</dd>
                                  </div>
                                  <div className="inventory-screen-enhancement-rate--failure">
                                    <dt>실패</dt>
                                    <dd>{enhancementRule.failurePercent}%</dd>
                                  </div>
                                  <div className="inventory-screen-enhancement-rate--destroy">
                                    <dt>파괴</dt>
                                    <dd>{enhancementRule.destroyPercent}%</dd>
                                  </div>
                                </dl>
                                {enhancementRule.destroyPercent > 0 && (
                                  <p className="inventory-screen-enhancement-warning" role="alert">
                                    실패 시 {enhancementRule.destroyPercent}% 확률로 장비가 파괴됩니다.
                                  </p>
                                )}
                                {!canAffordEnhancement && (
                                  <p className="inventory-screen-ash-shortage">
                                    기억의 재가 {(enhancementRule.ashCost - memoryAsh).toLocaleString("ko-KR")}개 부족합니다.
                                  </p>
                                )}
                              </>
                            ) : (
                              <div className="inventory-screen-enhancement-max">
                                <strong>최대 강화 +{MAX_GEAR_ENHANCEMENT}</strong>
                                <span>모든 강화 단계가 적용되었습니다.</span>
                              </div>
                            )}
                          </div>

                          {enhancementRule && (
                            <button
                              type="button"
                              className="inventory-screen-enhancement-button"
                              onClick={() => onEnhance(selectedItem.id)}
                              disabled={!canAffordEnhancement}
                            >
                              +{enhancementRule.target} 강화
                              <small>
                                장착 보스 전투력 {enhancementPowerGainLabel} · 재 {enhancementRule.ashCost.toLocaleString("ko-KR")}
                              </small>
                            </button>
                          )}
                        </section>

                      {selectedIsEquipped ? (
                        <div className="inventory-screen-equipped-actions">
                          <span className="inventory-screen-equipped-state">현재 장착 중인 장비입니다.</span>
                          <button
                            type="button"
                            className="inventory-screen-unequip-button"
                            onClick={() => unequipItem(selectedItem.slot)}
                            aria-label={`${formatGearDisplayName(selectedItem)} 장착 해제`}
                          >
                            장착 해제
                          </button>
                        </div>
                      ) : (
                        <div className="inventory-screen-actions">
                          <button
                            type="button"
                            className="inventory-screen-equip-button"
                            onClick={() => equipItem(selectedItem.id)}
                            disabled={selectedLevelLocked}
                            title={selectedLevelLocked ? `캐릭터 LV.${selectedRequiredLevel}부터 장착할 수 있습니다.` : undefined}
                          >
                            {selectedLevelLocked ? `LV.${selectedRequiredLevel}부터 장착` : "장착하기"}
                          </button>
                          <button type="button" className="inventory-screen-salvage-button" onClick={() => requestSalvageOne(selectedItem.id)}>
                            분해 · 재 {selectedSalvageAsh.toLocaleString("ko-KR")}
                          </button>
                        </div>
                      )}
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div className="inventory-screen-detail-placeholder">
                  <span aria-hidden="true">✦</span>
                  <p>
                    {readOnly
                      ? "장비를 선택하면 모든 능력치와 고유 효과를 확인할 수 있습니다."
                      : "장비를 선택하면 이곳에서 장착·강화·분해할 수 있습니다."}
                  </p>
                </div>
              )}
            </section>
          </div>

          <section
            className={`inventory-screen-backpack${readOnly ? " inventory-screen-backpack--read-only" : ""}`}
            aria-labelledby="inventory-screen-backpack-title"
          >
            <div className="inventory-screen-section-heading">
              <div>
                <h3 id="inventory-screen-backpack-title">방랑자의 가방</h3>
                <small>장비에 마우스를 올려 전체 옵션 확인</small>
              </div>
              <div
                className="inventory-screen-sort-controls"
                role="group"
                aria-label="가방 정렬 기준"
              >
                <span>정렬</span>
                {INVENTORY_SORT_OPTIONS.map((option) => (
                  <button
                    type="button"
                    key={option.id}
                    aria-pressed={inventorySortMode === option.id}
                    aria-label={`${option.label}별 정렬`}
                    title={option.title}
                    onClick={() => chooseInventorySortMode(option.id)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <div className="inventory-screen-capacity-actions">
                <span>
                  <b>{inventory.length}</b> / {normalizedInventoryCapacity}
                  {inventory.length > normalizedInventoryCapacity && (
                    <em>초과 {inventory.length - normalizedInventoryCapacity}</em>
                  )}
                </span>
                {!readOnly && (
                  <button type="button" onClick={onOpenShop}>
                    ＋ 공간 확장
                  </button>
                )}
              </div>
            </div>

            {!readOnly && (
              <div
                className={`inventory-screen-batch-toolbar ${salvageMode ? "inventory-screen-batch-toolbar--active" : ""}`}
                aria-label="장비 일괄 분해 도구"
              >
              <button
                type="button"
                className="inventory-screen-batch-mode-button"
                aria-pressed={salvageMode}
                onClick={toggleSalvageMode}
              >
                {salvageMode ? "선택 종료" : "일괄 분해"}
              </button>
              {!salvageMode && (
                <label className="inventory-screen-auto-salvage">
                  <span>
                    <i aria-hidden="true" />
                    자동 분해
                  </span>
                  <select
                    aria-label="새 장비 자동 분해 등급 기준"
                    value={autoSalvageMaxRarity ?? ""}
                    onChange={(event) =>
                      chooseAutoSalvageThreshold(event.currentTarget.value)
                    }
                  >
                    <option value="">사용 안 함</option>
                    {AUTO_SALVAGE_RARITIES.map((rarity) => (
                      <option value={rarity} key={rarity}>
                        {GEAR_RARITY_META[rarity].label} 이하
                      </option>
                    ))}
                  </select>
                  <small>새 장비만 · 전설 이상 보호</small>
                </label>
              )}
              {!salvageMode && onGrantRarityShowcase && (
                <button
                  type="button"
                  className="inventory-screen-rarity-showcase-button"
                  onClick={onGrantRarityShowcase}
                  title="로컬 화면 검수용으로 각 장비 등급을 하나씩 지급합니다"
                >
                  8등급 견본 지급
                </button>
              )}
              {salvageMode && (
                <>
                  <button type="button" onClick={selectAllForSalvage}>
                    전체 선택
                  </button>
                  <button
                    type="button"
                    onClick={clearSalvageSelection}
                    disabled={selectedSalvageItems.length === 0}
                  >
                    선택 해제
                  </button>
                  <span className="inventory-screen-batch-summary" aria-live="polite">
                    <b>{selectedSalvageItems.length}</b>개 선택 · 예상 기억의 재 <strong>{expectedSalvageAsh.toLocaleString("ko-KR")}</strong>
                    {expectedEnhancementRefund > 0 && (
                      <em> · 강화비 {expectedEnhancementRefund.toLocaleString("ko-KR")} 전액 환급(100% 성공 기준)</em>
                    )}
                  </span>
                  <button
                    type="button"
                    className="inventory-screen-batch-salvage-button"
                    onClick={requestSalvageMany}
                    disabled={selectedSalvageItems.length === 0}
                  >
                    선택 분해
                  </button>
                  <div
                    className="inventory-screen-rarity-salvage-filters"
                    role="group"
                    aria-label="등급별 일괄 분해 선택"
                  >
                    {GEAR_RARITIES.map((rarity) => {
                      const rarityItems = inventory.filter(
                        (item) => item.rarity === rarity,
                      );
                      const selectedCount = rarityItems.filter((item) =>
                        selectedForSalvage.has(item.id),
                      ).length;
                      const selectionState =
                        rarityItems.length > 0 &&
                        selectedCount === rarityItems.length
                          ? "all"
                          : selectedCount > 0
                            ? "mixed"
                            : "none";
                      return (
                        <button
                          type="button"
                          key={rarity}
                          className={`inventory-screen-rarity-salvage-filter is-${selectionState}`}
                          style={{
                            "--rarity-filter-color":
                              GEAR_RARITY_META[rarity].color,
                          } as CSSProperties}
                          aria-pressed={
                            selectionState === "mixed"
                              ? "mixed"
                              : selectionState === "all"
                          }
                          aria-label={`${GEAR_RARITY_META[rarity].label} 등급 ${rarityItems.length}개 중 ${selectedCount}개 선택`}
                          title={`${GEAR_RARITY_META[rarity].label} 등급 전체 선택 또는 해제`}
                          disabled={rarityItems.length === 0}
                          onClick={() => toggleRarityForSalvage(rarity)}
                        >
                          <i aria-hidden="true" />
                          <span>{GEAR_RARITY_META[rarity].label}</span>
                          <b>{selectedCount}/{rarityItems.length}</b>
                        </button>
                      );
                    })}
                  </div>
                </>
              )}
              </div>
            )}

            <div
              ref={inventoryViewportRef}
              className="inventory-screen-grid-viewport"
              role="region"
              aria-label={`가방 장비 목록, ${inventory.length}개 장비와 ${emptyCellCount}개 빈 슬롯, 세로 스크롤`}
              tabIndex={0}
              onScroll={() => setHoveredItem(null)}
              onKeyDown={handleInventoryScrollKeyDown}
            >
              <div className="inventory-screen-grid">
                {sortedInventory.map((item, itemIndex) => {
                const selected = item.id === selectedGearId;
                const requiredLevel = getGearRequiredLevel(item);
                const levelLocked = !canEquipGearAtLevel(playerLevel, item);
                const itemPowerDelta = inventoryPowerDeltaById.get(item.id) ?? 0;
                const checkedForSalvage =
                  salvageModeActive && selectedForSalvage.has(item.id);
                const sourceIndex = inventorySourceIndexById.get(item.id) ?? itemIndex;
                const overCapacity = sourceIndex >= normalizedInventoryCapacity;
                return (
                  <div
                    className={`inventory-screen-grid-cell ${salvageModeActive ? "inventory-screen-grid-cell--salvage-mode" : ""} ${checkedForSalvage ? "inventory-screen-grid-cell--salvage-selected" : ""} ${overCapacity ? "inventory-screen-grid-cell--over-capacity" : ""}`}
                    key={item.id}
                  >
                    <button
                      type="button"
                      className={`inventory-screen-grid-item ${rarityClass(item)} ${levelLocked ? "inventory-screen-grid-item--level-locked" : ""} ${!salvageModeActive && selected ? "inventory-screen-item--selected" : ""}`}
                      onClick={() => {
                        if (salvageModeActive) toggleSalvageSelection(item.id);
                        else onSelect(item.id);
                      }}
                      onDoubleClick={() => {
                        if (!salvageModeActive && !readOnly) equipItem(item.id);
                      }}
                      onMouseEnter={(event) => showPointerTooltip(item, false, event)}
                      onMouseMove={movePointerTooltip}
                      onMouseLeave={hidePointerTooltip}
                      onFocus={(event) => showFocusTooltip(item, false, event)}
                      onBlur={hideFocusTooltip}
                      onWheel={handleTooltipWheel}
                      onKeyDown={handleTooltipKeyDown}
                      aria-label={salvageModeActive
                        ? `${formatGearDisplayName(item, { includeZero: true })} 일괄 분해 ${checkedForSalvage ? "선택 해제" : "선택"}`
                        : `${formatGearDisplayName(item, { includeZero: true })}, 아이템 레벨 ${item.level}, 착용 필요 레벨 ${requiredLevel}, 아이템 보스 화력 ${item.powerScore}, 장착 보스 전투력 변화 ${formatPowerDelta(itemPowerDelta)}, 품질 ${item.qualityScore}점`}
                      aria-describedby={!salvageModeActive && hoveredItem?.id === item.id ? "inventory-screen-hover-tooltip" : undefined}
                      aria-pressed={salvageModeActive ? checkedForSalvage : selected}
                    >
                      <RaritySpectacle rarity={item.rarity} />
                      <span className="inventory-screen-slot-clip" aria-hidden="true">
                        <GearIcon item={item} size={84} />
                      </span>
                      <RarityAura rarity={item.rarity} />
                      <RaritySparkles rarity={item.rarity} />
                      {checkedForSalvage && (
                        <span className="inventory-screen-salvage-selection-mark" aria-hidden="true">
                          <span className="inventory-screen-salvage-selection-glyph">✓</span>
                          <strong>분해 선택됨</strong>
                        </span>
                      )}
                      <span className={`inventory-screen-card-edge-chip inventory-screen-grid-delta ${powerDeltaClass(itemPowerDelta)}`}>
                        {formatPowerDelta(itemPowerDelta)}
                      </span>
                      <span className={`inventory-screen-card-edge-chip inventory-screen-grid-level${levelLocked ? " inventory-screen-level-requirement--locked" : ""}`}>
                        LV.{item.level}
                        <small>착용 {requiredLevel}</small>
                      </span>
                      <span className="inventory-screen-card-edge-chip inventory-screen-grid-quality">품질 {item.qualityScore}/100</span>
                      <strong className="inventory-screen-card-edge-chip inventory-screen-enhancement-badge">+{item.enhancement}</strong>
                      <small className="inventory-screen-grid-name">{formatGearDisplayName(item)}</small>
                      {overCapacity && (
                        <span className="inventory-screen-over-capacity-mark">초과 보관</span>
                      )}
                    </button>
                  </div>
                );
              })}
                {Array.from({ length: emptyCellCount }, (_, index) => (
                  <span className="inventory-screen-grid-empty" key={`empty-${index}`} aria-hidden="true" />
                ))}
              </div>
            </div>
          </section>
        </div>

        <footer className="inventory-screen-footer">
          <span>
            {readOnly
              ? "클릭: 상세 선택 · 장비 위에 커서: 전체 옵션 · 정렬 및 스크롤 사용 가능"
              : "클릭: 선택 · 가방 더블 클릭: 장착 · 장착 장비 더블 클릭: 해제 · 장비 위에 커서: 전체 옵션"}
          </span>
          <span><kbd>I</kbd> 또는 <kbd>ESC</kbd> 닫기</span>
        </footer>
      </div>

      {operationNotice && (
        <div
          className="inventory-screen-operation-notice"
          role="status"
          aria-live="polite"
        >
          <span aria-hidden="true">✦</span>
          <p>{operationNotice}</p>
        </div>
      )}

      {!readOnly && salvageConfirmationOpen && (
        <div
          className="inventory-screen-confirm-backdrop"
          onMouseDown={(event) => {
            event.stopPropagation();
            if (event.target === event.currentTarget) {
              closeSalvageConfirmation();
            }
          }}
        >
          <section
            className="inventory-screen-confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="inventory-screen-confirm-title"
            aria-describedby="inventory-screen-confirm-description"
          >
            <span className="inventory-screen-confirm-sigil" aria-hidden="true">✦</span>
            <small>기억 분해 의식</small>
            <h3 id="inventory-screen-confirm-title">선택한 장비를 분해하시겠습니까?</h3>
            <p id="inventory-screen-confirm-description">
              분해한 장비는 되돌릴 수 없습니다. 획득한 기억의 재는 즉시 보관됩니다.
            </p>
            <dl>
              <div>
                <dt>선택 장비</dt>
                <dd>{confirmationSalvageItems.length}개</dd>
              </div>
              <div>
                <dt>기본 분해</dt>
                <dd>{confirmationBaseSalvageAsh.toLocaleString("ko-KR")}</dd>
              </div>
              <div className="inventory-screen-confirm-refund">
                <dt>강화 비용 환급</dt>
                <dd>+{confirmationEnhancementRefund.toLocaleString("ko-KR")}</dd>
                <small>100% 성공 기준</small>
              </div>
              <div className="inventory-screen-confirm-total">
                <dt>총 획득</dt>
                <dd>{confirmationSalvageAsh.toLocaleString("ko-KR")}</dd>
              </div>
            </dl>
            <div className="inventory-screen-confirm-actions">
              <button
                type="button"
                className="inventory-screen-confirm-cancel"
                onClick={closeSalvageConfirmation}
                autoFocus
              >
                취소
              </button>
              <button
                type="button"
                className="inventory-screen-confirm-salvage"
                onClick={confirmSalvage}
              >
                {confirmationSalvageItems.length}개 분해
              </button>
            </div>
          </section>
        </div>
      )}

      {!readOnly && divineForgeOpen && (
        <DivineForgeDialog
          targets={divineForgeTargets}
          targetId={divineForgeTargetId}
          inventory={inventory}
          memoryAsh={memoryAsh}
          step={divineForgeStep}
          result={divineForgeResult}
          onTargetChange={(targetId) => {
            setDivineForgeTargetId(targetId);
            setDivineForgeResult(null);
            setDivineForgeStep("prepare");
          }}
          onRequestConfirmation={() => setDivineForgeStep("confirm")}
          onCancelConfirmation={() => setDivineForgeStep("prepare")}
          onExecute={executeDivineForge}
          onClose={closeDivineForge}
          onGrantShowcase={onGrantDivineForgeShowcase}
        />
      )}

      {!salvageModeActive && hoveredItem && typeof document !== "undefined" &&
        createPortal(
          <GearTooltip
            item={hoveredItem}
            comparisonItem={hoveredComparisonItem}
            equipment={equipment}
            equipped={hoveredItemIsEquipped}
            readOnly={readOnly}
            playerLevel={playerLevel}
            position={tooltipPosition}
            powerDelta={
              hoveredItemIsEquipped
                ? 0
                : inventoryPowerDeltaById.get(hoveredItem.id) ?? 0
            }
            tooltipRef={tooltipElementRef}
            onMeasure={handleTooltipMeasure}
          />,
          document.body,
        )}
    </div>
  );
}
