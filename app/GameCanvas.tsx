"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import "./game.css";
import {
  SAVE_SLOT_IDS,
  migrateLegacySave,
  readSaveSlot,
  readSaveSlotSummaries,
  removeSaveSlot,
  writeSaveSlot,
  type SaveSlotId,
  type SaveSlotSummary,
} from "./save-slots";
import {
  PROFESSION_BONUS_PERCENT,
  PROFESSION_THRESHOLD,
  PROFESSION_TITLES,
  effectiveAugmentRank,
  isProfessionEligible,
} from "./professions";

const WIDTH = 1280;
const HEIGHT = 720;
const ROOM_GEOMETRY = {
  left: 74,
  right: WIDTH - 74,
  top: 70,
  bottom: HEIGHT - 70,
  horizontalDoorTop: HEIGHT / 2 - 64,
  horizontalDoorBottom: HEIGHT / 2 + 64,
  verticalDoorLeft: WIDTH / 2 - 74,
  verticalDoorRight: WIDTH / 2 + 74,
  transitionInsetX: 48,
  transitionInsetY: 46,
  openInsetX: 24,
  openInsetY: 24,
} as const;
type GameMode =
  | "menu"
  | "playing"
  | "augment"
  | "profession"
  | "story"
  | "shelter"
  | "map"
  | "dead"
  | "ending"
  | "paused";
type RoomKind = "battle" | "horde" | "elite" | "memory" | "shelter" | "boss";
type EnemyKind = 0 | 1 | 2 | 3 | 4 | 5;
type ProjectileAffinity =
  | "arcane"
  | "ember"
  | "storm"
  | "frost"
  | "poison"
  | "echo"
  | "enemy"
  | "witch"
  | "boss";

type Augment = {
  id: string;
  name: string;
  description: string;
  flavor: string;
  color: string;
  icon: number;
  tags: string[];
};

type Enemy = {
  id: number;
  kind: EnemyKind;
  x: number;
  y: number;
  radius: number;
  hp: number;
  maxHp: number;
  speed: number;
  damage: number;
  shootCooldown: number;
  slow: number;
  orbitalCooldown: number;
  poisonDamage: number;
  poisonTime: number;
  facing: number;
  walkCycle: number;
  moving: boolean;
  elite?: boolean;
};

type Projectile = {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  damage: number;
  life: number;
  pierce: number;
  hostile: boolean;
  color: string;
  affinity: ProjectileAffinity;
  age: number;
  maxLife: number;
  previousX: number;
  previousY: number;
  hit: Set<number>;
  returnAfter?: number;
  returning?: boolean;
  returnMultiplier?: number;
  homing?: number;
};

type MemoryOrb = {
  id: number;
  x: number;
  y: number;
  value: number;
};

type BehaviorEffectKind = "summon" | "teleport";
type CombatEffectKind = "muzzle" | "playerImpact" | "hostileImpact" | "chainArc";
type EffectKind = BehaviorEffectKind | CombatEffectKind;

type VisualEffect = {
  id: number;
  kind: EffectKind;
  x: number;
  y: number;
  life: number;
  duration: number;
  size: number;
  color?: string;
  angle?: number;
  endX?: number;
  endY?: number;
};

type RoomRecord = {
  kind: RoomKind;
  cleared: boolean;
};

type Player = {
  x: number;
  y: number;
  radius: number;
  hp: number;
  maxHp: number;
  shield: number;
  xp: number;
  nextXp: number;
  level: number;
  rooms: number;
  kills: number;
  augments: Record<string, number>;
  fireCooldown: number;
  invulnerable: number;
  dashCooldown: number;
  dashTime: number;
  dashX: number;
  dashY: number;
  shotCounter: number;
  endingSeen: boolean;
  profession: string | null;
  facing: number;
  walkCycle: number;
  moving: boolean;
};

type World = {
  seed: number;
  roomX: number;
  roomY: number;
  roomKind: RoomKind;
  roomCleared: boolean;
  rooms: Record<string, RoomRecord>;
  visited: string[];
  visitedLookup: Record<string, true>;
  enemies: Enemy[];
  projectiles: Projectile[];
  orbs: MemoryOrb[];
  effects: VisualEffect[];
  effectCounts: Record<BehaviorEffectKind, number>;
  transition: number;
  clearHandled: boolean;
};

type CartographyWorld = Pick<World, "roomX" | "roomY" | "rooms" | "visited">;

type SaveData = {
  player: Player;
  world: Pick<World, "seed" | "roomX" | "roomY" | "rooms" | "visited">;
  stableAugments: Record<string, number>;
  savedAt: number;
};

const ROOM_KIND_VALUES = new Set<RoomKind>([
  "battle",
  "horde",
  "elite",
  "memory",
  "shelter",
  "boss",
]);

function isHydratableSaveData(value: unknown): value is SaveData {
  if (typeof value !== "object" || value === null) return false;
  const data = value as Partial<SaveData>;
  const world = data.world as SaveData["world"] | undefined;
  if (!data.player || !world || !Number.isFinite(world.seed)) return false;
  if (!Number.isInteger(world.roomX) || !Number.isInteger(world.roomY)) return false;
  if (!world.rooms || typeof world.rooms !== "object") return false;
  if (!Array.isArray(world.visited) || !world.visited.every((key) => typeof key === "string")) {
    return false;
  }
  return Object.values(world.rooms).every(
    (room) =>
      typeof room === "object" &&
      room !== null &&
      ROOM_KIND_VALUES.has(room.kind) &&
      typeof room.cleared === "boolean",
  );
}

const AUGMENTS: Augment[] = [
  {
    id: "fang",
    name: "거인의 송곳니",
    description: "모든 피해 +18%. 랭크 제한 없음.",
    flavor: "지도 바깥의 거인이 남긴 마지막 이빨.",
    color: "#d76b4a",
    icon: 14,
    tags: ["물리", "공격"],
  },
  {
    id: "haste",
    name: "가속 심장",
    description: "공격 속도가 소프트캡 방식으로 계속 상승.",
    flavor: "멈추면 잊힌다. 그러니 더 빨리 뛴다.",
    color: "#ef5b4c",
    icon: 1,
    tags: ["속도", "공격"],
  },
  {
    id: "split",
    name: "갈라진 별",
    description: "측면 투사체 +1. 9개 초과분은 피해로 전환.",
    flavor: "별 하나가 부서져도 밤은 더 밝아졌다.",
    color: "#d8d0b8",
    icon: 2,
    tags: ["투사체", "성좌"],
  },
  {
    id: "pierce",
    name: "관통 맹세",
    description: "관통 +1, 관통할수록 피해 증가.",
    flavor: "길이 막혔다면 길을 뚫는다.",
    color: "#d8c37b",
    icon: 10,
    tags: ["투사체", "물리"],
  },
  {
    id: "eye",
    name: "사냥꾼의 눈",
    description: "치명타 확률과 치명 피해 증가.",
    flavor: "먹잇감의 다음 발자국까지 보인다.",
    color: "#b98cd9",
    icon: 12,
    tags: ["치명", "공격"],
  },
  {
    id: "return",
    name: "되감긴 칼날",
    description: "투사체의 체공 시간과 되감기 피해 증가.",
    flavor: "떠난 칼날은 반드시 기억을 안고 돌아온다.",
    color: "#c9c4b6",
    icon: 0,
    tags: ["투사체", "시간"],
  },
  {
    id: "ember",
    name: "잿불 씨앗",
    description: "명중 시 화염 추가 피해. 랭크마다 증폭.",
    flavor: "꺼진 세계에도 재 속에는 불이 남는다.",
    color: "#ef6549",
    icon: 1,
    tags: ["화염", "원소"],
  },
  {
    id: "oil",
    name: "기름 문장",
    description: "적 처치 시 주변으로 화염 폭발.",
    flavor: "한 번 번진 기억은 스스로 길을 찾는다.",
    color: "#b33a31",
    icon: 5,
    tags: ["화염", "폭발"],
  },
  {
    id: "frost",
    name: "서리못",
    description: "명중한 적을 둔화. 중첩될수록 강해짐.",
    flavor: "차갑게 박힌 못은 시간까지 붙든다.",
    color: "#8fc7da",
    icon: 11,
    tags: ["냉기", "제어"],
  },
  {
    id: "storm",
    name: "폭풍 이빨",
    description: "확률적으로 가까운 적에게 연쇄 번개.",
    flavor: "번개는 가장 짧은 길을 기억한다.",
    color: "#a991ff",
    icon: 6,
    tags: ["번개", "원소"],
  },
  {
    id: "poison",
    name: "독성 꽃",
    description: "적중 피해에 지속 독성 피해를 합산.",
    flavor: "아름다운 기억일수록 오래 썩는다.",
    color: "#6bbf86",
    icon: 13,
    tags: ["독", "원소"],
  },
  {
    id: "blood",
    name: "피의 계약",
    description: "최대 체력 -15%, 랭크당 피해 +14%.",
    flavor: "지도는 피로 쓴 약속만 지운 적이 없다.",
    color: "#d04743",
    icon: 5,
    tags: ["피", "공격"],
  },
  {
    id: "predator",
    name: "포식자의 위장",
    description: "처치가 쌓일 때마다 체력 회복.",
    flavor: "살아남은 자는 패배까지 먹어 치운다.",
    color: "#99886c",
    icon: 17,
    tags: ["회복", "피"],
  },
  {
    id: "glass",
    name: "유리 고치",
    description: "방 입장 시 랭크에 비례한 보호막.",
    flavor: "깨질 때 가장 날카로운 방어.",
    color: "#b9d3d3",
    icon: 3,
    tags: ["방어", "보호막"],
  },
  {
    id: "boots",
    name: "방랑자의 장화",
    description: "이동 속도 증가, 회피 재사용 감소.",
    flavor: "끝없는 지도에는 닳지 않는 발이 필요하다.",
    color: "#d0a65e",
    icon: 4,
    tags: ["이동", "회피"],
  },
  {
    id: "void",
    name: "공허 걸음",
    description: "회피가 주변 적에게 공허 피해를 남김.",
    flavor: "발이 닿지 않은 곳에도 상처는 남는다.",
    color: "#8b5ecc",
    icon: 18,
    tags: ["공허", "회피"],
  },
  {
    id: "orbit",
    name: "궤도의 달",
    description: "주위를 도는 달 칼날 +1, 최대 8개 표시.",
    flavor: "달은 길을 잃어도 하린을 돈다.",
    color: "#d8d4c9",
    icon: 11,
    tags: ["성좌", "근접"],
  },
  {
    id: "time",
    name: "시간의 흉터",
    description: "일정 공격마다 과거의 공격이 겹쳐짐.",
    flavor: "이미 지나간 상처가 다시 열린다.",
    color: "#aa88d5",
    icon: 9,
    tags: ["시간", "공격"],
  },
  {
    id: "magnet",
    name: "기억 나침반",
    description: "기억 조각 획득 범위와 경험치 증가.",
    flavor: "라온의 목소리는 늘 조각이 많은 쪽을 가리킨다.",
    color: "#63c6b2",
    icon: 19,
    tags: ["기억", "성장"],
  },
  {
    id: "map",
    name: "빈 지도",
    description: "방 클리어 보너스 피해와 회복 증가.",
    flavor: "아무것도 적히지 않았기에 무엇이든 될 수 있다.",
    color: "#c7a760",
    icon: 16,
    tags: ["지도", "성장"],
  },
  {
    id: "focus",
    name: "길잡이 렌즈",
    description: "투사체 피해·속도·사거리가 함께 증가.",
    flavor: "끝을 보지 못해도 나아갈 방향은 선명하다.",
    color: "#81c8d5",
    icon: 12,
    tags: ["투사체", "정밀"],
  },
  {
    id: "caliber",
    name: "별철 탄심",
    description: "투사체의 크기와 충돌 피해 증가.",
    flavor: "추락한 별의 무게는 작은 탄환에도 남아 있다.",
    color: "#d9b86c",
    icon: 10,
    tags: ["투사체", "충격"],
  },
  {
    id: "homing",
    name: "추적의 실",
    description: "투사체가 아직 맞지 않은 적을 향해 선회.",
    flavor: "한 번 묶인 운명은 벽 너머에서도 서로를 찾는다.",
    color: "#82d1b4",
    icon: 19,
    tags: ["투사체", "추적"],
  },
  {
    id: "ricochet",
    name: "메아리 돌",
    description: "명중 시 확률적으로 가까운 적에게 물리 메아리.",
    flavor: "한 번의 타격이 빈 회랑에서 두 번 죽음을 부른다.",
    color: "#c5b99b",
    icon: 17,
    tags: ["연쇄", "물리"],
  },
  {
    id: "execution",
    name: "종언 낙인",
    description: "체력이 낮은 적에게 강한 마무리 피해.",
    flavor: "마침표가 찍힌 이름은 지도에서 먼저 사라진다.",
    color: "#e06a5c",
    icon: 14,
    tags: ["처형", "공격"],
  },
  {
    id: "giantbane",
    name: "거인 먹물",
    description: "정예와 보스에게 주는 피해가 크게 증가.",
    flavor: "가장 큰 이름일수록 지우는 데 더 짙은 먹물이 든다.",
    color: "#b58d62",
    icon: 16,
    tags: ["보스", "공격"],
  },
  {
    id: "overcharge",
    name: "심홍 태엽",
    description: "일정 사격마다 과충전 탄막을 발사.",
    flavor: "태엽은 부서지기 직전에 가장 빠르게 돈다.",
    color: "#ec6459",
    icon: 1,
    tags: ["과충전", "공격"],
  },
  {
    id: "shrapnel",
    name: "뼈꽃 탄환",
    description: "적 처치 시 사방으로 아군 파편을 방출.",
    flavor: "쓰러진 뼈에서 다음 사냥의 꽃잎이 핀다.",
    color: "#ddd4b9",
    icon: 2,
    tags: ["처치", "폭발"],
  },
  {
    id: "leech",
    name: "피바늘",
    description: "투사체가 적중할 때마다 체력을 조금 회복.",
    flavor: "바늘 끝의 한 방울이면 길을 한 걸음 더 잇는다.",
    color: "#c94f58",
    icon: 5,
    tags: ["흡혈", "회복"],
  },
  {
    id: "armor",
    name: "철의 기도",
    description: "받는 모든 피해가 완만하게 감소.",
    flavor: "기도가 닿지 않는 곳에는 철을 겹쳐 두었다.",
    color: "#aeb5b4",
    icon: 3,
    tags: ["방어", "피해감소"],
  },
  {
    id: "resolve",
    name: "마지막 맹세",
    description: "체력이 40% 아래일 때 추가 피해 감소.",
    flavor: "마지막 한 줄은 누구도 대신 지워 줄 수 없다.",
    color: "#d78972",
    icon: 14,
    tags: ["생존", "피해감소"],
  },
  {
    id: "regeneration",
    name: "달샘 잔향",
    description: "전투 중에도 체력이 지속적으로 재생.",
    flavor: "말라붙은 우물은 달빛만으로 다시 차올랐다.",
    color: "#8bcab7",
    icon: 13,
    tags: ["재생", "회복"],
  },
  {
    id: "ward",
    name: "봉인 방패",
    description: "방에 들어설 때 추가 보호막 획득.",
    flavor: "문이 닫히는 소리는 방패가 잠기는 소리이기도 했다.",
    color: "#8faec2",
    icon: 3,
    tags: ["보호막", "방어"],
  },
  {
    id: "bulwark",
    name: "수호석",
    description: "보호막이 남아 있는 동안 받는 피해 추가 감소.",
    flavor: "작은 돌 하나가 무너질 세계의 첫 벽이 되었다.",
    color: "#95a69c",
    icon: 18,
    tags: ["보호막", "피해감소"],
  },
  {
    id: "momentum",
    name: "바람매듭",
    description: "이동 속도가 중첩에 따라 계속 증가.",
    flavor: "붙잡아 맨 바람은 발끝에서만 풀린다.",
    color: "#d3b867",
    icon: 4,
    tags: ["이동", "속도"],
  },
  {
    id: "reflex",
    name: "두 번째 발걸음",
    description: "회피가 더 빠르고 길어지며 재사용 대기시간 감소.",
    flavor: "첫 발은 몸이, 두 번째 발은 기억이 내디딘다.",
    color: "#a99ee0",
    icon: 4,
    tags: ["회피", "기동"],
  },
  {
    id: "scholar",
    name: "기록자의 먼지",
    description: "모든 경로에서 얻는 경험치 증가.",
    flavor: "지워진 문장도 먼지 속에서는 다시 읽힌다.",
    color: "#c8a967",
    icon: 16,
    tags: ["경험치", "성장"],
  },
  {
    id: "scavenger",
    name: "기억 갈고리",
    description: "쓰러진 적이 남기는 기억 조각의 가치 증가.",
    flavor: "버려진 기억일수록 깊은 곳에 단단히 걸려 있다.",
    color: "#67c4aa",
    icon: 19,
    tags: ["기억", "수집"],
  },
  {
    id: "conquest",
    name: "승리의 등불",
    description: "방 정복 시 체력을 회복하고 보호막 충전.",
    flavor: "닫힌 문 넷을 열 때마다 작은 불 하나가 살아났다.",
    color: "#e0a85e",
    icon: 6,
    tags: ["정복", "회복"],
  },
  {
    id: "frenzy",
    name: "붉은 박자",
    description: "잃은 체력에 비례해 공격 속도 증가.",
    flavor: "상처가 늘수록 심장은 더 정확한 박자를 새겼다.",
    color: "#df5557",
    icon: 9,
    tags: ["공격속도", "피"],
  },
];

const SYNERGIES = [
  { name: "대화재", needs: ["ember", "oil"], color: "#ef6549" },
  { name: "열충격", needs: ["ember", "frost"], color: "#d7a56a" },
  { name: "역병 폭풍", needs: ["poison", "storm"], color: "#9cbf75" },
  { name: "귀환 성좌", needs: ["split", "pierce", "return"], color: "#d8d0b8" },
  { name: "핏빛 번데기", needs: ["blood", "predator", "glass"], color: "#d04743" },
  { name: "월식 기관", needs: ["haste", "orbit", "time"], color: "#b79ce5" },
  { name: "혜성 자국", needs: ["boots", "void", "frost"], color: "#8fc7da" },
  { name: "참수자의 눈", needs: ["fang", "eye"], color: "#d8c37b" },
  { name: "유도 성좌", needs: ["focus", "homing", "pierce"], color: "#81c8d5" },
  { name: "백골 메아리", needs: ["shrapnel", "ricochet"], color: "#ddd4b9" },
  { name: "마지막 문장", needs: ["execution", "giantbane", "eye"], color: "#e06a5c" },
  { name: "혈침 순환", needs: ["leech", "blood", "predator"], color: "#c94f58" },
  { name: "철의 성소", needs: ["armor", "ward", "bulwark"], color: "#aeb5b4" },
  { name: "달빛 봉화", needs: ["regeneration", "conquest", "map"], color: "#e0a85e" },
  { name: "질풍 박동", needs: ["momentum", "reflex", "frenzy"], color: "#d3b867" },
  { name: "기억 채굴자", needs: ["scholar", "scavenger", "magnet"], color: "#67c4aa" },
  { name: "별철 과부하", needs: ["caliber", "overcharge", "ember"], color: "#ec6459" },
];

