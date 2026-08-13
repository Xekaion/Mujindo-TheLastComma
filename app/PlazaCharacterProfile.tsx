"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
} from "react";
import {
  EQUIPMENT_SLOT_LABELS,
  EQUIPMENT_SLOTS,
  GEAR_ICON_COLUMNS,
  GEAR_ICON_ROWS,
  GEAR_RARITY_META,
  LEGENDARY_POWERS,
  calculateEquipmentCombatPower,
  formatCompactGearLabel,
  formatGearDisplayName,
  gearIconCell,
  getGearAffixDisplay,
  getGearImplicitDisplay,
  getGearRequiredLevel,
  reconcileEquipmentLevelRequirements,
  type EquipmentLoadout,
  type EquipmentSlot,
  type GearItem,
} from "./equipment";
import {
  hubPublicEquipmentToLoadout,
  type HubCharacterProfile,
} from "./hub-protocol";
import InventoryPaperdollFigure from "./InventoryPaperdollFigure";
import "./plaza-character-profile.css";

export type PlazaCharacterProfileProps = Readonly<{
  open: boolean;
  profile: HubCharacterProfile | null;
  loading?: boolean;
  error?: string | null;
  onClose: () => void;
  onRetry?: () => void;
}>;

function profileEquipment(profile: HubCharacterProfile | null): EquipmentLoadout {
  const publicLoadout = hubPublicEquipmentToLoadout(profile?.publicEquipment);
  return reconcileEquipmentLevelRequirements(
    profile?.level ?? 1,
    publicLoadout,
    [],
  ).equipment;
}

function rarityClass(item: GearItem) {
  return `plaza-character-profile__rarity--${item.rarity}`;
}

function GearIcon({ item }: { item: GearItem }) {
  const { column, row } = gearIconCell(item.iconIndex);
  const backgroundX = GEAR_ICON_COLUMNS > 1
    ? (column / (GEAR_ICON_COLUMNS - 1)) * 100
    : 0;
  const backgroundY = GEAR_ICON_ROWS > 1
    ? (row / (GEAR_ICON_ROWS - 1)) * 100
    : 0;
  const style = {
    "--profile-icon-x": `${backgroundX}%`,
    "--profile-icon-y": `${backgroundY}%`,
    "--profile-rarity": GEAR_RARITY_META[item.rarity].color,
  } as CSSProperties;

  return (
    <span
      className="plaza-character-profile__gear-icon"
      style={style}
      role="img"
      aria-label={`${formatGearDisplayName(item, { includeZero: true })} 장비 아이콘`}
    />
  );
}

function EquipmentSlotButton({
  slot,
  item,
  selected,
  onSelect,
}: {
  slot: EquipmentSlot;
  item: GearItem | null;
  selected: boolean;
  onSelect: (slot: EquipmentSlot) => void;
}) {
  const label = EQUIPMENT_SLOT_LABELS[slot];
  if (!item) {
    return (
      <span
        className="plaza-character-profile__slot plaza-character-profile__slot--empty"
        data-slot={slot}
        aria-label={`${label} 비어 있음`}
      >
        <span aria-hidden="true">＋</span>
        <small>{label}</small>
      </span>
    );
  }

  return (
    <button
      type="button"
      className={`plaza-character-profile__slot ${rarityClass(item)}${selected ? " is-selected" : ""}`}
      data-slot={slot}
      aria-label={`${label}, ${formatGearDisplayName(item, { includeZero: true })} 상세 보기`}
      aria-pressed={selected}
      onClick={() => onSelect(slot)}
    >
      <span className="plaza-character-profile__slot-aura" aria-hidden="true" />
      <GearIcon item={item} />
      <small>{label}</small>
      <strong aria-label={`강화 +${item.enhancement}`}>+{item.enhancement}</strong>
    </button>
  );
}

