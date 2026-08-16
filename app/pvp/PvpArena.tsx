"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
} from "react";
import Link from "next/link";
import {
  DEFAULT_PVP_BUILD_PROFILE,
  PVP_ARENA_HEIGHT,
  PVP_ARENA_WIDTH,
  PVP_BOSS_HIT_RADIUS,
  PVP_DASH_DURATION_MS,
  PVP_INPUT_RATE_HZ,
  PVP_PHANTOM_MARCH_ACTIVATION_MS,
  PVP_PHANTOM_MARCH_MOVEMENT_EPSILON,
  PVP_PHANTOM_MARCH_TIMER_CAP_MS,
  sanitizePvpAppearance,
  sanitizePvpBuildProfile,
  type PvpAppearance,
  type PvpBuildProfile,
  type PvpInput,
  type PvpPlayerSnapshot,
  type PvpSnapshot,
  type RealtimeServerMessage,
} from "../pvp-protocol";
import {
  getLocalRealtimeCharacterIdentity,
  getRealtimeClient,
  type RealtimeConnectionState,
} from "../realtime-client";
import {
  LEGENDARY_POWERS,
  reconcileEquipmentLevelRequirements,
  type EquipmentSlot,
} from "../equipment";
import { createPvpEquipmentProfile } from "../pvp-equipment-profile";
import {
  PAPERDOLL_BODY_PATH,
  PAPERDOLL_WORLD_RENDER_HEIGHT,
  PAPERDOLL_WORLD_RENDER_WIDTH,
  createPaperdollGearSignature,
  drawPaperdollCharacterDirect,
  paperdollLayerPathsForLoadout,
  paperdollLoadoutFromEquipment,
  paperdollVisualCenterY,
  type PaperdollLoadout,
} from "../character-paperdoll";
import { createBrowserPaperdollImageStore } from "../paperdoll-image-store";
import {
  EQUIPPED_RARITY_VFX_PATHS,
  drawEquippedRarityVfx,
  resolveEquippedRarityVfxPlan,
  type EquippedRarityVfxTier,
} from "../equipped-rarity-vfx";
import { readActiveSaveSlot, readSaveSlot } from "../save-slots";
import {
  CHARACTER_IDLE_FRAME,
  advanceCharacterWalkCycle,
  characterFacingForVector,
  characterRenderFrameIndex,
  resolveCharacterMotion,
  settleCharacterWalkCycle,
} from "../character-motion";
import {
  ROOM_DOOR_VISUALS,
  roomDoorAtlasClipSourceRect,
  roomDoorAtlasFrameSourceRect,
  roomDoorClipCanvasRect,
} from "../room-door-visuals";
import {
  GAMEPLAY_VFX_MANIFEST,
  drawGameplayVfxFrame,
  gameplayVfxImageEntries,
  gameplayVfxImageKey,
  legendaryVfxId,
  loopingGameplayVfxProgress,
  projectileVfxId,
  type GameplayVfxId,
  type ProjectileVfxAffinity,
} from "../augment-vfx";
import { playGameSfx } from "../game-audio";
import {
  WALKABLE_FLOOR_POLYGON,
  constrainPointToConvexPolygon,
} from "../room-collision";
import { isLocalPvpShowcaseRequest } from "../pvp-showcase";
import {
  projectileMotionInterpolationCount,
  shouldDrawProjectileTrail,
  shouldProcessContinuousFrame,
} from "../runtime-performance";
import {
  MAX_CONTINUOUS_GAMEPLAY_BACKING_SCALE,
  canvasBackingDimensions,
} from "../canvas-performance";
import "./pvp.css";

type PvpArenaProps = {
  suggestedName?: string | null;
};

type MatchFoundMessage = Extract<RealtimeServerMessage, { type: "match_found" }>;
type MatchResultMessage = Extract<RealtimeServerMessage, { type: "match_result" }>;

const PVP_PLAYER_GROUND_OFFSET_Y = 8;
const pvpPlayerBodyCenterY = (playerY: number) =>
  paperdollVisualCenterY(
    playerY + PVP_PLAYER_GROUND_OFFSET_Y,
    PAPERDOLL_WORLD_RENDER_HEIGHT,
  );
const PVP_ROOM_VISUAL = ROOM_DOOR_VISUALS.roomElite;
const PVP_ROOM_FRAME = roomDoorAtlasFrameSourceRect(0);
const PVP_PLAYER_COLLISION_CLEARANCE = 27;
const PVP_MANUAL_AIM_WINDOW_MS = 850;
const PVP_MANUAL_AIM_CONE_RADIANS = 0.72;
const PVP_LOCAL_RECONCILE_RATE = 11;
const PVP_REMOTE_FOLLOW_RATE = 20;
const PVP_RECONCILE_SNAP_DISTANCE = 150;
const PVP_REMOTE_EXTRAPOLATION_SECONDS = 0.12;
const PVP_AUTHORITATIVE_TICK_MS = 50;

const PVP_SHOWCASE_PLAYER_ID = "local-pvp-showcase";
const PVP_SHOWCASE_OPPONENT_ID = "opponent-pvp-showcase";

const subscribeToLocalShowcaseLocation = () => () => undefined;
const localPvpShowcaseServerSnapshot = () => false;
const localPvpShowcaseBrowserSnapshot = () => {
  if (typeof window === "undefined") return false;
  return isLocalPvpShowcaseRequest(
    new URLSearchParams(window.location.search).get("pvpShowcase"),
    window.location.hostname,
  );
};

const activePvpIdentityServerSnapshot = () => "";
const activePvpIdentityBrowserSnapshot = () => {
  const identity = getLocalRealtimeCharacterIdentity();
  return identity
    ? `${identity.characterSlot}\u0000${identity.displayName}`
    : "";
};
const subscribeToActivePvpIdentity = (listener: () => void) => {
  if (typeof window === "undefined") return () => undefined;
  const notify = () => listener();
  window.addEventListener("storage", notify);
  window.addEventListener("focus", notify);
  document.addEventListener("visibilitychange", notify);
  // localStorage's native event is cross-document only. This low-frequency
  // check keeps same-tab character selection authoritative too.
  const interval = window.setInterval(notify, 750);
  return () => {
    window.removeEventListener("storage", notify);
    window.removeEventListener("focus", notify);
    document.removeEventListener("visibilitychange", notify);
    window.clearInterval(interval);
  };
};

const PVP_SHOWCASE_LOCAL_APPEARANCE = {
  weapon: { slot: "weapon", variant: 3, rarity: "mythic", enhancement: 10 },
  offhand: { slot: "offhand", variant: 3, rarity: "mythic", enhancement: 10 },
  helm: { slot: "helm", variant: 3, rarity: "mythic", enhancement: 10 },
  shoulders: { slot: "shoulders", variant: 3, rarity: "mythic", enhancement: 10 },
  armor: { slot: "armor", variant: 3, rarity: "mythic", enhancement: 10 },
  gloves: { slot: "gloves", variant: 3, rarity: "mythic", enhancement: 9 },
  belt: { slot: "belt", variant: 3, rarity: "mythic", enhancement: 8 },
  legs: { slot: "legs", variant: 3, rarity: "mythic", enhancement: 10 },
  boots: { slot: "boots", variant: 3, rarity: "mythic", enhancement: 10 },
  relic: { slot: "relic", variant: 3, rarity: "mythic", enhancement: 10 },
} as const satisfies PvpAppearance;

const PVP_SHOWCASE_OPPONENT_APPEARANCE = {
  weapon: { slot: "weapon", variant: 9, rarity: "cosmic", enhancement: 10 },
  offhand: { slot: "offhand", variant: 9, rarity: "cosmic", enhancement: 10 },
  helm: { slot: "helm", variant: 9, rarity: "cosmic", enhancement: 10 },
  shoulders: { slot: "shoulders", variant: 9, rarity: "cosmic", enhancement: 10 },
  armor: { slot: "armor", variant: 9, rarity: "cosmic", enhancement: 10 },
  gloves: { slot: "gloves", variant: 9, rarity: "cosmic", enhancement: 10 },
  belt: { slot: "belt", variant: 9, rarity: "cosmic", enhancement: 10 },
  legs: { slot: "legs", variant: 9, rarity: "cosmic", enhancement: 10 },
  boots: { slot: "boots", variant: 9, rarity: "cosmic", enhancement: 10 },
  relic: { slot: "relic", variant: 9, rarity: "cosmic", enhancement: 10 },
} as const satisfies PvpAppearance;

const PVP_SHOWCASE_MATCH: MatchFoundMessage = {
  type: "match_found",
  matchId: "local-pvp-showcase-match",
  opponentName: "종언을 걷는 자",
  side: 0,
  startsAt: 0,
  durationMs: 90_000,
  scoreToWin: 3,
};

const PVP_SHOWCASE_SNAPSHOT: PvpSnapshot = {
  type: "pvp_snapshot",
  matchId: PVP_SHOWCASE_MATCH.matchId,
  tick: 512,
  serverTime: 0,
  phase: "playing",
  startsAt: 0,
  remainingMs: 68_000,
  winnerId: null,
  combatVersion: 4,
  targetClass: "boss",
  combatModel: "equipment-power",
  players: [
    {
      id: PVP_SHOWCASE_PLAYER_ID,
      name: "이름 없는 기록자",
      side: 0,
      x: 430,
      y: 390,
      vx: 42,
      vy: -8,
      aimX: 1,
      aimY: -0.12,
      hp: 83,
      maxHp: 100,
      score: 2,
      dashCooldownMs: 0,
      dashRemainingMs: 0,
      invulnerableMs: 0,
      respawnMs: 0,
      connected: true,
      lastInputSequence: 231,
      equipmentPower: 6_639,
      attackRate: 1.85,
      projectileCount: 2,
      projectileSpeed: 690,
      projectileLifeMs: 1_220,
      projectileRadius: 6.2,
      homingStrength: 1.2,
      pierce: 0,
      projectileDamage: 146,
      phantomMarchMoveMs: 3_200,
      continuousMoveMultiplier: 1.12,
      appearance: PVP_SHOWCASE_LOCAL_APPEARANCE,
    },
    {
      id: PVP_SHOWCASE_OPPONENT_ID,
      name: "종언을 걷는 자",
      side: 1,
      x: 850,
      y: 326,
      vx: -36,
      vy: 14,
      aimX: -0.98,
      aimY: 0.18,
      hp: 69,
      maxHp: 100,
      score: 1,
      dashCooldownMs: 420,
      dashRemainingMs: 0,
      invulnerableMs: 0,
      respawnMs: 0,
      connected: true,
      lastInputSequence: 227,
      equipmentPower: 7_104,
      attackRate: 1.92,
      projectileCount: 2,
      projectileSpeed: 720,
      projectileLifeMs: 1_350,
      projectileRadius: 7,
      homingStrength: 2,
      pierce: 1,
      projectileDamage: 151,
      phantomMarchMoveMs: 0,
      continuousMoveMultiplier: 1.12,
      appearance: PVP_SHOWCASE_OPPONENT_APPEARANCE,
    },
  ],
  projectiles: [
    {
      id: 41,
      volleyId: 27,
      ownerId: PVP_SHOWCASE_PLAYER_ID,
      x: 618,
      y: 360,
      previousX: 586,
      previousY: 364,
      vx: 650,
      vy: -78,
      radius: 8,
      ageMs: 420,
      lifeMs: 730,
      critical: false,
      affinity: "arcane",
    },
    {
      id: 42,
      volleyId: 28,
      ownerId: PVP_SHOWCASE_OPPONENT_ID,
      x: 730,
      y: 346,
      previousX: 762,
      previousY: 341,
      vx: -642,
      vy: 102,
      radius: 8,
      ageMs: 510,
      lifeMs: 640,
      critical: true,
      affinity: "arcane",
    },
  ],
  events: [],
};

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.max(minimum, Math.min(maximum, value));

type PvpMoveTarget = {
  x: number;
  y: number;
  active: boolean;
};

type PendingPredictedInput = {
  input: PvpInput;
  sampledAt: number;
};

type PredictedPlayerState = {
  matchId: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  dashX: number;
  dashY: number;
  dashRemainingMs: number;
  dashCooldownMs: number;
  phantomMarchMoveMs: number;
  lastAuthoritativeTick: number;
  lastAcknowledgedSequence: number;
};

type PvpRenderPosition = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  dashRemainingMs: number;
  invulnerableMs: number;
  phantomMarchMoveMs: number;
  continuousMoveMultiplier: number;
};

type PvpTransientEffect = {
  id: number;
  kind: "muzzle" | "impact" | "defeat";
  x: number;
  y: number;
  angle: number;
  size: number;
  color: string;
  affinity: ProjectileVfxAffinity;
  startedAt: number;
  durationMs: number;
  critical: boolean;
  vfxId?: GameplayVfxId;
};

type PvpPredictedShot = {
  at: number;
  x: number;
  y: number;
  angle: number;
  volleyId: number;
  projectileIds: number[];
};

type PvpRenderableProjectile = Omit<
  PvpSnapshot["projectiles"][number],
  "affinity"
> & {
  affinity: ProjectileVfxAffinity;
  vfxId?: GameplayVfxId;
};

type PvpPredictedProjectile = PvpRenderableProjectile & {
  spawnedAt: number;
  homingStrength: number;
  /** Present only on damage-free client replicas of legendary bonus shots. */
  hitPlayerIds?: Set<string>;
  pierceRemaining?: number;
  pendingCatchupMs?: number;
};

const PVP_LEGENDARY_RARITIES = new Set(["legendary", "mythic", "cosmic"]);

const hasAppearanceLegendaryPower = (
  appearance: PvpAppearance,
  slot: EquipmentSlot,
) => {
  const piece = appearance[slot];
  return Boolean(piece && PVP_LEGENDARY_RARITIES.has(piece.rarity));
};

const normalizeVector = (x: number, y: number, fallbackX = 1, fallbackY = 0) => {
  const length = Math.hypot(x, y);
  return length > 0.001
    ? { x: x / length, y: y / length }
    : { x: fallbackX, y: fallbackY };
};

const distanceToSegmentSquared = (
  pointX: number,
  pointY: number,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
) => {
  const segmentX = endX - startX;
  const segmentY = endY - startY;
  const lengthSquared = segmentX * segmentX + segmentY * segmentY;
  if (lengthSquared <= 0.000_001) {
    return (pointX - startX) ** 2 + (pointY - startY) ** 2;
  }
  const projection = clamp(
    ((pointX - startX) * segmentX + (pointY - startY) * segmentY) /
      lengthSquared,
    0,
    1,
  );
  const closestX = startX + segmentX * projection;
  const closestY = startY + segmentY * projection;
  return (pointX - closestX) ** 2 + (pointY - closestY) ** 2;
};

const pvpAffinityColor = (affinity: ProjectileVfxAffinity) => {
  switch (affinity) {
    case "blood":
      return "#ff6f91";
    case "ember":
      return "#ff835e";
    case "storm":
      return "#b8a4ff";
    case "frost":
      return "#91eaff";
    case "poison":
      return "#86e998";
    case "echo":
      return "#d6b5f4";
    case "enemy":
    case "witch":
    case "boss":
      return "#ff637e";
    default:
      return "#72ead0";
  }
};