const ROOM_NAMES: Record<RoomKind, string> = {
  battle: "잿빛 회랑",
  horde: "메마른 자들의 뜰",
  elite: "붉은 봉인의 방",
  memory: "흐릿한 기억",
  shelter: "마지막 쉼표",
  boss: "백지의 중심",
};

const ROOM_ART_KEYS: Record<RoomKind, string> = {
  battle: "roomBattle",
  horde: "roomHorde",
  elite: "roomElite",
  memory: "roomMemory",
  shelter: "roomShelter",
  boss: "roomBoss",
};

const ROOM_COLOR_GRADE: Record<
  RoomKind,
  { tint: string; mote: string; locked: string; open: string }
> = {
  battle: { tint: "#8b775f", mote: "#c6aa78", locked: "#c34b43", open: "#72d5c0" },
  horde: { tint: "#74684c", mote: "#c7b47a", locked: "#bd5344", open: "#a7c883" },
  elite: { tint: "#7e2527", mote: "#da7764", locked: "#ed534c", open: "#80d1bd" },
  memory: { tint: "#506b83", mote: "#9fd3dc", locked: "#ba5e78", open: "#87d7dc" },
  shelter: { tint: "#9a6636", mote: "#f0c477", locked: "#be5743", open: "#8ed7b0" },
  boss: { tint: "#6f3035", mote: "#d8c7a2", locked: "#e34d50", open: "#d2c89c" },
};

const ENEMY_NAMES = [
  "메마른 자",
  "실꿰미",
  "껍질 문지기",
  "울음 둥지",
  "복사 마녀",
  "백지의 지도사",
];

const spriteCrops = [
  [0, 0, 384, 512],
  [384, 0, 384, 512],
  [768, 0, 384, 512],
  [1152, 0, 384, 512],
  [0, 512, 384, 512],
  [384, 512, 384, 512],
  [768, 420, 768, 604],
] as const;

const WALK_IMAGE_KEYS = [
  "walkWithered",
  "walkThreader",
  "walkGuardian",
  "walkNest",
  "walkWitch",
  "walkBoss",
] as const;
type DirectionFrame = { row: number; flipX?: boolean };
const makeDirectionFrames = (
  rows: readonly number[],
  flips: readonly boolean[] = [],
): readonly DirectionFrame[] =>
  rows.map((row, index) => ({ row, flipX: flips[index] ?? false }));

// Each generated enemy sheet has its own authored row order. Missing left-facing
// poses are synthesized from the matching right-facing pose instead of showing
// an enemy walking backwards.
const ENEMY_DIRECTION_FRAMES: readonly (readonly DirectionFrame[])[] = [
  makeDirectionFrames([0, 1, 6, 5, 4, 3, 2, 1], [false, true]),
  makeDirectionFrames([0, 1, 6, 3, 4, 5, 2, 1], [false, true]),
  makeDirectionFrames([0, 1, 2, 5, 4, 3, 2, 1], [false, true, true]),
  makeDirectionFrames([0, 7, 6, 5, 4, 3, 2, 1]),
  makeDirectionFrames([0, 1, 2, 3, 4, 5, 6, 7]),
  makeDirectionFrames([0, 1, 2, 5, 3, 5, 4, 7], [false, false, false, true]),
];
const DIRECTION_NAMES = ["남", "남서", "서", "북서", "북", "북동", "동", "남동"];
// Harin v2 has an irregular authored row order: S, SE, E, NW, N, NE, W, SW.
// Keep this correction local to the v2 sheet so legacy and enemy sprite sheets retain their mapping.
const HARIN_V2_DIRECTION_ROWS = [0, 7, 6, 3, 4, 5, 2, 1] as const;
const ROOM_DIRECTIONS = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
] as const;

const keyOf = (x: number, y: number) => `${x},${y}`;
const rankOf = (player: Player, id: string) => player.augments[id] ?? 0;
const powerRankOf = (player: Player, id: string) =>
  effectiveAugmentRank(player.augments, player.profession, id);
const xpThreshold = (level: number) =>
  26 + level * 12 + Math.floor(Math.pow(level, 1.25) * 3);
const distance = (ax: number, ay: number, bx: number, by: number) =>
  Math.hypot(ax - bx, ay - by);
const distanceToSegment = (
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
) => {
  const segmentX = bx - ax;
  const segmentY = by - ay;
  const segmentLengthSquared = segmentX * segmentX + segmentY * segmentY;
  if (segmentLengthSquared <= 0.0001) return distance(px, py, ax, ay);
  const projection = clamp(
    ((px - ax) * segmentX + (py - ay) * segmentY) / segmentLengthSquared,
    0,
    1,
  );
  return distance(px, py, ax + segmentX * projection, ay + segmentY * projection);
};
const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));
const colorWithAlpha = (color: string, alpha: number) => {
  const normalized = color.startsWith("#") ? color.slice(1) : color;
  if (!/^[0-9a-f]{6}$/i.test(normalized)) return color;
  const value = Number.parseInt(normalized, 16);
  return `rgba(${(value >> 16) & 255},${(value >> 8) & 255},${value & 255},${clamp(alpha, 0, 1)})`;
};
const positiveModulo = (value: number, divisor: number) =>
  ((value % divisor) + divisor) % divisor;
