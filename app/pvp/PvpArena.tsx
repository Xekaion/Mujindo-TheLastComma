"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
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
  sanitizePvpBuildProfile,
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
  normalizeEquipment,
} from "../equipment";
import {
  PAPERDOLL_BODY_PATH,
  drawPaperdollCharacterDirect,
  paperdollLayerPathsForLoadout,
  paperdollLoadoutFromEquipment,
  type PaperdollLoadout,
} from "../character-paperdoll";
import { createBrowserPaperdollImageStore } from "../paperdoll-image-store";
import { readActiveSaveSlot, readSaveSlot } from "../save-slots";
import {
  CHARACTER_IDLE_FRAME,
  advanceCharacterWalkCycle,
  characterFacingForVector,
  characterWalkFrameIndex,
  resolveCharacterMotion,
  settleCharacterWalkCycle,
} from "../character-motion";
import "./pvp.css";

type PvpArenaProps = {
  suggestedName?: string | null;
};

type MatchFoundMessage = Extract<RealtimeServerMessage, { type: "match_found" }>;
type MatchResultMessage = Extract<RealtimeServerMessage, { type: "match_result" }>;

const ARENA_OBSTACLES = [
  { x: 510, y: 360, radius: 66 },
  { x: 770, y: 360, radius: 66 },
] as const;

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
  return sanitizePvpBuildProfile({
    level: save.player.level,
    equipmentPower: calculateEquipmentCombatPower(
      normalizeEquipment(save.player.equipment),
    ),
    augmentStacks: Object.values(save.player.augments).reduce(
      (total, stacks) => total + stacks,
      0,
    ),
  });
}

/**
 * Keeps the cosmetic path local: no GearItem, affix, combat stat, or save
 * payload is added to the realtime protocol. The opponent therefore renders
 * the common body until the server owns a dedicated slot -> variant allowlist.
 */
function readLocalPvpPaperdollLoadout(): PaperdollLoadout {
  if (typeof window === "undefined") return {};
  const save = readSaveSlot(readActiveSaveSlot());
  if (!save) return {};
  return paperdollLoadoutFromEquipment(
    normalizeEquipment(save.player.equipment),
  );
}

