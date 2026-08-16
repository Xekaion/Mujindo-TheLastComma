"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import Link from "next/link";
import {
  DEFAULT_PVP_BUILD_PROFILE,
  PVP_ARENA_HEIGHT,
  PVP_ARENA_WIDTH,
  PVP_INPUT_RATE_HZ,
  PVP_MAX_TOTAL_AUGMENT_STACKS,
  calculatePvpBuildRating,
  calculatePvpOffenseScale,
  sanitizeDisplayName,
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
  getLocalDisplayName,
  getRealtimeClient,
  type RealtimeConnectionState,
} from "../realtime-client";
import {
  calculateEquipmentCombatPower,
  reconcileEquipmentLevelRequirements,
} from "../equipment";
import {
  PAPERDOLL_BODY_PATH,
  PAPERDOLL_WORLD_RENDER_HEIGHT,
  PAPERDOLL_WORLD_RENDER_WIDTH,
  createPaperdollGearSignature,
  drawPaperdollCharacterDirect,
  paperdollLayerPathsForLoadout,
  paperdollLoadoutFromEquipment,
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
  loopingGameplayVfxProgress,
  projectileVfxId,
  type GameplayVfxId,
} from "../augment-vfx";
import { isLocalPvpShowcaseRequest } from "../pvp-showcase";
import "./pvp.css";

type PvpArenaProps = {
  suggestedName?: string | null;
};

type MatchFoundMessage = Extract<RealtimeServerMessage, { type: "match_found" }>;
type MatchResultMessage = Extract<RealtimeServerMessage, { type: "match_result" }>;

const PVP_PLAYER_GROUND_OFFSET_Y = 8;
const PVP_ROOM_VISUAL = ROOM_DOOR_VISUALS.roomElite;
const PVP_ROOM_FRAME = roomDoorAtlasFrameSourceRect(0);
const PVP_PROJECTILE_VFX = {
  0: projectileVfxId("arcane"),
  1: projectileVfxId("blood"),
} as const satisfies Record<0 | 1, GameplayVfxId>;

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
  balanceVersion: 3,
  vitalityMultiplier: 1.38,
  targetTtkSeconds: 4.5,
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
      hp: 934,
      maxHp: 1_120,
      score: 2,
      dashCooldownMs: 0,
      respawnMs: 0,
      connected: true,
      lastInputSequence: 231,
      buildRating: 6_639,
      offenseScale: 1.42,
      projectileDamage: 146,
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
      hp: 781,
      maxHp: 1_120,
      score: 1,
      dashCooldownMs: 420,
      respawnMs: 0,
      connected: true,
      lastInputSequence: 227,
      buildRating: 7_104,
      offenseScale: 1.51,
      projectileDamage: 151,
      appearance: PVP_SHOWCASE_OPPONENT_APPEARANCE,
    },
  ],
  projectiles: [
    { id: 41, ownerId: PVP_SHOWCASE_PLAYER_ID, x: 618, y: 360, vx: 650, vy: -78, radius: 8 },
    { id: 42, ownerId: PVP_SHOWCASE_OPPONENT_ID, x: 730, y: 346, vx: -642, vy: 102, radius: 8 },
  ],
};

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.max(minimum, Math.min(maximum, value));

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
  return sanitizePvpBuildProfile({
    level: save.player.level,
    equipmentPower: calculateEquipmentCombatPower(gear.equipment),
    augmentStacks: Object.values(save.player.augments).reduce(
      (total, stacks) => total + stacks,
      0,
    ),
  });
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