const formatSavedAt = (timestamp: number) => {
  try {
    return new Intl.DateTimeFormat("ko-KR", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(timestamp);
  } catch {
    return "저장 시각 미상";
  }
};

function directionRow(dx: number, dy: number, fallback = 0) {
  if (Math.hypot(dx, dy) < 0.001) return fallback;
  const sector = positiveModulo(Math.round(Math.atan2(dy, dx) / (Math.PI / 4)), 8);
  return [6, 7, 0, 1, 2, 3, 4, 5][sector];
}
function hash(seed: number, x: number, y: number, salt = 0) {
  let n =
    (seed ^ Math.imul(x + 1013, 374761393) ^ Math.imul(y - 977, 668265263) ^ salt) |
    0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}

function makePlayer(): Player {
  return {
    x: WIDTH / 2,
    y: HEIGHT / 2,
    radius: 20,
    hp: 100,
    maxHp: 100,
    shield: 0,
    xp: 0,
    nextXp: 26,
    level: 1,
    rooms: 0,
    kills: 0,
    augments: {},
    fireCooldown: 0,
    invulnerable: 0,
    dashCooldown: 0,
    dashTime: 0,
    dashX: 0,
    dashY: 0,
    shotCounter: 0,
    endingSeen: false,
    profession: null,
    facing: 6,
    walkCycle: 1,
    moving: false,
  };
}

function makeWorld(seed: number): World {
  return {
    seed,
    roomX: 0,
    roomY: 0,
    roomKind: "battle",
    roomCleared: false,
    rooms: {},
    visited: [],
    visitedLookup: {},
    enemies: [],
    projectiles: [],
    orbs: [],
    effects: [],
    effectCounts: { summon: 0, teleport: 0 },
    transition: 0,
    clearHandled: false,
  };
}

function augmentTier(player: Player, ids: string[]) {
  const total = ids.reduce((sum, id) => sum + rankOf(player, id), 0);
  return 1 + Math.floor(Math.max(0, total - ids.length) / 5);
}

function activeSynergies(player: Player) {
  return SYNERGIES.filter((synergy) =>
    synergy.needs.every((id) => rankOf(player, id) > 0),
  ).map((synergy) => ({
    ...synergy,
    tier: augmentTier(player, synergy.needs),
  }));
}

function AugmentIcon({ icon, size = 76 }: { icon: number; size?: number }) {
  const column = icon % 5;
  const row = Math.floor(icon / 5);
  return (
    <span
      className="augment-icon"
      style={{
        width: size,
        height: size,
        backgroundSize: `${size * 5}px ${size * 4}px`,
        backgroundPosition: `${-column * size}px ${-row * size}px`,
      }}
      aria-hidden="true"
    />
  );
}

function MapGrid({
  world,
  radius = 3,
  large = false,
}: {
  world: CartographyWorld;
  radius?: number;
  large?: boolean;
}) {
  const visited = new Set(world.visited);
  const currentKey = keyOf(world.roomX, world.roomY);
  const knownCoordinates = Object.keys(world.rooms)
    .map((key) => {
      const [x, y] = key.split(",").map(Number);
      return Number.isFinite(x) && Number.isFinite(y) ? { key, x, y } : null;
    })
    .filter((coordinate): coordinate is { key: string; x: number; y: number } =>
      Boolean(coordinate),
    );

  if (!knownCoordinates.some(({ key }) => key === currentKey)) {
    knownCoordinates.push({ key: currentKey, x: world.roomX, y: world.roomY });
  }

  const minimumX = large
    ? Math.min(world.roomX, ...knownCoordinates.map(({ x }) => x)) - 1
    : world.roomX - radius;
  const maximumX = large
    ? Math.max(world.roomX, ...knownCoordinates.map(({ x }) => x)) + 1
    : world.roomX + radius;
  const minimumY = large
    ? Math.min(world.roomY, ...knownCoordinates.map(({ y }) => y)) - 1
    : world.roomY - radius;
  const maximumY = large
    ? Math.max(world.roomY, ...knownCoordinates.map(({ y }) => y)) + 1
    : world.roomY + radius;
  const columns = maximumX - minimumX + 1;
  const rows = maximumY - minimumY + 1;

  const makeCell = (x: number, y: number) => {
    const key = keyOf(x, y);
    const room = world.rooms[key];
    const wasVisited = visited.has(key);
    const current = x === world.roomX && y === world.roomY;
    const status = room?.cleared ? "정복 완료" : wasVisited ? "탐사 중" : "정찰됨";
    return (
      <span
        key={key}
        data-coordinate={key}
        data-room-kind={room?.kind ?? "unknown"}
        data-cleared={Boolean(room?.cleared)}
        data-visited={wasVisited}
        data-current={current}
        className={[
          "map-cell",
          room ? "is-known" : "",
          room ? `is-${room.kind}` : "",
          wasVisited ? "is-visited" : "",
          room?.cleared ? "is-cleared" : "",
          current ? "is-current" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        style={
          large
            ? {
                gridColumn: x - minimumX + 1,
                gridRow: y - minimumY + 1,
              }
            : undefined
        }
        title={room ? `${ROOM_NAMES[room.kind]} · ${status} · ${key}` : `미지의 좌표 · ${key}`}
      >
        {current ? <i /> : null}
      </span>
    );
  };

  const cells = large
    ? knownCoordinates.map(({ x, y }) => makeCell(x, y))
    : Array.from({ length: rows * columns }, (_, index) => {
        const x = minimumX + (index % columns);
        const y = minimumY + Math.floor(index / columns);
        return makeCell(x, y);
      });

  return (
    <div
      className={`minimap-grid ${large ? "is-large" : ""}`}
      data-map-min-x={minimumX}
      data-map-max-x={maximumX}
      data-map-min-y={minimumY}
      data-map-max-y={maximumY}
      data-map-columns={columns}
      data-map-rows={rows}
      style={{
        "--map-side": radius * 2 + 1,
        "--map-columns": columns,
        "--map-rows": rows,
      } as CSSProperties}
      role="img"
      aria-label={
        large
          ? `전체 지도. 현재 위치 ${currentKey}, 확인한 좌표 ${knownCoordinates.length}개`
          : `주변 지도. 현재 위치 ${currentKey}`
      }
    >
      {cells}
    </div>
  );
}

export default function GameCanvas() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const mapBoardRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<Player>(makePlayer());
  const worldRef = useRef<World>(makeWorld(1));
  const stableAugmentsRef = useRef<Record<string, number>>({});
  const checkpointRef = useRef<{ x: number; y: number } | null>(null);
  const activeSaveSlotRef = useRef<SaveSlotId>(1);
  const idRef = useRef(1);
  const keysRef = useRef(new Set<string>());
  const inputRef = useRef({
    aimX: WIDTH / 2,
    aimY: HEIGHT / 2,
    lastAim: 0,
    dashQueued: false,
    moveTargetX: WIDTH / 2,
    moveTargetY: HEIGHT / 2,
    hasMoveTarget: false,
  });
  const imagesRef = useRef<Record<string, HTMLImageElement>>({});
  const modeRef = useRef<GameMode>("menu");
  const storyActionRef = useRef<() => void>(() => undefined);
  const lastHudUpdateRef = useRef(0);
  const roomEnterRef = useRef<
    (x: number, y: number, entry?: "left" | "right" | "top" | "bottom") => void
  >(() => undefined);
  const pendingStoryRef = useRef<{
    eyebrow: string;
    title: string;
    body: string;
  } | null>(null);
  const pendingEndingRef = useRef(false);
  const professionResumeRef = useRef<() => void>(() => undefined);

  const [mode, setMode] = useState<GameMode>("menu");
  const [started, setStarted] = useState(false);
  const [activeSaveSlot, setActiveSaveSlot] = useState<SaveSlotId>(1);
  const [saveSlots, setSaveSlots] = useState<Array<SaveSlotSummary | null>>(() =>
    SAVE_SLOT_IDS.map(() => null),
  );
  const [choices, setChoices] = useState<Augment[]>([]);
  const [professionCandidate, setProfessionCandidate] = useState<Augment | null>(null);
  const [story, setStory] = useState({
    eyebrow: "서장",
    title: "끝을 찾는 자",
    body: "하린은 사라진 동생 라온의 목소리를 따라, 끝이 없다는 지도 안으로 발을 내디뎠다.",
  });
  const [toast, setToast] = useState("WASD로 움직이세요. 공격은 자동입니다.");
  const [buildOpen, setBuildOpen] = useState(false);
  const [hud, setHud] = useState(() => ({
    player: { ...makePlayer(), augments: {} as Record<string, number> },
    stableAugments: {} as Record<string, number>,
    world: {
      roomX: 0,
      roomY: 0,
      roomKind: "battle" as RoomKind,
      roomCleared: false,
      rooms: {} as Record<string, RoomRecord>,
      visited: [] as string[],
      knownRoomCount: 0,
      visitedCount: 0,
      clearedRoomCount: 0,
      enemies: 0,
      bossHp: 0,
      bossMaxHp: 0,
      activeEffects: 0,
      playerProjectiles: 0,
      hostileProjectiles: 0,
      combatEffects: 0,
      summonEffects: 0,
      teleportEffects: 0,
    },
  }));
  const [mapSnapshot, setMapSnapshot] = useState<CartographyWorld>(() => ({
    roomX: 0,
    roomY: 0,
    rooms: {},
    visited: [],
  }));

  const setGameMode = useCallback((next: GameMode) => {
    modeRef.current = next;
    setMode(next);
  }, []);

  const activateSaveSlot = useCallback((slot: SaveSlotId) => {
    activeSaveSlotRef.current = slot;
    setActiveSaveSlot(slot);
  }, []);

  const refreshSaveSlots = useCallback(() => {
    setSaveSlots(readSaveSlotSummaries());
  }, []);

  const syncHud = useCallback(() => {
    const player = playerRef.current;
    const world = worldRef.current;
    const nearbyRooms: Record<string, RoomRecord> = {};
    const nearbyVisited: string[] = [];
    for (let y = world.roomY - 5; y <= world.roomY + 5; y += 1) {
      for (let x = world.roomX - 5; x <= world.roomX + 5; x += 1) {
        const key = keyOf(x, y);
        if (world.rooms[key]) nearbyRooms[key] = world.rooms[key];
        if (world.visitedLookup[key]) nearbyVisited.push(key);
      }
    }
    const boss = world.enemies.find((enemy) => enemy.kind === 5);
    setHud({
      player: { ...player, augments: { ...player.augments } },
      stableAugments: { ...stableAugmentsRef.current },
      world: {
        roomX: world.roomX,
        roomY: world.roomY,
        roomKind: world.roomKind,
        roomCleared: world.roomCleared,
        rooms: nearbyRooms,
        visited: nearbyVisited,
        knownRoomCount: Object.keys(world.rooms).length,
        visitedCount: world.visited.length,
        clearedRoomCount: Object.values(world.rooms).filter((room) => room.cleared).length,
        enemies: world.enemies.length,
        bossHp: boss?.hp ?? 0,
        bossMaxHp: boss?.maxHp ?? 0,
        activeEffects: world.effects.length,
        playerProjectiles: world.projectiles.filter((projectile) => !projectile.hostile).length,
        hostileProjectiles: world.projectiles.filter((projectile) => projectile.hostile).length,
        combatEffects: world.effects.filter(
          (effect) => effect.kind !== "summon" && effect.kind !== "teleport",
        ).length,
        summonEffects: world.effectCounts.summon,
        teleportEffects: world.effectCounts.teleport,
      },
    });
  }, []);

  const openMap = useCallback(() => {
    const world = worldRef.current;
    setMapSnapshot({
      roomX: world.roomX,
      roomY: world.roomY,
      rooms: Object.fromEntries(
        Object.entries(world.rooms).map(([key, room]) => [key, { ...room }]),
      ),
      visited: [...world.visited],
    });
    setGameMode("map");
  }, [setGameMode]);

  const showStory = useCallback(
    (
      eyebrow: string,
      title: string,
      body: string,
      action: () => void = () => setGameMode("playing"),
    ) => {
      setStory({ eyebrow, title, body });
      storyActionRef.current = action;
      setGameMode("story");
    },
    [setGameMode],
  );

  const saveAtShelter = useCallback(() => {
    const player = playerRef.current;
    const world = worldRef.current;
    player.hp = player.maxHp;
    player.shield =
      10 + powerRankOf(player, "glass") * 9 + powerRankOf(player, "ward") * 5;
    stableAugmentsRef.current = { ...player.augments };
    checkpointRef.current = { x: world.roomX, y: world.roomY };
    const data: SaveData = {
      player: {
        ...player,
        augments: { ...player.augments },
        x: WIDTH / 2,
        y: HEIGHT / 2,
      },
      world: {
        seed: world.seed,
        roomX: world.roomX,
        roomY: world.roomY,
        rooms: world.rooms,
        visited: world.visited,
      },
      stableAugments: stableAugmentsRef.current,
      savedAt: Date.now(),
    };
    if (writeSaveSlot(activeSaveSlotRef.current, data)) {
      refreshSaveSlots();
      setToast(`${activeSaveSlotRef.current}번 슬롯 · 쉼터에 기억이 고정되었습니다.`);
    } else {
      setToast("이 기기에서 저장이 차단되었습니다. 탐험은 계속할 수 있습니다.");
    }
    syncHud();
  }, [refreshSaveSlots, syncHud]);

  const makeEnemy = useCallback(
    (kind: EnemyKind, x: number, y: number, depth: number, elite = false): Enemy => {
      const hpBases = [28, 24, 64, 80, 45, 950];
      const speedBases = [76, 50, 43, 26, 62, 38];
      const damageBases = [8, 10, 14, 7, 12, 16];
      const radii = [21, 20, 28, 32, 22, 62];
      const scale = Math.pow(1 + 0.075 * depth, 1.28);
      const eliteScale = elite ? 2.25 : 1;
      const hp = hpBases[kind] * scale * eliteScale;
      return {
        id: idRef.current++,
        kind,
        x,
        y,
        radius: radii[kind],
        hp,
        maxHp: hp,
        speed: speedBases[kind] * (elite ? 1.12 : 1),
        damage:
          damageBases[kind] *
          Math.pow(1 + 0.035 * depth, 1.16) *
          (elite ? 1.28 : 1),
        shootCooldown: 0.8 + hash(worldRef.current.seed, x | 0, y | 0, kind) * 1.4,
        slow: 0,
        orbitalCooldown: 0,
        poisonDamage: 0,
        poisonTime: 0,
        facing: 0,
        walkCycle: hash(worldRef.current.seed, x | 0, y | 0, kind + 31) * 4,
        moving: true,
        elite,
      };
    },
    [],
  );

  const spawnRoom = useCallback(
    (kind: RoomKind) => {
      const world = worldRef.current;
      const player = playerRef.current;
      const depth = player.rooms;
      const enemies: Enemy[] = [];
      const baseCount = clamp(4 + Math.floor(2.15 * Math.sqrt(depth + 1)), 4, 16);
      const count = kind === "horde" ? Math.ceil(baseCount * 1.55) : baseCount;
      const seedSalt = world.roomX * 41 + world.roomY * 73 + depth * 97;

      if (kind === "shelter") {
        world.enemies = [];
        return;
      }
      if (kind === "boss") {
        enemies.push(makeEnemy(5, WIDTH / 2, 210, depth, true));
        for (let i = 0; i < Math.min(5, 2 + Math.floor(depth / 4)); i += 1) {
          const angle = (Math.PI * 2 * i) / 5;
          enemies.push(
            makeEnemy(
              (i % 3) as EnemyKind,
              WIDTH / 2 + Math.cos(angle) * 260,
              HEIGHT / 2 + Math.sin(angle) * 185,
              depth,
            ),
          );
        }
        world.enemies = enemies;
        return;
      }

      for (let i = 0; i < count; i += 1) {
        const rx = hash(world.seed, world.roomX, world.roomY, seedSalt + i * 19);
        const ry = hash(world.seed, world.roomY, world.roomX, seedSalt + i * 31);
        let enemyKind = Math.floor(
          hash(world.seed, world.roomX + i, world.roomY - i, 911) *
            Math.min(5, 2 + Math.floor(depth / 2)),
        ) as EnemyKind;
        if (kind === "horde") enemyKind = 0;
        if (kind === "memory" && i % 2 === 0) enemyKind = 4;
        const elite = kind === "elite" && i === 0;
        enemies.push(
          makeEnemy(
            enemyKind,
            130 + rx * (WIDTH - 260),
            120 + ry * (HEIGHT - 240),
            depth,
            elite,
          ),
        );
      }
      world.enemies = enemies;
    },
    [makeEnemy],
  );

  const determineRoomKind = useCallback((x: number, y: number): RoomKind => {
    const world = worldRef.current;
    const existing = world.rooms[keyOf(x, y)];
    if (existing) return existing.kind;
    if (x === 0 && y === 0) return "battle";

    const radialDistance = Math.abs(x) + Math.abs(y);
    const onCardinalRoute = x === 0 || y === 0;
    if (onCardinalRoute && radialDistance >= 9 && radialDistance % 9 === 0) {
      return "boss";
    }
    if (onCardinalRoute && radialDistance >= 5 && radialDistance % 5 === 0) {
      return "shelter";
    }

    // Infinite-map landmarks are coordinate deterministic. Every 9×9 sector has
    // one boss and every 5×5 sector has one shelter, so a saved seed can never
    // reshuffle when the player explores branches in a different order.
    const bossSectorX = Math.floor(x / 9);
    const bossSectorY = Math.floor(y / 9);
    const bossX =
      bossSectorX * 9 +
      Math.min(8, Math.floor(hash(world.seed, bossSectorX, bossSectorY, 901) * 9));
    const bossY =
      bossSectorY * 9 +
      Math.min(8, Math.floor(hash(world.seed, bossSectorY, bossSectorX, 977) * 9));
    if (Math.abs(x) + Math.abs(y) >= 6 && x === bossX && y === bossY) return "boss";

    const shelterSectorX = Math.floor(x / 5);
    const shelterSectorY = Math.floor(y / 5);
    const shelterX =
      shelterSectorX * 5 +
      Math.min(4, Math.floor(hash(world.seed, shelterSectorX, shelterSectorY, 503) * 5));
    const shelterY =
      shelterSectorY * 5 +
      Math.min(4, Math.floor(hash(world.seed, shelterSectorY, shelterSectorX, 557) * 5));
    if (Math.abs(x) + Math.abs(y) >= 3 && x === shelterX && y === shelterY) {
      return "shelter";
    }

    const roll = hash(world.seed, x, y, 173);
    if (roll < 0.49) return "battle";
    if (roll < 0.67) return "horde";
    if (roll < 0.81) return "elite";
    return "memory";
  }, []);

  const enterRoom = useCallback(
    (
      x: number,
      y: number,
      entry: "left" | "right" | "top" | "bottom" = "left",
    ) => {
      const world = worldRef.current;
      const player = playerRef.current;
      const key = keyOf(x, y);
      const kind = determineRoomKind(x, y);
      if (!world.rooms[key]) world.rooms[key] = { kind, cleared: kind === "shelter" };
      for (const [offsetX, offsetY] of ROOM_DIRECTIONS) {
        const neighborX = x + offsetX;
        const neighborY = y + offsetY;
        const neighborKey = keyOf(neighborX, neighborY);
        if (!world.rooms[neighborKey]) {
          const neighborKind = determineRoomKind(neighborX, neighborY);
          world.rooms[neighborKey] = {
            kind: neighborKind,
            cleared: neighborKind === "shelter",
          };
        }
      }
      if (!world.visitedLookup[key]) {
        world.visited.push(key);
        world.visitedLookup[key] = true;
      }
      world.roomX = x;
      world.roomY = y;
      world.roomKind = kind;
      world.roomCleared = world.rooms[key].cleared;
      world.clearHandled = world.roomCleared;
      world.projectiles = [];
      world.orbs = [];
      world.effects = [];
      world.transition = 0.55;
      inputRef.current.hasMoveTarget = false;
      player.shotCounter = 0;
      player.x =
        entry === "left" ? 116 : entry === "right" ? WIDTH - 116 : WIDTH / 2;
      player.y =
        entry === "top" ? HEIGHT - 112 : entry === "bottom" ? 112 : HEIGHT / 2;
      player.shield = Math.max(
        player.shield,
        10 + powerRankOf(player, "glass") * 9 + powerRankOf(player, "ward") * 5,
      );
      if (world.roomCleared) world.enemies = [];
      else spawnRoom(kind);
      setToast(
        kind === "shelter"
          ? "불빛이 기억을 붙잡습니다."
          : kind === "boss"
            ? "지도 자체가 당신의 빌드를 되그리기 시작합니다."
            : `${ROOM_NAMES[kind]} — 문이 봉쇄되었습니다.`,
      );
      if (kind === "shelter") {
        saveAtShelter();
        setGameMode("shelter");
      }
      syncHud();
    },
    [determineRoomKind, saveAtShelter, setGameMode, spawnRoom, syncHud],
  );

  useEffect(() => {
    roomEnterRef.current = enterRoom;
  }, [enterRoom]);

  const openAugmentChoice = useCallback(() => {
    const player = playerRef.current;
    const owned = AUGMENTS.filter((augment) => rankOf(player, augment.id) > 0);
    const unowned = AUGMENTS.filter((augment) => rankOf(player, augment.id) === 0);
    const pool = [...owned, ...owned, ...unowned]
      .map((augment) => ({
        augment,
        roll: Math.random() + (rankOf(player, augment.id) > 0 ? 0.15 : 0),
      }))
      .sort((a, b) => b.roll - a.roll);
    const picked: Augment[] = [];
    if (owned.length > 0) {
      picked.push(
        owned
          .map((augment) => ({ augment, roll: Math.random() }))
          .sort((a, b) => b.roll - a.roll)[0].augment,
      );
    }
    for (const item of pool) {
      if (!picked.some((augment) => augment.id === item.augment.id)) {
        picked.push(item.augment);
      }
      if (picked.length === 3) break;
    }
    setChoices(picked);
    setGameMode("augment");
  }, [setGameMode]);

  const gainXp = useCallback(
    (amount: number) => {
      const player = playerRef.current;
      const scholarRank = powerRankOf(player, "scholar");
      const boosted =
        amount *
        (1 + powerRankOf(player, "magnet") * 0.08) *
        Math.pow(1 + scholarRank * 0.09, 0.7);
      player.xp += boosted;
      if (player.xp >= player.nextXp && modeRef.current === "playing") {
        player.xp -= player.nextXp;
        player.level += 1;
        player.nextXp = xpThreshold(player.level);
        openAugmentChoice();
      }
    },
    [openAugmentChoice],
  );

  const resumeAfterAugmentChoice = useCallback(() => {
    if (pendingEndingRef.current) {
      pendingEndingRef.current = false;
      setGameMode("ending");
    } else if (pendingStoryRef.current) {
      const pending = pendingStoryRef.current;
      pendingStoryRef.current = null;
      showStory(pending.eyebrow, pending.title, pending.body, () =>
        setGameMode("playing"),
      );
    } else {
      setGameMode("playing");
    }
  }, [setGameMode, showStory]);

  const openProfessionChoice = useCallback(
    (augment: Augment, resume: () => void = () => setGameMode("playing")) => {
      if (!isProfessionEligible(playerRef.current.augments, augment.id)) return;
      setProfessionCandidate(augment);
      professionResumeRef.current = resume;
      setGameMode("profession");
    },
    [setGameMode],
  );

  const closeProfessionChoice = useCallback(() => {
    setProfessionCandidate(null);
    professionResumeRef.current();
  }, []);

  const confirmProfession = useCallback(() => {
    if (!professionCandidate) return;
    const player = playerRef.current;
    player.profession = professionCandidate.id;
    const rawRank = rankOf(player, professionCandidate.id);
    const effectiveRank = powerRankOf(player, professionCandidate.id);
    setToast(
      `${PROFESSION_TITLES[professionCandidate.id]} 전직 완료 · ${professionCandidate.name} ${rawRank}스택이 전투력 ${effectiveRank}로 증폭됩니다.`,
    );
    setProfessionCandidate(null);
    syncHud();
    professionResumeRef.current();
  }, [professionCandidate, syncHud]);

  const chooseAugment = useCallback(
    (augment: Augment) => {
      const player = playerRef.current;
      const previous = rankOf(player, augment.id);
      player.augments[augment.id] = previous + 1;
      if (augment.id === "blood" && previous === 0) {
        player.maxHp = 85;
        player.hp = Math.min(player.hp, player.maxHp);
      }
      if (augment.id === "glass") {
        const previousPower =
          player.profession === "glass" ? previous + Math.floor(previous / 2) : previous;
        player.shield += 9 * Math.max(1, powerRankOf(player, "glass") - previousPower);
      }
      const synergies = activeSynergies(player);
      setToast(
        synergies.length
          ? `${augment.name} ${previous + 1}랭크 · 시너지 ${synergies.at(-1)?.name} 활성`
          : `${augment.name} ${previous + 1}랭크 — 기억이 빌드에 합쳐졌습니다.`,
      );
      syncHud();
      if (previous + 1 >= PROFESSION_THRESHOLD && player.profession !== augment.id) {
        openProfessionChoice(augment, resumeAfterAugmentChoice);
      } else {
        resumeAfterAugmentChoice();
      }
    },
    [openProfessionChoice, resumeAfterAugmentChoice, syncHud],
  );

  const loadSave = useCallback(
    (slot: SaveSlotId = activeSaveSlotRef.current) => {
      const candidate = readSaveSlot(slot);
      if (!candidate || !isHydratableSaveData(candidate)) {
        setToast(`${slot}번 슬롯의 저장 데이터를 읽을 수 없습니다.`);
        refreshSaveSlots();
        return false;
      }
      const data = candidate;
      activateSaveSlot(slot);
      playerRef.current = {
        ...makePlayer(),
        ...data.player,
        profession:
          typeof data.player.profession === "string" ? data.player.profession : null,
        x: WIDTH / 2,
        y: HEIGHT / 2,
        augments: { ...data.player.augments },
      };
      playerRef.current.nextXp = Math.min(
        playerRef.current.nextXp,
        xpThreshold(playerRef.current.level),
      );
      const world = makeWorld(data.world.seed);
      world.rooms = data.world.rooms;
      world.visited = data.world.visited;
      world.visitedLookup = Object.fromEntries(
        data.world.visited.map((key) => [key, true] as const),
      );
      worldRef.current = world;
      stableAugmentsRef.current = { ...(data.stableAugments ?? {}) };
      checkpointRef.current = { x: data.world.roomX, y: data.world.roomY };
      setStarted(true);
      enterRoom(data.world.roomX, data.world.roomY, "left");
      setGameMode("shelter");
      return true;
    },
    [activateSaveSlot, enterRoom, refreshSaveSlots, setGameMode],
  );

  const startNewRun = useCallback((slot: SaveSlotId = activeSaveSlotRef.current) => {
    activateSaveSlot(slot);
    removeSaveSlot(slot);
    refreshSaveSlots();
    keysRef.current.clear();
    pendingStoryRef.current = null;
    pendingEndingRef.current = false;
    const seed = (Date.now() ^ Math.floor(Math.random() * 0x7fffffff)) & 0x7fffffff;
    playerRef.current = makePlayer();
    worldRef.current = makeWorld(seed);
    stableAugmentsRef.current = {};
    checkpointRef.current = null;
    setStarted(true);
    enterRoom(0, 0, "left");
    showStory(
      "서장 · 끝을 찾는 자",
      "라온의 목소리",
      "“누나, 지도 끝에서 기다릴게.” 하린은 그 목소리가 진짜인지 묻지 않았다. 무진도에서 질문은 늘 또 하나의 방이 되었으니까.",
      () => setGameMode("playing"),
    );
  }, [activateSaveSlot, enterRoom, refreshSaveSlots, setGameMode, showStory]);

  const retryFromShelter = useCallback(() => {
    if (!loadSave()) startNewRun();
  }, [loadSave, startNewRun]);

  const deleteSaveSlot = useCallback(
    (slot: SaveSlotId) => {
      if (!window.confirm(`${slot}번 슬롯의 고정된 기억을 삭제할까요?`)) return;
      removeSaveSlot(slot);
      refreshSaveSlots();
      setToast(`${slot}번 슬롯을 비웠습니다.`);
    },
    [refreshSaveSlots],
  );

  const returnToMenu = useCallback(() => {
    keysRef.current.clear();
    inputRef.current.hasMoveTarget = false;
    setStarted(false);
    setGameMode("menu");
    setBuildOpen(false);
    refreshSaveSlots();
  }, [refreshSaveSlots, setGameMode]);

  useEffect(() => {
    migrateLegacySave();
    const saveCheck = window.setTimeout(refreshSaveSlots, 0);
    const imagePaths: Record<string, string> = {
      sprites: "/assets/characters-sprite-atlas.png",
      walkHarin: "/assets/walk/harin-walk-v2.png",
      walkHarinLegacy: "/assets/walk/harin-walk.png",
      walkWithered: "/assets/walk/withered-walk-v2.png",
      walkThreader: "/assets/walk/threader-walk.png",
      walkGuardian: "/assets/walk/guardian-walk.png",
      walkNest: "/assets/walk/nest-walk.png",
      walkWitch: "/assets/walk/witch-walk.png",
      walkBoss: "/assets/walk/cartographer-boss-walk.png",
      summonEffect: "/assets/effects/summon-rift.png",
      teleportEffect: "/assets/effects/teleport-rift.png",
      memoryFragments: "/assets/pickups/memory-fragments.png",
      roomBattle: "/assets/maps/room-battle.webp",
      roomHorde: "/assets/maps/room-horde.webp",
      roomElite: "/assets/maps/room-elite.webp",
      roomMemory: "/assets/maps/room-memory.webp",
      roomShelter: "/assets/maps/room-shelter.webp",
      roomBoss: "/assets/maps/room-boss.webp",
      ui: "/assets/augment-ui-atlas.png",
      menu: "/assets/menu-title-background.png",
    };
    for (const [name, source] of Object.entries(imagePaths)) {
      const image = new Image();
      image.src = source;
      imagesRef.current[name] = image;
    }
    return () => window.clearTimeout(saveCheck);
  }, [refreshSaveSlots]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (modeRef.current === "augment" && !event.repeat && ["1", "2", "3"].includes(key)) {
        const choice = choices[Number(key) - 1];
        if (choice) chooseAugment(choice);
        return;
      }
      keysRef.current.add(key);
      if (["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(key)) {
        inputRef.current.hasMoveTarget = false;
      }
      if ([" ", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(key)) {
        event.preventDefault();
      }
      if (key === " " && modeRef.current === "playing") inputRef.current.dashQueued = true;
      if (key === "b" && modeRef.current === "playing" && !event.repeat) {
        setBuildOpen((open) => !open);
      }
      if (key === "m" && started && !event.repeat) {
        if (modeRef.current === "playing") openMap();
        else if (modeRef.current === "map") setGameMode("playing");
      }
      if (key === "escape" && started && !event.repeat) {
        if (modeRef.current === "playing") setGameMode("paused");
        else if (modeRef.current === "paused" || modeRef.current === "map") {
          setGameMode("playing");
        }
      }
    };
    const onKeyUp = (event: KeyboardEvent) =>
      keysRef.current.delete(event.key.toLowerCase());
    const clearInputs = () => {
      keysRef.current.clear();
      inputRef.current.dashQueued = false;
    };
    window.addEventListener("keydown", onKeyDown, { passive: false });
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", clearInputs);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", clearInputs);
    };
  }, [choices, chooseAugment, openMap, setGameMode, started]);

  useEffect(() => {
    if (mode !== "map") return;
    const frame = window.requestAnimationFrame(() => {
      const board = mapBoardRef.current;
      const current = board?.querySelector<HTMLElement>(".map-cell.is-current");
      if (!board || !current) return;
      const boardRect = board.getBoundingClientRect();
      const currentRect = current.getBoundingClientRect();
      board.scrollLeft +=
        currentRect.left - boardRect.left - board.clientWidth / 2 + currentRect.width / 2;
      board.scrollTop +=
        currentRect.top - boardRect.top - board.clientHeight / 2 + currentRect.height / 2;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [mapSnapshot, mode]);

  useEffect(() => {
    if (!started) return;
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    let frame = 0;
    let last = performance.now();

    const damagePlayer = (amount: number) => {
      const player = playerRef.current;
      if (player.invulnerable > 0 || player.dashTime > 0) return;
      let mitigated = Math.min(amount, player.maxHp * 0.4);
      const armorRank = powerRankOf(player, "armor");
      mitigated /= Math.pow(1 + armorRank * 0.1, 0.62);
      if (player.hp / player.maxHp < 0.4) {
        const resolveRank = powerRankOf(player, "resolve");
        mitigated /= Math.pow(1 + resolveRank * 0.14, 0.6);
      }
      if (player.shield > 0) {
        const bulwarkRank = powerRankOf(player, "bulwark");
        mitigated /= Math.pow(1 + bulwarkRank * 0.12, 0.55);
      }
      const impact = mitigated;
      if (player.shield > 0) {
        const absorbed = Math.min(player.shield, mitigated);
        player.shield -= absorbed;
        amount = mitigated - absorbed;
      } else {
        amount = mitigated;
      }
      player.hp -= amount;
      player.invulnerable = 0.6;
      setToast(`기억이 ${Math.ceil(impact)}만큼 찢겼습니다.`);
      if (player.hp <= 0) {
        player.hp = 0;
        setGameMode("dead");
      }
    };

    const spawnHostileProjectile = (
      x: number,
      y: number,
      angle: number,
      speed: number,
      damage: number,
      radius = 6,
      affinity: ProjectileAffinity = "enemy",
    ) => {
      const life = affinity === "boss" ? 5 : 4;
      const muzzleOffset = radius + (affinity === "boss" ? 18 : 12);
      const startX = x + Math.cos(angle) * muzzleOffset;
      const startY = y + Math.sin(angle) * muzzleOffset;
      worldRef.current.projectiles.push({
        id: idRef.current++,
        x: startX,
        y: startY,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        radius,
        damage,
        life,
        pierce: 0,
        hostile: true,
        color: affinity === "boss" ? "#ff5961" : affinity === "witch" ? "#d66cff" : "#e14f55",
        affinity,
        age: 0,
        maxLife: life,
        previousX: startX,
        previousY: startY,
        hit: new Set<number>(),
      });
    };

    const spawnVisualEffect = (
      kind: BehaviorEffectKind,
      x: number,
      y: number,
      duration: number,
      size: number,
    ) => {
      const world = worldRef.current;
      world.effects.push({
        id: idRef.current++,
        kind,
        x,
        y,
        life: duration,
        duration,
        size,
      });
      world.effectCounts[kind] += 1;
    };

    const spawnCombatEffect = (
      kind: CombatEffectKind,
      x: number,
      y: number,
      duration: number,
      size: number,
      color: string,
      angle = 0,
      endX?: number,
      endY?: number,
    ) => {
      const world = worldRef.current;
      const combatEffectCount = world.effects.reduce(
        (count, effect) => count + (effect.kind === "summon" || effect.kind === "teleport" ? 0 : 1),
        0,
      );
      if (combatEffectCount >= 120) return;
      world.effects.push({
        id: idRef.current++,
        kind,
        x,
        y,
        life: duration,
        duration,
        size,
        color,
        angle,
        endX,
        endY,
      });
    };

    const killEnemy = (enemy: Enemy) => {
      const player = playerRef.current;
      const world = worldRef.current;
      player.kills += 1;
      const baseValue = enemy.kind === 5 ? 80 : enemy.elite ? 20 : 7 + enemy.kind * 2;
      const scavengerRank = powerRankOf(player, "scavenger");
      const value = baseValue * Math.pow(1 + scavengerRank * 0.1, 0.75);
      world.orbs.push({ id: idRef.current++, x: enemy.x, y: enemy.y, value });
      const predator = powerRankOf(player, "predator");
      if (predator > 0 && player.kills % Math.max(5, 18 - predator) === 0) {
        const heal = 2 + predator * 1.2;
        const cocoon = activeSynergies(player).find(
          (synergy) => synergy.name === "핏빛 번데기",
        );
        const missing = player.maxHp - player.hp;
        player.hp = Math.min(player.maxHp, player.hp + heal);
        if (cocoon && heal > missing) {
          player.shield += (heal - missing) * (1 + cocoon.tier * 0.25);
        }
      }
      const oil = powerRankOf(player, "oil");
      if (oil > 0) {
        const conflagration = activeSynergies(player).find(
          (synergy) => synergy.name === "대화재",
        );
        const burst =
          (12 + oil * 7 + powerRankOf(player, "ember") * 4) *
          (1 + (conflagration?.tier ?? 0) * 0.25);
        spawnCombatEffect(
          "playerImpact",
          enemy.x,
          enemy.y,
          0.38,
          58 + Math.min(62, oil * 7),
          "#ff7047",
        );
        for (const other of world.enemies) {
          if (other.id !== enemy.id && distance(enemy.x, enemy.y, other.x, other.y) < 118) {
            other.hp -= burst;
          }
        }
      }
      const shrapnelRank = powerRankOf(player, "shrapnel");
      if (shrapnelRank > 0) {
        const shardCount = 2 + Math.min(6, shrapnelRank);
        const focusRank = powerRankOf(player, "focus");
        const homingRank = powerRankOf(player, "homing");
        const shardSpeed = 430 * Math.pow(1 + focusRank * 0.06, 0.55);
        const shardLife = 0.62 + focusRank * 0.025;
        for (let i = 0; i < shardCount; i += 1) {
          const angle = (Math.PI * 2 * i) / shardCount + enemy.id * 0.73;
          world.projectiles.push({
            id: idRef.current++,
            x: enemy.x,
            y: enemy.y,
            vx: Math.cos(angle) * shardSpeed,
            vy: Math.sin(angle) * shardSpeed,
            radius: 3.5 + Math.min(3, shrapnelRank * 0.25),
            damage: 5 + shrapnelRank * 2.4,
            life: shardLife,
            pierce: Math.floor(shrapnelRank / 5),
            hostile: false,
            color: "#ead9b8",
            affinity: "arcane",
            age: 0,
            maxLife: shardLife,
            previousX: enemy.x,
            previousY: enemy.y,
            hit: new Set<number>([enemy.id]),
            homing:
              homingRank > 0 ? Math.min(10, 1.8 + homingRank * 0.55) : undefined,
          });
        }
      }
    };

    const firePlayerWeapon = () => {
      const player = playerRef.current;
      const world = worldRef.current;
      if (!world.enemies.length) return;
      const aimRecently = performance.now() - inputRef.current.lastAim < 850;
      let target: Enemy | undefined;
      let best = Infinity;
      for (const enemy of world.enemies) {
        const d = distance(player.x, player.y, enemy.x, enemy.y);
        if (aimRecently) {
          const aimAngle = Math.atan2(
            inputRef.current.aimY - player.y,
            inputRef.current.aimX - player.x,
          );
          const enemyAngle = Math.atan2(enemy.y - player.y, enemy.x - player.x);
          const delta = Math.abs(
            Math.atan2(Math.sin(enemyAngle - aimAngle), Math.cos(enemyAngle - aimAngle)),
          );
          const score = d + delta * 290;
          if (delta < 0.72 && score < best) {
            best = score;
            target = enemy;
          }
        } else if (d < best) {
          best = d;
          target = enemy;
        }
      }
      if (!target) target = world.enemies[0];
      const baseAngle = Math.atan2(target.y - player.y, target.x - player.x);
      const splitRank = powerRankOf(player, "split");
      const theoreticalCount = 1 + splitRank;
      const visibleCount = Math.min(9, theoreticalCount);
      const overflowCount = theoreticalCount / visibleCount;
      const hasteRank = powerRankOf(player, "haste");
      const missingHealthRatio = 1 - player.hp / player.maxHp;
      const frenzyRank = powerRankOf(player, "frenzy");
      const theoreticalRate =
        1.4 *
        Math.pow(1 + 0.14 * hasteRank, 0.7) *
        Math.pow(1 + frenzyRank * missingHealthRatio * 0.12, 0.65);
      const visibleRate = Math.min(12, theoreticalRate);
      const overflowRate = Math.max(1, theoreticalRate / visibleRate);
      const bloodRank = powerRankOf(player, "blood");
      const missingHealthBonus =
        bloodRank > 0 ? missingHealthRatio * bloodRank * 0.2 : 0;
      const synergyPower = activeSynergies(player).reduce(
        (sum, synergy) => sum + synergy.tier * 0.06,
        0,
      );
      const returnRank = powerRankOf(player, "return");
      const timeRank = powerRankOf(player, "time");
      const focusRank = powerRankOf(player, "focus");
      const caliberRank = powerRankOf(player, "caliber");
      const homingRank = powerRankOf(player, "homing");
      const overchargeRank = powerRankOf(player, "overcharge");
      const chargePeriod = Math.max(3, 8 - Math.min(5, overchargeRank));
      const overcharged =
        overchargeRank > 0 && (player.shotCounter + 1) % chargePeriod === 0;
      const stormRank = powerRankOf(player, "storm");
      const emberRank = powerRankOf(player, "ember");
      const frostRank = powerRankOf(player, "frost");
      const poisonRank = powerRankOf(player, "poison");
      const projectileAffinity: ProjectileAffinity =
        stormRank > 0
          ? "storm"
          : emberRank > 0
            ? "ember"
            : frostRank > 0
              ? "frost"
              : poisonRank > 0
                ? "poison"
                : "arcane";
      const projectileColor =
        projectileAffinity === "storm"
          ? "#b59aff"
          : projectileAffinity === "ember"
            ? "#ff744f"
            : projectileAffinity === "frost"
              ? "#8ee8ff"
              : projectileAffinity === "poison"
                ? "#7ee48d"
                : "#72ead0";
      const echoShot =
        timeRank > 0 &&
        (player.shotCounter + 1) % Math.max(2, 6 - Math.min(4, timeRank)) === 0;
      let damage =
        12 *
        (1 + powerRankOf(player, "fang") * 0.18) *
        (1 + bloodRank * 0.14 + missingHealthBonus) *
        (1 + powerRankOf(player, "ember") * 0.08) *
        (1 + powerRankOf(player, "poison") * 0.06) *
        (1 + timeRank * 0.07) *
        (1 + returnRank * 0.04) *
        (1 + powerRankOf(player, "map") * 0.06) *
        (1 + focusRank * 0.025) *
        (1 + caliberRank * 0.045) *
        (overcharged ? 1.35 + overchargeRank * 0.045 : 1) *
        (1 + synergyPower) *
        overflowCount *
        overflowRate;
      const eyeRank = powerRankOf(player, "eye");
      const critChance = 0.05 + 0.45 * (1 - Math.exp(-0.18 * eyeRank));
      if (Math.random() < critChance) damage *= 1.7 + eyeRank * 0.1;
      const spread = Math.min(0.62, visibleCount * 0.07);
      const projectileSpeed = 660 * Math.pow(1 + focusRank * 0.06, 0.55);
      const projectileLife =
        (1.15 + returnRank * 0.14) * Math.pow(1 + focusRank * 0.035, 0.5);
      const chargedColor = overcharged ? "#ff7764" : projectileColor;
      spawnCombatEffect(
        "muzzle",
        player.x,
        player.y - 8,
        0.2,
        28 + Math.min(18, visibleCount * 2),
        chargedColor,
        baseAngle,
      );
      for (let i = 0; i < visibleCount; i += 1) {
        const angle =
          baseAngle +
          (visibleCount === 1 ? 0 : -spread / 2 + (spread * i) / (visibleCount - 1));
        world.projectiles.push({
          id: idRef.current++,
          x: player.x,
          y: player.y - 8,
          vx: Math.cos(angle) * projectileSpeed,
          vy: Math.sin(angle) * projectileSpeed,
          radius:
            5 +
            Math.min(5, powerRankOf(player, "fang")) +
            Math.min(5, caliberRank * 0.55),
          damage,
          life: projectileLife,
          pierce: powerRankOf(player, "pierce"),
          hostile: false,
          color: chargedColor,
          affinity: projectileAffinity,
          age: 0,
          maxLife: projectileLife,
          previousX: player.x,
          previousY: player.y - 8,
          hit: new Set<number>(),
          returnAfter: returnRank > 0 ? 0.58 : undefined,
          returning: false,
          returnMultiplier: 0.45 + returnRank * 0.1,
          homing:
            homingRank > 0 ? Math.min(10, 1.8 + homingRank * 0.55) : undefined,
        });
        if (echoShot) {
          world.projectiles.push({
            id: idRef.current++,
            x: player.x,
            y: player.y - 8,
            vx: Math.cos(angle) * projectileSpeed * 0.92,
            vy: Math.sin(angle) * projectileSpeed * 0.92,
            radius: 4 + Math.min(4, timeRank),
            damage: damage * (0.45 + timeRank * 0.07),
            life: 1.05,
            pierce: powerRankOf(player, "pierce"),
            hostile: false,
            color: "#d0a9ee",
            affinity: "echo",
            age: 0,
            maxLife: 1.05,
            previousX: player.x,
            previousY: player.y - 8,
            hit: new Set<number>(),
            homing:
              homingRank > 0 ? Math.min(10, 1.8 + homingRank * 0.55) : undefined,
          });
        }
      }
      player.shotCounter += 1;
      player.fireCooldown = 1 / visibleRate;
    };

    const completeRoom = () => {
      const world = worldRef.current;
      const player = playerRef.current;
      if (world.clearHandled) return;
      world.clearHandled = true;
      world.roomCleared = true;
      world.rooms[keyOf(world.roomX, world.roomY)].cleared = true;
      player.rooms += 1;
      const conquestRank = powerRankOf(player, "conquest");
      const moonBeacon = activeSynergies(player).find(
        (synergy) => synergy.name === "달빛 봉화",
      );
      const heal =
        (4 + powerRankOf(player, "map") * 2 + conquestRank * 1.2) *
        (1 + (moonBeacon?.tier ?? 0) * 0.08);
      player.hp = Math.min(player.maxHp, player.hp + heal);
      if (conquestRank > 0) {
        const shieldCap =
          10 +
          powerRankOf(player, "glass") * 9 +
          powerRankOf(player, "ward") * 5 +
          conquestRank * 4;
        player.shield = Math.min(
          shieldCap,
          player.shield +
            conquestRank * 1.8 * (1 + (moonBeacon?.tier ?? 0) * 0.08),
        );
      }
      gainXp(14 + player.rooms * 1.5);
      setToast(`방 정복 · 기억 ${Math.round(14 + player.rooms * 1.5)} · 문이 열렸습니다.`);

      if (world.roomKind === "boss") {
        player.endingSeen = true;
        pendingEndingRef.current = true;
        if (modeRef.current === "playing") {
          pendingEndingRef.current = false;
          setGameMode("ending");
        }
        return;
      }
      const beats: Record<number, [string, string, string]> = {
        3: [
          "1막 · 끝을 찾는 자",
          "다른 탐험가의 기억",
          "쓰러진 적에게서 흘러나온 증강은 이상할 만큼 하린의 손에 익숙했다. 마치 이미 수백 번 골라 본 것처럼.",
        ],
        6: [
          "2막 · 길을 먹는 자",
          "쉼터지기의 고백",
          "“그 기억들은 다른 사람 것이 아니야. 전부 여기서 길을 잃었던 너희들이지.” 지도는 하린이 강해질수록 더 빠르게 그녀를 배웠다.",
        ],
      };
      const beat = beats[player.rooms];
      if (beat) {
        pendingStoryRef.current = {
          eyebrow: beat[0],
          title: beat[1],
          body: beat[2],
        };
        if (modeRef.current === "playing") {
          pendingStoryRef.current = null;
          showStory(beat[0], beat[1], beat[2], () => setGameMode("playing"));
        }
      }
    };

    const update = (dt: number) => {
      if (modeRef.current !== "playing") return;
      const player = playerRef.current;
      const world = worldRef.current;
      world.transition = Math.max(0, world.transition - dt);
      for (const effect of world.effects) effect.life -= dt;
      world.effects = world.effects.filter((effect) => effect.life > 0);
      player.fireCooldown -= dt;
      player.invulnerable = Math.max(0, player.invulnerable - dt);
      player.dashCooldown = Math.max(0, player.dashCooldown - dt);
      player.dashTime = Math.max(0, player.dashTime - dt);
      const regenerationRank = powerRankOf(player, "regeneration");
      if (regenerationRank > 0 && player.hp > 0) {
        player.hp = Math.min(player.maxHp, player.hp + regenerationRank * 0.14 * dt);
      }
      const keys = keysRef.current;
      let moveX =
        (keys.has("d") || keys.has("arrowright") ? 1 : 0) -
        (keys.has("a") || keys.has("arrowleft") ? 1 : 0);
      let moveY =
        (keys.has("s") || keys.has("arrowdown") ? 1 : 0) -
        (keys.has("w") || keys.has("arrowup") ? 1 : 0);
      let rawMoveLength = Math.hypot(moveX, moveY);
      if (rawMoveLength === 0 && inputRef.current.hasMoveTarget) {
        const targetDx = inputRef.current.moveTargetX - player.x;
        const targetDy = inputRef.current.moveTargetY - player.y;
        const targetDistance = Math.hypot(targetDx, targetDy);
        if (targetDistance > 12) {
          moveX = targetDx / targetDistance;
          moveY = targetDy / targetDistance;
          rawMoveLength = 1;
        } else {
          inputRef.current.hasMoveTarget = false;
        }
      }
      const moveLength = rawMoveLength || 1;
      moveX /= moveLength;
      moveY /= moveLength;
      const boots = powerRankOf(player, "boots");
      const momentumRank = powerRankOf(player, "momentum");
      const reflexRank = powerRankOf(player, "reflex");
      const moveSpeed =
        245 *
        Math.pow(1 + boots * 0.07, 0.55) *
        Math.pow(1 + momentumRank * 0.065, 0.55);

      if (inputRef.current.dashQueued && player.dashCooldown <= 0) {
        inputRef.current.dashQueued = false;
        player.dashX = moveX || Math.cos(Math.atan2(inputRef.current.aimY - player.y, inputRef.current.aimX - player.x));
        player.dashY = moveY || Math.sin(Math.atan2(inputRef.current.aimY - player.y, inputRef.current.aimX - player.x));
        player.dashTime = 0.17 + 0.075 * (1 - Math.exp(-0.12 * reflexRank));
        player.invulnerable = player.dashTime + 0.03;
        player.dashCooldown =
          1.35 /
          (Math.pow(1 + boots * 0.08, 0.6) * Math.pow(1 + reflexRank * 0.11, 0.55));
        const voidRank = powerRankOf(player, "void");
        if (voidRank > 0) {
          const comet = activeSynergies(player).find(
            (synergy) => synergy.name === "혜성 자국",
          );
          for (const enemy of world.enemies) {
            if (distance(player.x, player.y, enemy.x, enemy.y) < 125) {
              enemy.hp -=
                (8 + voidRank * 5) * (1 + (comet?.tier ?? 0) * 0.28);
              if (comet) enemy.slow = Math.max(enemy.slow, 0.8);
            }
          }
        }
      } else {
        inputRef.current.dashQueued = false;
      }

      const speed =
        player.dashTime > 0
          ? 900 * Math.pow(1 + reflexRank * 0.05, 0.4)
          : moveSpeed;
      const dx = player.dashTime > 0 ? player.dashX : moveX;
      const dy = player.dashTime > 0 ? player.dashY : moveY;
      player.x += dx * speed * dt;
      player.y += dy * speed * dt;
      player.moving = player.dashTime > 0 || rawMoveLength > 0;
      if (player.moving) {
        player.facing = directionRow(dx, dy, player.facing);
        player.walkCycle =
          (player.walkCycle + dt * (player.dashTime > 0 ? 16 : 8.5)) % 4;
      } else {
        player.walkCycle = 1;
      }

      const doorOpen = world.roomCleared;
      const inHorizontalDoor =
        player.y > ROOM_GEOMETRY.horizontalDoorTop &&
        player.y < ROOM_GEOMETRY.horizontalDoorBottom;
      const inVerticalDoor =
        player.x > ROOM_GEOMETRY.verticalDoorLeft &&
        player.x < ROOM_GEOMETRY.verticalDoorRight;
      if (doorOpen && world.transition <= 0) {
        if (player.x < ROOM_GEOMETRY.transitionInsetX && inHorizontalDoor) {
          roomEnterRef.current(world.roomX - 1, world.roomY, "right");
          return;
        }
        if (player.x > WIDTH - ROOM_GEOMETRY.transitionInsetX && inHorizontalDoor) {
          roomEnterRef.current(world.roomX + 1, world.roomY, "left");
          return;
        }
        if (player.y < ROOM_GEOMETRY.transitionInsetY && inVerticalDoor) {
          roomEnterRef.current(world.roomX, world.roomY - 1, "top");
          return;
        }
        if (player.y > HEIGHT - ROOM_GEOMETRY.transitionInsetY && inVerticalDoor) {
          roomEnterRef.current(world.roomX, world.roomY + 1, "bottom");
          return;
        }
      }
      const minX = doorOpen && inHorizontalDoor ? ROOM_GEOMETRY.openInsetX : ROOM_GEOMETRY.left;
      const maxX = doorOpen && inHorizontalDoor ? WIDTH - ROOM_GEOMETRY.openInsetX : ROOM_GEOMETRY.right;
      const minY = doorOpen && inVerticalDoor ? ROOM_GEOMETRY.openInsetY : ROOM_GEOMETRY.top;
      const maxY = doorOpen && inVerticalDoor ? HEIGHT - ROOM_GEOMETRY.openInsetY : ROOM_GEOMETRY.bottom;
      player.x = clamp(player.x, minX, maxX);
      player.y = clamp(player.y, minY, maxY);

      if (player.fireCooldown <= 0) firePlayerWeapon();

      const now = performance.now();
      for (const enemy of world.enemies) {
        enemy.slow = Math.max(0, enemy.slow - dt);
        enemy.orbitalCooldown = Math.max(0, enemy.orbitalCooldown - dt);
        enemy.shootCooldown -= dt;
        if (enemy.poisonTime > 0) {
          enemy.poisonTime -= dt;
          enemy.hp -= enemy.poisonDamage * dt;
        }
        const angle = Math.atan2(player.y - enemy.y, player.x - enemy.x);
        const d = distance(player.x, player.y, enemy.x, enemy.y);
        let movement = 1;
        if (enemy.kind === 1 && d < 280) movement = -0.32;
        if (enemy.kind === 3) movement = 0.22;
        if (enemy.slow > 0) movement *= 0.58;
        const enemyMoveX = Math.cos(angle) * movement;
        const enemyMoveY = Math.sin(angle) * movement;
        enemy.x += enemyMoveX * enemy.speed * dt;
        enemy.y += enemyMoveY * enemy.speed * dt;
        enemy.moving = Math.abs(movement) > 0.01;
        if (enemy.moving) {
          enemy.facing = directionRow(enemyMoveX, enemyMoveY, enemy.facing);
          enemy.walkCycle =
            (enemy.walkCycle + dt * (5.4 + enemy.speed / 38) * Math.abs(movement)) % 4;
        }
        enemy.x = clamp(enemy.x, 82, WIDTH - 82);
        enemy.y = clamp(enemy.y, 78, HEIGHT - 78);

        if (enemy.kind === 1 && enemy.shootCooldown <= 0) {
          for (let i = -1; i <= 1; i += 1) {
            spawnHostileProjectile(enemy.x, enemy.y, angle + i * 0.13, 285, enemy.damage);
          }
          enemy.shootCooldown = 2.2;
        }
        if (enemy.kind === 3 && enemy.shootCooldown <= 0 && world.enemies.length < 28) {
          const summonX = enemy.x + Math.cos(angle + 1) * 58;
          const summonY = enemy.y + Math.sin(angle + 1) * 58;
          world.enemies.push(makeEnemy(0, summonX, summonY, player.rooms));
          spawnVisualEffect("summon", summonX, summonY + 8, 0.72, 154);
          enemy.shootCooldown = 4.6;
        }
        if (enemy.kind === 4 && enemy.shootCooldown <= 0) {
          spawnVisualEffect("teleport", enemy.x, enemy.y + 8, 0.58, 146);
          enemy.x = 120 + hash(world.seed, enemy.id, player.rooms, now | 0) * (WIDTH - 240);
          enemy.y = 110 + hash(world.seed, player.rooms, enemy.id, (now / 7) | 0) * (HEIGHT - 220);
          spawnVisualEffect("teleport", enemy.x, enemy.y + 8, 0.68, 162);
          const teleportAngle = Math.atan2(player.y - enemy.y, player.x - enemy.x);
          spawnHostileProjectile(enemy.x, enemy.y, teleportAngle, 350, enemy.damage, 9, "witch");
          enemy.shootCooldown = 3.4;
        }
        if (enemy.kind === 5 && enemy.shootCooldown <= 0) {
          const phase = enemy.hp / enemy.maxHp;
          const count = phase > 0.66 ? 8 : phase > 0.33 ? 12 : 16;
          for (let i = 0; i < count; i += 1) {
            spawnHostileProjectile(
              enemy.x,
              enemy.y,
              (Math.PI * 2 * i) / count + now / 1800,
              210 + (1 - phase) * 85,
              enemy.damage,
              7,
              "boss",
            );
          }
          enemy.shootCooldown = 1.75 - (1 - phase) * 0.6;
        }
        if (d < player.radius + enemy.radius * 0.72) damagePlayer(enemy.damage);
      }

      const orbitRank = powerRankOf(player, "orbit");
      const orbitCount = Math.min(8, orbitRank);
      if (orbitCount > 0) {
        for (const enemy of world.enemies) {
          if (enemy.orbitalCooldown > 0) continue;
          for (let i = 0; i < orbitCount; i += 1) {
            const angle = now / 620 + (Math.PI * 2 * i) / orbitCount;
            const ox = player.x + Math.cos(angle) * (62 + orbitRank * 2);
            const oy = player.y + Math.sin(angle) * (44 + orbitRank * 1.4);
            if (distance(ox, oy, enemy.x, enemy.y) < enemy.radius + 13) {
              enemy.hp -= 7 + orbitRank * 3;
              enemy.orbitalCooldown = 0.24;
              break;
            }
          }
        }
      }

      for (const projectile of world.projectiles) {
        projectile.life -= dt;
        projectile.age += dt;
        if (projectile.life <= 0) continue;
        if (
          !projectile.hostile &&
          !projectile.returning &&
          projectile.returnAfter !== undefined
        ) {
          projectile.returnAfter -= dt;
          if (projectile.returnAfter <= 0) {
            projectile.returning = true;
            const returnAngle = Math.atan2(
              player.y - projectile.y,
              player.x - projectile.x,
            );
            projectile.vx = Math.cos(returnAngle) * 720;
            projectile.vy = Math.sin(returnAngle) * 720;
            projectile.damage *= projectile.returnMultiplier ?? 1;
            projectile.life = Math.max(projectile.life, 0.72);
            projectile.hit.clear();
            spawnCombatEffect(
              "muzzle",
              projectile.x,
              projectile.y,
              0.22,
              projectile.radius * 4.5,
              "#d9b5ff",
              returnAngle,
            );
          }
        }
        if (!projectile.hostile && !projectile.returning && projectile.homing) {
          let homingTarget: Enemy | undefined;
          let homingDistance = Infinity;
          for (const enemy of world.enemies) {
            if (enemy.hp <= 0 || projectile.hit.has(enemy.id)) continue;
            const candidateDistance = distance(projectile.x, projectile.y, enemy.x, enemy.y);
            if (candidateDistance < homingDistance) {
              homingTarget = enemy;
              homingDistance = candidateDistance;
            }
          }
          if (homingTarget) {
            const speed = Math.hypot(projectile.vx, projectile.vy);
            const currentAngle = Math.atan2(projectile.vy, projectile.vx);
            const targetAngle = Math.atan2(
              homingTarget.y - projectile.y,
              homingTarget.x - projectile.x,
            );
            const angleDelta = Math.atan2(
              Math.sin(targetAngle - currentAngle),
              Math.cos(targetAngle - currentAngle),
            );
            const steeredAngle =
              currentAngle +
              clamp(angleDelta, -projectile.homing * dt, projectile.homing * dt);
            projectile.vx = Math.cos(steeredAngle) * speed;
            projectile.vy = Math.sin(steeredAngle) * speed;
          }
        }
        projectile.previousX = projectile.x;
        projectile.previousY = projectile.y;
        projectile.x += projectile.vx * dt;
        projectile.y += projectile.vy * dt;
        const hitRoomWall =
          projectile.x < ROOM_GEOMETRY.left ||
          projectile.x > ROOM_GEOMETRY.right ||
          projectile.y < ROOM_GEOMETRY.top ||
          projectile.y > ROOM_GEOMETRY.bottom;
        if (hitRoomWall) {
          projectile.life = 0;
          spawnCombatEffect(
            projectile.hostile ? "hostileImpact" : "playerImpact",
            clamp(projectile.x, ROOM_GEOMETRY.left, ROOM_GEOMETRY.right),
            clamp(projectile.y, ROOM_GEOMETRY.top, ROOM_GEOMETRY.bottom),
            0.22,
            projectile.radius * 4.4,
            projectile.color,
            Math.atan2(projectile.vy, projectile.vx),
          );
          continue;
        }
        if (projectile.hostile) {
          if (
            distanceToSegment(
              player.x,
              player.y,
              projectile.previousX,
              projectile.previousY,
              projectile.x,
              projectile.y,
            ) <
            projectile.radius + player.radius
          ) {
            projectile.life = 0;
            spawnCombatEffect(
              "hostileImpact",
              projectile.x,
              projectile.y,
              0.34,
              projectile.radius * 6,
              projectile.color,
              Math.atan2(projectile.vy, projectile.vx),
            );
            damagePlayer(projectile.damage);
          }
          continue;
        }
        for (const enemy of world.enemies) {
          if (enemy.hp <= 0 || projectile.hit.has(enemy.id)) continue;
          if (
            distanceToSegment(
              enemy.x,
              enemy.y,
              projectile.previousX,
              projectile.previousY,
              projectile.x,
              projectile.y,
            ) <
            projectile.radius + enemy.radius * 0.72
          ) {
            projectile.hit.add(enemy.id);
            let hitDamage = projectile.damage;
            const giantbaneRank = powerRankOf(player, "giantbane");
            if (enemy.elite || enemy.kind === 5) {
              hitDamage *= Math.pow(1 + giantbaneRank * 0.15, 0.65);
            }
            const executionRank = powerRankOf(player, "execution");
            const executionThreshold = Math.min(0.4, 0.12 + executionRank * 0.012);
            if (executionRank > 0 && enemy.hp / enemy.maxHp <= executionThreshold) {
              const finalSentence = activeSynergies(player).find(
                (synergy) => synergy.name === "마지막 문장",
              );
              hitDamage *=
                (1.28 + executionRank * 0.04) *
                (1 + (finalSentence?.tier ?? 0) * 0.12);
            }
            enemy.hp -= hitDamage;
            spawnCombatEffect(
              "playerImpact",
              projectile.x,
              projectile.y,
              0.26,
              projectile.radius * (projectile.pierce > 0 ? 4.4 : 6.2),
              projectile.color,
              Math.atan2(projectile.vy, projectile.vx),
            );
            const frost = powerRankOf(player, "frost");
            if (frost > 0) enemy.slow = 0.45 + frost * 0.08;
            const poison = powerRankOf(player, "poison");
            if (poison > 0) {
              enemy.poisonDamage = Math.max(enemy.poisonDamage, 2 + poison * 1.2);
              enemy.poisonTime = Math.max(enemy.poisonTime, 5);
            }
            const leechRank = powerRankOf(player, "leech");
            if (leechRank > 0 && player.hp < player.maxHp) {
              const bloodNeedle = activeSynergies(player).find(
                (synergy) => synergy.name === "혈침 순환",
              );
              const heal =
                Math.min(0.65, 0.1 + leechRank * 0.03) *
                (1 + (bloodNeedle?.tier ?? 0) * 0.08);
              player.hp = Math.min(player.maxHp, player.hp + heal);
            }
            const storm = powerRankOf(player, "storm");
            if (storm > 0 && Math.random() < 1 - Math.pow(0.8, storm)) {
              const next = world.enemies
                .filter((other) => other.id !== enemy.id && other.hp > 0)
                .sort(
                  (a, b) =>
                    distance(enemy.x, enemy.y, a.x, a.y) -
                    distance(enemy.x, enemy.y, b.x, b.y),
              )[0];
              if (next && distance(enemy.x, enemy.y, next.x, next.y) < 260) {
                const plagueStorm = activeSynergies(player).find(
                  (synergy) => synergy.name === "역병 폭풍",
                );
                next.hp -=
                  hitDamage *
                  0.55 *
                  (1 + (plagueStorm?.tier ?? 0) * 0.24);
                spawnCombatEffect(
                  "chainArc",
                  enemy.x,
                  enemy.y,
                  0.2,
                  9 + Math.min(12, storm * 1.5),
                  "#c5b0ff",
                  0,
                  next.x,
                  next.y,
                );
                if (plagueStorm && enemy.poisonTime > 0) {
                  next.poisonDamage = Math.max(
                    next.poisonDamage,
                    enemy.poisonDamage * 0.5,
                  );
                  next.poisonTime = Math.max(next.poisonTime, enemy.poisonTime * 0.5);
                }
              }
            }
            const ricochetRank = powerRankOf(player, "ricochet");
            if (ricochetRank > 0 && Math.random() < 1 - Math.pow(0.88, ricochetRank)) {
              const next = world.enemies
                .filter((other) => other.id !== enemy.id && other.hp > 0)
                .sort(
                  (a, b) =>
                    distance(enemy.x, enemy.y, a.x, a.y) -
                    distance(enemy.x, enemy.y, b.x, b.y),
                )[0];
              if (next && distance(enemy.x, enemy.y, next.x, next.y) < 230) {
                const boneEcho = activeSynergies(player).find(
                  (synergy) => synergy.name === "백골 메아리",
                );
                const echoDamage =
                  hitDamage *
                  Math.min(0.72, 0.22 + ricochetRank * 0.025) *
                  (1 + (boneEcho?.tier ?? 0) * 0.14);
                next.hp -= echoDamage;
                spawnCombatEffect(
                  "chainArc",
                  enemy.x,
                  enemy.y,
                  0.16,
                  7 + Math.min(10, ricochetRank),
                  "#e4d5b6",
                  0,
                  next.x,
                  next.y,
                );
              }
            }
            if (projectile.pierce <= 0) projectile.life = 0;
            else projectile.pierce -= 1;
            break;
          }
        }
      }
      world.projectiles = world.projectiles.filter(
        (projectile) =>
          projectile.life > 0 &&
          projectile.x > -80 &&
          projectile.x < WIDTH + 80 &&
          projectile.y > -80 &&
          projectile.y < HEIGHT + 80,
      );

      const dead = world.enemies.filter((enemy) => enemy.hp <= 0);
      for (const enemy of dead) killEnemy(enemy);
      world.enemies = world.enemies.filter((enemy) => enemy.hp > 0);

      const pickupRange = 38 + powerRankOf(player, "magnet") * 42;
      for (const orb of world.orbs) {
        const d = distance(orb.x, orb.y, player.x, player.y);
        if (d < pickupRange * 2.4) {
          const speed = 190 + Math.max(0, pickupRange * 2.4 - d) * 2.8;
          const angle = Math.atan2(player.y - orb.y, player.x - orb.x);
          orb.x += Math.cos(angle) * speed * dt;
          orb.y += Math.sin(angle) * speed * dt;
        }
        if (d < player.radius + 15) {
          orb.value *= -1;
          gainXp(Math.abs(orb.value));
        }
      }
      world.orbs = world.orbs.filter((orb) => orb.value > 0);
      if (!world.roomCleared && world.enemies.length === 0) completeRoom();
    };

    const drawSprite = (
      image: HTMLImageElement | undefined,
      cropIndex: number,
      x: number,
      y: number,
      width: number,
      height: number,
      alpha = 1,
    ) => {
      if (!image?.complete || !image.naturalWidth) return false;
      const crop = spriteCrops[cropIndex];
      context.save();
      context.globalAlpha = alpha;
      context.drawImage(
        image,
        crop[0],
        crop[1],
        crop[2],
        crop[3],
        x - width / 2,
        y - height * 0.78,
        width,
        height,
      );
      context.restore();
      return true;
    };

    const drawWalkSprite = (
      image: HTMLImageElement | undefined,
      facing: number,
      frameIndex: number,
      x: number,
      y: number,
      width: number,
      height: number,
      alpha = 1,
      flipX = false,
    ) => {
      if (!image?.complete || !image.naturalWidth || !image.naturalHeight) return false;
      const sourceWidth = image.naturalWidth / 4;
      const sourceHeight = image.naturalHeight / 8;
      const column = positiveModulo(Math.floor(frameIndex), 4);
      const row = clamp(Math.floor(facing), 0, 7);
      context.save();
      context.globalAlpha = alpha;
      context.imageSmoothingEnabled = true;
      if (flipX) {
        context.translate(x, 0);
        context.scale(-1, 1);
      }
      context.drawImage(
        image,
        column * sourceWidth,
        row * sourceHeight,
        sourceWidth,
        sourceHeight,
        flipX ? -width / 2 : x - width / 2,
        y - height * 0.78,
        width,
        height,
      );
      context.restore();
      return true;
    };

    const drawEffectSprite = (
      image: HTMLImageElement | undefined,
      effect: VisualEffect,
    ) => {
      if (!image?.complete || !image.naturalWidth || !image.naturalHeight) return false;
      const progress = clamp(1 - effect.life / effect.duration, 0, 0.999);
      const frameIndex = clamp(Math.floor(progress * 4), 0, 3);
      const sourceWidth = image.naturalWidth / 2;
      const sourceHeight = image.naturalHeight / 2;
      const column = frameIndex % 2;
      const row = Math.floor(frameIndex / 2);
      context.save();
      context.globalAlpha = clamp(effect.life / Math.min(0.18, effect.duration), 0, 1);
      context.imageSmoothingEnabled = true;
      context.drawImage(
        image,
        column * sourceWidth,
        row * sourceHeight,
        sourceWidth,
        sourceHeight,
        effect.x - effect.size / 2,
        effect.y - effect.size * 0.66,
        effect.size,
        effect.size,
      );
      context.restore();
      return true;
    };

    const drawCombatEffect = (effect: VisualEffect, clock: number) => {
      if (effect.kind === "summon" || effect.kind === "teleport") return false;
      const progress = clamp(1 - effect.life / effect.duration, 0, 1);
      const fade = Math.sin(progress * Math.PI);
      const color = effect.color ?? "#ffffff";
      context.save();
      context.globalCompositeOperation = "lighter";
      context.lineCap = "round";

      if (effect.kind === "chainArc" && effect.endX !== undefined && effect.endY !== undefined) {
        const segments = 7;
        const deltaX = effect.endX - effect.x;
        const deltaY = effect.endY - effect.y;
        const length = Math.max(1, Math.hypot(deltaX, deltaY));
        const normalX = -deltaY / length;
        const normalY = deltaX / length;
        const traceArc = (width: number, stroke: string, jitterScale: number) => {
          context.beginPath();
          context.moveTo(effect.x, effect.y);
          for (let index = 1; index < segments; index += 1) {
            const ratio = index / segments;
            const jitter =
              Math.sin(effect.id * 2.17 + index * 5.43 + clock * 38) * effect.size * jitterScale;
            context.lineTo(
              effect.x + deltaX * ratio + normalX * jitter,
              effect.y + deltaY * ratio + normalY * jitter,
            );
          }
          context.lineTo(effect.endX!, effect.endY!);
          context.lineWidth = width;
          context.strokeStyle = stroke;
          context.stroke();
        };
        context.globalAlpha = fade * 0.38;
        traceArc(effect.size * 0.75, colorWithAlpha(color, 0.72), 0.72);
        context.globalAlpha = fade;
        traceArc(Math.max(1.2, effect.size * 0.16), "rgba(245,242,255,.96)", 0.62);
        context.restore();
        return true;
      }

      context.translate(effect.x, effect.y);
      context.rotate(effect.angle ?? 0);
      const radius = effect.size * (0.28 + progress * 0.72);
      context.shadowColor = color;
      context.shadowBlur = Math.min(28, effect.size * 0.8);

      if (effect.kind === "muzzle") {
        context.globalAlpha = fade * 0.75;
        context.fillStyle = colorWithAlpha(color, 0.52);
        context.beginPath();
        context.moveTo(effect.size * (0.5 + progress * 0.35), 0);
        context.lineTo(-effect.size * 0.25, effect.size * 0.24 * (1 - progress * 0.5));
        context.lineTo(-effect.size * 0.08, 0);
        context.lineTo(-effect.size * 0.25, -effect.size * 0.24 * (1 - progress * 0.5));
        context.closePath();
        context.fill();
      }

      context.globalAlpha = fade * (effect.kind === "hostileImpact" ? 0.88 : 0.72);
      context.strokeStyle = color;
      context.lineWidth = Math.max(1.3, effect.size * 0.08 * (1 - progress));
      context.beginPath();
      context.arc(0, 0, radius, 0, Math.PI * 2);
      context.stroke();

      const rayCount = effect.kind === "hostileImpact" ? 9 : 7;
      context.fillStyle = effect.kind === "hostileImpact" ? "#ffd1c9" : "#f5ffff";
      context.globalAlpha = fade * 0.82;
      for (let ray = 0; ray < rayCount; ray += 1) {
        const rayAngle = (Math.PI * 2 * ray) / rayCount + effect.id * 0.37;
        const inner = effect.size * (0.12 + progress * 0.18);
        const outer = effect.size * (0.4 + progress * (0.48 + (ray % 3) * 0.08));
        context.save();
        context.rotate(rayAngle);
        context.beginPath();
        context.moveTo(inner, 0);
        context.lineTo(outer, effect.size * 0.035);
        context.lineTo(outer * 0.76, -effect.size * 0.035);
        context.closePath();
        context.fill();
        context.restore();
      }
      context.restore();
      return true;
    };

    const drawProjectileVfx = (
      projectile: Projectile,
      clock: number,
      projectileCount: number,
      layer: "trail" | "core",
    ) => {
      const speed = Math.max(1, Math.hypot(projectile.vx, projectile.vy));
      const angle = Math.atan2(projectile.vy, projectile.vx);
      const radius = projectile.radius;
      const fadeIn = clamp(projectile.age / 0.07, 0, 1);
      const fadeOut = clamp(projectile.life / 0.14, 0, 1);
      const alpha = fadeIn * fadeOut;
      const dense = projectileCount > 120;
      const overloaded = projectileCount > 220;
      const speedScale = clamp(speed / 660, 0.65, 1.18);
      const tailLength =
        (projectile.hostile ? 24 + radius * 2.2 : 36 + radius * 3.4) *
        (projectile.returning ? 1.22 : 1) *
        (dense ? 0.76 : 1) *
        speedScale;
      const pulse = 0.82 + Math.sin(clock * 12 + projectile.id * 1.71) * 0.18;

      context.save();
      context.translate(projectile.x, projectile.y);
      context.rotate(angle);
      context.lineCap = "round";

      if (layer === "trail") {
        context.globalCompositeOperation = "lighter";
        const trail = context.createLinearGradient(-tailLength, 0, radius, 0);
        trail.addColorStop(0, colorWithAlpha(projectile.color, 0));
        trail.addColorStop(0.46, colorWithAlpha(projectile.color, alpha * 0.18));
        trail.addColorStop(1, colorWithAlpha(projectile.color, alpha * 0.86));
        context.strokeStyle = trail;
        context.lineWidth = radius * (projectile.hostile ? 1.1 : 1.35);
        context.beginPath();
        context.moveTo(-tailLength, 0);
        context.lineTo(radius * 0.5, 0);
        context.stroke();

        if (projectile.affinity === "storm" && !overloaded) {
          context.strokeStyle = colorWithAlpha("#eee9ff", alpha * 0.76);
          context.lineWidth = 1.2;
          context.beginPath();
          context.moveTo(-tailLength * 0.82, 0);
          for (let segment = 1; segment <= 5; segment += 1) {
            const ratio = segment / 5;
            context.lineTo(
              -tailLength * (0.82 - ratio * 0.86),
              Math.sin(projectile.id * 2.3 + segment * 4.7 + clock * 31) * radius * 0.75,
            );
          }
          context.stroke();
        } else if (projectile.affinity === "ember" && !overloaded) {
          context.fillStyle = colorWithAlpha("#ffc06f", alpha * 0.72);
          for (let spark = 0; spark < 3; spark += 1) {
            const sparkX = -tailLength * (0.25 + spark * 0.22);
            const sparkY = Math.sin(projectile.id + spark * 2.8 + clock * 17) * radius * 1.3;
            context.beginPath();
            context.arc(sparkX, sparkY, Math.max(1, radius * (0.22 - spark * 0.035)), 0, Math.PI * 2);
            context.fill();
          }
        } else if (projectile.affinity === "poison" && !dense) {
          context.fillStyle = colorWithAlpha("#c8ff9a", alpha * 0.48);
          for (let bubble = 0; bubble < 2; bubble += 1) {
            context.beginPath();
            context.arc(
              -tailLength * (0.3 + bubble * 0.3),
              Math.sin(clock * 5 + projectile.id + bubble * 3) * radius * 1.5,
              radius * (0.28 + bubble * 0.12),
              0,
              Math.PI * 2,
            );
            context.fill();
          }
        }
        context.restore();
        return;
      }

      context.globalAlpha = alpha;
      if (projectile.hostile) {
        context.globalCompositeOperation = "source-over";
        context.fillStyle = "rgba(5,2,7,.9)";
        context.strokeStyle = projectile.color;
        context.lineWidth = Math.max(1.5, radius * 0.28);
        context.shadowColor = projectile.color;
        context.shadowBlur = overloaded ? 7 : 15;
        context.beginPath();
        context.arc(0, 0, radius * 1.45, 0, Math.PI * 2);
        context.fill();
        context.stroke();

        context.globalCompositeOperation = "lighter";
        context.fillStyle = projectile.affinity === "boss" ? "#ffe2a3" : "#fff0ed";
        context.beginPath();
        context.arc(radius * 0.16, 0, radius * 0.54 * pulse, 0, Math.PI * 2);
        context.fill();

        if (!dense && (projectile.affinity === "witch" || projectile.affinity === "boss")) {
          const satellites = projectile.affinity === "boss" ? 4 : 3;
          context.strokeStyle = projectile.affinity === "boss" ? "#d8b56a" : "#e29aff";
          context.lineWidth = 1.2;
          context.beginPath();
          context.arc(0, 0, radius * 2.15, 0, Math.PI * 2);
          context.stroke();
          context.fillStyle = context.strokeStyle;
          for (let index = 0; index < satellites; index += 1) {
            const orbitAngle = clock * (projectile.affinity === "boss" ? -3 : 5) +
              (Math.PI * 2 * index) / satellites + projectile.id;
            context.beginPath();
            context.arc(
              Math.cos(orbitAngle) * radius * 2.15,
              Math.sin(orbitAngle) * radius * 2.15,
              Math.max(1.2, radius * 0.22),
              0,
              Math.PI * 2,
            );
            context.fill();
          }
        }
      } else {
        context.globalCompositeOperation = "lighter";
        context.shadowColor = projectile.color;
        context.shadowBlur = overloaded ? 8 : 18;
        context.fillStyle = projectile.color;
        context.beginPath();
        if (projectile.affinity === "poison") {
          context.arc(0, 0, radius * 1.08 * pulse, 0, Math.PI * 2);
        } else if (projectile.affinity === "ember") {
          context.moveTo(radius * 2.1, 0);
          context.quadraticCurveTo(-radius * 0.3, radius * 1.22, -radius * 1.45, 0);
          context.quadraticCurveTo(-radius * 0.28, -radius * 1.22, radius * 2.1, 0);
        } else {
          context.moveTo(radius * 2, 0);
          context.lineTo(-radius * 0.55, radius * 1.05);
          context.lineTo(-radius * 1.45, 0);
          context.lineTo(-radius * 0.55, -radius * 1.05);
          context.closePath();
        }
        context.fill();
        context.fillStyle = "rgba(244,255,255,.96)";
        context.beginPath();
        context.arc(radius * 0.42, 0, Math.max(1.4, radius * 0.42), 0, Math.PI * 2);
        context.fill();

        if (projectile.affinity === "frost" && !dense) {
          context.strokeStyle = "rgba(224,251,255,.82)";
          context.lineWidth = 1.2;
          for (let shard = -1; shard <= 1; shard += 2) {
            context.beginPath();
            context.moveTo(-radius * 0.3, shard * radius * 0.5);
            context.lineTo(-radius * 1.5, shard * radius * 1.45);
            context.stroke();
          }
        }
        if (projectile.affinity === "echo" || projectile.returning) {
          context.strokeStyle = colorWithAlpha("#e2c7ff", 0.72 * alpha);
          context.lineWidth = 1.4;
          context.beginPath();
          context.arc(-radius * 0.6, 0, radius * 1.7 * pulse, 0, Math.PI * 2);
          context.stroke();
        }
      }
      context.restore();
    };

    const draw = () => {
      const player = playerRef.current;
      const world = worldRef.current;
      const images = imagesRef.current;
      context.clearRect(0, 0, WIDTH, HEIGHT);
      context.fillStyle = "#0a0b0d";
      context.fillRect(0, 0, WIDTH, HEIGHT);

      const roomArt = images[ROOM_ART_KEYS[world.roomKind]];
      const roomGrade = ROOM_COLOR_GRADE[world.roomKind];
      if (roomArt?.complete && roomArt.naturalWidth && roomArt.naturalHeight) {
        const mirrorRoom =
          !["shelter", "boss"].includes(world.roomKind) &&
          hash(world.seed, world.roomX, world.roomY, 9041) > 0.5;
        context.save();
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = "high";
        if (mirrorRoom) {
          context.translate(WIDTH, 0);
          context.scale(-1, 1);
        }
        context.drawImage(roomArt, 0, 0, WIDTH, HEIGHT);
        context.restore();
      } else {
        const fallback = context.createRadialGradient(
          WIDTH / 2,
          HEIGHT / 2,
          90,
          WIDTH / 2,
          HEIGHT / 2,
          720,
        );
        fallback.addColorStop(0, roomGrade.tint);
        fallback.addColorStop(1, "#06080b");
        context.globalAlpha = 0.36;
        context.fillStyle = fallback;
        context.fillRect(0, 0, WIDTH, HEIGHT);
        context.globalAlpha = 1;
      }

      context.save();
      context.globalCompositeOperation = "soft-light";
      context.globalAlpha = world.roomKind === "shelter" ? 0.12 : 0.07;
      context.fillStyle = roomGrade.tint;
      context.fillRect(0, 0, WIDTH, HEIGHT);
      context.restore();

      const vignette = context.createRadialGradient(
        WIDTH / 2,
        HEIGHT / 2,
        180,
        WIDTH / 2,
        HEIGHT / 2,
        735,
      );
      vignette.addColorStop(0, "rgba(0,0,0,0)");
      vignette.addColorStop(0.68, "rgba(0,0,0,.04)");
      vignette.addColorStop(1, "rgba(0,0,0,.54)");
      context.fillStyle = vignette;
      context.fillRect(0, 0, WIDTH, HEIGHT);

      const ambientTime = performance.now() / 1000;
      context.save();
      context.fillStyle = roomGrade.mote;
      for (let index = 0; index < 18; index += 1) {
        const baseX = hash(world.seed, world.roomX, world.roomY, 1200 + index) * WIDTH;
        const baseY = hash(world.seed, world.roomX, world.roomY, 2200 + index) * HEIGHT;
        const drift = ambientTime * (5 + hash(world.seed, index, world.roomX, 3200) * 7);
        const x = positiveModulo(baseX + Math.sin(ambientTime * 0.43 + index) * 10, WIDTH);
        const y = positiveModulo(baseY - drift, HEIGHT);
        const edgeWeight = clamp(Math.abs(x - WIDTH / 2) / (WIDTH / 2), 0.18, 1);
        context.globalAlpha = (0.04 + 0.12 * Math.sin(ambientTime * 0.8 + index) ** 2) * edgeWeight;
        context.beginPath();
        context.arc(x, y, 0.8 + (index % 3) * 0.55, 0, Math.PI * 2);
        context.fill();
      }
      context.restore();

      type DoorSide = "west" | "east" | "north" | "south";
      const doorRects: Array<{ side: DoorSide; x: number; y: number; w: number; h: number }> = [
        {
          side: "west",
          x: ROOM_GEOMETRY.openInsetX,
          y: ROOM_GEOMETRY.horizontalDoorTop,
          w: ROOM_GEOMETRY.left - ROOM_GEOMETRY.openInsetX + 10,
          h: ROOM_GEOMETRY.horizontalDoorBottom - ROOM_GEOMETRY.horizontalDoorTop,
        },
        {
          side: "east",
          x: ROOM_GEOMETRY.right - 10,
          y: ROOM_GEOMETRY.horizontalDoorTop,
          w: ROOM_GEOMETRY.left - ROOM_GEOMETRY.openInsetX + 10,
          h: ROOM_GEOMETRY.horizontalDoorBottom - ROOM_GEOMETRY.horizontalDoorTop,
        },
        {
          side: "north",
          x: ROOM_GEOMETRY.verticalDoorLeft,
          y: ROOM_GEOMETRY.openInsetY,
          w: ROOM_GEOMETRY.verticalDoorRight - ROOM_GEOMETRY.verticalDoorLeft,
          h: ROOM_GEOMETRY.top - ROOM_GEOMETRY.openInsetY + 10,
        },
        {
          side: "south",
          x: ROOM_GEOMETRY.verticalDoorLeft,
          y: ROOM_GEOMETRY.bottom - 10,
          w: ROOM_GEOMETRY.verticalDoorRight - ROOM_GEOMETRY.verticalDoorLeft,
          h: ROOM_GEOMETRY.top - ROOM_GEOMETRY.openInsetY + 10,
        },
      ];

      const traceDiamond = (x: number, y: number, size: number) => {
        context.beginPath();
        context.moveTo(x, y - size);
        context.lineTo(x + size, y);
        context.lineTo(x, y + size);
        context.lineTo(x - size, y);
        context.closePath();
      };

      const drawDoorWard = ({ side, x, y, w, h }: (typeof doorRects)[number]) => {
        const horizontal = side === "west" || side === "east";
        const pulse = 0.72 + Math.sin(ambientTime * 3.2 + x * 0.01 + y * 0.01) * 0.16;
        context.save();
        if (!world.roomCleared) {
          const sealShade = horizontal
            ? context.createLinearGradient(x, y, x + w, y)
            : context.createLinearGradient(x, y, x, y + h);
          sealShade.addColorStop(0, "rgba(20,4,8,.12)");
          sealShade.addColorStop(0.5, "rgba(95,12,20,.34)");
          sealShade.addColorStop(1, "rgba(20,4,8,.12)");
          context.fillStyle = sealShade;
          context.fillRect(x, y, w, h);
          context.globalCompositeOperation = "screen";
          context.strokeStyle = roomGrade.locked;
          context.fillStyle = roomGrade.locked;
          context.shadowColor = roomGrade.locked;
          context.shadowBlur = 14;
          context.globalAlpha = pulse;
          context.lineWidth = 1.7;
          for (let rune = 0; rune < 3; rune += 1) {
            const offset = 0.24 + rune * 0.26;
            context.beginPath();
            if (horizontal) {
              const lineX = x + w * offset;
              context.moveTo(lineX, y + 10);
              context.quadraticCurveTo(lineX + (rune - 1) * 5, y + h / 2, lineX, y + h - 10);
            } else {
              const lineY = y + h * offset;
              context.moveTo(x + 12, lineY);
              context.quadraticCurveTo(x + w / 2, lineY + (rune - 1) * 5, x + w - 12, lineY);
            }
            context.stroke();
          }
          traceDiamond(x + w / 2, y + h / 2, 7 + pulse * 2);
          context.fill();
          context.globalAlpha = pulse * 0.55;
          traceDiamond(x + w / 2, y + h / 2, 15);
          context.stroke();
        } else {
          const thresholdX = side === "west" ? x + w - 3 : x + 3;
          const thresholdY = side === "north" ? y + h - 3 : y + 3;
          context.globalCompositeOperation = "screen";
          context.strokeStyle = roomGrade.open;
          context.fillStyle = roomGrade.open;
          context.shadowColor = roomGrade.open;
          context.shadowBlur = 12;
          context.globalAlpha = 0.34 + pulse * 0.32;
          context.lineWidth = 2;
          context.beginPath();
          if (horizontal) {
            context.moveTo(thresholdX, y + 15);
            context.lineTo(thresholdX, y + h - 15);
          } else {
            context.moveTo(x + 16, thresholdY);
            context.lineTo(x + w - 16, thresholdY);
          }
          context.stroke();
          for (let mote = 0; mote < 3; mote += 1) {
            const travel = positiveModulo(ambientTime * 28 + mote * 18, 48);
            const moteX =
              side === "west"
                ? thresholdX - travel
                : side === "east"
                  ? thresholdX + travel
                  : x + w / 2 + Math.sin(ambientTime * 2 + mote) * 11;
            const moteY =
              side === "north"
                ? thresholdY - travel
                : side === "south"
                  ? thresholdY + travel
                  : y + h / 2 + Math.sin(ambientTime * 1.7 + mote) * 14;
            context.globalAlpha = (1 - travel / 48) * 0.58;
            traceDiamond(moteX, moteY, 2.8);
            context.fill();
          }
        }
        context.restore();
      };

      doorRects.forEach(drawDoorWard);

      if (inputRef.current.hasMoveTarget) {
        const pulse = 12 + Math.sin(performance.now() / 140) * 3;
        context.beginPath();
        context.strokeStyle = "rgba(113,212,193,.72)";
        context.lineWidth = 2;
        context.arc(
          inputRef.current.moveTargetX,
          inputRef.current.moveTargetY,
          pulse,
          0,
          Math.PI * 2,
        );
        context.stroke();
        context.beginPath();
        context.fillStyle = "rgba(113,212,193,.7)";
        context.arc(
          inputRef.current.moveTargetX,
          inputRef.current.moveTargetY,
          3,
          0,
          Math.PI * 2,
        );
        context.fill();
      }

      for (const orb of world.orbs) {
        const pickupPulse = 0.82 + Math.sin(ambientTime * 4.2 + orb.id * 0.73) * 0.18;
        context.beginPath();
        context.fillStyle = `rgba(92,224,196,${0.1 + pickupPulse * 0.1})`;
        context.arc(orb.x, orb.y + 3, 13 + pickupPulse * 5, 0, Math.PI * 2);
        context.fill();
        const memoryFragments = images.memoryFragments;
        if (memoryFragments?.complete && memoryFragments.naturalWidth && memoryFragments.naturalHeight) {
          const rare = orb.value >= 45;
          const valuable = orb.value >= 18;
          const variant = rare ? 3 : valuable ? 2 : positiveModulo(orb.id, 2);
          const sourceWidth = memoryFragments.naturalWidth / 2;
          const sourceHeight = memoryFragments.naturalHeight / 2;
          const drawSize = rare ? 58 : valuable ? 49 : 39;
          const bob = Math.sin(ambientTime * 3.1 + orb.id) * 3;
          context.save();
          context.translate(orb.x, orb.y + bob);
          context.rotate(Math.sin(ambientTime * 1.2 + orb.id * 0.5) * 0.06);
          context.shadowColor = rare ? "#e5c675" : "#71e4d3";
          context.shadowBlur = rare ? 22 : 14;
          context.drawImage(
            memoryFragments,
            (variant % 2) * sourceWidth,
            Math.floor(variant / 2) * sourceHeight,
            sourceWidth,
            sourceHeight,
            -drawSize / 2,
            -drawSize * 0.58,
            drawSize,
            drawSize,
          );
          context.restore();
        } else {
          context.beginPath();
          context.fillStyle = "#78e3cd";
          context.arc(orb.x, orb.y, 5, 0, Math.PI * 2);
          context.fill();
        }
      }

      for (const effect of world.effects) {
        if (effect.kind === "summon" || effect.kind === "teleport") {
          drawEffectSprite(
            effect.kind === "summon" ? images.summonEffect : images.teleportEffect,
            effect,
          );
        }
      }

      for (const projectile of world.projectiles) {
        drawProjectileVfx(projectile, ambientTime, world.projectiles.length, "trail");
      }

      const sortedEnemies = [...world.enemies].sort((a, b) => a.y - b.y);
      for (const enemy of sortedEnemies) {
        context.beginPath();
        context.fillStyle = "rgba(0,0,0,.52)";
        context.ellipse(enemy.x, enemy.y + enemy.radius * 0.7, enemy.radius, enemy.radius * 0.42, 0, 0, Math.PI * 2);
        context.fill();
        const size = enemy.kind === 5 ? 185 : 72 + enemy.radius;
        const spriteAlpha = enemy.slow > 0 ? 0.78 : 1;
        const walkWidth = enemy.kind === 5 ? 250 : size * 1.2;
        const walkHeight = enemy.kind === 5 ? 225 : size * 1.25;
        const directionFrame =
          ENEMY_DIRECTION_FRAMES[enemy.kind][enemy.facing] ??
          ({ row: enemy.facing, flipX: false } satisfies DirectionFrame);
        const drawn =
          drawWalkSprite(
            images[WALK_IMAGE_KEYS[enemy.kind]],
            directionFrame.row,
            enemy.moving ? enemy.walkCycle : 1,
            enemy.x,
            enemy.y + 12,
            walkWidth,
            walkHeight,
            spriteAlpha,
            directionFrame.flipX,
          ) ||
          drawSprite(
            images.sprites,
            enemy.kind + 1,
            enemy.x,
            enemy.y + 12,
            enemy.kind === 5 ? 205 : size,
            enemy.kind === 5 ? 190 : size * 1.12,
            spriteAlpha,
          );
        if (!drawn) {
          context.beginPath();
          context.fillStyle = enemy.kind === 5 ? "#812f36" : enemy.elite ? "#b55a3e" : "#746554";
          context.arc(enemy.x, enemy.y, enemy.radius, 0, Math.PI * 2);
          context.fill();
        }
        const barWidth = enemy.kind === 5 ? 180 : enemy.radius * 2;
        context.fillStyle = "rgba(0,0,0,.75)";
        context.fillRect(enemy.x - barWidth / 2, enemy.y - enemy.radius - 38, barWidth, 6);
        context.fillStyle = enemy.kind === 5 ? "#d14f55" : "#b96649";
        context.fillRect(
          enemy.x - barWidth / 2,
          enemy.y - enemy.radius - 38,
          barWidth * clamp(enemy.hp / enemy.maxHp, 0, 1),
          6,
        );
        if (enemy.elite || enemy.kind === 5) {
          context.font = enemy.kind === 5 ? "700 15px serif" : "600 11px sans-serif";
          context.textAlign = "center";
          context.fillStyle = "#e8dfc8";
          context.fillText(ENEMY_NAMES[enemy.kind], enemy.x, enemy.y - enemy.radius - 46);
        }
      }

      for (const projectile of world.projectiles) {
        drawProjectileVfx(projectile, ambientTime, world.projectiles.length, "core");
      }
      for (const effect of world.effects) {
        drawCombatEffect(effect, ambientTime);
      }

      const orbitPower = powerRankOf(player, "orbit");
      const orbitCount = Math.min(8, orbitPower);
      for (let i = 0; i < orbitCount; i += 1) {
        const angle = performance.now() / 620 + (Math.PI * 2 * i) / orbitCount;
        const ox = player.x + Math.cos(angle) * (62 + orbitPower * 2);
        const oy = player.y + Math.sin(angle) * (44 + orbitPower * 1.4);
        context.save();
        context.translate(ox, oy);
        context.rotate(angle + Math.PI / 2);
        context.fillStyle = "#d8d4c9";
        context.shadowColor = "#8fc7da";
        context.shadowBlur = 10;
        context.beginPath();
        context.moveTo(0, -16);
        context.lineTo(7, 10);
        context.lineTo(0, 6);
        context.lineTo(-7, 10);
        context.closePath();
        context.fill();
        context.restore();
      }

      context.beginPath();
      context.fillStyle = "rgba(0,0,0,.55)";
      context.ellipse(player.x, player.y + 18, 28, 12, 0, 0, Math.PI * 2);
      context.fill();
      const playerAlpha =
        player.invulnerable > 0 && Math.floor(performance.now() / 70) % 2 ? 0.35 : 1;
      const playerDrawn =
        drawWalkSprite(
          images.walkHarin,
          HARIN_V2_DIRECTION_ROWS[player.facing] ?? player.facing,
          player.moving ? player.walkCycle : 1,
          player.x,
          player.y + 8,
          118,
          128,
          playerAlpha,
        ) ||
        drawWalkSprite(
          images.walkHarinLegacy,
          player.facing,
          player.moving ? player.walkCycle : 1,
          player.x,
          player.y + 8,
          118,
          128,
          playerAlpha,
        ) ||
        drawSprite(
          images.sprites,
          0,
          player.x,
          player.y + 8,
          86,
          112,
          playerAlpha,
        );
      if (!playerDrawn) {
        context.beginPath();
        context.fillStyle = player.invulnerable > 0 ? "#f0cf88" : "#9a4038";
        context.arc(player.x, player.y, player.radius, 0, Math.PI * 2);
        context.fill();
      }
      if (player.shield > 0) {
        context.beginPath();
        context.strokeStyle = "rgba(116,220,203,.8)";
        context.lineWidth = 2;
        context.arc(player.x, player.y, 34, 0, Math.PI * 2);
        context.stroke();
      }

      if (!world.roomCleared && world.enemies.length) {
        context.font = "700 12px sans-serif";
        context.textAlign = "center";
        context.fillStyle = "rgba(232,223,200,.68)";
        context.fillText(`${world.enemies.length}개의 기억이 문을 붙들고 있다`, WIDTH / 2, HEIGHT - 22);
      }

      if (world.transition > 0) {
        const transitionOpacity = clamp(world.transition / 0.55, 0, 1);
        context.fillStyle = `rgba(2,3,5,${transitionOpacity})`;
        context.fillRect(0, 0, WIDTH, HEIGHT);
      }
    };

    const loop = (now: number) => {
      const dt = Math.min(0.034, (now - last) / 1000);
      last = now;
      update(dt);
      draw();
      if (now - lastHudUpdateRef.current > 110) {
        lastHudUpdateRef.current = now;
        syncHud();
      }
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [
    gainXp,
    makeEnemy,
    setGameMode,
    showStory,
    started,
    syncHud,
  ]);

  const handleAim = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    inputRef.current.aimX = ((event.clientX - rect.left) / rect.width) * WIDTH;
    inputRef.current.aimY = ((event.clientY - rect.top) / rect.height) * HEIGHT;
    inputRef.current.lastAim = performance.now();
  };

  const handleMoveTarget = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    handleAim(event);
    if (modeRef.current !== "playing") return;
    const rect = event.currentTarget.getBoundingClientRect();
    inputRef.current.moveTargetX = ((event.clientX - rect.left) / rect.width) * WIDTH;
    inputRef.current.moveTargetY = ((event.clientY - rect.top) / rect.height) * HEIGHT;
    inputRef.current.hasMoveTarget = true;
  };

  const pressControl = (key: string, active: boolean) => {
    if (active) keysRef.current.add(key);
    else keysRef.current.delete(key);
  };

  const ownedAugments = useMemo(
    () =>
      AUGMENTS.filter((augment) => (hud.player.augments[augment.id] ?? 0) > 0).sort(
        (a, b) =>
          (hud.player.augments[b.id] ?? 0) - (hud.player.augments[a.id] ?? 0),
      ),
    [hud.player.augments],
  );
  const synergies = useMemo(() => activeSynergies(hud.player), [hud.player]);
  const currentProfession = useMemo(
    () => AUGMENTS.find((augment) => augment.id === hud.player.profession) ?? null,
    [hud.player.profession],
  );
  const buildMetrics = useMemo(() => {
    const damageMultiplier =
      (1 + powerRankOf(hud.player, "fang") * 0.18) *
      (1 + powerRankOf(hud.player, "blood") * 0.14) *
      (1 + powerRankOf(hud.player, "ember") * 0.08) *
      (1 + powerRankOf(hud.player, "focus") * 0.025) *
      (1 + powerRankOf(hud.player, "caliber") * 0.045) *
      (1 + synergies.reduce((sum, synergy) => sum + synergy.tier * 0.06, 0));
    const missingHealthRatio = 1 - hud.player.hp / hud.player.maxHp;
    const fireRate =
      1.4 *
      Math.pow(1 + powerRankOf(hud.player, "haste") * 0.14, 0.7) *
      Math.pow(
        1 + powerRankOf(hud.player, "frenzy") * missingHealthRatio * 0.12,
        0.65,
      );
    return [
      { label: "피해 계수", value: `×${damageMultiplier.toFixed(2)}` },
      {
        label: "발사 속도",
        value: `${fireRate.toFixed(1)}/초`,
      },
      { label: "투사체", value: `${1 + powerRankOf(hud.player, "split")}발` },
      {
        label: "치명타",
        value: `${Math.round((0.05 + 0.45 * (1 - Math.exp(-0.18 * powerRankOf(hud.player, "eye")))) * 100)}%`,
      },
    ];
  }, [hud.player, synergies]);
  const nearestLandmark = useMemo(() => {
    const landmarks = Object.entries(hud.world.rooms)
      .filter(([, room]) => room.kind === "shelter" || room.kind === "boss")
      .map(([key, room]) => {
        const [x, y] = key.split(",").map(Number);
        return {
          key,
          room,
          distance: Math.abs(x - hud.world.roomX) + Math.abs(y - hud.world.roomY),
        };
      })
      .filter((item) => item.distance > 0)
      .sort((a, b) => a.distance - b.distance);
    return landmarks[0] ?? null;
  }, [hud.world.roomX, hud.world.roomY, hud.world.rooms]);
  const mapNearestLandmark = useMemo(() => {
    const landmarks = Object.entries(mapSnapshot.rooms)
      .filter(([, room]) => room.kind === "shelter" || room.kind === "boss")
      .map(([key, room]) => {
        const [x, y] = key.split(",").map(Number);
        return {
          key,
          room,
          distance: Math.abs(x - mapSnapshot.roomX) + Math.abs(y - mapSnapshot.roomY),
        };
      })
      .filter((item) => item.distance > 0)
      .sort((a, b) => a.distance - b.distance);
    return landmarks[0] ?? null;
  }, [mapSnapshot]);
  const mapCounts = useMemo(
    () => ({
      known: Object.keys(mapSnapshot.rooms).length,
      visited: new Set(mapSnapshot.visited).size,
      cleared: Object.values(mapSnapshot.rooms).filter((room) => room.cleared).length,
    }),
    [mapSnapshot],
  );

  if (!started) {
    return (
      <main className="menu-screen">
        <div className="menu-backdrop" />
        <div className="menu-grain" />
        <section className="menu-copy">
          <p className="menu-kicker">ENDLESS AUGMENT ROGUELIKE</p>
          <h1>
            <span>무진도</span>
            <small>마지막 쉼표</small>
          </h1>
          <p className="menu-lead">
            죽었던 나의 기억을 증강으로 흡수하라.
            <br />
            지도는 끝이 없고, 빌드에는 상한이 없다.
          </p>
          <div className="save-slot-heading">
            <strong>원정 기록</strong>
            <small>쉼터에서 선택한 슬롯에 자동 저장됩니다.</small>
          </div>
          <div className="save-slot-grid" aria-label="저장 파일 슬롯">
            {SAVE_SLOT_IDS.map((slot, index) => {
              const summary = saveSlots[index];
              const professionTitle = summary?.profession
                ? PROFESSION_TITLES[summary.profession]
                : null;
              return (
                <article
                  key={slot}
                  className={`save-slot-card ${summary ? "is-occupied" : "is-empty"}`}
                  data-save-slot={slot}
                  data-save-state={summary ? "occupied" : "empty"}
                >
                  <header>
                    <small>SLOT 0{slot}</small>
                    <span>{summary ? formatSavedAt(summary.savedAt) : "EMPTY"}</span>
                  </header>
                  {summary ? (
                    <>
                      <h3>LV.{summary.level} · {summary.roomsCleared}방</h3>
                      <p>{professionTitle ?? "미전직 방랑자"}</p>
                      <dl>
                        <div><dt>증강</dt><dd>{summary.augmentStacks}</dd></div>
                        <div><dt>직업</dt><dd>{professionTitle ? "전직" : "대기"}</dd></div>
                      </dl>
                      <div className="save-slot-actions">
                        <button className="slot-continue" onClick={() => loadSave(slot)}>
                          계속
                        </button>
                        <button
                          onClick={() => {
                            if (window.confirm(`${slot}번 슬롯을 새 원정으로 덮어쓸까요?`)) {
                              startNewRun(slot);
                            }
                          }}
                        >
                          새 원정
                        </button>
                        <button
                          className="slot-delete"
                          aria-label={`${slot}번 저장 삭제`}
                          onClick={() => deleteSaveSlot(slot)}
                        >
                          ×
                        </button>
                      </div>
                    </>
                  ) : (
                    <button className="empty-slot-button" onClick={() => startNewRun(slot)}>
                      <span>새 원정</span>
                      <small>이 슬롯에서 시작</small>
                    </button>
                  )}
                </article>
              );
            })}
          </div>
        </section>
        <aside className="menu-features" aria-label="게임 특징">
          <span>∞ 무한 중첩 증강</span>
          <span>⌘ 좌표 기반 무한 방</span>
          <span>✦ 쉼터 자동 저장</span>
          <span>☄ 조합 시너지 진화</span>
        </aside>
        <p className="menu-controls">WASD / 방향키 또는 바닥 클릭 이동 · 자동 공격 · SPACE 회피 · M 지도 · B 빌드</p>
      </main>
    );
  }

  return (
    <main
      className={`game-screen ${hud.player.hp / hud.player.maxHp < 0.3 ? "is-low-health" : ""}`}
      data-game-mode={mode}
      data-room-x={hud.world.roomX}
      data-room-y={hud.world.roomY}
      data-room-kind={hud.world.roomKind}
      data-room-art={ROOM_ART_KEYS[hud.world.roomKind]}
      data-room-cleared={hud.world.roomCleared}
      data-known-rooms={hud.world.knownRoomCount}
      data-visited-rooms={hud.world.visitedCount}
      data-cleared-rooms={hud.world.clearedRoomCount}
      data-facing={DIRECTION_NAMES[hud.player.facing] ?? "남"}
      data-harin-sprite-row={HARIN_V2_DIRECTION_ROWS[hud.player.facing] ?? hud.player.facing}
      data-player-x={Math.round(hud.player.x)}
      data-player-y={Math.round(hud.player.y)}
      data-player-moving={hud.player.moving}
      data-walk-frame={positiveModulo(Math.floor(hud.player.walkCycle), 4)}
      data-active-save-slot={activeSaveSlot}
      data-profession={hud.player.profession ?? "none"}
      data-active-effects={hud.world.activeEffects}
      data-player-projectiles={hud.world.playerProjectiles}
      data-hostile-projectiles={hud.world.hostileProjectiles}
      data-combat-effects={hud.world.combatEffects}
      data-summon-effects={hud.world.summonEffects}
      data-teleport-effects={hud.world.teleportEffects}
    >
      <canvas
        ref={canvasRef}
        width={WIDTH}
        height={HEIGHT}
        className="game-canvas"
        onPointerMove={handleAim}
        onPointerDown={handleMoveTarget}
        aria-label="무진도 전투 화면"
      />

      <header className="top-hud">
        <section className="vitals hud-panel">
          <div className="portrait">
            <span>하린</span>
          </div>
          <div className="bars">
            <div className="bar health-bar">
              <i
                style={{
                  width: `${clamp((hud.player.hp / hud.player.maxHp) * 100, 0, 100)}%`,
                }}
              />
              <span>
                {Math.ceil(hud.player.hp)} / {Math.ceil(hud.player.maxHp)}
                {hud.player.shield > 0 ? ` +${Math.ceil(hud.player.shield)}` : ""}
              </span>
            </div>
            <div className="bar xp-bar">
              <i
                style={{
                  width: `${clamp((hud.player.xp / hud.player.nextXp) * 100, 0, 100)}%`,
                }}
              />
              <span>
                기억 {Math.floor(hud.player.xp)} / {hud.player.nextXp}
              </span>
            </div>
          </div>
          <strong>LV.{hud.player.level}</strong>
        </section>

        <section className="room-heading">
          <small>
            좌표 {hud.world.roomX >= 0 ? "+" : ""}
            {hud.world.roomX} : {hud.world.roomY >= 0 ? "+" : ""}
            {hud.world.roomY}
          </small>
          <h2>{ROOM_NAMES[hud.world.roomKind]}</h2>
          <span className={hud.world.roomCleared ? "is-clear" : "is-locked"}>
            {hud.world.roomCleared ? "탐색 가능 · 네 방향 개방" : `봉쇄 중 · 남은 기억 ${hud.world.enemies}`}
          </span>
        </section>

        <button
          type="button"
          className="minimap hud-panel"
          aria-label="전체 지도 열기 (M)"
          onClick={openMap}
        >
          <div>
            <small>무진도 단편</small>
            <strong>{hud.player.rooms} 방 돌파</strong>
            <span>M · 전체 지도</span>
          </div>
          <MapGrid world={hud.world} />
        </button>
      </header>

      {hud.world.bossMaxHp > 0 && (
        <section className="boss-hud" aria-label="보스 체력">
          <div>
            <small>백지의 권역</small>
            <strong>{ENEMY_NAMES[5]}</strong>
          </div>
          <span>
            <i
              style={{
                width: `${clamp((hud.world.bossHp / hud.world.bossMaxHp) * 100, 0, 100)}%`,
              }}
            />
          </span>
          <b>{Math.ceil((hud.world.bossHp / hud.world.bossMaxHp) * 100)}%</b>
        </section>
      )}

      <aside className={`build-rail ${buildOpen ? "is-open" : ""}`}>
        <button
          className="build-toggle"
          onClick={() => setBuildOpen((open) => !open)}
          aria-expanded={buildOpen}
        >
          <span>빌드</span>
          <strong>{ownedAugments.reduce((sum, item) => sum + rankOf(hud.player, item.id), 0)}</strong>
          <small>B</small>
        </button>
        <div className="build-content">
          <header>
            <div>
              <small>현재 기억 조합</small>
              <h3>하린의 무한 빌드</h3>
            </div>
            <button onClick={() => setBuildOpen(false)} aria-label="빌드 닫기">
              ×
            </button>
          </header>
          <section className={`profession-summary ${currentProfession ? "is-active" : ""}`}>
            <div>
              <small>{currentProfession ? "현재 전문 직업" : "전직 조건"}</small>
              <strong>
                {currentProfession
                  ? PROFESSION_TITLES[currentProfession.id]
                  : "하나의 증강을 20스택"}
              </strong>
            </div>
            <span>
              {currentProfession
                ? `${currentProfession.name} 전투 효율 +${PROFESSION_BONUS_PERCENT}%`
                : "조건을 달성하면 해당 증강의 전문가가 됩니다."}
            </span>
          </section>
          <section className="build-metrics" aria-label="현재 전투 능력치">
            {buildMetrics.map((metric) => (
              <div key={metric.label}>
                <small>{metric.label}</small>
                <strong>{metric.value}</strong>
              </div>
            ))}
          </section>
          {synergies.length > 0 && (
            <section className="synergy-list">
              <small>발현된 시너지</small>
              {synergies.map((synergy) => (
                <span key={synergy.name} style={{ borderColor: synergy.color }}>
                  {synergy.name} <b>Ⅱ{synergy.tier}</b>
                </span>
              ))}
            </section>
          )}
          <section className="augment-stack-list">
            {ownedAugments.length === 0 ? (
              <p>첫 기억 조각을 모으면 증강이 여기에 쌓입니다.</p>
            ) : (
              ownedAugments.map((augment) => {
                const level = rankOf(hud.player, augment.id);
                const stable = level <= (hud.stableAugments[augment.id] ?? 0);
                return (
                  <article key={augment.id}>
                    <AugmentIcon icon={augment.icon} size={52} />
                    <div>
                      <strong>{augment.name}</strong>
                      <small>
                        {hud.player.profession === augment.id
                          ? `${PROFESSION_TITLES[augment.id]} · 유효 ×${powerRankOf(hud.player, augment.id)}`
                          : stable
                            ? "고정된 기억"
                            : "불안정한 기억"}
                      </small>
                      {level >= PROFESSION_THRESHOLD && hud.player.profession !== augment.id && (
                        <button
                          className="profession-inline-button"
                          onClick={() => openProfessionChoice(augment)}
                        >
                          {hud.player.profession ? "전향 가능" : "전직 가능"}
                        </button>
                      )}
                    </div>
                    <b>×{level}</b>
                  </article>
                );
              })
            )}
          </section>
        </div>
      </aside>

      <nav className="control-dock" aria-label="빠른 조작">
        <span><kbd>WASD</kbd> 이동</span>
        <span><kbd>CLICK</kbd> 경로 지정</span>
        <span><kbd>SPACE</kbd> 회피</span>
        <button type="button" onClick={openMap}><kbd>M</kbd> 지도</button>
        <button type="button" onClick={() => setBuildOpen((open) => !open)}><kbd>B</kbd> 빌드</button>
        {nearestLandmark && (
          <em>
            {nearestLandmark.room.kind === "shelter" ? "✦ 쉼터" : "◆ 보스"} {nearestLandmark.key}
            <small>{nearestLandmark.distance}칸</small>
          </em>
        )}
      </nav>

      <div className="toast" role="status">
        <i />
        {toast}
      </div>

      <div className="touch-controls" aria-label="터치 조작">
        <div className="dpad">
          <button
            onPointerDown={() => pressControl("arrowup", true)}
            onPointerUp={() => pressControl("arrowup", false)}
            onPointerLeave={() => pressControl("arrowup", false)}
            onPointerCancel={() => pressControl("arrowup", false)}
            aria-label="위"
          >
            ↑
          </button>
          <button
            onPointerDown={() => pressControl("arrowleft", true)}
            onPointerUp={() => pressControl("arrowleft", false)}
            onPointerLeave={() => pressControl("arrowleft", false)}
            onPointerCancel={() => pressControl("arrowleft", false)}
            aria-label="왼쪽"
          >
            ←
          </button>
          <button
            onPointerDown={() => pressControl("arrowdown", true)}
            onPointerUp={() => pressControl("arrowdown", false)}
            onPointerLeave={() => pressControl("arrowdown", false)}
            onPointerCancel={() => pressControl("arrowdown", false)}
            aria-label="아래"
          >
            ↓
          </button>
          <button
            onPointerDown={() => pressControl("arrowright", true)}
            onPointerUp={() => pressControl("arrowright", false)}
            onPointerLeave={() => pressControl("arrowright", false)}
            onPointerCancel={() => pressControl("arrowright", false)}
            aria-label="오른쪽"
          >
            →
          </button>
        </div>
        <button
          className="dash-button"
          onPointerDown={() => {
            inputRef.current.dashQueued = true;
          }}
          onPointerCancel={() => {
            inputRef.current.dashQueued = false;
          }}
        >
          회피
        </button>
      </div>

      {mode === "augment" && (
        <div className="modal-layer augment-layer">
          <section className="augment-modal">
            <p className="modal-kicker">LEVEL {hud.player.level} · 기억 동기화</p>
            <h2>어떤 실패를 힘으로 바꿀까?</h2>
            <p>같은 증강은 무한히 다시 나타나며, 모든 랭크가 현재 빌드에 누적됩니다.</p>
            <div className="augment-choices">
              {choices.map((augment, index) => {
                const nextRank = rankOf(hud.player, augment.id) + 1;
                const unlockedSynergy = SYNERGIES.find(
                  (synergy) =>
                    synergy.needs.includes(augment.id) &&
                    synergy.needs.every(
                      (id) => id === augment.id || rankOf(hud.player, id) > 0,
                    ),
                );
                return (
                  <button
                    key={augment.id}
                    className="augment-card"
                    onClick={() => chooseAugment(augment)}
                    style={{ "--augment-color": augment.color } as CSSProperties}
                  >
                    <span className="choice-key">{index + 1}</span>
                    <span className="choice-state">
                      {nextRank === 1 ? "NEW" : `STACK ×${nextRank}`}
                    </span>
                    <AugmentIcon icon={augment.icon} size={104} />
                    <small>{augment.tags.join(" · ")}</small>
                    <h3>{augment.name}</h3>
                    <strong>RANK {nextRank}</strong>
                    <p>{augment.description}</p>
                    {unlockedSynergy && (
                      <span className="choice-synergy">시너지 발현 · {unlockedSynergy.name}</span>
                    )}
                    <em>“{augment.flavor}”</em>
                  </button>
                );
              })}
            </div>
          </section>
        </div>
      )}

      {mode === "profession" && professionCandidate && (
        <div className="modal-layer profession-layer">
          <section
            className="profession-modal"
            style={{ "--profession-color": professionCandidate.color } as CSSProperties}
          >
            <p className="modal-kicker">AUGMENT MASTERY · 20 STACKS</p>
            <div className="profession-emblem">
              <AugmentIcon icon={professionCandidate.icon} size={118} />
            </div>
            <small>{professionCandidate.name} 전문 직업</small>
            <h2>{PROFESSION_TITLES[professionCandidate.id]}</h2>
            <p>
              {professionCandidate.name}의 실제 {rankOf(hud.player, professionCandidate.id)}스택을
              전투 계산에서 <b>{rankOf(hud.player, professionCandidate.id) + Math.floor(rankOf(hud.player, professionCandidate.id) / 2)}스택</b>으로
              증폭합니다. 이후 쌓는 모든 스택에도 같은 전문 보정이 적용됩니다.
            </p>
            {hud.player.profession && hud.player.profession !== professionCandidate.id && (
              <span className="profession-warning">
                현재 직업 {PROFESSION_TITLES[hud.player.profession]}의 전문 보정은 해제됩니다.
              </span>
            )}
            <div className="profession-rank-preview" aria-label="전직 전후 증강 효율">
              <div><small>실제 스택</small><strong>{rankOf(hud.player, professionCandidate.id)}</strong></div>
              <i>→</i>
              <div><small>전문 전투력</small><strong>{rankOf(hud.player, professionCandidate.id) + Math.floor(rankOf(hud.player, professionCandidate.id) / 2)}</strong></div>
            </div>
            <div className="modal-actions">
              <button className="primary-button compact" onClick={confirmProfession}>
                {hud.player.profession ? "이 직업으로 전향" : "전직한다"}
              </button>
              <button className="text-button" onClick={closeProfessionChoice}>
                나중에 결정
              </button>
            </div>
          </section>
        </div>
      )}

      {mode === "story" && (
        <div className="modal-layer story-layer">
          <section className="story-modal">
            <p className="modal-kicker">{story.eyebrow}</p>
            <h2>{story.title}</h2>
            <p>{story.body}</p>
            <button
              className="primary-button compact"
              onClick={() => storyActionRef.current()}
            >
              지도를 펼친다
            </button>
          </section>
        </div>
      )}

      {mode === "shelter" && (
        <div className="modal-layer shelter-layer">
          <section className="shelter-modal">
            <p className="modal-kicker">SHELTER · AUTO SAVED</p>
            <h2>마지막 쉼표</h2>
            <p>
              모닥불이 지금까지의 증강을 <b>고정된 기억</b>으로 바꿨습니다.
              여기서 쓰러져도 이 빌드로 돌아옵니다.
            </p>
            <dl>
              <div>
                <dt>고정 증강</dt>
                <dd>{Object.values(hud.player.augments).reduce((a, b) => a + b, 0)}</dd>
              </div>
              <div>
                <dt>돌파한 방</dt>
                <dd>{hud.player.rooms}</dd>
              </div>
              <div>
                <dt>활성 시너지</dt>
                <dd>{synergies.length}</dd>
              </div>
            </dl>
            <div className="modal-actions">
              <button className="primary-button compact" onClick={() => setGameMode("playing")}>
                다시 길 위로
              </button>
              <button className="text-button" onClick={returnToMenu}>
                타이틀로 돌아가기
              </button>
            </div>
          </section>
        </div>
      )}

      {mode === "map" && (
        <div className="modal-layer map-layer">
          <section className="map-modal">
            <header>
              <div>
                <p className="modal-kicker">INFINITE CARTOGRAPHY · M</p>
                <h2>무진도 탐사도</h2>
                <span>
                  현재 좌표 {mapSnapshot.roomX >= 0 ? "+" : ""}{mapSnapshot.roomX} : {mapSnapshot.roomY >= 0 ? "+" : ""}{mapSnapshot.roomY}
                </span>
              </div>
              <button type="button" onClick={() => setGameMode("playing")} aria-label="지도 닫기">
                ×
              </button>
            </header>
            <div className="map-board" ref={mapBoardRef}>
              <span className="compass north">N</span>
              <span className="compass east">E</span>
              <span className="compass south">S</span>
              <span className="compass west">W</span>
              <MapGrid world={mapSnapshot} large />
            </div>
            <footer>
              <div className="map-legend" aria-label="지도 범례">
                <span><i className="legend-current" />현재 위치</span>
                <span><i className="legend-cleared" />정복 완료</span>
                <span><i className="legend-visited" />진입함</span>
                <span><i className="legend-battle" />회랑</span>
                <span><i className="legend-horde" />군락</span>
                <span><i className="legend-elite" />정예</span>
                <span><i className="legend-memory" />기억</span>
                <span><i className="legend-shelter" />쉼터</span>
                <span><i className="legend-boss" />보스</span>
              </div>
              <div className="map-route-summary">
                <small>탐사 기록</small>
                <strong>
                  {mapCounts.visited}개 진입 · {mapCounts.cleared}개 정복 · {mapCounts.known}개 좌표 확인
                </strong>
                <span>
                  {mapNearestLandmark
                    ? `가장 가까운 ${mapNearestLandmark.room.kind === "shelter" ? "쉼터" : "보스"}: ${mapNearestLandmark.key} · ${mapNearestLandmark.distance}칸`
                    : "사방의 문을 지나 새로운 좌표를 정찰하세요."}
                </span>
              </div>
              <button className="primary-button compact" onClick={() => setGameMode("playing")}>
                탐험 계속
              </button>
            </footer>
          </section>
        </div>
      )}

      {mode === "paused" && (
        <div className="modal-layer pause-layer">
          <section className="pause-modal">
            <p className="modal-kicker">PAUSED</p>
            <h2>지도를 접었습니다</h2>
            <div className="pause-dashboard">
              <div>
                <small>현재 원정</small>
                <strong>LV.{hud.player.level} · {hud.player.rooms}방 돌파</strong>
                <span>증강 {Object.values(hud.player.augments).reduce((a, b) => a + b, 0)}중첩 · 시너지 {synergies.length}</span>
              </div>
              <dl>
                <div><dt>이동</dt><dd>WASD / 방향키</dd></div>
                <div><dt>회피</dt><dd>SPACE</dd></div>
                <div><dt>전체 지도</dt><dd>M</dd></div>
                <div><dt>빌드 패널</dt><dd>B</dd></div>
              </dl>
            </div>
            <div className="modal-actions">
              <button className="primary-button compact" onClick={() => setGameMode("playing")}>
                계속 탐험
              </button>
              <button className="text-button" onClick={returnToMenu}>
                타이틀로
              </button>
            </div>
          </section>
        </div>
      )}

      {mode === "dead" && (
        <div className="modal-layer death-layer">
          <section className="death-modal">
            <p className="modal-kicker">MEMORY LOST</p>
            <h2>하린의 문장이 끊겼다</h2>
            <p>
              마지막 쉼터 이후 얻은 불안정한 기억은 흩어집니다.
              <br />
              고정된 빌드와 같은 지도는 그대로 남아 있습니다.
            </p>
            <div className="run-summary">
              <span>
                처치 <b>{hud.player.kills}</b>
              </span>
              <span>
                돌파 <b>{hud.player.rooms}</b>
              </span>
              <span>
                증강 <b>{ownedAugments.length}</b>
              </span>
            </div>
            <div className="modal-actions">
              <button className="primary-button compact" onClick={retryFromShelter}>
                마지막 쉼표에서 재도전
              </button>
              <button className="text-button" onClick={() => startNewRun()}>
                새 기억으로 시작
              </button>
            </div>
          </section>
        </div>
      )}

      {mode === "ending" && (
        <div className="modal-layer ending-layer">
          <section className="ending-modal">
            <p className="modal-kicker">3막 · 끝이 된 자</p>
            <h2>백지 위의 목소리</h2>
            <p>
              백지의 지도사는 최초로 이곳에 들어왔던 하린이었다. 라온의 목소리는
              지도가 하린을 계속 걷게 하려고 만든 미끼였다. 그러나 힘은, 기억은,
              지금의 빌드는 진짜다.
            </p>
            <div className="ending-choices">
              <button
                onClick={() => {
                  setToast("나침반은 닫혔지만, 무진도는 끝나지 않습니다. 무한 탐험 개방.");
                  setGameMode("playing");
                }}
              >
                <small>짧은 결말</small>
                <strong>나침반을 닫는다</strong>
                <span>거짓 목소리를 놓고 현재 빌드로 무한 탐험을 계속합니다.</span>
              </button>
              <button
                onClick={() => {
                  setToast("라온의 목소리를 따라 더 깊은 좌표로 향합니다. 무한 탐험 개방.");
                  setGameMode("playing");
                }}
              >
                <small>끝없는 결말</small>
                <strong>목소리를 따른다</strong>
                <span>지도와 함께 더 강해지며 끝이 없는 다음 막으로 갑니다.</span>
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