export default function PvpArena({ suggestedName }: PvpArenaProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const paperdollImagesRef = useRef(createBrowserPaperdollImageStore());
  const snapshotRef = useRef<PvpSnapshot | null>(null);
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

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const localName = getLocalDisplayName(suggestedName);
      setDisplayName(localName);
      setDraftName(localName);
      setBuildProfile(readLocalPvpBuildProfile());
      setLocalPaperdollLoadout(readLocalPvpPaperdollLoadout());
    });
    return () => window.cancelAnimationFrame(frame);
  }, [suggestedName]);

  useEffect(() => {
    paperdollImagesRef.current.reconcile([
      PAPERDOLL_BODY_PATH,
      ...paperdollLayerPathsForLoadout(localPaperdollLoadout),
    ]);
  }, [localPaperdollLoadout]);

  useEffect(
    () => {
      const paperdollImages = paperdollImagesRef.current;
      return () => paperdollImages.clear();
    },
    [],
  );

  useEffect(() => {
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
  }, [suggestedName]);

  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

  const enterQueue = useCallback(() => {
    setResult(null);
    setSnapshot(null);
    snapshotRef.current = null;
    setNotice("대전 상대의 기억 파장을 탐색하고 있습니다.");
    getRealtimeClient().joinQueue(buildProfile);
  }, [buildProfile]);

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
    const clear = () => keysRef.current.clear();
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
    if (!match) return;
    const interval = window.setInterval(() => {
      const current = snapshotRef.current;
      const localId = playerIdRef.current;
      if (!current || !localId || current.matchId !== match.matchId) return;
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
  }, [match]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const background = new Image();
    background.src = "/assets/maps/room-elite.webp";
    const renderedPositions = new Map<
      string,
      { x: number; y: number; facing: number; walkCycle: number }
    >();
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

    const drawBackground = () => {
      context.fillStyle = "#07090d";
      context.fillRect(0, 0, PVP_ARENA_WIDTH, PVP_ARENA_HEIGHT);
      if (background.complete && background.naturalWidth > 0) {
        context.globalAlpha = 0.78;
        context.drawImage(background, 0, 0, PVP_ARENA_WIDTH, PVP_ARENA_HEIGHT);
        context.globalAlpha = 1;
      }
      const gradient = context.createRadialGradient(640, 360, 80, 640, 360, 700);
      gradient.addColorStop(0, "rgba(94, 28, 43, 0.04)");
      gradient.addColorStop(0.68, "rgba(3, 5, 8, 0.18)");
      gradient.addColorStop(1, "rgba(0, 0, 0, 0.72)");
      context.fillStyle = gradient;
      context.fillRect(0, 0, PVP_ARENA_WIDTH, PVP_ARENA_HEIGHT);
      context.strokeStyle = "rgba(218, 174, 103, 0.1)";
      context.lineWidth = 1;
      context.setLineDash([5, 12]);
      context.beginPath();
      context.moveTo(640, 115);
      context.lineTo(640, 650);
      context.stroke();
      context.setLineDash([]);
      for (const obstacle of ARENA_OBSTACLES) {
        const aura = context.createRadialGradient(
          obstacle.x,
          obstacle.y,
          obstacle.radius * 0.25,
          obstacle.x,
          obstacle.y,
          obstacle.radius + 24,
        );
        aura.addColorStop(0, "rgba(7, 8, 12, 0.98)");
        aura.addColorStop(0.72, "rgba(28, 18, 24, 0.94)");
        aura.addColorStop(1, "rgba(184, 71, 91, 0)");
        context.fillStyle = aura;
        context.beginPath();
        context.arc(obstacle.x, obstacle.y, obstacle.radius + 24, 0, Math.PI * 2);
        context.fill();
        context.strokeStyle = "rgba(214, 157, 99, 0.35)";
        context.lineWidth = 2;
        context.beginPath();
        context.arc(obstacle.x, obstacle.y, obstacle.radius, 0, Math.PI * 2);
        context.stroke();
      }
    };

    const drawPlayer = (player: PvpPlayerSnapshot, elapsedSeconds: number) => {
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
      const frame = characterWalkFrameIndex(rendered.walkCycle, moving);
      const alpha = player.respawnMs > 0 ? 0.3 : 1;
      context.save();
      context.globalAlpha = alpha;
      const aura = context.createRadialGradient(
        rendered.x,
        rendered.y + 14,
        4,
        rendered.x,
        rendered.y + 14,
        48,
      );
      aura.addColorStop(0, `${accent}70`);
      aura.addColorStop(1, `${accent}00`);
      context.fillStyle = aura;
      context.beginPath();
      context.ellipse(rendered.x, rendered.y + 18, 47, 25, 0, 0, Math.PI * 2);
      context.fill();
      const bodyAtlas = paperdollImagesRef.current.get(PAPERDOLL_BODY_PATH);
      const appearance =
        player.id === playerIdRef.current ? localPaperdollLoadout : {};
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
          // Match the legacy cell's authored foot baseline (top y-79,
          // bottom y+39) while keeping the exact 256:192 aspect.
          y: rendered.y + 34,
          width: 157,
          height: 118,
        });
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
      drawBackground();
      const current = snapshotRef.current;
      if (current) {
        for (const projectile of current.projectiles) {
          const accent =
            current.players.find((player) => player.id === projectile.ownerId)?.side === 0
              ? "#71e8ff"
              : "#ff637e";
          context.save();
          context.strokeStyle = `${accent}90`;
          context.lineWidth = projectile.radius * 1.25;
          context.lineCap = "round";
          context.shadowColor = accent;
          context.shadowBlur = 18;
          context.beginPath();
          context.moveTo(projectile.x - projectile.vx * 0.025, projectile.y - projectile.vy * 0.025);
          context.lineTo(projectile.x, projectile.y);
          context.stroke();
          context.fillStyle = "#fff8df";
          context.beginPath();
          context.arc(projectile.x, projectile.y, projectile.radius * 0.55, 0, Math.PI * 2);
          context.fill();
          context.restore();
        }
        for (const player of current.players) drawPlayer(player, elapsedSeconds);
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
          context.fillText("MEMORY DUEL", 640, 370);
        }
      }
      animationFrame = window.requestAnimationFrame(render);
    };
    animationFrame = window.requestAnimationFrame(render);
    return () => {
      canvasResizeObserver.disconnect();
      window.cancelAnimationFrame(animationFrame);
    };
  }, [localPaperdollLoadout, result?.matchId, snapshot?.matchId]);

  const handleAim = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    aimRef.current.x = ((event.clientX - rect.left) / rect.width) * PVP_ARENA_WIDTH;
    aimRef.current.y = ((event.clientY - rect.top) / rect.height) * PVP_ARENA_HEIGHT;
  };

  const setMobileMove = (x: number, y: number) => {
    mobileMoveRef.current = { x, y };
  };

  const localPlayer = snapshot?.players.find((player) => player.id === playerId) ?? null;
  const opponent = snapshot?.players.find((player) => player.id !== playerId) ?? null;
  const localBuildRating = calculatePvpBuildRating(buildProfile);
  const localOffenseScale = calculatePvpOffenseScale(buildProfile);
  const matchActive = Boolean(match && snapshot && snapshot.phase !== "finished");
  const didWin = Boolean(result && result.winnerId && result.winnerId === playerId);
  const isDraw = Boolean(result && result.winnerId === null);

  return (
    <main className={`pvp-screen is-${connection}`}>
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
              <small>{snapshot?.phase === "countdown" ? "결투 동기화" : "3킬 선취"}</small>
              <strong><b>{localPlayer?.score ?? 0}</b><i>:</i><b>{opponent?.score ?? 0}</b></strong>
              <span>{formatClock(snapshot?.remainingMs ?? 90_000)} · 생존력 ×{(snapshot?.vitalityMultiplier ?? 1).toFixed(2)} · {ping ?? "--"}ms</span>
            </div>
            <article className="pvp-combatant is-opponent">
              <small>상대 기억</small>
              <strong>{opponent?.name ?? match?.opponentName ?? "상대 탐색 중"}</strong>
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
              <button onPointerDown={() => setMobileMove(0, -1)} onPointerUp={() => setMobileMove(0, 0)} onPointerCancel={() => setMobileMove(0, 0)}>↑</button>
              <button onPointerDown={() => setMobileMove(-1, 0)} onPointerUp={() => setMobileMove(0, 0)} onPointerCancel={() => setMobileMove(0, 0)}>←</button>
              <button onPointerDown={() => setMobileMove(1, 0)} onPointerUp={() => setMobileMove(0, 0)} onPointerCancel={() => setMobileMove(0, 0)}>→</button>
              <button onPointerDown={() => setMobileMove(0, 1)} onPointerUp={() => setMobileMove(0, 0)} onPointerCancel={() => setMobileMove(0, 0)}>↓</button>
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