export default function PvpArena({ suggestedName }: PvpArenaProps) {
  const localShowcase = useSyncExternalStore(
    subscribeToLocalShowcaseLocation,
    localPvpShowcaseBrowserSnapshot,
    localPvpShowcaseServerSnapshot,
  );
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const paperdollImagesRef = useRef(createBrowserPaperdollImageStore());
  const equippedRarityVfxImagesRef = useRef<
    Partial<Record<EquippedRarityVfxTier, HTMLImageElement>>
  >({});
  const projectileVfxImagesRef = useRef<
    Partial<Record<GameplayVfxId, HTMLImageElement>>
  >({});
  const snapshotRef = useRef<PvpSnapshot | null>(null);
  const snapshotReceivedAtRef = useRef<number | null>(null);
  const playerIdRef = useRef<string | null>(null);
  const keysRef = useRef(new Set<string>());
  const aimRef = useRef({ x: PVP_ARENA_WIDTH / 2, y: PVP_ARENA_HEIGHT / 2 });
  const dashQueuedRef = useRef(false);
  const mobileMoveRef = useRef({ x: 0, y: 0 });
  const sequenceRef = useRef(0);
  const [connection, setConnection] = useState<RealtimeConnectionState>("idle");
  const [online, setOnline] = useState(0);
  const [playerId, setPlayerId] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState(() =>
    sanitizeDisplayName(suggestedName ?? "방랑자"),
  );
  const [draftName, setDraftName] = useState(displayName);
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
  const [notice, setNotice] = useState("마지막 쉼터의 빌드를 읽고 적응형 생존력을 계산합니다.");

  const activePlayerId = localShowcase ? PVP_SHOWCASE_PLAYER_ID : playerId;
  const activeMatch = localShowcase ? PVP_SHOWCASE_MATCH : match;
  const activeSnapshot = localShowcase ? PVP_SHOWCASE_SNAPSHOT : snapshot;
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
      const localName = getLocalDisplayName(suggestedName);
      setDisplayName(localName);
      setDraftName(localName);
      setBuildProfile(readLocalPvpBuildProfile());
      setLocalPaperdollLoadout(readLocalPvpPaperdollLoadout());
    });
    return () => window.cancelAnimationFrame(frame);
  }, [localShowcase, suggestedName]);

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

    for (const vfxId of Object.values(PVP_PROJECTILE_VFX)) {
      const image = new Image();
      image.decoding = "async";
      image.onload = () => {
        if (!disposed) images[vfxId] = image;
      };
      image.src = GAMEPLAY_VFX_MANIFEST[vfxId].assetPath;
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
          setDisplayName(event.displayName);
          setDraftName(event.displayName);
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
          setNotice(`${event.opponentName}의 기억과 결투가 성립되었습니다.`);
          break;
        case "pvp_snapshot":
          snapshotReceivedAtRef.current = performance.now();
          snapshotRef.current = event;
          setSnapshot(event);
          break;
        case "match_result":
          setResult(event);
          setQueued(false);
          break;
        case "pong":
          setPing(Math.max(0, Date.now() - event.clientTime));
          break;
        case "error":
          setNotice(event.message);
          break;
      }
    }, suggestedName);
    return unsubscribe;
  }, [localShowcase, suggestedName]);

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
    setResult(null);
    setSnapshot(null);
    snapshotRef.current = null;
    snapshotReceivedAtRef.current = null;
    setNotice("대전 상대의 기억 파장을 탐색하고 있습니다.");
    getRealtimeClient().joinQueue(buildProfile, activeLocalAppearance);
  }, [activeLocalAppearance, buildProfile]);

  const cancelQueue = useCallback(() => {
    getRealtimeClient().cancelQueue();
    setQueued(false);
    setQueuePosition(null);
    setNotice("매칭 탐색을 중단했습니다.");
  }, []);

  const updateProfile = (event: FormEvent) => {
    event.preventDefault();
    if (queued || (snapshot && snapshot.phase !== "finished")) return;
    const normalized = getRealtimeClient().setDisplayName(draftName);
    playerIdRef.current = null;
    setPlayerId(null);
    setDisplayName(normalized);
    setDraftName(normalized);
    setNotice("결투명이 새로운 기억에 새겨졌습니다.");
  };

  useEffect(() => {
    const preventGameKeys = (event: KeyboardEvent) => {
      if (["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright", " "].includes(event.key.toLowerCase())) {
        event.preventDefault();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      preventGameKeys(event);
      keysRef.current.add(event.key.toLowerCase());
      if (event.key === " " && !event.repeat) dashQueuedRef.current = true;
    };
    const onKeyUp = (event: KeyboardEvent) => {
      preventGameKeys(event);
      keysRef.current.delete(event.key.toLowerCase());
    };
    const clear = () => {
      keysRef.current.clear();
      mobileMoveRef.current = { x: 0, y: 0 };
      dashQueuedRef.current = false;
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
      const keys = keysRef.current;
      let moveX =
        (keys.has("d") || keys.has("arrowright") ? 1 : 0) -
        (keys.has("a") || keys.has("arrowleft") ? 1 : 0) +
        mobileMoveRef.current.x;
      let moveY =
        (keys.has("s") || keys.has("arrowdown") ? 1 : 0) -
        (keys.has("w") || keys.has("arrowup") ? 1 : 0) +
        mobileMoveRef.current.y;
      const moveLength = Math.hypot(moveX, moveY);
      if (moveLength > 1) {
        moveX /= moveLength;
        moveY /= moveLength;
      }
      let aimX = aimRef.current.x - localPlayer.x;
      let aimY = aimRef.current.y - localPlayer.y;
      if (Math.hypot(aimX, aimY) < 12 && opponent) {
        aimX = opponent.x - localPlayer.x;
        aimY = opponent.y - localPlayer.y;
      }
      const aimLength = Math.hypot(aimX, aimY) || 1;
      sequenceRef.current += 1;
      const input: PvpInput = {
        sequence: sequenceRef.current,
        moveX,
        moveY,
        aimX: aimX / aimLength,
        aimY: aimY / aimLength,
        fire: current.phase === "playing" && localPlayer.respawnMs <= 0,
        dash: dashQueuedRef.current,
      };
      dashQueuedRef.current = false;
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
    const roomVignette = context.createRadialGradient(
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
    const renderedPositions = new Map<
      string,
      { x: number; y: number; facing: number; walkCycle: number }
    >();
    const renderedProjectiles = new Map<number, { x: number; y: number }>();
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
    let canvasCssScale = 1;
    const cacheCanvasCssScale = (renderedWidth: number, renderedHeight: number) => {
      if (renderedWidth <= 0 || renderedHeight <= 0) return;
      canvasCssScale = Math.max(
        0.01,
        Math.min(
          renderedWidth / PVP_ARENA_WIDTH,
          renderedHeight / PVP_ARENA_HEIGHT,
        ),
      );
    };
    const initialCanvasRect = canvas.getBoundingClientRect();
    cacheCanvasCssScale(initialCanvasRect.width, initialCanvasRect.height);
    const canvasResizeObserver = new ResizeObserver(([entry]) => {
      if (!entry) return;
      cacheCanvasCssScale(entry.contentRect.width, entry.contentRect.height);
    });
    canvasResizeObserver.observe(canvas);
    const readableCanvasFontSize = (basePx: number, minimumCssPx: number) =>
      Math.max(basePx, minimumCssPx / canvasCssScale);

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
      context.fillStyle = roomVignette;
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
      context.fillStyle = roomVignette;
      context.fillRect(0, 0, PVP_ARENA_WIDTH, PVP_ARENA_HEIGHT);
      context.restore();
    };

    const drawPlayer = (
      player: PvpPlayerSnapshot,
      elapsedSeconds: number,
      renderTime: number,
    ) => {
      const targetFacing = characterFacingForVector(
        Math.abs(player.vx) + Math.abs(player.vy) > 3 ? player.vx : player.aimX,
        Math.abs(player.vx) + Math.abs(player.vy) > 3 ? player.vy : player.aimY,
        player.side === 0 ? 6 : 2,
      );
      const rendered = renderedPositions.get(player.id) ?? {
        x: player.x,
        y: player.y,
        facing: targetFacing,
        walkCycle: CHARACTER_IDLE_FRAME,
      };
      const previousRenderedX = rendered.x;
      const previousRenderedY = rendered.y;
      rendered.x += (player.x - rendered.x) * 0.34;
      rendered.y += (player.y - rendered.y) * 0.34;
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
            undefined,
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
      const alpha = player.respawnMs > 0 ? 0.3 : 1;
      context.save();
      context.globalAlpha = alpha;
      const movementSpeed = Math.hypot(player.vx, player.vy);
      if (movementSpeed > 420) {
        const dashLength = clamp(movementSpeed * 0.095, 46, 92);
        const dashAngle = Math.atan2(player.vy, player.vx);
        const dashTrail = context.createLinearGradient(
          rendered.x - Math.cos(dashAngle) * dashLength,
          rendered.y - Math.sin(dashAngle) * dashLength,
          rendered.x,
          rendered.y,
        );
        dashTrail.addColorStop(0, `${accent}00`);
        dashTrail.addColorStop(0.72, `${accent}42`);
        dashTrail.addColorStop(1, `${accent}a8`);
        context.strokeStyle = dashTrail;
        context.lineWidth = 18;
        context.lineCap = "round";
        context.shadowColor = accent;
        context.shadowBlur = 16;
        context.beginPath();
        context.moveTo(
          rendered.x - Math.cos(dashAngle) * dashLength,
          rendered.y - Math.sin(dashAngle) * dashLength,
        );
        context.lineTo(rendered.x, rendered.y);
        context.stroke();
        context.shadowBlur = 0;
      }
      context.fillStyle = "rgba(0,0,0,.55)";
      context.beginPath();
      context.ellipse(rendered.x, rendered.y + 18, 28, 12, 0, 0, Math.PI * 2);
      context.fill();
      const bodyAtlas = paperdollImagesRef.current.get(PAPERDOLL_BODY_PATH);
      const appearance = appearanceForPlayer(player);
      if (
        bodyAtlas?.complete &&
        bodyAtlas.naturalWidth > 0 &&
        bodyAtlas.naturalHeight > 0
      ) {
        context.shadowColor = accent;
        context.shadowBlur = 16;
        const appearanceDrawn = drawPaperdollCharacterDirect(context, {
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
        if (appearanceDrawn) {
          context.shadowBlur = 0;
          context.shadowColor = "transparent";
          drawEquippedRarityVfx(context, {
            plan: rarityVfxPlanForPlayer(player),
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
        }
        if (!appearanceDrawn) {
          context.fillStyle = accent;
          context.beginPath();
          context.arc(rendered.x, rendered.y, 25, 0, Math.PI * 2);
          context.fill();
        }
      } else {
        context.fillStyle = accent;
        context.beginPath();
        context.arc(rendered.x, rendered.y, 25, 0, Math.PI * 2);
        context.fill();
      }
      context.restore();

      context.font = `700 ${readableCanvasFontSize(12, 11)}px Pretendard, sans-serif`;
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

    let previousRenderTime: number | null = null;
    const render = (renderTime: number) => {
      const elapsedSeconds =
        previousRenderTime === null
          ? 0
          : Math.min(0.1, Math.max(0, (renderTime - previousRenderTime) / 1_000));
      previousRenderTime = renderTime;
      drawBackground(renderTime);
      const current = snapshotRef.current;
      if (current) {
        const currentProjectileIds = new Set<number>();
        const snapshotLeadSeconds =
          current.serverTime > 0 && snapshotReceivedAtRef.current !== null
            ? clamp(
                (renderTime - snapshotReceivedAtRef.current) / 1_000,
                0,
                0.11,
              )
            : 0;
        for (const projectile of current.projectiles) {
          currentProjectileIds.add(projectile.id);
          const owner = current.players.find(
            (player) => player.id === projectile.ownerId,
          );
          const side = owner?.side ?? 0;
          const accent = side === 0 ? "#71e8ff" : "#ff637e";
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
          const speed = Math.max(1, Math.hypot(projectile.vx, projectile.vy));
          const angle = Math.atan2(projectile.vy, projectile.vx);
          const tailLength = 34 + projectile.radius * 3.2;
          context.save();
          const trail = context.createLinearGradient(
            rendered.x - (projectile.vx / speed) * tailLength,
            rendered.y - (projectile.vy / speed) * tailLength,
            rendered.x,
            rendered.y,
          );
          trail.addColorStop(0, `${accent}00`);
          trail.addColorStop(0.52, `${accent}32`);
          trail.addColorStop(1, `${accent}d8`);
          context.globalCompositeOperation = "lighter";
          context.strokeStyle = trail;
          context.lineWidth = projectile.radius * 1.18;
          context.lineCap = "round";
          context.shadowColor = accent;
          context.shadowBlur = 14;
          context.beginPath();
          context.moveTo(
            rendered.x - (projectile.vx / speed) * tailLength,
            rendered.y - (projectile.vy / speed) * tailLength,
          );
          context.lineTo(rendered.x, rendered.y);
          context.stroke();
          context.restore();

          const vfxId = PVP_PROJECTILE_VFX[side];
          const definition = GAMEPLAY_VFX_MANIFEST[vfxId];
          const authoredDrawn = drawGameplayVfxFrame(
            context,
            projectileVfxImagesRef.current[vfxId],
            definition,
            {
              x: rendered.x,
              y: rendered.y,
              size: projectile.radius,
              progress: loopingGameplayVfxProgress(
                renderTime / 1_000 + projectile.id * 0.037,
                definition,
              ),
              angle,
              frameOffset: projectile.id,
              interpolateFrames: true,
            },
          );
          if (!authoredDrawn) {
            context.save();
            context.translate(rendered.x, rendered.y);
            context.rotate(angle);
            context.globalCompositeOperation = "lighter";
            context.fillStyle = accent;
            context.shadowColor = accent;
            context.shadowBlur = 16;
            context.beginPath();
            context.moveTo(projectile.radius * 2.1, 0);
            context.lineTo(-projectile.radius * 0.6, projectile.radius);
            context.lineTo(-projectile.radius * 1.5, 0);
            context.lineTo(-projectile.radius * 0.6, -projectile.radius);
            context.closePath();
            context.fill();
            context.restore();
          }
        }
        for (const projectileId of renderedProjectiles.keys()) {
          if (!currentProjectileIds.has(projectileId)) {
            renderedProjectiles.delete(projectileId);
          }
        }
        for (const player of [...current.players].sort(
          (left, right) => left.y - right.y || left.side - right.side,
        )) {
          drawPlayer(player, elapsedSeconds, renderTime);
        }
        drawSouthDoorForeground();
        if (current.phase === "countdown") {
          const remaining = Math.max(0, current.startsAt - Date.now());
          context.textAlign = "center";
          context.font = `700 ${readableCanvasFontSize(82, 11)}px Georgia, serif`;
          context.fillStyle = "rgba(250, 224, 168, 0.96)";
          context.shadowColor = "rgba(231, 90, 108, 0.72)";
          context.shadowBlur = 28;
          context.fillText(String(Math.max(1, Math.ceil(remaining / 1_000))), 640, 336);
          context.shadowBlur = 0;
          context.font = `800 ${readableCanvasFontSize(12, 10)}px Pretendard, sans-serif`;
          context.letterSpacing = "0.32em";
          context.fillText("기억 결투", 640, 370);
        }
      }
      animationFrame = window.requestAnimationFrame(render);
    };
    animationFrame = window.requestAnimationFrame(render);
    return () => {
      canvasResizeObserver.disconnect();
      window.cancelAnimationFrame(animationFrame);
      roomAtlas.onload = null;
      roomAtlas.onerror = null;
      fallbackRoom.onload = null;
      fallbackRoom.onerror = null;
      roomAtlas.src = "";
      fallbackRoom.src = "";
    };
  }, [activeLocalAppearance, appearanceSignature, result?.matchId, activeSnapshot?.matchId]);

  const handleAim = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    aimRef.current.x = ((event.clientX - rect.left) / rect.width) * PVP_ARENA_WIDTH;
    aimRef.current.y = ((event.clientY - rect.top) / rect.height) * PVP_ARENA_HEIGHT;
  };

  const setMobileMove = (x: number, y: number) => {
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
  const localBuildRating = calculatePvpBuildRating(buildProfile);
  const localOffenseScale = calculatePvpOffenseScale(buildProfile);
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
            <span className="pvp-eyebrow">1 VS 1 · ADAPTIVE BUILD ARENA</span>
            <h1>기억은 강함을<br />증명하고 싶어 한다</h1>
            <p>
              마지막 쉼터에 저장된 레벨·장비·증강이 화력에 반영됩니다. 매치의 최고 화력을
              기준으로 양쪽 최대 체력이 함께 조정되어 빌드 우위는 남고 한방사는 사라집니다.
            </p>
            <div className="pvp-rule-strip">
              <span><b>90</b>초</span>
              <span><b>3</b>킬 선취</span>
              <span><b>4.5s</b> 목표 생존</span>
            </div>
          </div>

          <aside className="pvp-lobby-panel">
            <div className="pvp-panel-heading">
              <small>DUELIST PROFILE</small>
              <strong>결투 준비</strong>
            </div>
            <form onSubmit={updateProfile} className="pvp-name-form">
              <label htmlFor="pvp-display-name">월드에 표시될 이름</label>
              <div>
                <input
                  id="pvp-display-name"
                  value={draftName}
                  onChange={(event) => setDraftName(event.target.value)}
                  maxLength={18}
                  disabled={queued}
                  autoComplete="nickname"
                />
                <button type="submit" disabled={queued || draftName.trim() === displayName}>
                  새기기
                </button>
              </div>
            </form>
            <div className="pvp-readiness">
              <span><i className={connection === "online" ? "is-ready" : ""} />실시간 서버</span>
              <span><i className="is-ready" />적응형 생존력</span>
              <span><i className="is-ready" />8방향 동기화</span>
            </div>
            <div className="pvp-build-profile" aria-label="현재 PVP 빌드 프로필">
              <div>
                <small>마지막 쉼터 빌드</small>
                <strong>LV.{buildProfile.level} · RATING {localBuildRating.toLocaleString("ko-KR")}</strong>
              </div>
              <span>
                장비 {buildProfile.equipmentPower.toLocaleString("ko-KR")} · 증강 {buildProfile.augmentStacks}/{PVP_MAX_TOTAL_AUGMENT_STACKS} · 예상 화력 ×{localOffenseScale.toFixed(2)}
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
                disabled={connection !== "online"}
              >
                <span>일반전 찾기</span>
                <small>{connection === "online" ? "온라인 1대1 매칭 시작" : "서버 연결을 기다리는 중"}</small>
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
              <span>HP {Math.ceil(localPlayer?.hp ?? 0)}/{Math.ceil(localPlayer?.maxHp ?? 0)} · 화력 ×{(localPlayer?.offenseScale ?? 1).toFixed(2)}</span>
            </article>
            <div className="pvp-scoreboard">
              <small>{activeSnapshot?.phase === "countdown" ? "결투 동기화" : "3킬 선취"}</small>
              <strong><b>{localPlayer?.score ?? 0}</b><i>:</i><b>{opponent?.score ?? 0}</b></strong>
              <span>{formatClock(activeSnapshot?.remainingMs ?? 90_000)} · 생존력 ×{(activeSnapshot?.vitalityMultiplier ?? 1).toFixed(2)} · {localShowcase ? "LOCAL QA" : `${ping ?? "--"}ms`}</span>
            </div>
            <article className="pvp-combatant is-opponent">
              <small>상대 기억</small>
              <strong>{opponent?.name ?? activeMatch?.opponentName ?? "상대 탐색 중"}</strong>
              <div><i style={{ width: `${clamp(((opponent?.hp ?? 0) / (opponent?.maxHp || 100)) * 100, 0, 100)}%` }} /></div>
              <span>{opponent?.connected === false ? "재접속 대기 중" : `HP ${Math.ceil(opponent?.hp ?? 0)}/${Math.ceil(opponent?.maxHp ?? 0)} · 화력 ×${(opponent?.offenseScale ?? 1).toFixed(2)}`}</span>
            </article>
          </div>

          <canvas
            ref={canvasRef}
            width={PVP_ARENA_WIDTH}
            height={PVP_ARENA_HEIGHT}
            className="pvp-canvas"
            onPointerMove={handleAim}
            onPointerDown={handleAim}
            aria-label="온라인 기억 결투 경기장"
          />

          <div className="pvp-mobile-controls" aria-label="모바일 결투 조작">
            <div className="pvp-mobile-pad">
              <button onPointerDown={() => setMobileMove(0, -1)} onPointerUp={() => setMobileMove(0, 0)} onPointerCancel={() => setMobileMove(0, 0)} onPointerLeave={() => setMobileMove(0, 0)}>↑</button>
              <button onPointerDown={() => setMobileMove(-1, 0)} onPointerUp={() => setMobileMove(0, 0)} onPointerCancel={() => setMobileMove(0, 0)} onPointerLeave={() => setMobileMove(0, 0)}>←</button>
              <button onPointerDown={() => setMobileMove(1, 0)} onPointerUp={() => setMobileMove(0, 0)} onPointerCancel={() => setMobileMove(0, 0)} onPointerLeave={() => setMobileMove(0, 0)}>→</button>
              <button onPointerDown={() => setMobileMove(0, 1)} onPointerUp={() => setMobileMove(0, 0)} onPointerCancel={() => setMobileMove(0, 0)} onPointerLeave={() => setMobileMove(0, 0)}>↓</button>
            </div>
            <button className="pvp-mobile-dash" onPointerDown={() => { dashQueuedRef.current = true; }}>회피</button>
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
