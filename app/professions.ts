export const PROFESSION_THRESHOLD = 20;
export const PROFESSION_BONUS_PERCENT = 50;

export const PROFESSION_TITLES: Readonly<Record<string, string>> = {
  fang: "거인 사냥꾼",
  haste: "맥동 추적자",
  split: "별분열술사",
  pierce: "관통 집행자",
  eye: "참수의 명사수",
  return: "귀환 검술사",
  ember: "잿불술사",
  oil: "화염 문장사",
  frost: "서리 감시자",
  storm: "폭풍 인도자",
  poison: "역병 원예사",
  blood: "혈계 기사",
  predator: "포식 생존자",
  glass: "유리 수호자",
  boots: "무진 방랑자",
  void: "공허 보행자",
  orbit: "월륜 기사",
  time: "시간 재봉사",
  magnet: "기억 항해사",
  map: "무진 지도사",
  focus: "천문 조준사",
  caliber: "별철 포격수",
  homing: "운명 추적자",
  ricochet: "회랑 반향사",
  execution: "종언 집행자",
  giantbane: "거인 파문사",
  overcharge: "심홍 기관사",
  shrapnel: "백골 개화사",
  leech: "혈침 치유사",
  armor: "철벽 기도사",
  resolve: "최후 맹세자",
  regeneration: "달샘 순례자",
  ward: "봉인 수호자",
  bulwark: "성채 조각가",
  momentum: "바람 매듭사",
  reflex: "찰나 보행자",
  scholar: "무진 기록관",
  scavenger: "기억 채굴자",
  conquest: "승리 봉화지기",
  frenzy: "혈박 투사",
  strength: "강철 투사",
  rapidfire: "속사 명사수",
  range: "장거리 사수",
  velocity: "유성 사수",
  expansion: "거탄 포격수",
  sprint: "질풍 보행자",
  defense: "철갑 수호자",
  recovery: "전장 치유사",
  learning: "성장 기록관",
  collection: "기억 수집가",
};

export function isProfessionEligible(
  augments: Readonly<Record<string, number>>,
  augmentId: string,
): boolean {
  const candidate = augments[augmentId] ?? 0;
  const rawRank = Number.isFinite(candidate)
    ? Math.min(PROFESSION_THRESHOLD, Math.max(0, Math.floor(candidate)))
    : 0;
  return rawRank >= PROFESSION_THRESHOLD;
}

export function effectiveAugmentRank(
  augments: Readonly<Record<string, number>>,
  profession: string | null,
  augmentId: string,
): number {
  // A profession amplifies the *effect* of a capped rank. It never creates or
  // persists a twenty-first stack.
  const candidate = augments[augmentId] ?? 0;
  const rawRank = Number.isFinite(candidate)
    ? Math.min(PROFESSION_THRESHOLD, Math.max(0, Math.floor(candidate)))
    : 0;
  return profession === augmentId
    ? rawRank + Math.floor((rawRank * PROFESSION_BONUS_PERCENT) / 100)
    : rawRank;
}
