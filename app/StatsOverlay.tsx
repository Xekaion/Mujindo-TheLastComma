import {
  useEffect,
  useRef,
  type MouseEvent,
  type ReactNode,
} from "react";
import type { GearStatTotals } from "./equipment";
import type { PlayerStatSnapshot } from "./player-stats";
import "./stats-overlay.css";

export type StatsOverlayProps = {
  open: boolean;
  snapshot: PlayerStatSnapshot;
  professionTitle: string | null;
  onClose: () => void;
};

type StatRowProps = {
  label: string;
  value: string;
  detail?: string;
  active?: boolean;
  meter?: number;
};

const numberFormatter = new Intl.NumberFormat("ko-KR", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const integerFormatter = new Intl.NumberFormat("ko-KR", {
  maximumFractionDigits: 0,
});

const formatNumber = (value: number, suffix = "") =>
  `${numberFormatter.format(Number.isFinite(value) ? value : 0)}${suffix}`;

const formatPercent = (ratio: number) => formatNumber(ratio * 100, "%");

const formatMultiplier = (value: number) => `×${formatNumber(value)}`;

function StatRow({ label, value, detail, active, meter }: StatRowProps) {
  return (
    <div className={`stats-row${active ? " is-active" : ""}`}>
      <dt>
        <span>{label}</span>
        {detail && <small>{detail}</small>}
      </dt>
      <dd>{value}</dd>
      {typeof meter === "number" && (
        <span className="stats-row-meter" aria-hidden="true">
          <i style={{ width: `${Math.max(0, Math.min(100, meter))}%` }} />
        </span>
      )}
    </div>
  );
}

function StatsSection({
  eyebrow,
  title,
  icon,
  children,
}: {
  eyebrow: string;
  title: string;
  icon: string;
  children: ReactNode;
}) {
  return (
    <section className="stats-section">
      <header>
        <span aria-hidden="true">{icon}</span>
        <div>
          <small>{eyebrow}</small>
          <h3>{title}</h3>
        </div>
      </header>
      <dl>{children}</dl>
    </section>
  );
}

const EQUIPMENT_STAT_ROWS: ReadonlyArray<{
  key: keyof GearStatTotals;
  label: string;
  suffix: string;
}> = [
  { key: "attackPowerFlat", label: "기본 공격력", suffix: "" },
  { key: "damagePercent", label: "모든 피해", suffix: "%" },
  { key: "attackSpeedPercent", label: "공격 속도", suffix: "%" },
  { key: "projectileSpeedPercent", label: "투사체 속도", suffix: "%" },
  { key: "maxHpFlat", label: "최대 생명력", suffix: "" },
  { key: "damageReductionPercent", label: "장비 피해 감소", suffix: "%" },
  { key: "moveSpeedPercent", label: "이동 속도", suffix: "%" },
  { key: "dashCooldownPercent", label: "회피 재사용 효율", suffix: "%" },
  { key: "pickupRadiusPercent", label: "획득 범위", suffix: "%" },
  { key: "xpGainPercent", label: "경험치 획득", suffix: "%" },
  { key: "critChancePercent", label: "치명타 확률", suffix: "%p" },
  { key: "critDamagePercent", label: "치명타 피해", suffix: "%p" },
  { key: "projectileSizePercent", label: "투사체 크기", suffix: "%" },
  { key: "eliteDamagePercent", label: "정예·보스 피해", suffix: "%" },
  { key: "lifeOnHitFlat", label: "적중 회복 효율", suffix: "" },
  { key: "gearFindPercent", label: "장비 발견", suffix: "%" },
];

export default function StatsOverlay({
  open,
  snapshot,
  professionTitle,
  onClose,
}: StatsOverlayProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusFrame = window.requestAnimationFrame(() => closeButtonRef.current?.focus());

    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])",
        ) ?? [],
      ).filter((element) => !element.hasAttribute("disabled"));
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
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

    window.addEventListener("keydown", trapFocus);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener("keydown", trapFocus);
      restoreFocusRef.current?.focus();
      restoreFocusRef.current = null;
    };
  }, [open]);

  if (!open) return null;

  const { context, equipment, resources, offense, projectile, defense, sustain, mobility, utility } =
    snapshot;
  const onBackdropClick = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) onClose();
  };

  return (
    <div className="stats-backdrop" onMouseDown={onBackdropClick}>
      <div
        ref={dialogRef}
        className="stats-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="stats-title"
        aria-describedby="stats-description"
      >
        <div className="stats-dialog-ornament" aria-hidden="true" />
        <header className="stats-header">
          <div className="stats-identity">
            <span className="stats-identity-sigil" aria-hidden="true">逗</span>
            <div>
              <small>CHARACTER RECORD · CURRENT FORMULA</small>
              <h2 id="stats-title">하린의 능력치</h2>
              <p id="stats-description">
                LV.{context.level} · {professionTitle ?? "미전직 방랑자"} · 장착 {context.equippedCount}/10
              </p>
            </div>
          </div>
          <div className="stats-header-meta">
            <span>
              <small>증강</small>
              <strong>{context.rawAugmentStacks}</strong>
            </span>
            <span>
              <small>시너지</small>
              <strong>{context.activeSynergyCount}</strong>
            </span>
            <span className="is-power">
              <small>장비 전투력</small>
              <strong>{integerFormatter.format(equipment.power.total)}</strong>
            </span>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            className="stats-close"
            onClick={onClose}
            aria-label="능력치 창 닫기"
          >
            <span>닫기</span>
            <kbd>C</kbd>
          </button>
        </header>

        <section className="stats-prime" aria-label="핵심 능력치">
          <article>
            <small>현재 공격력</small>
            <strong>{formatNumber(offense.normalProjectileDamage)}</strong>
            <span>일반탄 1발 · 비치명</span>
          </article>
          <article>
            <small>현재 생명력</small>
            <strong>{formatNumber(resources.hp)}</strong>
            <span>최대 {formatNumber(resources.maxHp)} · 방벽 {formatNumber(resources.shield)}</span>
          </article>
          <article className={defense.lowHpActive || defense.shieldDefenseActive ? "is-contextual" : ""}>
            <small>현재 피해 감소</small>
            <strong>{formatPercent(defense.currentDamageReduction)}</strong>
            <span>{defense.shieldDefenseActive ? "보호막 보정 적용" : defense.lowHpActive ? "위기 보정 적용" : "상시 보정"}</span>
          </article>
          <article>
            <small>이동 속도</small>
            <strong>{formatNumber(mobility.moveSpeed)}</strong>
            <span>px/초 · 기본 대비 +{formatPercent(mobility.moveSpeedIncrease)}</span>
          </article>
          <article>
            <small>치명타 확률</small>
            <strong>{formatPercent(offense.critChance)}</strong>
            <span>상한 75.00% · 피해 {formatMultiplier(offense.critMultiplier)}</span>
          </article>
        </section>

        <div className="stats-content">
          <StatsSection eyebrow="OFFENSE" title="공격" icon="✦">
            <StatRow label="기본 공격력" value={formatNumber(offense.baseAttack)} detail={`캐릭터 ${formatNumber(offense.baseAttack - equipment.stats.attackPowerFlat)} + 장비 ${formatNumber(equipment.stats.attackPowerFlat)}`} />
            <StatRow label="현재 일반탄 피해" value={formatNumber(offense.normalProjectileDamage)} detail="현재 체력·증강·시너지·장비 반영" />
            <StatRow label="치명타 1발 피해" value={formatNumber(offense.criticalProjectileDamage)} detail={`치명 피해 ${formatMultiplier(offense.critMultiplier)}`} />
            <StatRow label="치명 기대 1발" value={formatNumber(offense.expectedProjectileDamage)} detail="치명 확률 가중 평균" />
            <StatRow label="기본탄 기대 DPS" value={formatNumber(offense.expectedPrimaryDps)} detail="전탄 적중 · 과부하 평균 포함" />
            <StatRow label="발사 속도" value={formatNumber(offense.renderedFireRate, "/초")} detail={`이론 ${formatNumber(offense.theoreticalFireRate)}/초`} meter={(offense.renderedFireRate / 12) * 100} />
            <StatRow label="치명타 확률" value={formatPercent(offense.critChance)} detail={`장비 +${formatNumber(equipment.stats.critChancePercent)}%p`} meter={(offense.critChance / 0.75) * 100} />
            <StatRow label="정예·보스 피해" value={formatMultiplier(offense.eliteMultiplier)} detail="거인 파문·장비·사냥 문장" />
            {offense.shotsUntilOvercharge && (
              <StatRow label="다음 과부하" value={`${offense.shotsUntilOvercharge}회 후`} detail={`과부하 피해 ${formatMultiplier(offense.overchargeMultiplier)}`} />
            )}
          </StatsSection>

          <StatsSection eyebrow="DEFENSE" title="생존" icon="◇">
            <StatRow label="최대 생명력" value={formatNumber(resources.maxHp)} detail={`장비 +${formatNumber(equipment.stats.maxHpFlat)}`} />
            <StatRow label="현재 보호막" value={formatNumber(resources.shield)} detail={`방 진입 기준 ${formatNumber(resources.roomEntryShield)}`} />
            <StatRow label="장비 피해 감소" value={formatPercent(defense.gearDamageReduction)} detail="장비 구간 상한 65.00%" meter={(defense.gearDamageReduction / 0.65) * 100} />
            <StatRow label="상시 종합 감소" value={formatPercent(defense.alwaysDamageReduction)} detail="장비·피해 감소·철갑 기도" />
            <StatRow label="위기 상태 감소" value={formatPercent(defense.lowHpDamageReduction)} detail="생명력 40% 미만" active={defense.lowHpActive} />
            <StatRow label="보호막 상태 감소" value={formatPercent(defense.shieldDamageReduction)} detail="보호막이 남은 동안" active={defense.shieldDefenseActive} />
            <StatRow label="현재 유효 생명력" value={formatNumber(defense.currentEffectiveHp)} detail="현재 생명력+보호막 ÷ 피격 배율" />
            <StatRow label="1회 원피해 상한" value={formatNumber(defense.rawHitCap)} detail="최대 생명력의 40.00%" />
            {defense.lastMemoryEquipped && (
              <StatRow label="마지막 기억" value={defense.lastMemoryReady ? "준비 완료" : "사용 완료"} detail="방마다 치명상 1회 되감기" active={defense.lastMemoryReady} />
            )}
          </StatsSection>

          <StatsSection eyebrow="PROJECTILE" title="투사체" icon="➵">
            <StatRow label="일제 사격" value={`${offense.renderedProjectileCount}발`} detail={`이론 ${offense.theoreticalProjectileCount}발 · 화면 상한 9발`} />
            <StatRow label="일제 기대 피해" value={formatNumber(offense.expectedVolleyDamage)} detail="치명·과부하 평균" />
            <StatRow label="비행 속도" value={formatNumber(projectile.speed, "px/s")} detail={`장비 +${formatNumber(equipment.stats.projectileSpeedPercent)}%`} />
            <StatRow label="유지 시간" value={formatNumber(projectile.lifetime, "초")} detail="귀환·집중·사거리 반영" />
            <StatRow label="예상 사거리" value={formatNumber(projectile.approximateRange, "px")} detail="속도 × 유지 시간" />
            <StatRow label="투사체 크기" value={formatNumber(projectile.diameter, "px")} detail={`지름 · 장비 구간 ${formatNumber(Math.min(150, equipment.stats.projectileSizePercent))}%`} />
            <StatRow label="관통" value={`${projectile.pierce}회`} detail="첫 적중 이후 추가 관통" />
            <StatRow label="유도력" value={projectile.homing > 0 ? formatNumber(projectile.homing) : "없음"} detail={`탄 퍼짐 ${formatNumber(projectile.spreadDegrees)}°`} />
          </StatsSection>

          <StatsSection eyebrow="MOBILITY" title="기동" icon="⌁">
            <StatRow label="이동 속도" value={formatNumber(mobility.moveSpeed, "px/s")} detail={`기본 ${formatNumber(mobility.baseMoveSpeed)} · +${formatPercent(mobility.moveSpeedIncrease)}`} />
            <StatRow label="회피 속도" value={formatNumber(mobility.dashSpeed, "px/s")} detail="두 번째 발걸음 반영" />
            <StatRow label="회피 지속" value={formatNumber(mobility.dashDuration, "초")} detail="지속 중 피격 무시" />
            <StatRow label="회피 거리" value={formatNumber(mobility.dashDistance, "px")} detail="속도 × 지속 시간" />
            <StatRow label="회피 재사용" value={formatNumber(mobility.dashCooldown, "초")} detail={`장비 효율 +${formatNumber(equipment.stats.dashCooldownPercent)}%`} />
            <StatRow label="기억 흡수 반경" value={formatNumber(utility.memoryPickupRadius, "px")} detail={`끌림 시작 ${formatNumber(utility.memoryAttractionRadius)}px`} />
            <StatRow label="장비 획득 반경" value={formatNumber(utility.gearPickupRadius, "px")} detail="자석 증강 제외 · 수집 범위 적용" />
          </StatsSection>

          <StatsSection eyebrow="SUSTAIN & GROWTH" title="회복 · 성장" icon="✚">
            <StatRow label="초당 생명력 회복" value={formatNumber(sustain.regenerationPerSecond, "/초")} detail="달샘의 숨" />
            <StatRow label="장비 적중 회복" value={formatNumber(sustain.equipmentHealPerHit, "/타")} detail="실전 상한 1.50" meter={(sustain.equipmentHealPerHit / 1.5) * 100} />
            <StatRow label="흡혈 적중 회복" value={formatNumber(sustain.leechHealPerHit, "/타")} detail="혈침 순환 시너지 포함" />
            <StatRow label="방 정복 회복" value={formatNumber(sustain.roomClearHeal)} detail="지도·정복·회복·달빛 봉화" />
            <StatRow label="정복 보호막" value={formatNumber(sustain.conquestShieldGain)} detail={`정복 후 상한 ${formatNumber(resources.conquestShieldCap)}`} />
            <StatRow label="포식 회복" value={sustain.predatorKillInterval ? `${sustain.predatorKillInterval}킬마다 ${formatNumber(sustain.predatorHeal)}` : "비활성"} detail="포식자의 위장" />
            <StatRow label="경험치 획득" value={formatMultiplier(utility.xpMultiplier)} detail={`장비 +${formatNumber(equipment.stats.xpGainPercent)}%`} />
            <StatRow label="기억 조각 가치" value={formatMultiplier(utility.memoryFragmentValueMultiplier)} detail="기억 갈고리" />
          </StatsSection>

          <section className="stats-section stats-equipment-section">
            <header>
              <span aria-hidden="true">⌬</span>
              <div>
                <small>EQUIPMENT CONTRIBUTION</small>
                <h3>장비 기여</h3>
              </div>
            </header>
            <div className="stats-equipment-power">
              <strong>{integerFormatter.format(equipment.power.total)}</strong>
              <span>장비 전투력</span>
              <small>
                공격 {integerFormatter.format(equipment.power.offense)} · 방어 {integerFormatter.format(equipment.power.defense)} · 유지 {integerFormatter.format(equipment.power.sustain)} · 기동 {integerFormatter.format(equipment.power.mobility)} · 탐사 {integerFormatter.format(equipment.power.utility)}
              </small>
            </div>
            <dl className="stats-equipment-grid">
              {EQUIPMENT_STAT_ROWS.map((row) => (
                <div key={row.key}>
                  <dt>{row.label}</dt>
                  <dd>+{formatNumber(equipment.stats[row.key], row.suffix)}</dd>
                </div>
              ))}
            </dl>
          </section>

          <section className="stats-section stats-find-section">
            <header>
              <span aria-hidden="true">⌖</span>
              <div>
                <small>LOOT PROJECTION</small>
                <h3>탐사 · 드랍</h3>
              </div>
            </header>
            <dl>
              <StatRow label="유효 장비 발견" value={`+${formatNumber(utility.effectiveGearFindPercent)}%`} detail="드랍 확률 계산 상한 200.00%" meter={(utility.effectiveGearFindPercent / 200) * 100} />
              <StatRow label="일반 적 장비" value={formatPercent(utility.normalGearDropChance)} detail="기억 갈고리·장비 발견 적용" />
              <StatRow label="정예 적 장비" value={formatPercent(utility.eliteGearDropChance)} detail="상한 95.00%" />
              <StatRow label="보스 장비" value={`${formatPercent(utility.bossGearDropChance)} · ${utility.bossGearRolls}회`} detail="보스 처치 시 고정" />
              <StatRow label="활성 증강 종류" value={`${context.activeAugmentCount}종`} detail={`총 ${context.rawAugmentStacks}스택 · 각 20스택 상한`} />
              <StatRow label="시너지 피해 보정" value={`+${formatPercent(context.synergyPower)}`} detail={`${context.activeSynergyCount}개 활성`} />
            </dl>
          </section>
        </div>

        <footer className="stats-footer">
          <div className="stats-specials" aria-label="활성 특수 효과">
            <small>활성 특수 효과</small>
            {snapshot.specials.length > 0 ? (
              snapshot.specials.map((special) => (
                <span key={special.id} title={special.condition}>
                  <b>{special.label}</b> {special.value}
                </span>
              ))
            ) : (
              <span>현재 수치형 특수 발동 없음</span>
            )}
          </div>
          <p>
            현재 체력·보호막·전직 효과를 실시간 반영합니다. 기본탄 DPS는 모든 투사체 적중 기대값이며 연쇄, 도트, 처형, 전설 발동은 별도입니다.
          </p>
        </footer>
      </div>
    </div>
  );
}
