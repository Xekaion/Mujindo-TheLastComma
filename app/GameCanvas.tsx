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

const WIDTH = 1280;
const HEIGHT = 720;
const SAVE_KEY = "mujindo:last-comma:save-v1";

type GameMode =
  | "menu"
  | "playing"
  | "augment"
  | "story"
  | "shelter"
  | "dead"
  | "ending"
  | "paused";
type RoomKind = "battle" | "horde" | "elite" | "memory" | "shelter" | "boss";
type EnemyKind = 0 | 1 | 2 | 3 | 4 | 5;

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
  hit: Set<number>;
  returnAfter?: number;
  returning?: boolean;
  returnMultiplier?: number;
};

type MemoryOrb = {
  id: number;
  x: number;
  y: number;
  value: number;
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
  transition: number;
  clearHandled: boolean;
};

type SaveData = {
  player: Player;
  world: Pick<World, "seed" | "roomX" | "roomY" | "rooms" | "visited">;
  stableAugments: Record<string, number>;
  savedAt: number;
};

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
];

const ROOM_NAMES: Record<RoomKind, string> = {
  battle: "잿빛 회랑",
  horde: "메마른 자들의 뜰",
  elite: "붉은 봉인의 방",
  memory: "흐릿한 기억",
  shelter: "마지막 쉼표",
  boss: "백지의 중심",
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

const keyOf = (x: number, y: number) => `${x},${y}`;
const rankOf = (player: Player, id: string) => player.augments[id] ?? 0;
const xpThreshold = (level: number) =>
  26 + level * 12 + Math.floor(Math.pow(level, 1.25) * 3);
const distance = (ax: number, ay: number, bx: number, by: number) =>
  Math.hypot(ax - bx, ay - by);
const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));
const readSavedRun = () => {
  try {
    return typeof window === "undefined" ? null : localStorage.getItem(SAVE_KEY);
  } catch {
    return null;
  }
};
const removeSavedRun = () => {
  try {
    localStorage.removeItem(SAVE_KEY);
  } catch {
    // Storage may be disabled; a new in-memory run can still start.
  }
};

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
        backgroundSize: `${size * 5}px ${size * 7.5}px`,
        backgroundPosition: `${-column * size}px ${-row * size * 1.19}px`,
      }}
      aria-hidden="true"
    />
  );
}