const angularDistance = (left: number, right: number) =>
  Math.abs(Math.atan2(Math.sin(left - right), Math.cos(left - right)));

const colorWithAlpha = (color: string, alpha: number) => {
  const normalized = color.startsWith("#") ? color.slice(1) : color;
  if (!/^[0-9a-f]{6}$/i.test(normalized)) return color;
  const value = Number.parseInt(normalized, 16);
  return `rgba(${(value >> 16) & 255},${(value >> 8) & 255},${value & 255},${clamp(alpha, 0, 1)})`;
};

const formatClock = (milliseconds: number) => {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
};

function connectionLabel(state: RealtimeConnectionState): string {
  switch (state) {
    case "online":
      return "결투 서버 연결";
    case "connecting":
      return "서버에 접속 중";
    case "reconnecting":
      return "연결 복구 중";
    case "offline":
      return "서버 연결 끊김";
    default:
      return "서버 준비 중";
  }
}

function readLocalPvpBuildProfile(): PvpBuildProfile {
  if (typeof window === "undefined") return { ...DEFAULT_PVP_BUILD_PROFILE };
  const save = readSaveSlot(readActiveSaveSlot());
  if (!save) return { ...DEFAULT_PVP_BUILD_PROFILE };
  const gear = reconcileEquipmentLevelRequirements(
    save.player.level,
    save.player.equipment,
    save.player.inventory,
  );
  return sanitizePvpBuildProfile(createPvpEquipmentProfile(gear.equipment));
}

/**
 * Converts the local save into the same renderer-only slot metadata accepted
 * by the realtime allowlist. Gear identities, affixes, stats, and save payloads
 * never leave this client.
 */
function readLocalPvpPaperdollLoadout(): PaperdollLoadout {
  if (typeof window === "undefined") return {};
  const save = readSaveSlot(readActiveSaveSlot());
  if (!save) return {};
  const gear = reconcileEquipmentLevelRequirements(
    save.player.level,
    save.player.equipment,
    save.player.inventory,
  );
  return paperdollLoadoutFromEquipment(gear.equipment);
}