function SelectedEquipmentDetail({ item }: { item: GearItem | null }) {
  if (!item) {
    return (
      <div className="plaza-character-profile__detail-empty">
        <span aria-hidden="true">◇</span>
        <strong>장착 장비를 선택하세요</strong>
        <p>장비 슬롯을 누르면 기본 옵션과 추가 옵션을 확인할 수 있습니다.</p>
      </div>
    );
  }

  const implicit = getGearImplicitDisplay(item);
  const legendaryPower = item.legendaryPowerId
    ? LEGENDARY_POWERS[item.legendaryPowerId]
    : null;

  return (
    <div
      className={`plaza-character-profile__detail ${rarityClass(item)}`}
      style={{ "--profile-rarity": GEAR_RARITY_META[item.rarity].color } as CSSProperties}
      aria-live="polite"
    >
      <div className="plaza-character-profile__detail-heading">
        <div className="plaza-character-profile__detail-icon">
          <span className="plaza-character-profile__slot-aura" aria-hidden="true" />
          <GearIcon item={item} />
        </div>
        <div>
          <small>
            {GEAR_RARITY_META[item.rarity].label} · {EQUIPMENT_SLOT_LABELS[item.slot]}
          </small>
          <h3>{formatGearDisplayName(item, { includeZero: true })}</h3>
          <span>
            아이템 레벨 {item.level} · 착용 필요 레벨 {getGearRequiredLevel(item)} · 품질 {item.qualityScore}/100
          </span>
        </div>
      </div>

      <dl className="plaza-character-profile__detail-power">
        <div>
          <dt>아이템 보스 화력</dt>
          <dd>{item.powerScore.toLocaleString("ko-KR")}</dd>
        </div>
        <div>
          <dt>강화 단계</dt>
          <dd>+{item.enhancement}</dd>
        </div>
      </dl>

      <section className="plaza-character-profile__option-group">
        <h4>기본 옵션</h4>
        <strong>{formatCompactGearLabel(implicit.totalLabel)}</strong>
      </section>

      <section className="plaza-character-profile__option-group">
        <h4>추가 옵션 <span>{item.affixes.length}</span></h4>
        {item.affixes.length > 0 ? (
          <ul>
            {item.affixes.map((affix, index) => (
              <li key={`${affix.stat}-${index}`}>
                {formatCompactGearLabel(getGearAffixDisplay(affix, item).totalLabel)}
              </li>
            ))}
          </ul>
        ) : (
          <p>추가 옵션 없음</p>
        )}
      </section>

      {legendaryPower && (
        <section className="plaza-character-profile__legendary">
          <small>고유 효과</small>
          <h4>{legendaryPower.name}</h4>
          <p>{legendaryPower.description}</p>
        </section>
      )}
    </div>
  );
}