function MiniMap({
  world,
}: {
  world: Pick<World, "roomX" | "roomY" | "rooms" | "visited">;
}) {
  const cells = [];
  for (let y = world.roomY - 3; y <= world.roomY + 3; y += 1) {
    for (let x = world.roomX - 3; x <= world.roomX + 3; x += 1) {
      const key = keyOf(x, y);
      const room = world.rooms[key];
      const visited = world.visited.includes(key);
      const current = x === world.roomX && y === world.roomY;
      cells.push(
        <span
          key={key}
          className={[
            "map-cell",
            visited ? "is-visited" : "",
            current ? "is-current" : "",
            room?.kind === "shelter" ? "is-shelter" : "",
            room?.kind === "boss" ? "is-boss" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          title={visited ? ROOM_NAMES[room?.kind ?? "battle"] : "미지의 방"}
        />,
      );
    }
  }
  return <div className="minimap-grid">{cells}</div>;
}

export default function GameCanvas() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const playerRef = useRef<Player>(makePlayer());
  const worldRef = useRef<World>(makeWorld(1));
  const stableAugmentsRef = useRef<Record<string, number>>({});
  const checkpointRef = useRef<{ x: number; y: number } | null>(null);
  const idRef = useRef(1);
  const keysRef = useRef(new Set<string>());
  const inputRef = useRef({
    aimX: WIDTH / 2,
    aimY: HEIGHT / 2,
    lastAim: 0,
    dashQueued: false,
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

  const [mode, setMode] = useState<GameMode>("menu");
  const [started, setStarted] = useState(false);
  const [hasSave, setHasSave] = useState(false);
  const [choices, setChoices] = useState<Augment[]>([]);
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
      enemies: 0,
    },
  }));

  const setGameMode = useCallback((next: GameMode) => {
    modeRef.current = next;
    setMode(next);
  }, []);

  const syncHud = useCallback(() => {
    const player = playerRef.current;
    const world = worldRef.current;
    const nearbyRooms: Record<string, RoomRecord> = {};
    const nearbyVisited: string[] = [];
    for (let y = world.roomY - 3; y <= world.roomY + 3; y += 1) {
      for (let x = world.roomX - 3; x <= world.roomX + 3; x += 1) {
        const key = keyOf(x, y);
        if (world.rooms[key]) nearbyRooms[key] = world.rooms[key];
        if (world.visitedLookup[key]) nearbyVisited.push(key);
      }
    }
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
        enemies: world.enemies.length,
      },
    });
  }, []);

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
    player.shield = 10 + rankOf(player, "glass") * 9;
    stableAugmentsRef.current = { ...player.augments };
    checkpointRef.current = { x: world.roomX, y: world.roomY };
    try {
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
      localStorage.setItem(SAVE_KEY, JSON.stringify(data));
      setHasSave(true);
      setToast("쉼터에 기억이 고정되었습니다.");
    } catch {
      setToast("이 기기에서 저장이 차단되었습니다. 탐험은 계속할 수 있습니다.");
    }
    syncHud();
  }, [syncHud]);

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
    const discovered = Object.keys(world.rooms).length + 1;
    if (x === 0 && y === 0) return "battle";
    if (discovered % 9 === 0) return "boss";
    if (discovered % 5 === 0) return "shelter";
    const roll = hash(world.seed, x, y, discovered);
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
      world.transition = 0.55;
      player.x =
        entry === "left" ? 116 : entry === "right" ? WIDTH - 116 : WIDTH / 2;
      player.y =
        entry === "top" ? HEIGHT - 112 : entry === "bottom" ? 112 : HEIGHT / 2;
      player.shield = Math.max(player.shield, 10 + rankOf(player, "glass") * 9);
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
      const boosted = amount * (1 + rankOf(player, "magnet") * 0.08);
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
        player.shield += 9;
      }
      const synergies = activeSynergies(player);
      setToast(
        synergies.length
          ? `${augment.name} ${previous + 1}랭크 · 시너지 ${synergies.at(-1)?.name} 활성`
          : `${augment.name} ${previous + 1}랭크 — 기억이 빌드에 합쳐졌습니다.`,
      );
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
      syncHud();
    },
    [setGameMode, showStory, syncHud],
  );

  const loadSave = useCallback(() => {
    const raw = readSavedRun();
    if (!raw) return false;
    try {
      const data = JSON.parse(raw) as SaveData;
      playerRef.current = {
        ...makePlayer(),
        ...data.player,
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
      stableAugmentsRef.current = { ...data.stableAugments };
      checkpointRef.current = { x: data.world.roomX, y: data.world.roomY };
      setStarted(true);
      enterRoom(data.world.roomX, data.world.roomY, "left");
      setGameMode("shelter");
      return true;
    } catch {
      removeSavedRun();
      setHasSave(false);
      return false;
    }
  }, [enterRoom, setGameMode]);

  const startNewRun = useCallback(() => {
    removeSavedRun();
    setHasSave(false);
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
  }, [enterRoom, setGameMode, showStory]);

  const retryFromShelter = useCallback(() => {
    if (!loadSave()) startNewRun();
  }, [loadSave, startNewRun]);

  const returnToMenu = useCallback(() => {
    keysRef.current.clear();
    setStarted(false);
    setGameMode("menu");
    setBuildOpen(false);
    setHasSave(Boolean(readSavedRun()));
  }, [setGameMode]);

  useEffect(() => {
    const saveCheck = window.setTimeout(
      () => setHasSave(Boolean(readSavedRun())),
      0,
    );
    const imagePaths: Record<string, string> = {
      sprites: "/assets/characters-sprite-atlas.png",
      environment: "/assets/environment-tile-atlas.png",
      ui: "/assets/augment-ui-atlas.png",
      menu: "/assets/menu-title-background.png",
    };
    for (const [name, source] of Object.entries(imagePaths)) {
      const image = new Image();
      image.src = source;
      imagesRef.current[name] = image;
    }
    return () => window.clearTimeout(saveCheck);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      keysRef.current.add(key);
      if ([" ", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(key)) {
        event.preventDefault();
      }
      if (key === " ") inputRef.current.dashQueued = true;
      if (key === "b") setBuildOpen((open) => !open);
      if (key === "escape" && started) {
        if (modeRef.current === "playing") setGameMode("paused");
        else if (modeRef.current === "paused") setGameMode("playing");
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
  }, [setGameMode, started]);

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
      const capped = Math.min(amount, player.maxHp * 0.4);
      if (player.shield > 0) {
        const absorbed = Math.min(player.shield, capped);
        player.shield -= absorbed;
        amount = capped - absorbed;
      } else {
        amount = capped;
      }
      player.hp -= amount;
      player.invulnerable = 0.6;
      setToast(`기억이 ${Math.ceil(capped)}만큼 찢겼습니다.`);
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
    ) => {
      worldRef.current.projectiles.push({
        id: idRef.current++,
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        radius,
        damage,
        life: 4,
        pierce: 0,
        hostile: true,
        color: "#d84c51",
        hit: new Set<number>(),
      });
    };

    const killEnemy = (enemy: Enemy) => {
      const player = playerRef.current;
      const world = worldRef.current;
      player.kills += 1;
      const value = enemy.kind === 5 ? 80 : enemy.elite ? 20 : 7 + enemy.kind * 2;
      world.orbs.push({ id: idRef.current++, x: enemy.x, y: enemy.y, value });
      const predator = rankOf(player, "predator");
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
      const oil = rankOf(player, "oil");
      if (oil > 0) {
        const conflagration = activeSynergies(player).find(
          (synergy) => synergy.name === "대화재",
        );
        const burst =
          (12 + oil * 7 + rankOf(player, "ember") * 4) *
          (1 + (conflagration?.tier ?? 0) * 0.25);
        for (const other of world.enemies) {
          if (other.id !== enemy.id && distance(enemy.x, enemy.y, other.x, other.y) < 118) {
            other.hp -= burst;
          }
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
      const splitRank = rankOf(player, "split");
      const theoreticalCount = 1 + splitRank;
      const visibleCount = Math.min(9, theoreticalCount);
      const overflowCount = theoreticalCount / visibleCount;
      const hasteRank = rankOf(player, "haste");
      const theoreticalRate = 1.4 * Math.pow(1 + 0.14 * hasteRank, 0.7);
      const visibleRate = Math.min(12, theoreticalRate);
      const overflowRate = Math.max(1, theoreticalRate / visibleRate);
      const bloodRank = rankOf(player, "blood");
      const missingHealthBonus =
        bloodRank > 0 ? (1 - player.hp / player.maxHp) * bloodRank * 0.2 : 0;
      const synergyPower = activeSynergies(player).reduce(
        (sum, synergy) => sum + synergy.tier * 0.06,
        0,
      );
      const returnRank = rankOf(player, "return");
      const timeRank = rankOf(player, "time");
      const echoShot =
        timeRank > 0 &&
        (player.shotCounter + 1) % Math.max(2, 6 - Math.min(4, timeRank)) === 0;
      let damage =
        12 *
        (1 + rankOf(player, "fang") * 0.18) *
        (1 + bloodRank * 0.14 + missingHealthBonus) *
        (1 + rankOf(player, "ember") * 0.08) *
        (1 + rankOf(player, "poison") * 0.06) *
        (1 + timeRank * 0.07) *
        (1 + returnRank * 0.04) *
        (1 + rankOf(player, "map") * 0.06) *
        (1 + synergyPower) *
        overflowCount *
        overflowRate;
      const critChance = 0.05 + 0.45 * (1 - Math.exp(-0.18 * rankOf(player, "eye")));
      if (Math.random() < critChance) damage *= 1.7 + rankOf(player, "eye") * 0.1;
      const spread = Math.min(0.62, visibleCount * 0.07);
      for (let i = 0; i < visibleCount; i += 1) {
        const angle =
          baseAngle +
          (visibleCount === 1 ? 0 : -spread / 2 + (spread * i) / (visibleCount - 1));
        world.projectiles.push({
          id: idRef.current++,
          x: player.x,
          y: player.y - 8,
          vx: Math.cos(angle) * 660,
          vy: Math.sin(angle) * 660,
          radius: 5 + Math.min(5, rankOf(player, "fang")),
          damage,
          life: 1.15 + rankOf(player, "return") * 0.14,
          pierce: rankOf(player, "pierce"),
          hostile: false,
          color:
            rankOf(player, "storm") > 0
              ? "#a991ff"
              : rankOf(player, "ember") > 0
                ? "#ef6549"
                : "#71d4c1",
          hit: new Set<number>(),
          returnAfter: returnRank > 0 ? 0.58 : undefined,
          returning: false,
          returnMultiplier: 0.45 + returnRank * 0.1,
        });
        if (echoShot) {
          world.projectiles.push({
            id: idRef.current++,
            x: player.x,
            y: player.y - 8,
            vx: Math.cos(angle) * 610,
            vy: Math.sin(angle) * 610,
            radius: 4 + Math.min(4, timeRank),
            damage: damage * (0.45 + timeRank * 0.07),
            life: 1.05,
            pierce: rankOf(player, "pierce"),
            hostile: false,
            color: "#d0a9ee",
            hit: new Set<number>(),
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
      const heal = 4 + rankOf(player, "map") * 2;
      player.hp = Math.min(player.maxHp, player.hp + heal);
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
      player.fireCooldown -= dt;
      player.invulnerable = Math.max(0, player.invulnerable - dt);
      player.dashCooldown = Math.max(0, player.dashCooldown - dt);
      player.dashTime = Math.max(0, player.dashTime - dt);
      const keys = keysRef.current;
      let moveX =
        (keys.has("d") || keys.has("arrowright") ? 1 : 0) -
        (keys.has("a") || keys.has("arrowleft") ? 1 : 0);
      let moveY =
        (keys.has("s") || keys.has("arrowdown") ? 1 : 0) -
        (keys.has("w") || keys.has("arrowup") ? 1 : 0);
      const moveLength = Math.hypot(moveX, moveY) || 1;
      moveX /= moveLength;
      moveY /= moveLength;
      const boots = rankOf(player, "boots");
      const moveSpeed = 245 * Math.pow(1 + boots * 0.07, 0.55);

      if (inputRef.current.dashQueued && player.dashCooldown <= 0) {
        inputRef.current.dashQueued = false;
        player.dashX = moveX || Math.cos(Math.atan2(inputRef.current.aimY - player.y, inputRef.current.aimX - player.x));
        player.dashY = moveY || Math.sin(Math.atan2(inputRef.current.aimY - player.y, inputRef.current.aimX - player.x));
        player.dashTime = 0.17;
        player.invulnerable = 0.2;
        player.dashCooldown = 1.35 / Math.pow(1 + boots * 0.08, 0.6);
        const voidRank = rankOf(player, "void");
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

      const speed = player.dashTime > 0 ? 900 : moveSpeed;
      const dx = player.dashTime > 0 ? player.dashX : moveX;
      const dy = player.dashTime > 0 ? player.dashY : moveY;
      player.x += dx * speed * dt;
      player.y += dy * speed * dt;

      const doorOpen = world.roomCleared;
      const inHorizontalDoor = player.y > HEIGHT / 2 - 64 && player.y < HEIGHT / 2 + 64;
      const inVerticalDoor = player.x > WIDTH / 2 - 74 && player.x < WIDTH / 2 + 74;
      if (doorOpen && world.transition <= 0) {
        if (player.x < 48 && inHorizontalDoor) {
          roomEnterRef.current(world.roomX - 1, world.roomY, "right");
          return;
        }
        if (player.x > WIDTH - 48 && inHorizontalDoor) {
          roomEnterRef.current(world.roomX + 1, world.roomY, "left");
          return;
        }
        if (player.y < 46 && inVerticalDoor) {
          roomEnterRef.current(world.roomX, world.roomY - 1, "top");
          return;
        }
        if (player.y > HEIGHT - 46 && inVerticalDoor) {
          roomEnterRef.current(world.roomX, world.roomY + 1, "bottom");
          return;
        }
      }
      const minX = doorOpen && inHorizontalDoor ? 24 : 74;
      const maxX = doorOpen && inHorizontalDoor ? WIDTH - 24 : WIDTH - 74;
      const minY = doorOpen && inVerticalDoor ? 24 : 70;
      const maxY = doorOpen && inVerticalDoor ? HEIGHT - 24 : HEIGHT - 70;
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
        enemy.x += Math.cos(angle) * enemy.speed * movement * dt;
        enemy.y += Math.sin(angle) * enemy.speed * movement * dt;
        enemy.x = clamp(enemy.x, 82, WIDTH - 82);
        enemy.y = clamp(enemy.y, 78, HEIGHT - 78);

        if (enemy.kind === 1 && enemy.shootCooldown <= 0) {
          for (let i = -1; i <= 1; i += 1) {
            spawnHostileProjectile(enemy.x, enemy.y, angle + i * 0.13, 285, enemy.damage);
          }
          enemy.shootCooldown = 2.2;
        }
        if (enemy.kind === 3 && enemy.shootCooldown <= 0 && world.enemies.length < 28) {
          world.enemies.push(
            makeEnemy(
              0,
              enemy.x + Math.cos(angle + 1) * 42,
              enemy.y + Math.sin(angle + 1) * 42,
              player.rooms,
            ),
          );
          enemy.shootCooldown = 4.6;
        }
        if (enemy.kind === 4 && enemy.shootCooldown <= 0) {
          enemy.x = 120 + hash(world.seed, enemy.id, player.rooms, now | 0) * (WIDTH - 240);
          enemy.y = 110 + hash(world.seed, player.rooms, enemy.id, (now / 7) | 0) * (HEIGHT - 220);
          spawnHostileProjectile(enemy.x, enemy.y, angle, 350, enemy.damage, 9);
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
            );
          }
          enemy.shootCooldown = 1.75 - (1 - phase) * 0.6;
        }
        if (d < player.radius + enemy.radius * 0.72) damagePlayer(enemy.damage);
      }

      const orbitRank = rankOf(player, "orbit");
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
          }
        }
        projectile.x += projectile.vx * dt;
        projectile.y += projectile.vy * dt;
        if (projectile.hostile) {
          if (
            distance(projectile.x, projectile.y, player.x, player.y) <
            projectile.radius + player.radius
          ) {
            projectile.life = 0;
            damagePlayer(projectile.damage);
          }
          continue;
        }
        for (const enemy of world.enemies) {
          if (projectile.hit.has(enemy.id)) continue;
          if (
            distance(projectile.x, projectile.y, enemy.x, enemy.y) <
            projectile.radius + enemy.radius * 0.72
          ) {
            projectile.hit.add(enemy.id);
            enemy.hp -= projectile.damage;
            const frost = rankOf(player, "frost");
            if (frost > 0) enemy.slow = 0.45 + frost * 0.08;
            const poison = rankOf(player, "poison");
            if (poison > 0) {
              enemy.poisonDamage = Math.max(enemy.poisonDamage, 2 + poison * 1.2);
              enemy.poisonTime = Math.max(enemy.poisonTime, 5);
            }
            const storm = rankOf(player, "storm");
            if (storm > 0 && Math.random() < 1 - Math.pow(0.8, storm)) {
              const next = world.enemies
                .filter((other) => other.id !== enemy.id)
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
                  projectile.damage *
                  0.55 *
                  (1 + (plagueStorm?.tier ?? 0) * 0.24);
                if (plagueStorm && enemy.poisonTime > 0) {
                  next.poisonDamage = Math.max(
                    next.poisonDamage,
                    enemy.poisonDamage * 0.5,
                  );
                  next.poisonTime = Math.max(next.poisonTime, enemy.poisonTime * 0.5);
                }
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

      const pickupRange = 38 + rankOf(player, "magnet") * 42;
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

    const draw = () => {
      const player = playerRef.current;
      const world = worldRef.current;
      const images = imagesRef.current;
      context.clearRect(0, 0, WIDTH, HEIGHT);
      context.fillStyle = "#0a0b0d";
      context.fillRect(0, 0, WIDTH, HEIGHT);

      const environment = images.environment;
      if (environment?.complete && environment.naturalWidth) {
        const quadrant =
          (Math.abs(world.roomX * 7 + world.roomY * 11) +
            (world.roomKind === "shelter" ? 3 : world.roomKind === "boss" ? 2 : 0)) %
          4;
        const sw = environment.naturalWidth / 2;
        const sh = environment.naturalHeight / 2;
        context.save();
        context.globalAlpha = world.roomKind === "shelter" ? 0.42 : 0.25;
        context.drawImage(
          environment,
          (quadrant % 2) * sw,
          Math.floor(quadrant / 2) * sh,
          sw,
          sh,
          0,
          0,
          WIDTH,
          HEIGHT,
        );
        context.restore();
      }
      const gradient = context.createRadialGradient(
        WIDTH / 2,
        HEIGHT / 2,
        120,
        WIDTH / 2,
        HEIGHT / 2,
        690,
      );
      gradient.addColorStop(0, "rgba(34,31,28,.1)");
      gradient.addColorStop(0.72, "rgba(4,5,7,.5)");
      gradient.addColorStop(1, "rgba(0,0,0,.92)");
      context.fillStyle = gradient;
      context.fillRect(0, 0, WIDTH, HEIGHT);

      context.strokeStyle = world.roomKind === "boss" ? "#75332e" : "#4e4537";
      context.lineWidth = 7;
      context.strokeRect(68, 64, WIDTH - 136, HEIGHT - 128);
      context.lineWidth = 1;
      context.strokeStyle = "rgba(210,185,135,.16)";
      for (let x = 100; x < WIDTH - 80; x += 64) {
        context.beginPath();
        context.moveTo(x, 70);
        context.lineTo(x - 42, HEIGHT - 70);
        context.stroke();
      }

      const drawDoor = (x: number, y: number, w: number, h: number) => {
        context.fillStyle = world.roomCleared ? "rgba(89,196,171,.34)" : "rgba(135,48,43,.48)";
        context.strokeStyle = world.roomCleared ? "#67c6b3" : "#b04a42";
        context.lineWidth = 3;
        context.fillRect(x, y, w, h);
        context.strokeRect(x, y, w, h);
      };
      drawDoor(36, HEIGHT / 2 - 55, 46, 110);
      drawDoor(WIDTH - 82, HEIGHT / 2 - 55, 46, 110);
      drawDoor(WIDTH / 2 - 65, 30, 130, 46);
      drawDoor(WIDTH / 2 - 65, HEIGHT - 76, 130, 46);

      for (const orb of world.orbs) {
        context.beginPath();
        context.fillStyle = "rgba(92,224,196,.2)";
        context.arc(orb.x, orb.y, 14, 0, Math.PI * 2);
        context.fill();
        context.beginPath();
        context.fillStyle = "#78e3cd";
        context.arc(orb.x, orb.y, 5, 0, Math.PI * 2);
        context.fill();
      }

      for (const projectile of world.projectiles) {
        context.beginPath();
        context.fillStyle = projectile.color;
        context.shadowColor = projectile.color;
        context.shadowBlur = 12;
        context.arc(projectile.x, projectile.y, projectile.radius, 0, Math.PI * 2);
        context.fill();
        context.shadowBlur = 0;
      }

      const sortedEnemies = [...world.enemies].sort((a, b) => a.y - b.y);
      for (const enemy of sortedEnemies) {
        context.beginPath();
        context.fillStyle = "rgba(0,0,0,.52)";
        context.ellipse(enemy.x, enemy.y + enemy.radius * 0.7, enemy.radius, enemy.radius * 0.42, 0, 0, Math.PI * 2);
        context.fill();
        const size = enemy.kind === 5 ? 185 : 72 + enemy.radius;
        const drawn = drawSprite(
          images.sprites,
          enemy.kind + 1,
          enemy.x,
          enemy.y + 12,
          enemy.kind === 5 ? 205 : size,
          enemy.kind === 5 ? 190 : size * 1.12,
          enemy.slow > 0 ? 0.78 : 1,
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

      const orbitCount = Math.min(8, rankOf(player, "orbit"));
      for (let i = 0; i < orbitCount; i += 1) {
        const angle = performance.now() / 620 + (Math.PI * 2 * i) / orbitCount;
        const ox = player.x + Math.cos(angle) * (62 + rankOf(player, "orbit") * 2);
        const oy = player.y + Math.sin(angle) * (44 + rankOf(player, "orbit") * 1.4);
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
      const playerDrawn = drawSprite(
        images.sprites,
        0,
        player.x,
        player.y + 8,
        86,
        112,
        player.invulnerable > 0 && Math.floor(performance.now() / 70) % 2 ? 0.35 : 1,
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
          <div className="menu-actions">
            <button className="primary-button" onClick={startNewRun}>
              <span>새 원정</span>
              <small>처음부터 기억을 쌓습니다</small>
            </button>
            <button
              className="secondary-button"
              onClick={loadSave}
              disabled={!hasSave}
            >
              <span>마지막 쉼표에서 계속</span>
              <small>{hasSave ? "고정된 빌드를 불러옵니다" : "아직 저장된 기억이 없습니다"}</small>
            </button>
          </div>
        </section>
        <aside className="menu-features" aria-label="게임 특징">
          <span>∞ 무한 중첩 증강</span>
          <span>⌘ 좌표 기반 무한 방</span>
          <span>✦ 쉼터 자동 저장</span>
          <span>☄ 조합 시너지 진화</span>
        </aside>
        <p className="menu-controls">WASD / 방향키 이동 · 마우스 조준 · SPACE 회피 · B 빌드</p>
      </main>
    );
  }

  return (
    <main className="game-screen">
      <canvas
        ref={canvasRef}
        width={WIDTH}
        height={HEIGHT}
        className="game-canvas"
        onPointerMove={handleAim}
        onPointerDown={handleAim}
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
          <span>{hud.world.roomCleared ? "문이 열렸다" : `남은 기억 ${hud.world.enemies}`}</span>
        </section>

        <section className="minimap hud-panel" aria-label="미니맵">
          <div>
            <small>무진도 단편</small>
            <strong>{hud.player.rooms} 방 돌파</strong>
          </div>
          <MiniMap world={hud.world} />
        </section>
      </header>

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
                      <small>{stable ? "고정된 기억" : "불안정한 기억"}</small>
                    </div>
                    <b>×{level}</b>
                  </article>
                );
              })
            )}
          </section>
        </div>
      </aside>

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
                return (
                  <button
                    key={augment.id}
                    className="augment-card"
                    onClick={() => chooseAugment(augment)}
                    style={{ "--augment-color": augment.color } as CSSProperties}
                  >
                    <span className="choice-key">{index + 1}</span>
                    <AugmentIcon icon={augment.icon} size={104} />
                    <small>{augment.tags.join(" · ")}</small>
                    <h3>{augment.name}</h3>
                    <strong>RANK {nextRank}</strong>
                    <p>{augment.description}</p>
                    <em>“{augment.flavor}”</em>
                  </button>
                );
              })}
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

      {mode === "paused" && (
        <div className="modal-layer pause-layer">
          <section className="pause-modal">
            <p className="modal-kicker">PAUSED</p>
            <h2>지도를 접었습니다</h2>
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
              <button className="text-button" onClick={startNewRun}>
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