export default function PvpArena(_props: PvpArenaProps) {
  void _props;
  const localShowcase = useSyncExternalStore(
    subscribeToLocalShowcaseLocation,
    localPvpShowcaseBrowserSnapshot,
    localPvpShowcaseServerSnapshot,
  );
  const activeIdentitySnapshot = useSyncExternalStore(
    subscribeToActivePvpIdentity,
    activePvpIdentityBrowserSnapshot,
    activePvpIdentityServerSnapshot,
  );
  const identitySeparator = activeIdentitySnapshot.indexOf("\u0000");
  const activeCharacterSlot =
    identitySeparator > 0
      ? Number(activeIdentitySnapshot.slice(0, identitySeparator))
      : null;
  const activeCharacterDisplayName =
    identitySeparator > 0
      ? activeIdentitySnapshot.slice(identitySeparator + 1)
      : null;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const canvasBackingScaleRef = useRef(1);
  const [paperdollImageStore] = useState(createBrowserPaperdollImageStore);
  const paperdollImagesRef = useRef(paperdollImageStore);
  const equippedRarityVfxImagesRef = useRef<
    Partial<Record<EquippedRarityVfxTier, HTMLImageElement>>
  >({});
  const projectileVfxImagesRef = useRef<
    Partial<Record<string, HTMLImageElement>>
  >({});
  const snapshotRef = useRef<PvpSnapshot | null>(null);
  const snapshotReceivedAtRef = useRef<number | null>(null);
  const playerIdRef = useRef<string | null>(null);
  const keysRef = useRef(new Set<string>());
  const aimRef = useRef({ x: PVP_ARENA_WIDTH / 2, y: PVP_ARENA_HEIGHT / 2 });
  const lastAimAtRef = useRef(Number.NEGATIVE_INFINITY);
  const dashQueuedRef = useRef(false);
  const predictionDashQueuedRef = useRef(false);
  const discardQueuedDashRef = useRef(false);
  const mobileMoveRef = useRef({ x: 0, y: 0 });
  const moveTargetRef = useRef<PvpMoveTarget>({ x: 0, y: 0, active: false });
  const latestPredictedInputRef = useRef<PvpInput | null>(null);
  const pendingPredictedInputsRef = useRef<PendingPredictedInput[]>([]);
  const predictedLocalPlayerRef = useRef<PredictedPlayerState | null>(null);
  const sequenceRef = useRef(0);
  const [connection, setConnection] = useState<RealtimeConnectionState>("idle");
  const [online, setOnline] = useState(0);
  const [playerId, setPlayerId] = useState<string | null>(null);
  const [queued, setQueued] = useState(false);
  const [queuePosition, setQueuePosition] = useState<number | null>(null);
  const [match, setMatch] = useState<MatchFoundMessage | null>(null);
  const [snapshot, setSnapshot] = useState<PvpSnapshot | null>(null);
  const [result, setResult] = useState<MatchResultMessage | null>(null);
  const [ping, setPing] = useState<number | null>(null);
  const [buildProfile, setBuildProfile] = useState<PvpBuildProfile>(() => ({
    ...DEFAULT_PVP_BUILD_PROFILE,
  }));
  const [localPaperdollLoadout, setLocalPaperdollLoadout] =
    useState<PaperdollLoadout>({});
  const [notice, setNotice] = useState("마지막 쉼터의 장착 장비 전투력을 읽고 있습니다.");

  const activePlayerId = localShowcase ? PVP_SHOWCASE_PLAYER_ID : playerId;
  const activeMatch = localShowcase ? PVP_SHOWCASE_MATCH : match;
  const activeSnapshot = localShowcase ? PVP_SHOWCASE_SNAPSHOT : snapshot;
  const displayName = localShowcase
    ? PVP_SHOWCASE_SNAPSHOT.players[0].name
    : activeCharacterDisplayName ?? "닉네임 미설정";
  const activeLocalAppearance = localShowcase
    ? PVP_SHOWCASE_LOCAL_APPEARANCE
    : localPaperdollLoadout;
  const appearanceSignature = [
    createPaperdollGearSignature(activeLocalAppearance),
    ...(activeSnapshot?.players.map((participant) =>
      createPaperdollGearSignature(
        sanitizePvpAppearance(participant.appearance),
      ),
    ) ?? []),
  ].join("||");
  const paperdollPathSignature = [
    PAPERDOLL_BODY_PATH,
    ...new Set([
      ...paperdollLayerPathsForLoadout(activeLocalAppearance),
      ...(activeSnapshot?.players.flatMap((participant) =>
        paperdollLayerPathsForLoadout(
          sanitizePvpAppearance(participant.appearance),
        ),
      ) ?? []),
    ]),
  ].join("|");

  useEffect(() => {
    if (localShowcase || localPvpShowcaseBrowserSnapshot()) return;
    const frame = window.requestAnimationFrame(() => {
      setBuildProfile(readLocalPvpBuildProfile());
      setLocalPaperdollLoadout(readLocalPvpPaperdollLoadout());
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeIdentitySnapshot, localShowcase]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const resizeBackingStore = () => {
      const rect = canvas.getBoundingClientRect();
      const backing = canvasBackingDimensions(
        PVP_ARENA_WIDTH,
        PVP_ARENA_HEIGHT,
        rect.width,
        rect.height,
        window.devicePixelRatio || 1,
        MAX_CONTINUOUS_GAMEPLAY_BACKING_SCALE,
      );
      canvasBackingScaleRef.current = backing.scale;
      if (canvas.width !== backing.width) canvas.width = backing.width;
      if (canvas.height !== backing.height) canvas.height = backing.height;
    };

    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(resizeBackingStore);
    observer?.observe(canvas);
    window.addEventListener("resize", resizeBackingStore);
    resizeBackingStore();
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", resizeBackingStore);
    };
  }, [activeSnapshot?.matchId]);

  useEffect(() => {
    paperdollImagesRef.current.reconcile(paperdollPathSignature.split("|"));
  }, [paperdollPathSignature]);

  useEffect(() => {
    let disposed = false;
    const images = equippedRarityVfxImagesRef.current;
    const pending: HTMLImageElement[] = [];

    for (const tier of Object.keys(
      EQUIPPED_RARITY_VFX_PATHS,
    ) as EquippedRarityVfxTier[]) {
      const image = new Image();
      image.decoding = "async";
      image.onload = () => {
        if (!disposed) images[tier] = image;
      };
      image.src = EQUIPPED_RARITY_VFX_PATHS[tier];
      pending.push(image);
    }

    return () => {
      disposed = true;
      for (const image of pending) {
        image.onload = null;
        image.onerror = null;
        image.src = "";
      }
      equippedRarityVfxImagesRef.current = {};
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    const images = projectileVfxImagesRef.current;
    const pending: HTMLImageElement[] = [];

    for (const [imageKey, assetPath] of gameplayVfxImageEntries()) {
      const image = new Image();
      image.decoding = "async";
      image.onload = () => {
        if (!disposed) images[imageKey] = image;
      };
      image.src = assetPath;
      pending.push(image);
    }

    return () => {
      disposed = true;
      for (const image of pending) {
        image.onload = null;
        image.onerror = null;
        image.src = "";
      }
      projectileVfxImagesRef.current = {};
    };
  }, []);

  useEffect(
    () => {
      const paperdollImages = paperdollImagesRef.current;
      return () => paperdollImages.clear();
    },
    [],
  );

  useEffect(() => {
    if (localShowcase || localPvpShowcaseBrowserSnapshot()) {
      playerIdRef.current = PVP_SHOWCASE_PLAYER_ID;
      snapshotRef.current = PVP_SHOWCASE_SNAPSHOT;
      snapshotReceivedAtRef.current = performance.now();
      return;
    }
    const realtime = getRealtimeClient();
    const unsubscribe = realtime.subscribe((event) => {
      switch (event.type) {
        case "connection_state":
          setConnection(event.state);
          break;
        case "connected":
          playerIdRef.current = event.playerId;
          setPlayerId(event.playerId);
          setOnline(event.online);
          break;
        case "presence":
          setOnline(event.online);
          break;
        case "queue_state":
          setQueued(event.state === "queued");
          setQueuePosition(event.state === "queued" ? event.position ?? 1 : null);
          break;
        case "match_found":
          setMatch(event);
          setQueued(false);
          setQueuePosition(null);
          setResult(null);
          pendingPredictedInputsRef.current = [];
          predictedLocalPlayerRef.current = null;
          dashQueuedRef.current = false;
          predictionDashQueuedRef.current = false;
          discardQueuedDashRef.current = false;
          moveTargetRef.current.active = false;
          setNotice(`${event.opponentName}의 기억과 결투가 성립되었습니다.`);
          break;
        case "pvp_snapshot":
          snapshotReceivedAtRef.current = performance.now();
          snapshotRef.current = event;
          {
            const localId = playerIdRef.current;
            const acknowledgedSequence = localId
              ? event.players.find((participant) => participant.id === localId)
                  ?.lastInputSequence
              : undefined;
            if (acknowledgedSequence !== undefined) {
              pendingPredictedInputsRef.current =
                pendingPredictedInputsRef.current.filter(
                  (pending) => pending.input.sequence > acknowledgedSequence,
                );
            }
          }
          setSnapshot(event);
          break;
        case "match_result":
          setResult(event);
          setQueued(false);
          pendingPredictedInputsRef.current = [];
          dashQueuedRef.current = false;
          predictionDashQueuedRef.current = false;
          discardQueuedDashRef.current = false;
          moveTargetRef.current.active = false;
          break;
        case "pong":
          setPing(Math.max(0, Date.now() - event.clientTime));
          break;
        case "error":
          setNotice(event.message);
          break;
      }
    });
    return unsubscribe;
  }, [activeIdentitySnapshot, localShowcase]);

  useEffect(() => {
    snapshotRef.current = activeSnapshot;
    if (localShowcase) {
      playerIdRef.current = PVP_SHOWCASE_PLAYER_ID;
      snapshotReceivedAtRef.current = performance.now();
    } else if (!activeSnapshot) {
      snapshotReceivedAtRef.current = null;
    }
  }, [activeSnapshot, localShowcase]);

  const enterQueue = useCallback(() => {
    if (!activeCharacterDisplayName) {
      setNotice(
        "선택한 캐릭터의 닉네임을 먼저 설정해 주세요. 캐릭터 선택 화면에서 이름을 새긴 뒤 입장할 수 있습니다.",
      );
      return;
    }
    setResult(null);
    setSnapshot(null);
    snapshotRef.current = null;
    snapshotReceivedAtRef.current = null;
    pendingPredictedInputsRef.current = [];
    predictedLocalPlayerRef.current = null;
    dashQueuedRef.current = false;
    predictionDashQueuedRef.current = false;
    discardQueuedDashRef.current = false;
    moveTargetRef.current.active = false;
    setNotice("대전 상대의 기억 파장을 탐색하고 있습니다.");
    getRealtimeClient().joinQueue(buildProfile, activeLocalAppearance);
  }, [activeCharacterDisplayName, activeLocalAppearance, buildProfile]);

  const cancelQueue = useCallback(() => {
    getRealtimeClient().cancelQueue();
    setQueued(false);
    setQueuePosition(null);
    setNotice("매칭 탐색을 중단했습니다.");
  }, []);

  useEffect(() => {
    const preventGameKeys = (event: KeyboardEvent) => {
      if (["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright", " "].includes(event.key.toLowerCase())) {
        event.preventDefault();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      preventGameKeys(event);
      const key = event.key.toLowerCase();
      keysRef.current.add(key);
      if (["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(key)) {
        moveTargetRef.current.active = false;
      }
      if (event.key === " " && !event.repeat) {
        dashQueuedRef.current = true;
        predictionDashQueuedRef.current = true;
        discardQueuedDashRef.current = false;
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      preventGameKeys(event);
      keysRef.current.delete(event.key.toLowerCase());
    };
    const clear = () => {
      keysRef.current.clear();
      mobileMoveRef.current = { x: 0, y: 0 };
      dashQueuedRef.current = false;
      predictionDashQueuedRef.current = false;
      discardQueuedDashRef.current = false;
      moveTargetRef.current.active = false;
    };
    window.addEventListener("keydown", onKeyDown, { passive: false });
    window.addEventListener("keyup", onKeyUp, { passive: false });
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", clear);
    };
  }, []);

  useEffect(() => {
    if (localShowcase || !activeMatch) return;
    const interval = window.setInterval(() => {
      const current = snapshotRef.current;
      const localId = playerIdRef.current;
      if (!current || !localId || current.matchId !== activeMatch.matchId) return;
      const localPlayer = current.players.find((player) => player.id === localId);
      const opponent = current.players.find((player) => player.id !== localId);
      if (!localPlayer) return;
      const predicted = predictedLocalPlayerRef.current;
      const originX =
        predicted?.matchId === current.matchId ? predicted.x : localPlayer.x;
      const originY =
        predicted?.matchId === current.matchId ? predicted.y : localPlayer.y;
      const sampledAt = performance.now();
      const keys = keysRef.current;
      let moveX =
        (keys.has("d") || keys.has("arrowright") ? 1 : 0) -
        (keys.has("a") || keys.has("arrowleft") ? 1 : 0) +
        mobileMoveRef.current.x;
      let moveY =
        (keys.has("s") || keys.has("arrowdown") ? 1 : 0) -
        (keys.has("w") || keys.has("arrowup") ? 1 : 0) +
        mobileMoveRef.current.y;
      let moveLength = Math.hypot(moveX, moveY);
      if (moveLength <= 0.001 && moveTargetRef.current.active) {
        const targetX = moveTargetRef.current.x - originX;
        const targetY = moveTargetRef.current.y - originY;
        const targetDistance = Math.hypot(targetX, targetY);
        if (targetDistance > 12) {
          moveX = targetX / targetDistance;
          moveY = targetY / targetDistance;
          moveLength = 1;
        } else {
          moveTargetRef.current.active = false;
        }
      }
      if (moveLength > 1) {
        moveX /= moveLength;
        moveY /= moveLength;
      }
      const pointerAim = normalizeVector(
        aimRef.current.x - originX,
        aimRef.current.y - originY,
        localPlayer.aimX,
        localPlayer.aimY,
      );
      const opponentLeadSeconds =
        opponent && snapshotReceivedAtRef.current !== null
          ? clamp(
              (sampledAt - snapshotReceivedAtRef.current) / 1_000,
              0,
              PVP_REMOTE_EXTRAPOLATION_SECONDS,
            )
          : 0;
      const bossAim = opponent
        ? normalizeVector(
            opponent.x + opponent.vx * opponentLeadSeconds - originX,
            opponent.y + opponent.vy * opponentLeadSeconds - originY,
            pointerAim.x,
            pointerAim.y,
          )
        : pointerAim;
      const manuallyAiming =
        sampledAt - lastAimAtRef.current < PVP_MANUAL_AIM_WINDOW_MS;
      const bossInsideManualCone =
        !manuallyAiming ||
        angularDistance(
          Math.atan2(pointerAim.y, pointerAim.x),
          Math.atan2(bossAim.y, bossAim.x),
        ) < PVP_MANUAL_AIM_CONE_RADIANS;
      const aim = bossInsideManualCone ? bossAim : pointerAim;
      const canControl =
        current.phase === "playing" && localPlayer.respawnMs <= 0;
      const canFire =
        canControl && Boolean(opponent && opponent.respawnMs <= 0);
      const predictedDashAvailable =
        (predicted?.dashCooldownMs ?? localPlayer.dashCooldownMs) <= 0 &&
        (predicted?.dashRemainingMs ?? localPlayer.dashRemainingMs) <= 0;
      const locallyPredictedDashAccepted =
        dashQueuedRef.current &&
        !predictionDashQueuedRef.current &&
        !discardQueuedDashRef.current;
      const dashAvailable =
        canControl &&
        !discardQueuedDashRef.current &&
        (predictedDashAvailable || locallyPredictedDashAccepted);
      const dash = dashQueuedRef.current && dashAvailable;
      if (dashQueuedRef.current && !dashAvailable) {
        predictionDashQueuedRef.current = false;
      }
      const sampledAim = dash ? pointerAim : aim;
      sequenceRef.current += 1;
      const input: PvpInput = {
        sequence: sequenceRef.current,
        moveX,
        moveY,
        // Expedition dashes fall back to the raw cursor when stationary.
        // Preserve that edge direction even though normal fire aim locks to
        // the live boss target.
        aimX: sampledAim.x,
        aimY: sampledAim.y,
        fire: canFire && bossInsideManualCone,
        dash,
      };
      dashQueuedRef.current = false;
      discardQueuedDashRef.current = false;
      latestPredictedInputRef.current = input;
      pendingPredictedInputsRef.current.push({
        input,
        sampledAt,
      });
      if (pendingPredictedInputsRef.current.length > 128) {
        pendingPredictedInputsRef.current.splice(
          0,
          pendingPredictedInputsRef.current.length - 128,
        );
      }
      getRealtimeClient().sendPvpInput(input);
    }, Math.round(1_000 / PVP_INPUT_RATE_HZ));
    return () => window.clearInterval(interval);
  }, [activeMatch, localShowcase]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const roomAtlas = new Image();
    roomAtlas.decoding = "async";
    roomAtlas.src = PVP_ROOM_VISUAL.imagePath;
    const fallbackRoom = new Image();
    fallbackRoom.decoding = "async";
    fallbackRoom.src = "/assets/maps/room-elite.webp";
    let roomVignette: CanvasGradient | null = null;
    let roomVignetteBackingScale = 0;
    const getRoomVignette = () => {
      const backingScale = canvasBackingScaleRef.current;
      if (roomVignette && roomVignetteBackingScale === backingScale) {
        return roomVignette;
      }
      roomVignette = context.createRadialGradient(
        PVP_ARENA_WIDTH / 2,
        PVP_ARENA_HEIGHT / 2,
        180,
        PVP_ARENA_WIDTH / 2,
        PVP_ARENA_HEIGHT / 2,
        735,
      );
      roomVignette.addColorStop(0, "rgba(0,0,0,0)");
      roomVignette.addColorStop(0.68, "rgba(0,0,0,.04)");
      roomVignette.addColorStop(1, "rgba(0,0,0,.54)");
      roomVignetteBackingScale = backingScale;
      return roomVignette;
    };
    const renderedPositions = new Map<
      string,
      { x: number; y: number; facing: number; walkCycle: number }
    >();
    const renderedProjectiles = new Map<number, { x: number; y: number }>();
    const currentProjectileIds = new Set<number>();
    const rarityVfxPlans = new Map<
      string,
      ReturnType<typeof resolveEquippedRarityVfxPlan>
    >();
    const fallbackLocalAppearance = sanitizePvpAppearance(
      activeLocalAppearance,
    );
    const appearanceByPlayerId = new Map<string, PvpAppearance>();
    for (const player of snapshotRef.current?.players ?? []) {
      const snapshotAppearance = sanitizePvpAppearance(player.appearance);
      appearanceByPlayerId.set(
        player.id,
        Object.keys(snapshotAppearance).length > 0 ||
          player.id !== playerIdRef.current
          ? snapshotAppearance
          : fallbackLocalAppearance,
      );
    }
    for (const [participantId, appearance] of appearanceByPlayerId) {
      rarityVfxPlans.set(
        participantId,
        resolveEquippedRarityVfxPlan(appearance),
      );
    }
    let animationFrame = 0;
    let lastProcessedCombatEventId = 0;
    let nextTransientEffectId = -1;
    let nextPredictedProjectileId = -1_000_000;
    let nextPredictedVolleyId = -1;
    let nextPredictedShotAt = 0;
    const transientEffects: PvpTransientEffect[] = [];
    const predictedLocalShots: PvpPredictedShot[] = [];
    const predictedLocalProjectiles: PvpPredictedProjectile[] = [];
    const predictedLocalDashes: Array<{ at: number; x: number; y: number }> = [];
    const lastAffinityByActor = new Map<string, ProjectileVfxAffinity>();
    const seenAuthoritativeLocalProjectileIds = new Set<number>();
    const reconciledAuthoritativeVolleyIds = new Set<number>();
    const acknowledgedLocalShotEvents: Array<{
      occurredAt: number;
      volleyId?: number;
    }> = [];
    const shotCountByActor = new Map<string, number>();
    const criticalHitCountByActor = new Map<string, number>();
    const landedCriticalVolleyIdsByActor = new Map<string, Set<number>>();
    const bloodwovenReadyByActor = new Set<string>();
    const hitCountByActor = new Map<string, number>();
    const starfallUntilByActor = new Map<string, number>();
    const mirrorBarrierUntilByActor = new Map<string, number>();
    const hunterSigilPulseUntilByTarget = new Map<string, number>();
    const movementStateByActor = new Map<
      string,
      { lastPhantomTrailAt: number; lastRiftTrailAt: number }
    >();

    const pushTransientEffect = (
      effect: Omit<PvpTransientEffect, "id">,
    ) => {
      transientEffects.push({ ...effect, id: nextTransientEffectId-- });
      if (transientEffects.length > 96) {
        transientEffects.splice(0, transientEffects.length - 96);
      }
    };

    const removePredictedVolley = (volleyId: number) => {
      for (let index = predictedLocalProjectiles.length - 1; index >= 0; index -= 1) {
        if (predictedLocalProjectiles[index].volleyId === volleyId) {
          predictedLocalProjectiles.splice(index, 1);
        }
      }
    };

    const immediateMoveVector = (originX: number, originY: number) => {
      const keys = keysRef.current;
      let x =
        (keys.has("d") || keys.has("arrowright") ? 1 : 0) -
        (keys.has("a") || keys.has("arrowleft") ? 1 : 0) +
        mobileMoveRef.current.x;
      let y =
        (keys.has("s") || keys.has("arrowdown") ? 1 : 0) -
        (keys.has("w") || keys.has("arrowup") ? 1 : 0) +
        mobileMoveRef.current.y;
      let length = Math.hypot(x, y);
      if (length <= 0.001 && moveTargetRef.current.active) {
        const targetX = moveTargetRef.current.x - originX;
        const targetY = moveTargetRef.current.y - originY;
        const targetDistance = Math.hypot(targetX, targetY);
        if (targetDistance > 12) {
          x = targetX / targetDistance;
          y = targetY / targetDistance;
          length = 1;
        } else {
          moveTargetRef.current.active = false;
        }
      }
      return length > 1 ? { x: x / length, y: y / length } : { x, y };
    };

    const constrainPredictedPlayer = (state: Pick<PredictedPlayerState, "x" | "y">) => {
      constrainPointToConvexPolygon(
        state,
        WALKABLE_FLOOR_POLYGON,
        PVP_PLAYER_COLLISION_CLEARANCE,
      );
    };

    const advancePredictedMotion = (
      state: Pick<
        PredictedPlayerState,
        | "x"
        | "y"
        | "dashX"
        | "dashY"
        | "dashRemainingMs"
        | "dashCooldownMs"
        | "phantomMarchMoveMs"
      >,
      elapsedMs: number,
      moveX: number,
      moveY: number,
      canMove: boolean,
      continuousMoveMultiplier: number,
    ) => {
      if (!(elapsedMs > 0)) {
        if (!canMove) return { vx: 0, vy: 0 };
        if (state.dashRemainingMs > 0) {
          return {
            vx: state.dashX * buildProfile.dashSpeed,
            vy: state.dashY * buildProfile.dashSpeed,
          };
        }
        const speed =
          buildProfile.moveSpeed *
          (state.phantomMarchMoveMs >= PVP_PHANTOM_MARCH_ACTIVATION_MS
            ? continuousMoveMultiplier
            : 1);
        return { vx: moveX * speed, vy: moveY * speed };
      }
      const stepCount = Math.max(
        1,
        Math.min(120, Math.ceil(elapsedMs / (1_000 / 60))),
      );
      const stepMs = elapsedMs / stepCount;
      let velocityX = 0;
      let velocityY = 0;
      for (let step = 0; step < stepCount; step += 1) {
        const previousX = state.x;
        const previousY = state.y;
        const dashStepMs = canMove
          ? Math.min(stepMs, state.dashRemainingMs)
          : 0;
        const normalStepMs = canMove ? stepMs - dashStepMs : 0;
        const normalSpeedMultiplier =
          state.phantomMarchMoveMs >= PVP_PHANTOM_MARCH_ACTIVATION_MS
            ? continuousMoveMultiplier
            : 1;
        if (dashStepMs > 0) {
          state.x +=
            state.dashX * buildProfile.dashSpeed * (dashStepMs / 1_000);
          state.y +=
            state.dashY * buildProfile.dashSpeed * (dashStepMs / 1_000);
          velocityX = state.dashX * buildProfile.dashSpeed;
          velocityY = state.dashY * buildProfile.dashSpeed;
        }
        if (normalStepMs > 0) {
          const normalSpeed =
            buildProfile.moveSpeed * normalSpeedMultiplier;
          state.x += moveX * normalSpeed * (normalStepMs / 1_000);
          state.y += moveY * normalSpeed * (normalStepMs / 1_000);
          velocityX = moveX * normalSpeed;
          velocityY = moveY * normalSpeed;
        } else if (!canMove) {
          velocityX = 0;
          velocityY = 0;
        }
        constrainPredictedPlayer(state);
        const actuallyMoved =
          Math.hypot(state.x - previousX, state.y - previousY) >
          PVP_PHANTOM_MARCH_MOVEMENT_EPSILON;
        state.phantomMarchMoveMs =
          continuousMoveMultiplier > 1 && actuallyMoved
            ? Math.min(
                PVP_PHANTOM_MARCH_TIMER_CAP_MS,
                state.phantomMarchMoveMs + stepMs,
              )
            : 0;
        state.dashRemainingMs = Math.max(
          0,
          state.dashRemainingMs - stepMs,
        );
        state.dashCooldownMs = Math.max(
          0,
          state.dashCooldownMs - stepMs,
        );
      }
      return { vx: velocityX, vy: velocityY };
    };

    const replayPendingInputs = (
      authoritative: PvpPlayerSnapshot,
      renderTime: number,
    ) => {
      const pending = pendingPredictedInputsRef.current;
      const continuousMoveMultiplier =
        authoritative.continuousMoveMultiplier ??
        buildProfile.continuousMoveMultiplier;
      const replay = {
        x: authoritative.x,
        y: authoritative.y,
        dashX: normalizeVector(
          authoritative.vx,
          authoritative.vy,
          authoritative.aimX,
          authoritative.aimY,
        ).x,
        dashY: normalizeVector(
          authoritative.vx,
          authoritative.vy,
          authoritative.aimX,
          authoritative.aimY,
        ).y,
        dashRemainingMs: authoritative.dashRemainingMs,
        dashCooldownMs: authoritative.dashCooldownMs,
        phantomMarchMoveMs: authoritative.phantomMarchMoveMs ?? 0,
      };
      if (pending.length === 0) {
        const receivedAt = snapshotReceivedAtRef.current ?? renderTime;
        const leadMs = clamp(
          renderTime - receivedAt,
          0,
          PVP_REMOTE_EXTRAPOLATION_SECONDS * 1_000,
        );
        const authoritativeMoving =
          Math.hypot(authoritative.vx, authoritative.vy) > 0.001;
        const latestInput = latestPredictedInputRef.current;
        const move = latestInput
          ? { x: latestInput.moveX, y: latestInput.moveY }
          : authoritativeMoving
            ? normalizeVector(authoritative.vx, authoritative.vy)
            : { x: 0, y: 0 };
        advancePredictedMotion(
          replay,
          leadMs,
          move.x,
          move.y,
          authoritative.respawnMs <= 0,
          continuousMoveMultiplier,
        );
        return replay;
      }

      let cursor = Math.max(renderTime - 250, pending[0].sampledAt);
      for (let index = 0; index < pending.length; index += 1) {
        const sample = pending[index];
        const nextAt = pending[index + 1]?.sampledAt ?? renderTime;
        const endAt = Math.min(renderTime, Math.max(cursor, nextAt));
        const elapsedMs = clamp(endAt - cursor, 0, 75);
        if (
          sample.input.dash &&
          replay.dashCooldownMs <= 0 &&
          replay.dashRemainingMs <= 0
        ) {
          const dashDirection = normalizeVector(
            sample.input.moveX,
            sample.input.moveY,
            sample.input.aimX,
            sample.input.aimY,
          );
          replay.dashX = dashDirection.x;
          replay.dashY = dashDirection.y;
          replay.dashRemainingMs = PVP_DASH_DURATION_MS;
          replay.dashCooldownMs = buildProfile.dashCooldownMs;
        }
        advancePredictedMotion(
          replay,
          elapsedMs,
          sample.input.moveX,
          sample.input.moveY,
          authoritative.respawnMs <= 0,
          continuousMoveMultiplier,
        );
        cursor = endAt;
      }
      return replay;
    };

    const appearanceForPlayer = (player: PvpPlayerSnapshot): PvpAppearance => {
      return (
        appearanceByPlayerId.get(player.id) ??
        (player.id === playerIdRef.current ? fallbackLocalAppearance : {})
      );
    };
    const rarityVfxPlanForPlayer = (player: PvpPlayerSnapshot) => {
      return (
        rarityVfxPlans.get(player.id) ??
        resolveEquippedRarityVfxPlan(appearanceForPlayer(player))
      );
    };

    const updatePredictedLocalPlayer = (
      authoritative: PvpPlayerSnapshot,
      current: PvpSnapshot,
      elapsedSeconds: number,
      renderTime: number,
    ): PvpRenderPosition => {
      let predicted = predictedLocalPlayerRef.current;
      if (!predicted || predicted.matchId !== current.matchId) {
        const dashDirection = normalizeVector(
          authoritative.vx,
          authoritative.vy,
          authoritative.aimX,
          authoritative.aimY,
        );
        predicted = {
          matchId: current.matchId,
          x: authoritative.x,
          y: authoritative.y,
          vx: authoritative.vx,
          vy: authoritative.vy,
          dashX: dashDirection.x,
          dashY: dashDirection.y,
          dashRemainingMs: authoritative.dashRemainingMs,
          dashCooldownMs: authoritative.dashCooldownMs,
          phantomMarchMoveMs: authoritative.phantomMarchMoveMs ?? 0,
          lastAuthoritativeTick: current.tick,
          lastAcknowledgedSequence: authoritative.lastInputSequence,
        };
        predictedLocalPlayerRef.current = predicted;
      }

      const input = latestPredictedInputRef.current ?? {
        sequence: authoritative.lastInputSequence,
        moveX: 0,
        moveY: 0,
        aimX: authoritative.aimX,
        aimY: authoritative.aimY,
        fire: false,
        dash: false,
      };
      const immediateMove = immediateMoveVector(predicted.x, predicted.y);
      const continuousMoveMultiplier =
        authoritative.continuousMoveMultiplier ??
        buildProfile.continuousMoveMultiplier;
      if (
        predictionDashQueuedRef.current &&
        current.phase === "playing" &&
        authoritative.respawnMs <= 0 &&
        predicted.dashCooldownMs <= 0
      ) {
        predictionDashQueuedRef.current = false;
        discardQueuedDashRef.current = false;
        const pointerDashAim = normalizeVector(
          aimRef.current.x - predicted.x,
          aimRef.current.y - predicted.y,
          input.aimX,
          input.aimY,
        );
        const dashDirection = normalizeVector(
          immediateMove.x,
          immediateMove.y,
          pointerDashAim.x,
          pointerDashAim.y,
        );
        predicted.dashX = dashDirection.x;
        predicted.dashY = dashDirection.y;
        predicted.dashRemainingMs = PVP_DASH_DURATION_MS;
        predicted.dashCooldownMs = buildProfile.dashCooldownMs;
        predictedLocalDashes.push({
          at: renderTime,
          x: predicted.x,
          y: predicted.y,
        });
        const localAppearance = appearanceForPlayer(authoritative);
        if (hasAppearanceLegendaryPower(localAppearance, "shoulders")) {
          starfallUntilByActor.set(
            authoritative.id,
            renderTime +
              LEGENDARY_POWERS.starfallMantle.parameters.durationSeconds * 1_000,
          );
          pushTransientEffect({
            kind: "impact",
            x: predicted.x,
            y: pvpPlayerBodyCenterY(predicted.y),
            angle: 0,
            size: 118,
            color: "#f8d98a",
            affinity: "arcane",
            startedAt: renderTime,
            durationMs: 540,
            critical: false,
            vfxId: legendaryVfxId("starfallMantle"),
          });
          playGameSfx("playerDash", { playbackRate: 1.28, gain: 0.7 });
        }
        playGameSfx("playerDash", {
          pan: clamp(predicted.dashX * 0.45, -0.45, 0.45),
        });
      } else if (predictionDashQueuedRef.current) {
        // Match expedition input semantics: an edge pressed while dash is
        // unavailable is consumed now, never replayed as a ghost dash when
        // the cooldown later reaches zero.
        predictionDashQueuedRef.current = false;
        discardQueuedDashRef.current = true;
      }

      if (authoritative.dashRemainingMs > predicted.dashRemainingMs + 34) {
        const serverDashDirection = normalizeVector(
          authoritative.vx,
          authoritative.vy,
          authoritative.aimX,
          authoritative.aimY,
        );
        predicted.dashX = serverDashDirection.x;
        predicted.dashY = serverDashDirection.y;
        predicted.dashRemainingMs = authoritative.dashRemainingMs;
      }

      const canMove =
        current.phase === "playing" && authoritative.respawnMs <= 0;
      const stepCount = Math.max(
        1,
        Math.min(120, Math.ceil(elapsedSeconds * 60)),
      );
      const stepMs = (elapsedSeconds * 1_000) / stepCount;
      for (let step = 0; step < stepCount; step += 1) {
        const move = immediateMoveVector(predicted.x, predicted.y);
        const velocity = advancePredictedMotion(
          predicted,
          stepMs,
          move.x,
          move.y,
          canMove,
          continuousMoveMultiplier,
        );
        predicted.vx = velocity.vx;
        predicted.vy = velocity.vy;
      }

      const authorityAdvanced =
        authoritative.lastInputSequence > predicted.lastAcknowledgedSequence;
      const authoritativeSnapshotAdvanced =
        current.tick > predicted.lastAuthoritativeTick;
      if (authorityAdvanced) {
        predicted.lastAcknowledgedSequence = authoritative.lastInputSequence;
      }
      if (authoritativeSnapshotAdvanced) {
        predicted.lastAuthoritativeTick = current.tick;
      }
      const replayed = replayPendingInputs(authoritative, renderTime);
      const errorX = replayed.x - predicted.x;
      const errorY = replayed.y - predicted.y;
      const errorDistance = Math.hypot(errorX, errorY);
      if (
        authoritative.respawnMs > 0 ||
        (authorityAdvanced && errorDistance > PVP_RECONCILE_SNAP_DISTANCE)
      ) {
        predicted.x = replayed.x;
        predicted.y = replayed.y;
        predicted.vx = authoritative.vx;
        predicted.vy = authoritative.vy;
        predicted.dashRemainingMs = authoritative.dashRemainingMs;
        predicted.dashCooldownMs = authoritative.dashCooldownMs;
        predicted.phantomMarchMoveMs = replayed.phantomMarchMoveMs;
      } else {
        const correction =
          elapsedSeconds > 0
            ? 1 - Math.exp(-PVP_LOCAL_RECONCILE_RATE * elapsedSeconds)
            : 0;
        predicted.x += errorX * correction;
        predicted.y += errorY * correction;
        if (authorityAdvanced) {
          predicted.dashCooldownMs +=
            (authoritative.dashCooldownMs - predicted.dashCooldownMs) *
            correction;
        }
        if (authoritativeSnapshotAdvanced) {
          predicted.phantomMarchMoveMs = replayed.phantomMarchMoveMs;
        }
      }
      constrainPredictedPlayer(predicted);

      return {
        x: predicted.x,
        y: predicted.y,
        vx: predicted.vx,
        vy: predicted.vy,
        dashRemainingMs: predicted.dashRemainingMs,
        phantomMarchMoveMs: predicted.phantomMarchMoveMs,
        continuousMoveMultiplier,
        invulnerableMs: Math.max(
          authoritative.invulnerableMs,
          predicted.dashRemainingMs + 30,
        ),
      };
    };

    const roomAtlasReady = () =>
      roomAtlas.complete &&
      roomAtlas.naturalWidth >= PVP_ROOM_FRAME.x + PVP_ROOM_FRAME.width &&
      roomAtlas.naturalHeight >= PVP_ROOM_FRAME.y + PVP_ROOM_FRAME.height;

    const drawBackground = (renderTime: number) => {
      context.fillStyle = "#07090d";
      context.fillRect(0, 0, PVP_ARENA_WIDTH, PVP_ARENA_HEIGHT);
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      if (roomAtlasReady()) {
        context.drawImage(
          roomAtlas,
          PVP_ROOM_FRAME.x,
          PVP_ROOM_FRAME.y,
          PVP_ROOM_FRAME.width,
          PVP_ROOM_FRAME.height,
          0,
          0,
          PVP_ARENA_WIDTH,
          PVP_ARENA_HEIGHT,
        );
      } else if (
        fallbackRoom.complete &&
        fallbackRoom.naturalWidth > 0 &&
        fallbackRoom.naturalHeight > 0
      ) {
        context.drawImage(
          fallbackRoom,
          0,
          0,
          PVP_ARENA_WIDTH,
          PVP_ARENA_HEIGHT,
        );
      }

      context.save();
      context.globalCompositeOperation = "soft-light";
      context.globalAlpha = 0.07;
      context.fillStyle = "#7e2527";
      context.fillRect(0, 0, PVP_ARENA_WIDTH, PVP_ARENA_HEIGHT);
      context.restore();
      context.fillStyle = getRoomVignette();
      context.fillRect(0, 0, PVP_ARENA_WIDTH, PVP_ARENA_HEIGHT);

      const ambientTime = renderTime / 1_000;
      context.save();
      context.fillStyle = "#da7764";
      for (let index = 0; index < 18; index += 1) {
        const baseX = (211 + index * 379) % PVP_ARENA_WIDTH;
        const baseY = (97 + index * 223) % PVP_ARENA_HEIGHT;
        const drift = ambientTime * (5 + (index % 7));
        const x =
          (baseX + Math.sin(ambientTime * 0.43 + index) * 10 + PVP_ARENA_WIDTH) %
          PVP_ARENA_WIDTH;
        const y = (baseY - drift + PVP_ARENA_HEIGHT * 10) % PVP_ARENA_HEIGHT;
        const edgeWeight = clamp(
          Math.abs(x - PVP_ARENA_WIDTH / 2) / (PVP_ARENA_WIDTH / 2),
          0.18,
          1,
        );
        context.globalAlpha =
          (0.04 + 0.12 * Math.sin(ambientTime * 0.8 + index) ** 2) *
          edgeWeight;
        context.beginPath();
        context.arc(x, y, 0.8 + (index % 3) * 0.55, 0, Math.PI * 2);
        context.fill();
      }
      context.restore();
    };

    const drawSouthDoorForeground = () => {
      if (!roomAtlasReady()) return;
      const clip = PVP_ROOM_VISUAL.doorwayClips.south;
      const source = roomDoorAtlasClipSourceRect(0, clip);
      const destination = roomDoorClipCanvasRect(
        clip,
        PVP_ARENA_WIDTH,
        PVP_ARENA_HEIGHT,
      );
      context.save();
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.drawImage(
        roomAtlas,
        source.x,
        source.y,
        source.width,
        source.height,
        destination.x,
        destination.y,
        destination.width,
        destination.height,
      );
      context.beginPath();
      context.rect(
        destination.x,
        destination.y,
        destination.width,
        destination.height,
      );
      context.clip();
      context.globalCompositeOperation = "soft-light";
      context.globalAlpha = 0.07;
      context.fillStyle = "#7e2527";
      context.fillRect(0, 0, PVP_ARENA_WIDTH, PVP_ARENA_HEIGHT);
      context.globalCompositeOperation = "source-over";
      context.globalAlpha = 1;
      context.fillStyle = getRoomVignette();
      context.fillRect(0, 0, PVP_ARENA_WIDTH, PVP_ARENA_HEIGHT);
      context.restore();
    };

    const drawPlayer = (
      player: PvpPlayerSnapshot,
      elapsedSeconds: number,
      renderTime: number,
      target: PvpRenderPosition,
      locallyPredicted: boolean,
    ) => {
      const previousRendered = renderedPositions.get(player.id);
      const targetMoving = Math.abs(target.vx) + Math.abs(target.vy) > 3;
      const targetFacing = targetMoving
        ? characterFacingForVector(
            target.vx,
            target.vy,
            previousRendered?.facing ?? (player.side === 0 ? 6 : 2),
          )
        : previousRendered?.facing ?? (player.side === 0 ? 6 : 2);
      const rendered = previousRendered ?? {
        x: target.x,
        y: target.y,
        facing: targetFacing,
        walkCycle: CHARACTER_IDLE_FRAME,
      };
      const previousRenderedX = rendered.x;
      const previousRenderedY = rendered.y;
      const follow = locallyPredicted
        ? 1
        : elapsedSeconds > 0
          ? 1 - Math.exp(-PVP_REMOTE_FOLLOW_RATE * elapsedSeconds)
          : 1;
      rendered.x += (target.x - rendered.x) * follow;
      rendered.y += (target.y - rendered.y) * follow;
      const motion = resolveCharacterMotion(
        rendered.x - previousRenderedX,
        rendered.y - previousRenderedY,
        targetFacing,
        0.01,
      );
      rendered.facing = motion.moving ? motion.facing : targetFacing;
      rendered.walkCycle = motion.moving
        ? advanceCharacterWalkCycle(
            rendered.walkCycle,
            motion.distance,
            target.dashRemainingMs > 0 ? 220 : undefined,
            elapsedSeconds,
          )
        : settleCharacterWalkCycle(rendered.walkCycle);
      renderedPositions.set(player.id, rendered);
      const accent = player.side === 0 ? "#65d9ee" : "#ff667f";
      const moving = motion.moving;
      const frame = characterRenderFrameIndex(
        rendered.facing,
        rendered.walkCycle,
        moving,
      );
      const alpha =
        player.respawnMs > 0
          ? 0.3
          : target.invulnerableMs > 0 && Math.floor(renderTime / 70) % 2
            ? 0.35
            : 1;
      context.save();
      context.globalAlpha = alpha;
      context.fillStyle = "rgba(0,0,0,.55)";
      context.beginPath();
      context.ellipse(rendered.x, rendered.y + 18, 28, 12, 0, 0, Math.PI * 2);
      context.fill();
      const bodyAtlas = paperdollImagesRef.current.get(PAPERDOLL_BODY_PATH);
      const appearance = appearanceForPlayer(player);
      const rarityVfxPlan = rarityVfxPlanForPlayer(player);
      let hunterMarked = false;
      for (const [actorId, actorAppearance] of appearanceByPlayerId) {
        if (
          actorId !== player.id &&
          hasAppearanceLegendaryPower(actorAppearance, "helm")
        ) {
          hunterMarked = true;
          break;
        }
      }
      if (hunterMarked) {
        const hunterVfxId = legendaryVfxId("hunterSigil");
        drawGameplayVfxFrame(
          context,
          projectileVfxImagesRef.current[gameplayVfxImageKey(hunterVfxId)],
          GAMEPLAY_VFX_MANIFEST[hunterVfxId],
          {
            x: rendered.x,
            y: pvpPlayerBodyCenterY(rendered.y),
            size: 84,
            progress: (renderTime * 0.00078 + player.side * 0.17) % 1,
            alpha:
              (hunterSigilPulseUntilByTarget.get(player.id) ?? 0) > renderTime
                ? 1
                : 0.58 + Math.sin(renderTime * 0.0032 + player.side) * 0.12,
            frameOffset: player.side,
          },
        );
      }
      let appearanceDrawn = false;
      if (
        bodyAtlas?.complete &&
        bodyAtlas.naturalWidth > 0 &&
        bodyAtlas.naturalHeight > 0
      ) {
        appearanceDrawn = drawPaperdollCharacterDirect(context, {
          bodyAtlas,
          layerSources: paperdollImagesRef.current.imageMap(),
          loadout: appearance,
          direction: rendered.facing,
          frame,
          x: rendered.x,
          // Expedition and PvP share the same collision-foot baseline.
          y: rendered.y + PVP_PLAYER_GROUND_OFFSET_Y,
          width: PAPERDOLL_WORLD_RENDER_WIDTH,
          height: PAPERDOLL_WORLD_RENDER_HEIGHT,
        });
      }
      if (!appearanceDrawn) {
        context.fillStyle = accent;
        context.beginPath();
        context.arc(rendered.x, rendered.y, 25, 0, Math.PI * 2);
        context.fill();
      }
      // Use the exact expedition equipment-aura contract: full alpha, scale,
      // and all equipped mythic/cosmic pieces in the combat foreground pass.
      drawEquippedRarityVfx(context, {
        plan: rarityVfxPlan,
        images: equippedRarityVfxImagesRef.current,
        direction: rendered.facing,
        frame,
        timeMs: renderTime,
        x: rendered.x,
        y: rendered.y + PVP_PLAYER_GROUND_OFFSET_Y,
        width: PAPERDOLL_WORLD_RENDER_WIDTH,
        height: PAPERDOLL_WORLD_RENDER_HEIGHT,
        context: "combat",
        alpha,
      });
      if (
        hasAppearanceLegendaryPower(appearance, "shoulders") &&
        (starfallUntilByActor.get(player.id) ?? 0) > renderTime
      ) {
        const mantleVfxId = legendaryVfxId("starfallMantle");
        drawGameplayVfxFrame(
          context,
          projectileVfxImagesRef.current[gameplayVfxImageKey(mantleVfxId)],
          GAMEPLAY_VFX_MANIFEST[mantleVfxId],
          {
            x: rendered.x,
            y: pvpPlayerBodyCenterY(rendered.y),
            size: 108,
            progress: (renderTime * 0.0014) % 1,
            alpha: 0.92 * alpha,
          },
        );
      }
      if (
        hasAppearanceLegendaryPower(appearance, "offhand") &&
        (mirrorBarrierUntilByActor.get(player.id) ?? 0) > renderTime
      ) {
        const barrierVfxId = legendaryVfxId("mirrorAegis");
        drawGameplayVfxFrame(
          context,
          projectileVfxImagesRef.current[gameplayVfxImageKey(barrierVfxId)],
          GAMEPLAY_VFX_MANIFEST[barrierVfxId],
          {
            x: rendered.x,
            y: pvpPlayerBodyCenterY(rendered.y),
            size: 112,
            progress: (renderTime * 0.00165) % 1,
            alpha: 0.94 * alpha,
          },
        );
      }
      context.restore();

      const movementState = movementStateByActor.get(player.id) ?? {
        lastPhantomTrailAt: Number.NEGATIVE_INFINITY,
        lastRiftTrailAt: Number.NEGATIVE_INFINITY,
      };
      if (
        moving &&
        hasAppearanceLegendaryPower(appearance, "legs") &&
        target.continuousMoveMultiplier > 1 &&
        target.phantomMarchMoveMs >= PVP_PHANTOM_MARCH_ACTIVATION_MS &&
        renderTime - movementState.lastPhantomTrailAt >= 400
      ) {
        movementState.lastPhantomTrailAt = renderTime;
        pushTransientEffect({
          kind: "impact",
          x: previousRenderedX,
          y: previousRenderedY + PVP_PLAYER_GROUND_OFFSET_Y,
          angle: Math.atan2(target.vy, target.vx),
          size: 74,
          color: "#a68cff",
          affinity: "arcane",
          startedAt: renderTime,
          durationMs: 950,
          critical: false,
          vfxId: legendaryVfxId("phantomMarch"),
        });
      }
      if (
        target.dashRemainingMs > 0 &&
        hasAppearanceLegendaryPower(appearance, "boots") &&
        renderTime - movementState.lastRiftTrailAt >= 55
      ) {
        movementState.lastRiftTrailAt = renderTime;
        pushTransientEffect({
          kind: "impact",
          x: rendered.x,
          y: rendered.y + PVP_PLAYER_GROUND_OFFSET_Y,
          angle: Math.atan2(target.vy, target.vx),
          size: 52,
          color: "#bd6cff",
          affinity: "arcane",
          startedAt: renderTime,
          durationMs: 300,
          critical: false,
          vfxId: legendaryVfxId("riftStride"),
        });
      }
      movementStateByActor.set(player.id, movementState);

      context.font = "700 12px Pretendard, sans-serif";
      context.letterSpacing = "0px";
      context.textAlign = "center";
      context.fillStyle = "rgba(250, 239, 216, 0.95)";
      context.fillText(player.name, rendered.x, rendered.y - 88);
      context.fillStyle = "rgba(4, 5, 8, 0.86)";
      context.fillRect(rendered.x - 40, rendered.y - 78, 80, 7);
      context.fillStyle = accent;
      context.fillRect(
        rendered.x - 39,
        rendered.y - 77,
        78 * clamp(player.hp / player.maxHp, 0, 1),
        5,
      );
      if (player.respawnMs > 0) {
        context.fillStyle = "rgba(245, 224, 190, 0.9)";
        context.fillText(`${Math.ceil(player.respawnMs / 1_000)}`, rendered.x, rendered.y - 48);
      }
    };

    const predictLocalWeaponPresentation = (
      current: PvpSnapshot,
      localPlayer: PvpPlayerSnapshot | undefined,
      localPosition: PvpRenderPosition | undefined,
      renderTime: number,
    ) => {
      const input = latestPredictedInputRef.current;
      if (
        !localPlayer ||
        !localPosition ||
        !input?.fire ||
        current.phase !== "playing" ||
        localPlayer.respawnMs > 0
      ) {
        nextPredictedShotAt = renderTime;
        return;
      }
      const opponent = current.players.find(
        (player) => player.id !== localPlayer.id && player.respawnMs <= 0,
      );
      if (!opponent) {
        nextPredictedShotAt = renderTime;
        return;
      }
      const opponentLeadSeconds =
        snapshotReceivedAtRef.current !== null
          ? clamp(
              (renderTime - snapshotReceivedAtRef.current) / 1_000,
              0,
              PVP_REMOTE_EXTRAPOLATION_SECONDS,
            )
          : 0;
      const liveBossAim = normalizeVector(
        opponent.x + opponent.vx * opponentLeadSeconds - localPosition.x,
        opponent.y + opponent.vy * opponentLeadSeconds - localPosition.y,
        input.aimX,
        input.aimY,
      );
      const baseAngle = Math.atan2(liveBossAim.y, liveBossAim.x);
      const shotIntervalMs = 1_000 / Math.max(0.1, buildProfile.attackRate);
      if (nextPredictedShotAt <= 0) nextPredictedShotAt = renderTime;
      let emitted = 0;
      while (renderTime >= nextPredictedShotAt && emitted < 4) {
        const affinity: ProjectileVfxAffinity = "arcane";
        const shotAt = nextPredictedShotAt;
        const muzzleX = localPosition.x;
        const muzzleY = pvpPlayerBodyCenterY(localPosition.y);
        const volleyId = nextPredictedVolleyId--;
        const projectileIds: number[] = [];
        const spread = Math.min(0.62, buildProfile.projectileCount * 0.07);
        const initialAgeMs = Math.max(0, renderTime - shotAt);
        for (let index = 0; index < buildProfile.projectileCount; index += 1) {
          const angle =
            baseAngle +
            (buildProfile.projectileCount === 1
              ? 0
              : -spread / 2 +
                (spread * index) / (buildProfile.projectileCount - 1));
          const id = nextPredictedProjectileId--;
          const startX = localPosition.x;
          const startY = localPosition.y - 8;
          const vx = Math.cos(angle) * buildProfile.projectileSpeed;
          const vy = Math.sin(angle) * buildProfile.projectileSpeed;
          projectileIds.push(id);
          predictedLocalProjectiles.push({
            id,
            ownerId: localPlayer.id,
            x: startX + vx * (initialAgeMs / 1_000),
            y: startY + vy * (initialAgeMs / 1_000),
            previousX: startX,
            previousY: startY,
            vx,
            vy,
            radius: buildProfile.projectileRadius,
            ageMs: initialAgeMs,
            lifeMs: Math.max(0, buildProfile.projectileLifeMs - initialAgeMs),
            critical: false,
            affinity,
            spawnedAt: shotAt,
            volleyId,
            homingStrength: buildProfile.homingStrength,
          });
        }
        predictedLocalShots.push({
          at: shotAt,
          x: muzzleX,
          y: muzzleY,
          angle: baseAngle,
          volleyId,
          projectileIds,
        });
        if (predictedLocalProjectiles.length > 192) {
          predictedLocalProjectiles.splice(
            0,
            predictedLocalProjectiles.length - 192,
          );
        }
        pushTransientEffect({
          kind: "muzzle",
          x: muzzleX,
          y: muzzleY,
          angle: baseAngle,
          size: 28 + Math.min(18, buildProfile.projectileCount * 2),
          color: pvpAffinityColor(affinity),
          affinity,
          startedAt: renderTime,
          durationMs: 200,
          critical: false,
        });
        playGameSfx("playerShot", {
          gain: 0.88,
          playbackRate: 1 + Math.min(0.12, buildProfile.attackRate / 100),
        });
        nextPredictedShotAt += shotIntervalMs;
        emitted += 1;
      }
      if (renderTime - nextPredictedShotAt > shotIntervalMs * 4) {
        nextPredictedShotAt = renderTime + shotIntervalMs;
      }
    };

    const consumePredictedShot = (
      eventAt: number,
      angle: number | null,
    ) => {
      let bestIndex = -1;
      let bestScore = Number.POSITIVE_INFINITY;
      if (angle === null) {
        const oldest = predictedLocalShots[0];
        if (!oldest || Math.abs(eventAt - oldest.at) > 450) return null;
        bestIndex = 0;
      }
      for (let index = 0; index < predictedLocalShots.length; index += 1) {
        if (angle === null) break;
        const predicted = predictedLocalShots[index];
        const timeDelta = Math.abs(eventAt - predicted.at);
        const angleDelta = angularDistance(angle, predicted.angle);
        if (timeDelta > 450 || angleDelta > 0.42) continue;
        const score = timeDelta + angleDelta * 180;
        if (score < bestScore) {
          bestScore = score;
          bestIndex = index;
        }
      }
      if (bestIndex < 0) return null;
      const [predicted] = predictedLocalShots.splice(bestIndex, 1);
      if (predicted) removePredictedVolley(predicted.volleyId);
      return predicted ?? null;
    };

    const reconcilePredictedProjectiles = (
      current: PvpSnapshot,
      renderTime: number,
    ) => {
      const localId = playerIdRef.current;
      if (!localId) return;
      const receivedAt = snapshotReceivedAtRef.current ?? renderTime;
      const networkLeadMs = Math.max(0, renderTime - receivedAt);
      while (
        acknowledgedLocalShotEvents[0] &&
        current.serverTime - acknowledgedLocalShotEvents[0].occurredAt > 1_000
      ) {
        acknowledgedLocalShotEvents.shift();
      }
      reconciledAuthoritativeVolleyIds.clear();
      for (const projectile of current.projectiles) {
        if (
          projectile.ownerId !== localId ||
          seenAuthoritativeLocalProjectileIds.has(projectile.id)
        ) {
          continue;
        }
        seenAuthoritativeLocalProjectileIds.add(projectile.id);
        // Mark every projectile id as seen, but hand off only once per exact
        // authoritative volley; a trailing pellet can never consume the next
        // predicted shot, even at the 12/s attack-rate ceiling.
        if (reconciledAuthoritativeVolleyIds.has(projectile.volleyId)) continue;
        reconciledAuthoritativeVolleyIds.add(projectile.volleyId);
        const acknowledgedEventIndex = acknowledgedLocalShotEvents.findIndex(
          (event) => {
            if (event.volleyId !== undefined) {
              return event.volleyId === projectile.volleyId;
            }
            const sameVolleyAgeDelta =
              projectile.ageMs - (current.serverTime - event.occurredAt);
            return (
              sameVolleyAgeDelta > 0 &&
              sameVolleyAgeDelta <= PVP_AUTHORITATIVE_TICK_MS
            );
          },
        );
        if (acknowledgedEventIndex >= 0) {
          acknowledgedLocalShotEvents.splice(acknowledgedEventIndex, 1);
          continue;
        }
        if (predictedLocalProjectiles.length === 0) continue;
        const projectileAngle = Math.atan2(projectile.vy, projectile.vx);
        const estimatedShotAt =
          renderTime - projectile.ageMs - networkLeadMs;
        consumePredictedShot(estimatedShotAt, projectileAngle);
      }
    };

    const advancePredictedProjectiles = (
      current: PvpSnapshot,
      elapsedSeconds: number,
      renderTime: number,
    ) => {
      for (
        let index = predictedLocalProjectiles.length - 1;
        index >= 0;
        index -= 1
      ) {
        const projectile = predictedLocalProjectiles[index];
        const catchupSeconds = Math.max(0, projectile.pendingCatchupMs ?? 0) / 1_000;
        projectile.pendingCatchupMs = 0;
        const totalElapsedSeconds = elapsedSeconds + catchupSeconds;
        const stepCount = Math.max(
          1,
          Math.min(
            120,
            Math.ceil(elapsedSeconds * 60) + Math.ceil(catchupSeconds * 60),
          ),
        );
        const stepSeconds = totalElapsedSeconds / stepCount;
        const opponent =
          current.players[0]?.id === projectile.ownerId
            ? current.players[1]
            : current.players[0];
        let previousX = projectile.x;
        let previousY = projectile.y;
        let simulatedSeconds = 0;
        for (let step = 0; step < stepCount; step += 1) {
          const liveSeconds = Math.min(
            stepSeconds,
            Math.max(0, projectile.lifeMs) / 1_000,
          );
          if (liveSeconds <= 0) break;
          const alreadyHitOpponent = Boolean(
            opponent && projectile.hitPlayerIds?.has(opponent.id),
          );
          if (
            opponent &&
            opponent.respawnMs <= 0 &&
            !alreadyHitOpponent &&
            projectile.homingStrength > 0
          ) {
            const speed = Math.hypot(projectile.vx, projectile.vy);
            const currentAngle = Math.atan2(projectile.vy, projectile.vx);
            const targetAngle = Math.atan2(
              opponent.y - projectile.y,
              opponent.x - projectile.x,
            );
            const angleDelta = Math.atan2(
              Math.sin(targetAngle - currentAngle),
              Math.cos(targetAngle - currentAngle),
            );
            const steeredAngle =
              currentAngle +
              clamp(
                angleDelta,
                -projectile.homingStrength * liveSeconds,
                projectile.homingStrength * liveSeconds,
              );
            projectile.vx = Math.cos(steeredAngle) * speed;
            projectile.vy = Math.sin(steeredAngle) * speed;
          }
          const segmentStartX = projectile.x;
          const segmentStartY = projectile.y;
          projectile.x += projectile.vx * liveSeconds;
          projectile.y += projectile.vy * liveSeconds;
          projectile.ageMs += liveSeconds * 1_000;
          projectile.lifeMs -= liveSeconds * 1_000;
          simulatedSeconds += liveSeconds;
          previousX = segmentStartX;
          previousY = segmentStartY;

          const collisionRadius = projectile.radius + PVP_BOSS_HIT_RADIUS;
          if (
            opponent &&
            projectile.hitPlayerIds &&
            opponent.respawnMs <= 0 &&
            opponent.invulnerableMs <= 0 &&
            !projectile.hitPlayerIds.has(opponent.id) &&
            distanceToSegmentSquared(
              opponent.x,
              opponent.y,
              segmentStartX,
              segmentStartY,
              projectile.x,
              projectile.y,
            ) <=
              collisionRadius ** 2
          ) {
            projectile.hitPlayerIds.add(opponent.id);
            const piercesTarget = (projectile.pierceRemaining ?? 0) > 0;
            pushTransientEffect({
              kind: "impact",
              x: projectile.x,
              y: projectile.y,
              angle: Math.atan2(projectile.vy, projectile.vx),
              size: projectile.radius * (piercesTarget ? 4.4 : 6.2),
              color: pvpAffinityColor(projectile.affinity),
              affinity: projectile.affinity,
              startedAt:
                renderTime -
                Math.max(0, totalElapsedSeconds - simulatedSeconds) * 1_000,
              durationMs: 260,
              critical: projectile.critical,
              vfxId: projectile.vfxId,
            });
            playGameSfx("playerImpact", {
              pan: clamp(
                (opponent.x - PVP_ARENA_WIDTH / 2) / 520,
                -0.76,
                0.76,
              ),
              gain: piercesTarget ? 0.86 : 1,
            });
            if (piercesTarget) {
              projectile.pierceRemaining =
                Math.max(0, projectile.pierceRemaining ?? 0) - 1;
            } else {
              projectile.lifeMs = 0;
              break;
            }
          }
        }
        projectile.previousX = previousX;
        projectile.previousY = previousY;
        const hitArenaWall =
          projectile.x < 0 ||
          projectile.x > PVP_ARENA_WIDTH ||
          projectile.y < 0 ||
          projectile.y > PVP_ARENA_HEIGHT;
        if (hitArenaWall) {
          pushTransientEffect({
            kind: "impact",
            x: clamp(projectile.x, 0, PVP_ARENA_WIDTH),
            y: clamp(projectile.y, 0, PVP_ARENA_HEIGHT),
            angle: Math.atan2(projectile.vy, projectile.vx),
            size: projectile.radius * 4.4,
            color: pvpAffinityColor(projectile.affinity),
            affinity: projectile.affinity,
            startedAt:
              renderTime -
              Math.max(0, totalElapsedSeconds - simulatedSeconds) * 1_000,
            durationMs: 220,
            critical: false,
            vfxId: projectile.vfxId,
          });
        }
        if (projectile.lifeMs <= 0 || hitArenaWall) {
          predictedLocalProjectiles.splice(index, 1);
        }
      }
      while (
        predictedLocalShots[0] &&
        renderTime - predictedLocalShots[0].at > 900
      ) {
        predictedLocalShots.shift();
      }
    };

    const processCombatEvents = (current: PvpSnapshot, renderTime: number) => {
      const receivedAt = snapshotReceivedAtRef.current ?? renderTime;
      while (
        predictedLocalDashes[0] &&
        renderTime - predictedLocalDashes[0].at > 800
      ) {
        predictedLocalDashes.shift();
      }
      for (const event of current.events) {
        if (event.id <= lastProcessedCombatEventId) continue;
        lastProcessedCombatEventId = event.id;
        const occurredAt = Number.isFinite(event.occurredAt)
          ? event.occurredAt
          : current.serverTime;
        const eventAgeMs = Math.max(
          0,
          current.serverTime - occurredAt + (renderTime - receivedAt),
        );
        const actor = current.players.find((player) => player.id === event.actorId);
        const target = current.players.find((player) => player.id === event.targetId);
        const actorAppearance = actor ? appearanceForPlayer(actor) : {};
        const targetAppearance = target ? appearanceForPlayer(target) : {};
        const affinity = lastAffinityByActor.get(event.actorId) ?? "arcane";
        const color = pvpAffinityColor(affinity);
        const actorAngle = Math.atan2(actor?.aimY ?? 0, actor?.aimX ?? 1);
        const eventProjectile = current.projectiles.find(
          (projectile) =>
            projectile.ownerId === event.actorId &&
            event.volleyId !== undefined &&
            projectile.volleyId === event.volleyId,
        );
        const eventAngle = eventProjectile
          ? Math.atan2(eventProjectile.vy, eventProjectile.vx)
          : actorAngle;
        const actorProjectileRadius =
          actor?.projectileRadius ??
          eventProjectile?.radius ??
          (event.actorId === playerIdRef.current
            ? buildProfile.projectileRadius
            : DEFAULT_PVP_BUILD_PROFILE.projectileRadius);
        const actorPierce = Math.max(
          0,
          Math.floor(
            actor?.pierce ??
              (event.actorId === playerIdRef.current
                ? buildProfile.pierce
                : DEFAULT_PVP_BUILD_PROFILE.pierce),
          ),
        );
        const durationMs =
          event.kind === "dash"
            ? 320
            : event.kind === "defeat"
              ? 520
              : event.kind === "shot"
                ? 200
                : event.kind === "hit"
                  ? 260
                  : event.kind === "impact"
                    ? 220
                    : 340;

        let locallyPredicted = false;
        if (event.actorId === playerIdRef.current && event.kind === "shot") {
          const consumedShot = consumePredictedShot(
            renderTime - eventAgeMs,
            null,
          );
          locallyPredicted = consumedShot !== null;
          if (consumedShot) {
            acknowledgedLocalShotEvents.push({
              occurredAt,
              ...(event.volleyId !== undefined
                ? { volleyId: event.volleyId }
                : {}),
            });
          }
        } else if (
          event.actorId === playerIdRef.current &&
          event.kind === "dash"
        ) {
          const predictedIndex = predictedLocalDashes.findIndex(
            (dash) => Math.abs(renderTime - eventAgeMs - dash.at) <= 450,
          );
          if (predictedIndex >= 0) {
            predictedLocalDashes.splice(predictedIndex, 1);
            locallyPredicted = true;
          }
        }

        const nextShotCount =
          event.kind === "shot"
            ? (shotCountByActor.get(event.actorId) ?? 0) + 1
            : 0;
        if (event.kind === "shot") {
          shotCountByActor.set(event.actorId, nextShotCount);
        }
        const bloodwovenBurstTriggered = Boolean(
          event.kind === "shot" &&
            hasAppearanceLegendaryPower(actorAppearance, "gloves") &&
            bloodwovenReadyByActor.has(event.actorId),
        );
        let bloodwovenBurstAngle = actorAngle;
        if (bloodwovenBurstTriggered) {
          bloodwovenReadyByActor.delete(event.actorId);
          const liveBossTarget = current.players.find(
            (player) => player.id !== event.actorId && player.respawnMs <= 0,
          );
          const bloodwovenBaseAngle = liveBossTarget
            ? Math.atan2(liveBossTarget.y - event.y, liveBossTarget.x - event.x)
            : actorAngle;
          bloodwovenBurstAngle = bloodwovenBaseAngle;
          const referenceProjectile = current.projectiles.find(
            (projectile) =>
              projectile.ownerId === event.actorId &&
              (event.volleyId === undefined ||
                projectile.volleyId === event.volleyId),
          );
          const bloodwovenSpeed =
            Math.max(
              1,
              actor?.projectileSpeed ??
                (referenceProjectile
                  ? Math.hypot(referenceProjectile.vx, referenceProjectile.vy)
                  : event.actorId === playerIdRef.current
                    ? buildProfile.projectileSpeed
                    : DEFAULT_PVP_BUILD_PROFILE.projectileSpeed),
            ) * 1.04;
          const bloodwovenLifeMs =
            actor?.projectileLifeMs ??
            (referenceProjectile
              ? referenceProjectile.ageMs + referenceProjectile.lifeMs
              : event.actorId === playerIdRef.current
                ? buildProfile.projectileLifeMs
                : DEFAULT_PVP_BUILD_PROFILE.projectileLifeMs);
          const initialAgeMs = Math.min(eventAgeMs, bloodwovenLifeMs);
          const bloodwovenProjectileCount =
            LEGENDARY_POWERS.bloodwovenGrip.parameters.projectileCount;
          const bloodwovenSpread = 0.34;
          const cosmeticVolleyId = nextPredictedVolleyId--;
          for (
            let index = 0;
            index < bloodwovenProjectileCount;
            index += 1
          ) {
            const angle =
              bloodwovenBaseAngle +
              (bloodwovenProjectileCount === 1
                ? 0
                : -bloodwovenSpread / 2 +
                  (bloodwovenSpread * index) / (bloodwovenProjectileCount - 1));
            const vx = Math.cos(angle) * bloodwovenSpeed;
            const vy = Math.sin(angle) * bloodwovenSpeed;
            const startX = event.x;
            const startY = event.y - 8;
            const id = nextPredictedProjectileId--;
            predictedLocalProjectiles.push({
              id,
              volleyId: cosmeticVolleyId,
              ownerId: event.actorId,
              x: startX,
              y: startY,
              previousX: startX,
              previousY: startY,
              vx,
              vy,
              radius: Math.max(
                5.5,
                (actor?.projectileRadius ?? referenceProjectile?.radius ?? 5) *
                  1.1,
              ),
              ageMs: 0,
              lifeMs: bloodwovenLifeMs,
              critical: true,
              affinity: "blood",
              vfxId: legendaryVfxId("bloodwovenGrip"),
              spawnedAt: renderTime - eventAgeMs,
              homingStrength: Math.min(
                13,
                actor?.homingStrength ??
                  (event.actorId === playerIdRef.current
                    ? buildProfile.homingStrength
                    : 0),
              ),
              hitPlayerIds: new Set<string>(),
              pierceRemaining: actorPierce,
              pendingCatchupMs: initialAgeMs,
            });
          }
          if (predictedLocalProjectiles.length > 192) {
            predictedLocalProjectiles.splice(
              0,
              predictedLocalProjectiles.length - 192,
            );
          }
        }
        const hitTargetId = event.kind === "hit" ? event.targetId : undefined;
        const nextReceivedHitCount = hitTargetId
          ? (hitCountByActor.get(hitTargetId) ?? 0) + 1
          : 0;
        if (hitTargetId) {
          hitCountByActor.set(hitTargetId, nextReceivedHitCount);
        }
        if (
          event.kind === "hit" &&
          hitTargetId &&
          hasAppearanceLegendaryPower(actorAppearance, "helm")
        ) {
          hunterSigilPulseUntilByTarget.set(
            hitTargetId,
            Math.max(
              hunterSigilPulseUntilByTarget.get(hitTargetId) ?? 0,
              renderTime - eventAgeMs + 180,
            ),
          );
        }
        let bloodwovenReadyTriggered = false;
        if (
          event.kind === "hit" &&
          event.critical &&
          hitTargetId &&
          typeof event.volleyId === "number" &&
          Number.isSafeInteger(event.volleyId) &&
          event.volleyId > 0 &&
          hasAppearanceLegendaryPower(actorAppearance, "gloves")
        ) {
          const landedVolleys =
            landedCriticalVolleyIdsByActor.get(event.actorId) ?? new Set<number>();
          if (!landedCriticalVolleyIdsByActor.has(event.actorId)) {
            landedCriticalVolleyIdsByActor.set(event.actorId, landedVolleys);
          }
          // One authoritative volley identity is shared by its shot and every
          // pellet hit, so a multi-projectile critical attack advances the PVE
          // counter exactly once and adjacent 12/s volleys remain distinct.
          if (!landedVolleys.has(event.volleyId)) {
            landedVolleys.add(event.volleyId);
            const threshold =
              LEGENDARY_POWERS.bloodwovenGrip.parameters.everyCriticalHits;
            const nextCriticalHitCount =
              (criticalHitCountByActor.get(event.actorId) ?? 0) + 1;
            if (nextCriticalHitCount >= threshold) {
              criticalHitCountByActor.set(event.actorId, 0);
              bloodwovenReadyByActor.add(event.actorId);
              bloodwovenReadyTriggered = true;
            } else {
              criticalHitCountByActor.set(event.actorId, nextCriticalHitCount);
            }
          }
        }
        const mirrorTriggered = Boolean(
          hitTargetId &&
            hasAppearanceLegendaryPower(targetAppearance, "offhand") &&
            nextReceivedHitCount %
              LEGENDARY_POWERS.mirrorAegis.parameters.everyHits ===
              0,
        );
        if (mirrorTriggered && hitTargetId) {
          mirrorBarrierUntilByActor.set(
            hitTargetId,
            renderTime -
              eventAgeMs +
              LEGENDARY_POWERS.mirrorAegis.parameters.barrierDurationSeconds *
                1_000,
          );
        }
        if (
          event.kind === "dash" &&
          hasAppearanceLegendaryPower(actorAppearance, "shoulders")
        ) {
          starfallUntilByActor.set(
            event.actorId,
            renderTime -
              eventAgeMs +
              LEGENDARY_POWERS.starfallMantle.parameters.durationSeconds * 1_000,
          );
        }

        if (eventAgeMs >= durationMs) continue;

        if (!locallyPredicted && event.kind !== "dash") {
          pushTransientEffect({
            kind:
              event.kind === "shot"
                ? "muzzle"
                : event.kind === "defeat"
                    ? "defeat"
                    : "impact",
            x: event.x,
            y:
              event.kind === "shot"
                ? pvpPlayerBodyCenterY(event.y)
                : event.y,
            angle:
              event.kind === "hit" || event.kind === "impact"
                ? eventAngle
                : actorAngle,
            size:
              event.kind === "defeat"
                ? 104
                : event.kind === "shot"
                    ? 28 + Math.min(18, (actor?.projectileCount ?? 1) * 2)
                    : event.kind === "hit"
                      ? actorProjectileRadius * (actorPierce > 0 ? 4.4 : 6.2)
                      : event.kind === "impact"
                        ? actorProjectileRadius * 4.4
                        : 46,
            color,
            affinity,
            startedAt: renderTime - eventAgeMs,
            durationMs,
            critical: Boolean(event.critical),
            ...(event.kind === "hit" || event.kind === "impact"
              ? { vfxId: projectileVfxId(affinity) }
              : {}),
          });
        }

        if (event.kind === "dash" && !locallyPredicted) {
          if (hasAppearanceLegendaryPower(actorAppearance, "shoulders")) {
            pushTransientEffect({
              kind: "impact",
              x: event.x,
              y: pvpPlayerBodyCenterY(event.y),
              angle: 0,
              size: 118,
              color: "#f8d98a",
              affinity,
              startedAt: renderTime - eventAgeMs,
              durationMs: 540,
              critical: false,
              vfxId: legendaryVfxId("starfallMantle"),
            });
            playGameSfx("playerDash", { playbackRate: 1.28, gain: 0.7 });
          }
        }
        if (
          event.kind === "shot" &&
          hasAppearanceLegendaryPower(actorAppearance, "weapon") &&
          nextShotCount % LEGENDARY_POWERS.crescentEcho.parameters.everyShots === 0
        ) {
          const liveBossTarget = current.players.find(
            (player) => player.id !== event.actorId && player.respawnMs <= 0,
          );
          const crescentBaseAngle = liveBossTarget
            ? Math.atan2(liveBossTarget.y - event.y, liveBossTarget.x - event.x)
            : actorAngle;
          const referenceProjectile = current.projectiles.find(
            (projectile) =>
              projectile.ownerId === event.actorId &&
              (event.volleyId === undefined ||
                projectile.volleyId === event.volleyId),
          );
          const crescentSpeed =
            Math.max(
              1,
              actor?.projectileSpeed ??
                (referenceProjectile
                  ? Math.hypot(referenceProjectile.vx, referenceProjectile.vy)
                  : event.actorId === playerIdRef.current
                    ? buildProfile.projectileSpeed
                    : DEFAULT_PVP_BUILD_PROFILE.projectileSpeed),
            ) * 0.94;
          const crescentLifeMs =
            actor?.projectileLifeMs ??
            (referenceProjectile
              ? referenceProjectile.ageMs + referenceProjectile.lifeMs
              : event.actorId === playerIdRef.current
                ? buildProfile.projectileLifeMs
                : DEFAULT_PVP_BUILD_PROFILE.projectileLifeMs);
          const initialAgeMs = Math.min(eventAgeMs, crescentLifeMs);
          const cosmeticVolleyId = nextPredictedVolleyId--;
          for (const offset of [-0.34, 0.34]) {
            const angle = crescentBaseAngle + offset;
            const vx = Math.cos(angle) * crescentSpeed;
            const vy = Math.sin(angle) * crescentSpeed;
            const startX = event.x;
            const startY = event.y - 8;
            predictedLocalProjectiles.push({
              id: nextPredictedProjectileId--,
              volleyId: cosmeticVolleyId,
              ownerId: event.actorId,
              x: startX,
              y: startY,
              previousX: startX,
              previousY: startY,
              vx,
              vy,
              radius: Math.max(
                6,
                (actor?.projectileRadius ?? referenceProjectile?.radius ?? 5) *
                  1.2,
              ),
              ageMs: 0,
              lifeMs: crescentLifeMs,
              critical: Boolean(event.critical),
              affinity: "echo",
              vfxId: legendaryVfxId("crescentEcho"),
              spawnedAt: renderTime - eventAgeMs,
              homingStrength: Math.min(
                12,
                actor?.homingStrength ??
                  (event.actorId === playerIdRef.current
                    ? buildProfile.homingStrength
                    : 0),
              ),
              hitPlayerIds: new Set<string>(),
              pierceRemaining: 1 + actorPierce,
              pendingCatchupMs: initialAgeMs,
            });
          }
          if (predictedLocalProjectiles.length > 192) {
            predictedLocalProjectiles.splice(
              0,
              predictedLocalProjectiles.length - 192,
            );
          }
        }
        if (bloodwovenReadyTriggered) {
          pushTransientEffect({
            kind: "impact",
            x: target?.x ?? event.x,
            y: pvpPlayerBodyCenterY(target?.y ?? event.y),
            angle: 0,
            size: 88,
            color: "#ff477f",
            affinity: "blood",
            startedAt: renderTime - eventAgeMs,
            durationMs: 460,
            critical: true,
            vfxId: legendaryVfxId("bloodwovenGrip"),
          });
          playGameSfx("playerCrit", { playbackRate: 0.82, gain: 1.04 });
        }
        if (bloodwovenBurstTriggered) {
          pushTransientEffect({
            kind: "impact",
            x: event.x,
            y: pvpPlayerBodyCenterY(event.y),
            angle: bloodwovenBurstAngle,
            size: 82,
            color: "#ff477f",
            affinity: "blood",
            startedAt: renderTime - eventAgeMs,
            durationMs: 420,
            critical: true,
            vfxId: legendaryVfxId("bloodwovenGrip"),
          });
          playGameSfx("playerCrit", { playbackRate: 0.72, gain: 1.12 });
        }
        if (mirrorTriggered) {
          pushTransientEffect({
            kind: "impact",
            x: target?.x ?? event.x,
            y: pvpPlayerBodyCenterY(target?.y ?? event.y),
            angle: 0,
            size: 210,
            color: "#8df7ff",
            affinity: "frost",
            startedAt: renderTime - eventAgeMs,
            durationMs: 620,
            critical: false,
            vfxId: legendaryVfxId("mirrorAegis"),
          });
          playGameSfx("playerCrit", { playbackRate: 0.78, gain: 1.08 });
        }

        if (event.kind === "shot") {
          if (!locallyPredicted) {
            const attackRate = Math.max(
              0.1,
              actor?.attackRate ?? DEFAULT_PVP_BUILD_PROFILE.attackRate,
            );
            playGameSfx("playerShot", {
              gain: 0.88,
              playbackRate: 1 + Math.min(0.12, attackRate / 100),
            });
          }
          if (event.critical) {
            playGameSfx("playerCrit", { playbackRate: 1 });
          }
        } else if (event.kind === "dash") {
          if (!locallyPredicted) {
            const dashDirection = normalizeVector(
              actor?.vx ?? 0,
              actor?.vy ?? 0,
              actor?.aimX ?? 1,
              actor?.aimY ?? 0,
            );
            playGameSfx("playerDash", {
              pan: clamp(dashDirection.x * 0.45, -0.45, 0.45),
              playbackRate: 1,
            });
          }
        } else if (event.kind === "hit") {
          playGameSfx("playerImpact", {
            pan: clamp((event.x - PVP_ARENA_WIDTH / 2) / 520, -0.76, 0.76),
            gain: actorPierce > 0 ? 0.86 : 1,
          });
        } else if (event.kind === "defeat") {
          playGameSfx("playerImpact", {
            pan: clamp((event.x - PVP_ARENA_WIDTH / 2) / 520, -0.76, 0.76),
            gain: 1.12,
          });
        }
      }
    };

    const drawTransientEffects = (renderTime: number) => {
      for (let index = transientEffects.length - 1; index >= 0; index -= 1) {
        const effect = transientEffects[index];
        const progress = (renderTime - effect.startedAt) / effect.durationMs;
        if (progress >= 1) {
          transientEffects.splice(index, 1);
          continue;
        }
        if (progress < 0) continue;
        const vfxId = effect.vfxId ?? projectileVfxId(effect.affinity);
        const definition = GAMEPLAY_VFX_MANIFEST[vfxId];
        const fade = Math.sin(progress * Math.PI);
        const drawAt = (x: number, y: number, alpha: number, size: number) =>
          drawGameplayVfxFrame(
            context,
            projectileVfxImagesRef.current[gameplayVfxImageKey(vfxId)],
            definition,
            {
              x,
              y,
              size,
              progress,
              angle: effect.angle,
              alpha,
              frameOffset: 0,
              interpolateFrames: false,
            },
          );
        const authored = drawAt(
          effect.x,
          effect.y,
          Math.min(1, fade * 1.38),
          effect.size,
        );
        if (!authored) {
          context.save();
          context.globalCompositeOperation = "lighter";
          context.globalAlpha = fade;
          context.strokeStyle = effect.color;
          context.lineWidth = effect.critical ? 4 : 2;
          context.beginPath();
          context.arc(
            effect.x,
            effect.y,
            effect.size * (0.25 + progress * 0.7),
            0,
            Math.PI * 2,
          );
          context.stroke();
          context.restore();
        }
      }
    };

    const drawProjectile = (
      projectile: PvpRenderableProjectile,
      x: number,
      y: number,
      projectileCount: number,
      renderTime: number,
      layer: "trail" | "core",
    ) => {
      const speed = Math.max(1, Math.hypot(projectile.vx, projectile.vy));
      const angle = Math.atan2(projectile.vy, projectile.vx);
      const radius = projectile.radius;
      const affinity = projectile.affinity;
      const color = pvpAffinityColor(affinity);
      const fadeIn = clamp(projectile.ageMs / 70, 0, 1);
      const fadeOut = clamp(projectile.lifeMs / 140, 0, 1);
      const alpha = fadeIn * fadeOut;
      const dense = projectileCount > 120;
      const hostile = projectile.ownerId !== playerIdRef.current;
      const speedScale = clamp(speed / 660, 0.65, 1.18);
      const tailLength =
        (36 + radius * 3.4) *
        (dense ? 0.76 : 1) *
        speedScale;

      if (
        layer === "trail" &&
        shouldDrawProjectileTrail(projectile.id, hostile, projectileCount)
      ) {
        context.save();
        context.translate(x, y);
        context.rotate(angle);
        context.globalCompositeOperation = "lighter";
        const trail = context.createLinearGradient(-tailLength, 0, radius, 0);
        trail.addColorStop(0, colorWithAlpha(color, 0));
        trail.addColorStop(0.46, colorWithAlpha(color, alpha * 0.18));
        trail.addColorStop(1, colorWithAlpha(color, alpha * 0.86));
        context.strokeStyle = trail;
        context.lineWidth = radius * 1.35;
        context.lineCap = "round";
        context.beginPath();
        context.moveTo(-tailLength, 0);
        context.lineTo(radius * 0.5, 0);
        context.stroke();
        if (affinity === "blood" && !dense) {
          const clock = renderTime / 1_000;
          context.fillStyle = colorWithAlpha("#ffb0c8", alpha * 0.8);
          for (let drop = 0; drop < 3; drop += 1) {
            const dropX = -tailLength * (0.2 + drop * 0.24);
            const dropY =
              Math.sin(clock * 12 + projectile.id + drop * 2.4) * radius;
            context.beginPath();
            context.arc(
              dropX,
              dropY,
              Math.max(1, radius * (0.25 - drop * 0.035)),
              0,
              Math.PI * 2,
            );
            context.fill();
          }
        }
        context.restore();
      }
      if (layer === "trail") return;

      // Expedition keeps legendary metadata on bonus projectiles, while their
      // moving core itself still renders from combat affinity.
      const vfxId = projectileVfxId(affinity);
      const definition = GAMEPLAY_VFX_MANIFEST[vfxId];
      const progress = loopingGameplayVfxProgress(
        projectile.ageMs / 1_000,
        definition,
      );
      const sampleCount = projectileMotionInterpolationCount(
        projectile.previousX,
        projectile.previousY,
        x,
        y,
        radius,
        projectileCount,
        hostile,
      );
      const deltaX = x - projectile.previousX;
      const deltaY = y - projectile.previousY;
      for (let sample = 1; sample <= sampleCount; sample += 1) {
        const sampleProgress = sample / (sampleCount + 1);
        drawGameplayVfxFrame(
          context,
          projectileVfxImagesRef.current[gameplayVfxImageKey(vfxId)],
          definition,
          {
            x: projectile.previousX + deltaX * sampleProgress,
            y: projectile.previousY + deltaY * sampleProgress,
            size: radius,
            progress,
            angle,
            alpha: alpha * (0.1 + sampleProgress * 0.12),
            frameOffset: projectile.id,
          },
        );
      }
      const authored = drawGameplayVfxFrame(
        context,
        projectileVfxImagesRef.current[gameplayVfxImageKey(vfxId)],
        definition,
        {
          x,
          y,
          size: radius,
          progress,
          angle,
          alpha,
          frameOffset: projectile.id,
          interpolateFrames:
            projectileCount <= 48 ||
            (projectileCount <= 96
              ? hostile || Math.abs(projectile.id) % 2 === 0
              : hostile &&
                projectileCount <= 160 &&
                Math.abs(projectile.id) % 2 === 0),
        },
      );
      if (!authored) {
        context.save();
        context.translate(x, y);
        context.rotate(angle);
        context.globalCompositeOperation = "lighter";
        context.fillStyle = color;
        context.shadowColor = color;
        context.shadowBlur = 16;
        context.beginPath();
        context.moveTo(radius * 2.1, 0);
        context.lineTo(-radius * 0.6, radius);
        context.lineTo(-radius * 1.5, 0);
        context.lineTo(-radius * 0.6, -radius);
        context.closePath();
        context.fill();
        context.restore();
      }
    };

    let previousRenderTime: number | null = null;
    let lastProcessedFrameAt = Number.NEGATIVE_INFINITY;
    const render = (renderTime: number) => {
      if (!shouldProcessContinuousFrame(lastProcessedFrameAt, renderTime)) {
        animationFrame = window.requestAnimationFrame(render);
        return;
      }
      lastProcessedFrameAt = renderTime;
      if (document.hidden) {
        previousRenderTime = renderTime;
        animationFrame = window.requestAnimationFrame(render);
        return;
      }
      const backingScale = canvasBackingScaleRef.current;
      context.setTransform(backingScale, 0, 0, backingScale, 0, 0);
      const elapsedSeconds =
        previousRenderTime === null
          ? 0
          : Math.max(0, (renderTime - previousRenderTime) / 1_000);
      previousRenderTime = renderTime;
      drawBackground(renderTime);
      const current = snapshotRef.current;
      if (current) {
        currentProjectileIds.clear();
        const snapshotLeadSeconds =
          current.serverTime > 0 && snapshotReceivedAtRef.current !== null
            ? clamp(
                 (renderTime - snapshotReceivedAtRef.current) / 1_000,
                 0,
                 PVP_REMOTE_EXTRAPOLATION_SECONDS,
               )
             : 0;
        for (const projectile of current.projectiles) {
          lastAffinityByActor.set(projectile.ownerId, projectile.affinity);
        }
        const localId = playerIdRef.current;
        const authoritativeLocalPlayer = current.players.find(
          (player) => player.id === localId,
        );
        const predictedLocalPosition = authoritativeLocalPlayer
          ? updatePredictedLocalPlayer(
              authoritativeLocalPlayer,
              current,
              elapsedSeconds,
              renderTime,
            )
          : undefined;
        processCombatEvents(current, renderTime);
        reconcilePredictedProjectiles(current, renderTime);
        predictLocalWeaponPresentation(
          current,
          authoritativeLocalPlayer,
          predictedLocalPosition,
          renderTime,
        );
        for (const projectile of current.projectiles) {
          currentProjectileIds.add(projectile.id);
          const targetX = projectile.x + projectile.vx * snapshotLeadSeconds;
          const targetY = projectile.y + projectile.vy * snapshotLeadSeconds;
          const rendered = renderedProjectiles.get(projectile.id) ?? {
            x: targetX,
            y: targetY,
          };
          const interpolation =
            elapsedSeconds > 0 ? 1 - Math.exp(-elapsedSeconds * 24) : 1;
          rendered.x += (targetX - rendered.x) * interpolation;
          rendered.y += (targetY - rendered.y) * interpolation;
          renderedProjectiles.set(projectile.id, rendered);
        }
        advancePredictedProjectiles(current, elapsedSeconds, renderTime);
        for (const projectileId of renderedProjectiles.keys()) {
          if (!currentProjectileIds.has(projectileId)) {
            renderedProjectiles.delete(projectileId);
          }
        }
        const totalProjectileCount =
          current.projectiles.length + predictedLocalProjectiles.length;
        for (const projectile of current.projectiles) {
          const rendered = renderedProjectiles.get(projectile.id) ?? projectile;
          drawProjectile(
            projectile,
            rendered.x,
            rendered.y,
            totalProjectileCount,
            renderTime,
            "trail",
          );
        }
        for (const projectile of predictedLocalProjectiles) {
          drawProjectile(
            projectile,
            projectile.x,
            projectile.y,
            totalProjectileCount,
            renderTime,
            "trail",
          );
        }
        for (const player of [...current.players].sort(
          (left, right) => left.y - right.y || left.side - right.side,
        )) {
          const locallyPredicted =
            player.id === localId && predictedLocalPosition !== undefined;
          const target: PvpRenderPosition = locallyPredicted
            ? predictedLocalPosition
            : {
                x: player.x + player.vx * snapshotLeadSeconds,
                y: player.y + player.vy * snapshotLeadSeconds,
                vx: player.vx,
                vy: player.vy,
                dashRemainingMs: Math.max(
                  0,
                  player.dashRemainingMs - snapshotLeadSeconds * 1_000,
                ),
                invulnerableMs: Math.max(
                  0,
                  player.invulnerableMs - snapshotLeadSeconds * 1_000,
                ),
                phantomMarchMoveMs: player.phantomMarchMoveMs ?? 0,
                continuousMoveMultiplier:
                  player.continuousMoveMultiplier ?? 1,
              };
          drawPlayer(
            player,
            elapsedSeconds,
            renderTime,
            target,
            Boolean(locallyPredicted),
          );
        }
        for (const projectile of current.projectiles) {
          const rendered = renderedProjectiles.get(projectile.id) ?? projectile;
          drawProjectile(
            projectile,
            rendered.x,
            rendered.y,
            totalProjectileCount,
            renderTime,
            "core",
          );
        }
        for (const projectile of predictedLocalProjectiles) {
          drawProjectile(
            projectile,
            projectile.x,
            projectile.y,
            totalProjectileCount,
            renderTime,
            "core",
          );
        }
        drawTransientEffects(renderTime);
        drawSouthDoorForeground();
        if (current.phase === "countdown") {
          const remaining = Math.max(0, current.startsAt - Date.now());
          context.textAlign = "center";
          context.font = "700 82px Georgia, serif";
          context.fillStyle = "rgba(250, 224, 168, 0.96)";
          context.shadowColor = "rgba(231, 90, 108, 0.72)";
          context.shadowBlur = 28;
          context.fillText(String(Math.max(1, Math.ceil(remaining / 1_000))), 640, 336);
          context.shadowBlur = 0;
          context.font = "800 12px Pretendard, sans-serif";
          context.letterSpacing = "0.32em";
          context.fillText("기억 결투", 640, 370);
        }
      }
      animationFrame = window.requestAnimationFrame(render);
    };
    animationFrame = window.requestAnimationFrame(render);
    return () => {
      window.cancelAnimationFrame(animationFrame);
      roomAtlas.onload = null;
      roomAtlas.onerror = null;
      fallbackRoom.onload = null;
      fallbackRoom.onerror = null;
      roomAtlas.src = "";
      fallbackRoom.src = "";
    };
  }, [
    activeLocalAppearance,
    appearanceSignature,
    buildProfile,
    result?.matchId,
    activeSnapshot?.matchId,
  ]);

  const handleAim = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    aimRef.current.x = ((event.clientX - rect.left) / rect.width) * PVP_ARENA_WIDTH;
    aimRef.current.y = ((event.clientY - rect.top) / rect.height) * PVP_ARENA_HEIGHT;
    lastAimAtRef.current = performance.now();
  };

  const handleMovePointerDown = (
    event: ReactPointerEvent<HTMLCanvasElement>,
  ) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    handleAim(event);
    moveTargetRef.current = {
      x: aimRef.current.x,
      y: aimRef.current.y,
      active: true,
    };
  };

  const setMobileMove = (x: number, y: number) => {
    if (Math.abs(x) + Math.abs(y) > 0) {
      moveTargetRef.current.active = false;
    }
    mobileMoveRef.current = { x, y };
  };

  const localPlayer =
    activeSnapshot?.players.find(
      (participant) => participant.id === activePlayerId,
    ) ?? null;
  const opponent =
    activeSnapshot?.players.find(
      (participant) => participant.id !== activePlayerId,
    ) ?? null;
  const matchActive = Boolean(
    activeMatch && activeSnapshot && activeSnapshot.phase !== "finished",
  );
  const matchView = matchActive || Boolean(result);
  const didWin = Boolean(
    result && result.winnerId && result.winnerId === activePlayerId,
  );
  const isDraw = Boolean(result && result.winnerId === null);
  const localGearCount = Object.keys(
    sanitizePvpAppearance(localPlayer?.appearance ?? activeLocalAppearance),
  ).length;
  const opponentGearCount = Object.keys(
    sanitizePvpAppearance(opponent?.appearance),
  ).length;

  return (
    <main
      className={`pvp-screen is-${localShowcase ? "online" : connection}${
        matchView ? " is-match-view" : ""
      }`}
      data-pvp-view={matchView ? "match" : "lobby"}
      data-pvp-showcase={localShowcase ? "match" : undefined}
      data-pvp-local-gear-count={localGearCount}
      data-pvp-opponent-gear-count={opponentGearCount}
    >
      <div className="pvp-backdrop" aria-hidden="true" />
      <header className="pvp-navigation">
        <Link href="/?town=1" className="pvp-back-link">← 기억 광장으로</Link>
        <div className="pvp-title-lockup">
          <small>MUJINDO ONLINE</small>
          <strong>기억 결투</strong>
        </div>
        <div className={`pvp-network-state is-${connection}`}>
          <i aria-hidden="true" />
          <span>{connectionLabel(connection)}</span>
          <b>{online}명</b>
        </div>
      </header>

      {!matchActive && !result ? (
        <section className="pvp-lobby">
          <div className="pvp-lobby-copy">
            <span className="pvp-eyebrow">1 VS 1 · EQUIPMENT POWER ARENA</span>
            <h1>기억은 강함을<br />증명하고 싶어 한다</h1>
            <p>
              마지막 쉼터에 장착한 장비 전투력이 그대로 적용됩니다. 레벨·증강·상대 전투력에
              따른 보정은 없으며, 상대 기억은 원정의 보스와 같은 판정으로 싸웁니다.
            </p>
            <div className="pvp-rule-strip">
              <span><b>90</b>초</span>
              <span><b>3</b>킬 선취</span>
              <span><b>BOSS</b> 판정</span>
            </div>
          </div>

          <aside className="pvp-lobby-panel">
            <div className="pvp-panel-heading">
              <small>DUELIST PROFILE</small>
              <strong>결투 준비</strong>
            </div>
            <div className="pvp-character-identity">
              <small>선택 캐릭터 · SLOT {activeCharacterSlot ?? "--"}</small>
              {activeCharacterDisplayName ? (
                <strong>{activeCharacterDisplayName}</strong>
              ) : (
                <>
                  <strong>닉네임 설정이 필요합니다</strong>
                  <p>캐릭터 선택 화면에서 사용할 슬롯과 닉네임을 먼저 설정해 주세요.</p>
                  <Link href="/">캐릭터 선택으로</Link>
                </>
              )}
            </div>
            <div className="pvp-readiness">
              <span><i className={connection === "online" ? "is-ready" : ""} />실시간 서버</span>
              <span><i className="is-ready" />장비 전투력 직결</span>
              <span><i className="is-ready" />원정 전투 감각</span>
            </div>
            <div className="pvp-build-profile" aria-label="현재 PVP 빌드 프로필">
              <div>
                <small>장착 장비 기준</small>
                <strong>전투력 {buildProfile.equipmentPower.toLocaleString("ko-KR")}</strong>
              </div>
              <span>
                공격 속도 {buildProfile.attackRate.toFixed(2)}/초 · 투사체 {buildProfile.projectileCount}발 · 이동 {Math.round(buildProfile.moveSpeed)}
              </span>
            </div>
            <p className="pvp-notice" role="status">{notice}</p>
            {queued ? (
              <div className="pvp-queue-card">
                <span className="pvp-search-radar" aria-hidden="true" />
                <small>기억 파장 탐색 중</small>
                <strong>상대를 찾고 있습니다</strong>
                <p>대기 순번 {queuePosition ?? 1} · 접속자 {online}명</p>
                <button type="button" onClick={cancelQueue}>탐색 취소</button>
              </div>
            ) : (
              <button
                type="button"
                className="pvp-matchmake-button"
                onClick={enterQueue}
                disabled={
                  connection !== "online" || !activeCharacterDisplayName
                }
              >
                <span>일반전 찾기</span>
                <small>
                  {!activeCharacterDisplayName
                    ? "캐릭터 선택 화면에서 닉네임을 설정해 주세요"
                    : connection === "online"
                      ? "온라인 1대1 매칭 시작"
                      : "서버 연결을 기다리는 중"}
                </small>
              </button>
            )}
            <footer>
              <span>WASD 이동</span>
              <span>마우스 조준 · 자동 공격</span>
              <span>SPACE 회피</span>
            </footer>
          </aside>
        </section>
      ) : (
        <section className="pvp-match-stage">
          <div className="pvp-match-hud">
            <article className="pvp-combatant is-local">
              <small>나의 기억</small>
              <strong>{localPlayer?.name ?? displayName}</strong>
              <div><i style={{ width: `${clamp(((localPlayer?.hp ?? 0) / (localPlayer?.maxHp || 100)) * 100, 0, 100)}%` }} /></div>
              <span>HP {Math.ceil(localPlayer?.hp ?? 0)}/{Math.ceil(localPlayer?.maxHp ?? 0)} · 전투력 {(localPlayer?.equipmentPower ?? buildProfile.equipmentPower).toLocaleString("ko-KR")}</span>
            </article>
            <div className="pvp-scoreboard">
              <small>{activeSnapshot?.phase === "countdown" ? "결투 동기화" : "3킬 선취"}</small>
              <strong><b>{localPlayer?.score ?? 0}</b><i>:</i><b>{opponent?.score ?? 0}</b></strong>
              <span>{formatClock(activeSnapshot?.remainingMs ?? 90_000)} · 보스 판정 · 무보정 · {localShowcase ? "LOCAL QA" : `${ping ?? "--"}ms`}</span>
            </div>
            <article className="pvp-combatant is-opponent">
              <small>상대 기억</small>
              <strong>{opponent?.name ?? activeMatch?.opponentName ?? "상대 탐색 중"}</strong>
              <div><i style={{ width: `${clamp(((opponent?.hp ?? 0) / (opponent?.maxHp || 100)) * 100, 0, 100)}%` }} /></div>
              <span>{opponent?.connected === false ? "재접속 대기 중" : `HP ${Math.ceil(opponent?.hp ?? 0)}/${Math.ceil(opponent?.maxHp ?? 0)} · 전투력 ${(opponent?.equipmentPower ?? 0).toLocaleString("ko-KR")}`}</span>
            </article>
          </div>

          <canvas
            ref={canvasRef}
            className="pvp-canvas"
            onPointerMove={handleAim}
            onPointerDown={handleMovePointerDown}
            aria-label="온라인 기억 결투 경기장"
          />

          <div className="pvp-mobile-controls" aria-label="모바일 결투 조작">
            <div className="pvp-mobile-pad">
              <button onPointerDown={() => setMobileMove(0, -1)} onPointerUp={() => setMobileMove(0, 0)} onPointerCancel={() => setMobileMove(0, 0)} onPointerLeave={() => setMobileMove(0, 0)}>↑</button>
              <button onPointerDown={() => setMobileMove(-1, 0)} onPointerUp={() => setMobileMove(0, 0)} onPointerCancel={() => setMobileMove(0, 0)} onPointerLeave={() => setMobileMove(0, 0)}>←</button>
              <button onPointerDown={() => setMobileMove(1, 0)} onPointerUp={() => setMobileMove(0, 0)} onPointerCancel={() => setMobileMove(0, 0)} onPointerLeave={() => setMobileMove(0, 0)}>→</button>
              <button onPointerDown={() => setMobileMove(0, 1)} onPointerUp={() => setMobileMove(0, 0)} onPointerCancel={() => setMobileMove(0, 0)} onPointerLeave={() => setMobileMove(0, 0)}>↓</button>
            </div>
            <button className="pvp-mobile-dash" onPointerDown={() => { dashQueuedRef.current = true; predictionDashQueuedRef.current = true; discardQueuedDashRef.current = false; }}>회피</button>
          </div>

          {result && (
            <div className={`pvp-result ${didWin ? "is-victory" : isDraw ? "is-draw" : "is-defeat"}`}>
              <small>MEMORY DUEL COMPLETE</small>
              <h2>{didWin ? "승리의 문장" : isDraw ? "끝나지 않은 쉼표" : "패배한 기억"}</h2>
              <p>
                {localPlayer?.score ?? 0} : {opponent?.score ?? 0}
                <span>{result.reason === "disconnect" ? "상대 연결 종료" : result.reason === "timeout" ? "제한시간 종료" : result.reason === "draw" ? "동점" : "목표 점수 달성"}</span>
              </p>
              <div>
                <button type="button" onClick={enterQueue}>다시 상대 찾기</button>
                <Link href="/?town=1">기억 광장으로 돌아가기</Link>
              </div>
            </div>
          )}
        </section>
      )}
    </main>
  );
}