export default function PlazaCharacterProfile({
  open,
  profile,
  loading = false,
  error = null,
  onClose,
  onRetry,
}: PlazaCharacterProfileProps) {
  const panelRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<EquipmentSlot | null>(null);
  const equipment = useMemo(() => profileEquipment(profile), [profile]);
  const displayName = profile?.displayName ?? "이름 없는 기록자";
  const level = profile?.level ?? 1;
  const dungeonFloor = profile?.dungeonFloor ?? 1;
  const equipmentPower = useMemo(
    () => calculateEquipmentCombatPower(equipment),
    [equipment],
  );
  const equippedCount = EQUIPMENT_SLOTS.filter((slot) => equipment[slot]).length;
  const effectiveSelectedSlot =
    selectedSlot && equipment[selectedSlot]
      ? selectedSlot
      : EQUIPMENT_SLOTS.find((slot) => equipment[slot] !== null) ?? null;
  const selectedItem = effectiveSelectedSlot
    ? equipment[effectiveSelectedSlot]
    : null;

  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const focusFrame = window.requestAnimationFrame(() => {
      closeButtonRef.current?.focus({ preventScroll: true });
    });
    return () => {
      window.cancelAnimationFrame(focusFrame);
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = Array.from(
        panel.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => !element.hasAttribute("hidden"));
      if (focusable.length === 0) {
        event.preventDefault();
        panel.focus({ preventScroll: true });
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [onClose, open]);

  if (!open) return null;

  const handleBackdropMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) onClose();
  };

  return (
    <div
      className="plaza-character-profile"
      onMouseDown={handleBackdropMouseDown}
      role="presentation"
    >
      <section
        ref={panelRef}
        className="plaza-character-profile__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="plaza-character-profile-title"
        aria-describedby="plaza-character-profile-description"
        aria-busy={loading}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="plaza-character-profile__header">
          <div>
            <small>PUBLIC MEMORY RECORD</small>
            <h2 id="plaza-character-profile-title">캐릭터 정보</h2>
            <p id="plaza-character-profile-description">
              광장에 공개된 탐사 기록과 현재 장착 장비입니다.
            </p>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            className="plaza-character-profile__close"
            onClick={onClose}
            aria-label="캐릭터 정보 닫기"
          >
            <span aria-hidden="true">×</span>
          </button>
        </header>

        {loading ? (
          <div className="plaza-character-profile__state" role="status">
            <span className="plaza-character-profile__loader" aria-hidden="true" />
            <strong>공개 기록을 불러오는 중입니다</strong>
            <p>장착 장비와 탐사 기록을 확인하고 있습니다.</p>
          </div>
        ) : error ? (
          <div className="plaza-character-profile__state plaza-character-profile__state--error" role="alert">
            <span aria-hidden="true">!</span>
            <strong>캐릭터 정보를 불러오지 못했습니다</strong>
            <p>{error}</p>
            {onRetry && <button type="button" onClick={onRetry}>다시 시도</button>}
          </div>
        ) : !profile ? (
          <div className="plaza-character-profile__state" role="status">
            <span aria-hidden="true">◇</span>
            <strong>공개된 캐릭터 정보가 없습니다</strong>
            <p>대상이 광장을 떠났거나 공개 기록이 아직 동기화되지 않았습니다.</p>
          </div>
        ) : (
          <>
            <div className="plaza-character-profile__identity">
              <div>
                <span>광장 기록자</span>
                <strong>{displayName}</strong>
              </div>
              <dl>
                <div><dt>레벨</dt><dd>LV.{level}</dd></div>
                <div><dt>탐사 심도</dt><dd>지하 {dungeonFloor.toLocaleString("ko-KR")}층</dd></div>
                <div><dt>전체 장비 보스 전투력</dt><dd>{equipmentPower.toLocaleString("ko-KR")}</dd></div>
              </dl>
            </div>

            <div className="plaza-character-profile__content">
              <section className="plaza-character-profile__appearance" aria-labelledby="plaza-profile-appearance-title">
                <div className="plaza-character-profile__section-title">
                  <h3 id="plaza-profile-appearance-title">장착 외형</h3>
                  <span>{equippedCount}/10 부위</span>
                </div>
                <div className="plaza-character-profile__paperdoll">
                  <InventoryPaperdollFigure equipment={equipment} />
                </div>
              </section>

              <section className="plaza-character-profile__equipment" aria-labelledby="plaza-profile-equipment-title">
                <div className="plaza-character-profile__section-title">
                  <h3 id="plaza-profile-equipment-title">장착 장비</h3>
                  <span>슬롯을 눌러 상세 확인</span>
                </div>
                <div className="plaza-character-profile__slots">
                  {EQUIPMENT_SLOTS.map((slot) => (
                    <EquipmentSlotButton
                      key={slot}
                      slot={slot}
                      item={equipment[slot]}
                      selected={effectiveSelectedSlot === slot}
                      onSelect={setSelectedSlot}
                    />
                  ))}
                </div>
              </section>

              <section className="plaza-character-profile__item-detail" aria-label="선택 장비 상세 정보">
                <div className="plaza-character-profile__section-title">
                  <h3>장비 상세</h3>
                  <span>읽기 전용</span>
                </div>
                <SelectedEquipmentDetail item={selectedItem} />
              </section>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
