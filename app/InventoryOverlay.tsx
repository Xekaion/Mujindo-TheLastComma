import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  EQUIPMENT_SLOT_LABELS,
  EQUIPMENT_SLOTS,
  GEAR_RARITIES,
  GEAR_ICON_COLUMNS,
  GEAR_ICON_ROWS,
  GEAR_ENHANCEMENT_EFFECT_PER_STAGE,
  GEAR_RARITY_META,
  LEGENDARY_POWERS,
  MAX_GEAR_ENHANCEMENT,
  calculateEquipmentPowerDelta,
  formatCompactGearLabel,
  formatGearDisplayName,
  gearIconCell,
  getGearAffixDisplay,
  getGearImplicitDisplay,
  getGearEnhancementRule,
  getGearSalvageAshBreakdown,
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

export type InventoryOverlayProps = {
  open: boolean;
  onClose: () => void;
  equipment: EquipmentLoadout;
  inventory: GearItem[];
  inventoryCapacity: number;
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
  onEnhance: (gearId: string) => void;
  equippedPower: number;
};

const TOOLTIP_WIDTH = 390;
const TOOLTIP_HEIGHT = 720;
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

function clampTooltipPosition(clientX: number, clientY: number): TooltipPosition {
  if (typeof window === "undefined") return { x: clientX, y: clientY };

  const roomOnRight = clientX + TOOLTIP_GAP + TOOLTIP_WIDTH <= window.innerWidth;
  const preferredX = roomOnRight
    ? clientX + TOOLTIP_GAP
    : clientX - TOOLTIP_WIDTH - TOOLTIP_GAP;

  return {
    x: Math.max(12, Math.min(preferredX, window.innerWidth - TOOLTIP_WIDTH - 12)),
    y: Math.max(12, Math.min(clientY - 48, window.innerHeight - TOOLTIP_HEIGHT - 12)),
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

function GearTooltip({
  item,
  comparisonItem,
  equipment,
  equipped,
  position,
}: {
  item: GearItem;
  comparisonItem: GearItem | null;
  equipment: EquipmentLoadout;
  equipped: boolean;
  position: TooltipPosition;
}) {
  const powerDelta = calculateEquipmentPowerDelta(equipment, item);

  return (
    <div
      id="inventory-screen-hover-tooltip"
      role="tooltip"
      className={`inventory-screen-tooltip ${rarityClass(item)} ${item.rarity === "rare" ? "inventory-screen-tooltip--rare" : ""} ${item.rarity === "epic" ? "inventory-screen-tooltip--epic" : ""} ${item.rarity === "legendary" ? "inventory-screen-tooltip--legendary" : ""} ${item.rarity === "mythic" ? "inventory-screen-tooltip--mythic" : ""} ${item.rarity === "cosmic" ? "inventory-screen-tooltip--cosmic" : ""}`}
      style={{ left: position.x, top: position.y }}
    >
      <div className="inventory-screen-tooltip-crest" aria-hidden="true">
        <RaritySpectacle rarity={item.rarity} />
        <RarityAura rarity={item.rarity} />
        <GearIcon item={item} size={88} />
      </div>
      <div className="inventory-screen-tooltip-heading">
        <small>
          {GEAR_RARITY_META[item.rarity].label} · {EQUIPMENT_SLOT_LABELS[item.slot]}
        </small>
        <h4>{formatGearDisplayName(item)}</h4>
        <span>아이템 레벨 {item.level}</span>
      </div>
      <div className="inventory-screen-tooltip-power">
        <span>전투력</span>
        <strong>{item.powerScore.toLocaleString("ko-KR")}</strong>
        {!equipped && (
          <em className={powerDeltaClass(powerDelta)}>
            {formatPowerDelta(powerDelta)}
          </em>
        )}
      </div>
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
        <span>클릭하여 선택 · 더블 클릭하여 장착</span>
      </footer>
    </div>
  );
}

export default function InventoryOverlay({
  open,
  onClose,
  equipment,
  inventory,
  inventoryCapacity,
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
  onEnhance,
  equippedPower,
}: InventoryOverlayProps) {
  const [hoveredItem, setHoveredItem] = useState<GearItem | null>(null);
  const [hoveredItemIsEquipped, setHoveredItemIsEquipped] = useState(false);
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
  const inventoryViewportRef = useRef<HTMLDivElement>(null);
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
  const selectedIsEquipped = selectedEquippedItem !== null;
  const selectedSalvageAsh = selectedInventoryItem
    ? getGearSalvageAshBreakdown(selectedInventoryItem).total
    : 0;
  const comparisonItem = selectedInventoryItem
    ? equipment[selectedInventoryItem.slot]
    : null;
  const powerDelta = selectedInventoryItem
    ? calculateEquipmentPowerDelta(equipment, selectedInventoryItem)
    : 0;
  const enhancementRule = selectedItem
    ? getGearEnhancementRule(selectedItem)
    : null;
  const enhancementEfficiencyPercent = selectedItem
    ? (GEAR_ENHANCEMENT_EFFECT_PER_STAGE[selectedItem.rarity] * 100).toFixed(2)
    : "0.00";
  const selectedImplicitDisplay = selectedItem
    ? getGearImplicitDisplay(selectedItem)
    : null;
  const equipmentWithSelectedItem: EquipmentLoadout = selectedItem
    ? { ...equipment, [selectedItem.slot]: selectedItem }
    : equipment;
  const enhancementPowerGain = selectedItem && enhancementRule
    ? Math.max(
        0,
        calculateEquipmentPowerDelta(equipmentWithSelectedItem, {
          ...selectedItem,
          enhancement: enhancementRule.target,
        }),
      )
    : 0;
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

  const showPointerTooltip = (
    item: GearItem,
    equipped: boolean,
    event: MouseEvent<HTMLElement>,
  ) => {
    if (salvageMode) return;
    setHoveredItem(item);
    setHoveredItemIsEquipped(equipped);
    setTooltipPosition(clampTooltipPosition(event.clientX, event.clientY));
  };

  const showFocusTooltip = (
    item: GearItem,
    equipped: boolean,
    event: FocusEvent<HTMLElement>,
  ) => {
    if (salvageMode) return;
    const rect = event.currentTarget.getBoundingClientRect();
    setHoveredItem(item);
    setHoveredItemIsEquipped(equipped);
    setTooltipPosition(
      clampTooltipPosition(rect.right, rect.top + Math.min(rect.height / 2, 56)),
    );
  };

  const hidePointerTooltip = (event: MouseEvent<HTMLElement>) => {
    if (document.activeElement === event.currentTarget) {
      const rect = event.currentTarget.getBoundingClientRect();
      setTooltipPosition(
        clampTooltipPosition(rect.right, rect.top + Math.min(rect.height / 2, 56)),
      );
      return;
    }
    setHoveredItem(null);
  };

  const equipItem = (gearId: string) => {
    setHoveredItem(null);
    onEquip(gearId);
  };

  const toggleSalvageSelection = (gearId: string) => {
    setSelectedForSalvage((current) => {
      const next = new Set(current);
      if (next.has(gearId)) next.delete(gearId);
      else next.add(gearId);
      return next;
    });
  };

  const toggleRarityForSalvage = (rarity: GearRarity) => {
    setSelectedForSalvage((current) =>
      toggleRaritySalvageSelection(inventory, current, rarity),
    );
  };

  const chooseAutoSalvageThreshold = (value: string) => {
    const threshold =
      AUTO_SALVAGE_RARITIES.find((rarity) => rarity === value) ?? null;
    onAutoSalvageMaxRarityChange(threshold);
  };

  const selectAllForSalvage = () => {
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
    setSalvageMode((current) => !current);
    clearSalvageSelection();
    setHoveredItem(null);
  };

  const requestSalvageMany = () => {
    if (selectedSalvageItems.length === 0) return;
    setHoveredItem(null);
    setPendingSingleSalvageId(null);
    setSalvageConfirmationOpen(true);
  };

  const requestSalvageOne = (gearId: string) => {
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
    setHoveredItem(null);
    onClose();
  };

  const handleInventoryClose = () => {
    closeSalvageConfirmation();
    setHoveredItem(null);
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
      className="inventory-screen"
      role="dialog"
      aria-modal="true"
      aria-labelledby="inventory-screen-title"
      onMouseDown={handleBackdropMouseDown}
    >
      <div
        className="inventory-screen-panel"
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
            장비 위에 커서를 올리면 모든 접사와 비교 수치가 펼쳐집니다.
          </p>
          <div className="inventory-screen-header-resources">
            <span>기억의 재</span>
            <b>{memoryAsh.toLocaleString("ko-KR")}</b>
          </div>
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
                <span>
                  총 전투력 <b>{equippedPower.toLocaleString("ko-KR")}</b>
                </span>
              </div>

              <div className="inventory-screen-equipment-slots">
                <div className="inventory-screen-paperdoll-figure" aria-hidden="true" />
                {EQUIPMENT_SLOTS.map((slot) => {
                  const item = equipment[slot];
                  const selected = item?.id === selectedGearId;
                  return (
                    <button
                      type="button"
                      key={slot}
                      className={`inventory-screen-equipment-card inventory-screen-equipment-card--${slot} ${item ? rarityClass(item) : "inventory-screen-equipment-card--empty"} ${selected ? "inventory-screen-item--selected" : ""}`}
                      onClick={() => item && onSelect(item.id)}
                      onMouseEnter={(event) => item && showPointerTooltip(item, true, event)}
                      onMouseMove={(event) => item && showPointerTooltip(item, true, event)}
                      onMouseLeave={(event) => item && hidePointerTooltip(event)}
                      onFocus={(event) => item && showFocusTooltip(item, true, event)}
                      onBlur={() => setHoveredItem(null)}
                      aria-label={
                        item
                          ? `${EQUIPMENT_SLOT_LABELS[slot]} 장착품 ${formatGearDisplayName(item)} 정보 보기`
                          : `${EQUIPMENT_SLOT_LABELS[slot]} 슬롯 비어 있음`
                      }
                      aria-describedby={item && !salvageMode && hoveredItem?.id === item.id ? "inventory-screen-hover-tooltip" : undefined}
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
                      {item && item.enhancement > 0 && (
                        <strong className="inventory-screen-equipment-enhancement">
                          +{item.enhancement}
                        </strong>
                      )}
                    </button>
                  );
                })}
              </div>
            </section>

            <section
              className={`inventory-screen-details ${selectedItem ? rarityClass(selectedItem) : "inventory-screen-details--empty"}`}
              aria-labelledby="inventory-screen-details-title"
              aria-live="polite"
            >
              <div className="inventory-screen-section-heading">
                <h3 id="inventory-screen-details-title">각인 작업대</h3>
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
                      <span>
                        LV.{selectedItem.level} · 전투력 <b>{selectedItem.powerScore.toLocaleString("ko-KR")}</b>
                      </span>
                    </div>
                    {!selectedIsEquipped && (
                      <strong className={`inventory-screen-workbench-delta ${powerDeltaClass(powerDelta)}`}>
                        {formatPowerDelta(powerDelta)}
                      </strong>
                    )}
                  </div>

                  <div className="inventory-screen-detail-columns">
                    <div className="inventory-screen-detail-stats">
                      {!selectedIsEquipped && (
                        <div className="inventory-screen-comparison">
                          <span>{comparisonItem ? formatGearDisplayName(comparisonItem) : "빈 슬롯"} 대비</span>
                          <strong className={powerDeltaClass(powerDelta)}>
                            {formatPowerDelta(powerDelta)} 전투력
                          </strong>
                        </div>
                      )}
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

                    <div className="inventory-screen-detail-actions-column">
                      <section
                        className="inventory-screen-enhancement"
                        aria-labelledby="inventory-screen-enhancement-title"
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
                                단계마다 기본 옵션 수치의 {enhancementEfficiencyPercent}% 추가
                              </em>
                            </div>
                            <div className="inventory-screen-enhancement-affix-gains">
                              <strong>이번 단계 증가</strong>
                              <ul>
                                <li>
                                  <span>{selectedImplicitDisplay ? formatCompactGearLabel(selectedImplicitDisplay.totalLabel) : ""}</span>
                                  <em>{selectedImplicitDisplay ? formatCompactGearLabel(selectedImplicitDisplay.nextStageGainLabel) : ""}</em>
                                </li>
                              </ul>
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
                            <button
                              type="button"
                              className="inventory-screen-enhancement-button"
                              onClick={() => onEnhance(selectedItem.id)}
                              disabled={!canAffordEnhancement}
                            >
                              +{enhancementRule.target} 강화
                              <small>
                                전투력 +{enhancementPowerGain.toLocaleString("ko-KR")} · 재 {enhancementRule.ashCost.toLocaleString("ko-KR")}
                              </small>
                            </button>
                          </>
                        ) : (
                          <div className="inventory-screen-enhancement-max">
                            <strong>최대 강화 +{MAX_GEAR_ENHANCEMENT}</strong>
                            <span>모든 강화 단계가 적용되었습니다.</span>
                          </div>
                        )}
                      </section>

                      {selectedIsEquipped ? (
                        <div className="inventory-screen-equipped-actions">
                          <span className="inventory-screen-equipped-state">현재 장착 중인 장비입니다.</span>
                          <button
                            type="button"
                            className="inventory-screen-unequip-button"
                            onClick={() => onUnequip(selectedItem.slot)}
                            aria-label={`${formatGearDisplayName(selectedItem)} 장착 해제`}
                          >
                            장착 해제
                          </button>
                        </div>
                      ) : (
                        <div className="inventory-screen-actions">
                          <button type="button" className="inventory-screen-equip-button" onClick={() => equipItem(selectedItem.id)}>
                            장착하기
                          </button>
                          <button type="button" className="inventory-screen-salvage-button" onClick={() => requestSalvageOne(selectedItem.id)}>
                            분해 · 재 {selectedSalvageAsh.toLocaleString("ko-KR")}
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="inventory-screen-detail-placeholder">
                  <span aria-hidden="true">✦</span>
                  <p>장비를 선택하면 이곳에서 장착·강화·분해할 수 있습니다.</p>
                </div>
              )}
            </section>
          </div>

          <section
            className="inventory-screen-backpack"
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
                <button type="button" onClick={onOpenShop}>
                  ＋ 공간 확장
                </button>
              </div>
            </div>

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
                const itemPowerDelta = calculateEquipmentPowerDelta(equipment, item);
                const checkedForSalvage = selectedForSalvage.has(item.id);
                const sourceIndex = inventorySourceIndexById.get(item.id) ?? itemIndex;
                const overCapacity = sourceIndex >= normalizedInventoryCapacity;
                return (
                  <div
                    className={`inventory-screen-grid-cell ${salvageMode ? "inventory-screen-grid-cell--salvage-mode" : ""} ${checkedForSalvage ? "inventory-screen-grid-cell--salvage-selected" : ""} ${overCapacity ? "inventory-screen-grid-cell--over-capacity" : ""}`}
                    key={item.id}
                  >
                    <button
                      type="button"
                      className={`inventory-screen-grid-item ${rarityClass(item)} ${!salvageMode && selected ? "inventory-screen-item--selected" : ""}`}
                      onClick={() => {
                        if (salvageMode) toggleSalvageSelection(item.id);
                        else onSelect(item.id);
                      }}
                      onDoubleClick={() => {
                        if (!salvageMode) equipItem(item.id);
                      }}
                      onMouseEnter={(event) => showPointerTooltip(item, false, event)}
                      onMouseMove={(event) => showPointerTooltip(item, false, event)}
                      onMouseLeave={hidePointerTooltip}
                      onFocus={(event) => showFocusTooltip(item, false, event)}
                      onBlur={() => setHoveredItem(null)}
                      aria-label={salvageMode
                        ? `${formatGearDisplayName(item)} 일괄 분해 ${checkedForSalvage ? "선택 해제" : "선택"}`
                        : `${formatGearDisplayName(item)}, 전투력 ${item.powerScore}, 장착품 대비 ${formatPowerDelta(itemPowerDelta)}, 품질 ${item.qualityScore}점`}
                      aria-describedby={!salvageMode && hoveredItem?.id === item.id ? "inventory-screen-hover-tooltip" : undefined}
                      aria-pressed={salvageMode ? checkedForSalvage : selected}
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
                      <span className={`inventory-screen-grid-delta ${powerDeltaClass(itemPowerDelta)}`}>
                        {formatPowerDelta(itemPowerDelta)}
                      </span>
                      <span className="inventory-screen-grid-level">LV.{item.level}</span>
                      <span className="inventory-screen-grid-quality">품질 {item.qualityScore}/100</span>
                      {item.enhancement > 0 && (
                        <strong className="inventory-screen-enhancement-badge">+{item.enhancement}</strong>
                      )}
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
          <span>클릭: 선택 · 더블 클릭: 즉시 장착 · 장비 위에 커서: 전체 옵션</span>
          <span><kbd>I</kbd> 또는 <kbd>ESC</kbd> 닫기</span>
        </footer>
      </div>

      {salvageConfirmationOpen && (
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

      {!salvageMode && hoveredItem && typeof document !== "undefined" &&
        createPortal(
          <GearTooltip
            item={hoveredItem}
            comparisonItem={hoveredComparisonItem}
            equipment={equipment}
            equipped={hoveredItemIsEquipped}
            position={tooltipPosition}
          />,
          document.body,
        )}
    </div>
  );
}
