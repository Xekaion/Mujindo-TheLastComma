"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import "./plaza.css";
import {
  PLAZA_PORTALS,
  PLAZA_SPAWN_POINT,
  PLAZA_WORLD_HEIGHT,
  PLAZA_WORLD_WIDTH,
  isPlazaWalkable,
  nearestPlazaPortal,
  plazaFacingForVector,
  plazaPortalById,
  plazaSpriteRowForFacing,
  resolvePlazaMovement,
  sanitizePlazaPoint,
  type PlazaPoint,
  type PlazaPortalDefinition,
  type PlazaPortalId,
} from "./plaza-world";
import {
  HUB_PLAYER_SPEED,
  type HubCharacterSlot,
  type HubFacing,
  type HubPlayerSnapshot,
  type HubSpriteKey,
} from "./hub-protocol";
// Keep optimistic movement aligned with the worker's authoritative budget.
const PLAYER_SPEED = HUB_PLAYER_SPEED;
const MOVEMENT_SEND_INTERVAL_MS = 66;
const CAMERA_LERP = 0.13;
const PORTAL_PULSE_SECONDS = 2.4;
const PLAZA_MAP_PATH = "/assets/maps/memory-plaza-v1.png";

const SPRITE_PATHS: Record<string, string> = {
  harin: "/assets/walk/harin-walk-v2.png",
  "harin-equipped": "/assets/walk/harin-equipped-v3.png",
};

export type PlazaCharacterIdentity = {
  characterId: string;
  displayName: string;
  level: number;
  saveSlot: HubCharacterSlot;
  appearance?: {
    spriteKey?: HubSpriteKey;
    equipped?: boolean;
  };
};

export type PlazaRemotePlayer = HubPlayerSnapshot;

export type PlazaMoveIntent = {
  moveX: number;
  moveY: number;
  facing: HubFacing;
  sequence: number;
};

export type PlazaConnectionState =
  | "idle"
  | "offline"
  | "connecting"
  | "online"
  | "reconnecting";

export type PlazaHubProps = {
  character: PlazaCharacterIdentity;
  remotePlayers?: readonly PlazaRemotePlayer[];
  onlineCount?: number;
  initialPosition?: PlazaPoint;
  localAuthoritativePosition?: PlazaPoint | null;
  connectionState?: PlazaConnectionState;
  paused?: boolean;
  onMoveIntent?: (intent: PlazaMoveIntent) => void;
  onPortalActivate?: (portal: PlazaPortalDefinition) => void;
  onExitToCharacterSelect?: () => void;
};

type DrawPlayer = {
  key: string;
  displayName: string;
  level: number;
  x: number;
  y: number;
  facing: number;
  moving: boolean;
  spriteKey: string;
  local: boolean;
  stale: boolean;
};

type RemoteRenderPoint = PlazaPoint & {
  targetX: number;
  targetY: number;
};

type ViewportState = {
  width: number;
  height: number;
  dpr: number;
};

const safeLabel = (value: string, fallback: string) => {
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return normalized.slice(0, 24) || fallback;
};

const clampLevel = (level: number) =>
  Math.min(999, Math.max(1, Number.isFinite(level) ? Math.floor(level) : 1));

const normalizedFacing = (facing: number) =>
  ((Number.isFinite(facing) ? Math.floor(facing) : 0) % 8 + 8) % 8;

function spritePath(spriteKey: string | undefined, equipped = false) {
  if (spriteKey && SPRITE_PATHS[spriteKey]) return SPRITE_PATHS[spriteKey];
  return equipped ? SPRITE_PATHS["harin-equipped"] : SPRITE_PATHS.harin;
}

function roundedRectPath(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
}

function drawFloor(
  context: CanvasRenderingContext2D,
  time: number,
  plazaMap: HTMLImageElement | undefined,
) {
  context.fillStyle = "#080a0d";
  context.fillRect(0, 0, PLAZA_WORLD_WIDTH, PLAZA_WORLD_HEIGHT);

  if (plazaMap?.complete && plazaMap.naturalWidth > 0 && plazaMap.naturalHeight > 0) {
    // The generated map is authored at 16:9, exactly matching the authoritative
    // 2400×1350 hub world. Keeping one image/world ratio prevents visual walls
    // from drifting away from their collision boundary.
    context.drawImage(plazaMap, 0, 0, PLAZA_WORLD_WIDTH, PLAZA_WORLD_HEIGHT);
    const mapGrade = context.createRadialGradient(1200, 675, 140, 1200, 675, 1280);
    mapGrade.addColorStop(0, "rgba(21, 42, 44, .035)");
    mapGrade.addColorStop(0.72, "rgba(7, 9, 12, .04)");
    mapGrade.addColorStop(1, "rgba(2, 3, 5, .32)");
    context.fillStyle = mapGrade;
    context.fillRect(0, 0, PLAZA_WORLD_WIDTH, PLAZA_WORLD_HEIGHT);

    const pulse = 0.11 + Math.sin(time * 0.8) * 0.025;
    context.strokeStyle = `rgba(111, 224, 207, ${pulse})`;
    context.lineWidth = 2;
    context.beginPath();
    context.ellipse(1200, 675, 315, 178, 0, 0, Math.PI * 2);
    context.stroke();
    return;
  }

  const floorGradient = context.createRadialGradient(1200, 720, 90, 1200, 720, 1300);
  floorGradient.addColorStop(0, "#23242a");
  floorGradient.addColorStop(0.48, "#171a1e");
  floorGradient.addColorStop(1, "#0b0e12");
  context.fillStyle = floorGradient;
  roundedRectPath(context, 92, 82, 2216, PLAZA_WORLD_HEIGHT - 164, 172);
  context.fill();

  context.save();
  roundedRectPath(context, 92, 82, 2216, PLAZA_WORLD_HEIGHT - 164, 172);
  context.clip();

  context.strokeStyle = "rgba(216, 194, 146, .075)";
  context.lineWidth = 2;
  for (let x = 116; x < PLAZA_WORLD_WIDTH; x += 78) {
    context.beginPath();
    context.moveTo(x, 88);
    context.lineTo(x - 118, PLAZA_WORLD_HEIGHT - 82);
    context.stroke();
  }
  for (let y = 92; y < PLAZA_WORLD_HEIGHT; y += 62) {
    context.beginPath();
    context.moveTo(88, y);
    context.lineTo(2312, y + 36);
    context.stroke();
  }

  const roadGradient = context.createLinearGradient(0, 0, 0, PLAZA_WORLD_HEIGHT);
  roadGradient.addColorStop(0, "rgba(110, 80, 76, .28)");
  roadGradient.addColorStop(0.52, "rgba(180, 153, 105, .16)");
  roadGradient.addColorStop(1, "rgba(95, 77, 52, .25)");
  context.fillStyle = roadGradient;
  context.fillRect(1048, 90, 304, PLAZA_WORLD_HEIGHT - 180);
  context.fillRect(96, 644, 2208, 212);

  context.strokeStyle = "rgba(231, 203, 139, .26)";
  context.lineWidth = 3;
  context.setLineDash([12, 22]);
  context.lineDashOffset = -time * 16;
  context.strokeRect(1073, 92, 254, PLAZA_WORLD_HEIGHT - 184);
  context.strokeRect(94, 674, 2212, 152);
  context.setLineDash([]);

  for (let ring = 0; ring < 4; ring += 1) {
    context.beginPath();
    context.strokeStyle = `rgba(202, 171, 108, ${0.22 - ring * 0.035})`;
    context.lineWidth = ring === 0 ? 4 : 2;
    context.ellipse(1200, 675, 256 + ring * 66, 194 + ring * 48, 0, 0, Math.PI * 2);
    context.stroke();
  }

  const sigilRotation = time * 0.035;
  context.save();
  context.translate(1200, 675);
  context.rotate(sigilRotation);
  context.strokeStyle = "rgba(215, 186, 120, .15)";
  context.lineWidth = 2;
  for (let ray = 0; ray < 12; ray += 1) {
    context.rotate(Math.PI / 6);
    context.beginPath();
    context.moveTo(212, 0);
    context.lineTo(378, 0);
    context.stroke();
  }
  context.restore();
  context.restore();

  context.strokeStyle = "rgba(215, 179, 106, .42)";
  context.lineWidth = 5;
  roundedRectPath(context, 94, 84, 2212, PLAZA_WORLD_HEIGHT - 168, 170);
  context.stroke();
  context.strokeStyle = "rgba(58, 198, 183, .16)";
  context.lineWidth = 1;
  roundedRectPath(context, 106, 96, 2188, PLAZA_WORLD_HEIGHT - 192, 160);
  context.stroke();
}

function drawCentralSigil(context: CanvasRenderingContext2D, time: number) {
  context.save();
  context.translate(1200, 675);
  context.rotate(time * 0.025);
  context.strokeStyle = `rgba(145, 255, 242, ${0.12 + Math.sin(time * 1.4) * 0.035})`;
  context.lineWidth = 3;
  for (let ring = 0; ring < 3; ring += 1) {
    context.beginPath();
    context.ellipse(0, 0, 98 + ring * 48, 62 + ring * 30, 0, 0, Math.PI * 2);
    context.stroke();
  }
  context.restore();
}

function drawStall(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  label: string,
) {
  context.save();
  context.translate(x, y);
  context.fillStyle = "rgba(0, 0, 0, .38)";
  context.fillRect(-width / 2 + 16, 52, width, 48);
  context.fillStyle = "#111318";
  context.fillRect(-width / 2, -20, width, 110);
  context.fillStyle = "#562b2c";
  context.beginPath();
  context.moveTo(-width / 2 - 22, -22);
  context.lineTo(width / 2 + 22, -22);
  context.lineTo(width / 2 - 2, 24);
  context.lineTo(-width / 2 + 2, 24);
  context.closePath();
  context.fill();
  context.strokeStyle = "#b88a50";
  context.lineWidth = 4;
  context.stroke();
  context.fillStyle = "#dbca9f";
  context.font = "700 18px serif";
  context.textAlign = "center";
  context.fillText(label, 0, 62);
  context.restore();
}

function drawPortal(
  context: CanvasRenderingContext2D,
  portal: PlazaPortalDefinition,
  time: number,
  selected: boolean,
) {
  const phase = (time % PORTAL_PULSE_SECONDS) / PORTAL_PULSE_SECONDS;
  const pulse = 0.5 + Math.sin(phase * Math.PI * 2) * 0.5;
  const horizontal = portal.id === "duel" || portal.id === "exchange";
  context.save();
  context.translate(portal.x, portal.y);
  if (horizontal) context.rotate(Math.PI / 2);

  context.fillStyle = "rgba(0, 0, 0, .46)";
  context.beginPath();
  context.ellipse(0, 96, 110, 34, 0, 0, Math.PI * 2);
  context.fill();

  context.shadowColor = portal.hue;
  context.shadowBlur = 18 + pulse * 28 + (selected ? 18 : 0);
  context.strokeStyle = portal.hue;
  context.lineWidth = selected ? 11 : 8;
  context.beginPath();
  context.moveTo(-78, 86);
  context.lineTo(-78, -34);
  context.quadraticCurveTo(-78, -128, 0, -142);
  context.quadraticCurveTo(78, -128, 78, -34);
  context.lineTo(78, 86);
  context.stroke();

  const rift = context.createRadialGradient(0, -32, 8, 0, -32, 98);
  rift.addColorStop(0, `${portal.accent}e8`);
  rift.addColorStop(0.18, `${portal.hue}a8`);
  rift.addColorStop(0.65, `${portal.hue}28`);
  rift.addColorStop(1, "rgba(4, 4, 8, 0)");
  context.fillStyle = rift;
  context.beginPath();
  context.ellipse(0, -24, 75 + pulse * 5, 111 + pulse * 8, 0, 0, Math.PI * 2);
  context.fill();

  context.rotate(time * 0.38 * (portal.id === "duel" ? -1 : 1));
  context.strokeStyle = portal.accent;
  context.globalAlpha = 0.42 + pulse * 0.34;
  context.lineWidth = 2;
  context.setLineDash([8, 12]);
  context.beginPath();
  context.arc(0, -24, 56, 0, Math.PI * 2);
  context.stroke();
  context.setLineDash([]);
  context.restore();

  context.save();
  context.textAlign = "center";
  context.shadowColor = "#000";
  context.shadowBlur = 9;
  context.fillStyle = "#f2ead8";
  context.font = "700 25px serif";
  const labelX = horizontal ? portal.x + (portal.id === "duel" ? 22 : -22) : portal.x;
  const labelY = horizontal ? portal.y - 164 : portal.y + (portal.id === "caravan" ? -182 : 178);
  context.fillText(portal.name, labelX, labelY);
  context.fillStyle = portal.accent;
  context.font = "600 10px sans-serif";
  context.letterSpacing = "1.8px";
  context.fillText(portal.englishName, labelX, labelY + 19);
  context.restore();
}

function drawPlazaDecor(context: CanvasRenderingContext2D, time: number) {
  drawStall(context, 750, 1035, 280, "기억 감정소");
  drawStall(context, 1650, 1035, 280, "원정 보급소");

  for (const [x, y] of [
    [785, 486],
    [1615, 486],
  ] as const) {
    context.save();
    context.translate(x, y);
    context.fillStyle = "rgba(0,0,0,.45)";
    context.beginPath();
    context.ellipse(0, 54, 70, 24, 0, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = "#24262b";
    context.beginPath();
    context.moveTo(-54, 54);
    context.lineTo(-28, -28);
    context.lineTo(0, -76);
    context.lineTo(28, -28);
    context.lineTo(54, 54);
    context.closePath();
    context.fill();
    context.strokeStyle = "#79633f";
    context.lineWidth = 4;
    context.stroke();
    context.shadowColor = "#d5b86f";
    context.shadowBlur = 18 + Math.sin(time * 2 + x) * 6;
    context.fillStyle = "#e4c274";
    context.beginPath();
    context.arc(0, -80, 7, 0, Math.PI * 2);
    context.fill();
    context.restore();
  }
}

function drawPlayer(
  context: CanvasRenderingContext2D,
  player: DrawPlayer,
  image: HTMLImageElement | undefined,
  time: number,
  readableCanvasFontSize: (basePx: number, minimumCssPx: number) => number,
) {
  const shadowWidth = player.local ? 34 : 30;
  context.fillStyle = "rgba(0, 0, 0, .58)";
  context.beginPath();
  context.ellipse(player.x, player.y + 24, shadowWidth, 12, 0, 0, Math.PI * 2);
  context.fill();

  const alpha = player.stale ? 0.44 : 1;
  const frame = player.moving ? Math.floor(time * 8.5) % 4 : 1;
  if (image?.complete && image.naturalWidth > 0 && image.naturalHeight > 0) {
    const sourceWidth = image.naturalWidth / 4;
    const sourceHeight = image.naturalHeight / 8;
    const row = plazaSpriteRowForFacing(player.facing);
    context.save();
    context.globalAlpha = alpha;
    context.imageSmoothingEnabled = true;
    context.drawImage(
      image,
      frame * sourceWidth,
      row * sourceHeight,
      sourceWidth,
      sourceHeight,
      player.x - 59,
      player.y - 92,
      118,
      128,
    );
    context.restore();
  } else {
    context.save();
    context.globalAlpha = alpha;
    context.fillStyle = player.local ? "#9b3f43" : "#3b6973";
    context.beginPath();
    context.arc(player.x, player.y - 16, 24, 0, Math.PI * 2);
    context.fill();
    context.restore();
  }

  context.save();
  context.textAlign = "center";
  context.shadowColor = "rgba(0, 0, 0, .95)";
  context.shadowBlur = 7;
  context.fillStyle = player.local ? "#fff1bd" : "#edf5f2";
  context.font = player.local
    ? `700 ${readableCanvasFontSize(14, 11)}px sans-serif`
    : `600 ${readableCanvasFontSize(13, 11)}px sans-serif`;
  context.fillText(`${player.displayName} · LV.${player.level}`, player.x, player.y - 105);
  if (player.local) {
    context.fillStyle = "#71e4d5";
    context.font = `700 ${readableCanvasFontSize(9, 11)}px sans-serif`;
    context.fillText("현재 캐릭터", player.x, player.y - 121);
  }
  context.restore();
}

function connectionLabel(state: PlazaConnectionState) {
  if (state === "online") return "공동 광장 연결됨";
  if (state === "connecting") return "광장 연결 중";
  if (state === "reconnecting") return "광장 재연결 중";
  return "로컬 광장";
}

export default function PlazaHub({
  character,
  remotePlayers = [],
  onlineCount = remotePlayers.length + 1,
  initialPosition = PLAZA_SPAWN_POINT,
  localAuthoritativePosition = null,
  connectionState = "offline",
  paused = false,
  onMoveIntent,
  onPortalActivate,
  onExitToCharacterSelect,
}: PlazaHubProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rootRef = useRef<HTMLElement | null>(null);
  const positionRef = useRef<PlazaPoint>(sanitizePlazaPoint(initialPosition));
  const cameraRef = useRef<PlazaPoint>(sanitizePlazaPoint(initialPosition));
  const facingRef = useRef(4);
  const movingRef = useRef(false);
  const pointerTargetRef = useRef<PlazaPoint | null>(null);
  const keysRef = useRef(new Set<string>());
  const touchDirectionRef = useRef<PlazaPoint>({ x: 0, y: 0 });
  const viewportRef = useRef<ViewportState>({ width: 1280, height: 720, dpr: 1 });
  const spriteImagesRef = useRef(new Map<string, HTMLImageElement>());
  const remotePlayersRef = useRef(remotePlayers);
  const remoteRenderPointsRef = useRef(new Map<string, RemoteRenderPoint>());
  const previousTimeRef = useRef(0);
  const sendTimeRef = useRef(0);
  const sequenceRef = useRef(0);
  const lastSentIntentRef = useRef<Omit<PlazaMoveIntent, "sequence"> | null>(null);
  const nearPortalIdRef = useRef<PlazaPortalId | null>(null);
  const guidedPortalIdRef = useRef<PlazaPortalId | null>(null);
  const onMoveIntentRef = useRef(onMoveIntent);
  const pausedRef = useRef(paused);
  const [nearPortalId, setNearPortalId] = useState<PlazaPortalId | null>(null);
  const [guidedPortalId, setGuidedPortalId] = useState<PlazaPortalId | null>(null);
  const [notice, setNotice] = useState("광장 중앙에서 네 갈래의 기억이 이어집니다.");
  const characterSpriteKey = character.appearance?.spriteKey;
  const characterEquipped = character.appearance?.equipped;

  const normalizedCharacter = useMemo(
    () => ({
      characterId: character.characterId,
      displayName: safeLabel(character.displayName, "이름 없는 기록자"),
      level: clampLevel(character.level),
      saveSlot: character.saveSlot,
      appearance: characterSpriteKey !== undefined || characterEquipped !== undefined
        ? {
            spriteKey: characterSpriteKey,
            equipped: characterEquipped,
          }
        : undefined,
    }),
    [
      characterEquipped,
      characterSpriteKey,
      character.characterId,
      character.displayName,
      character.level,
      character.saveSlot,
    ],
  );
  const normalizedCharacterRef = useRef(normalizedCharacter);

  useEffect(() => {
    normalizedCharacterRef.current = normalizedCharacter;
  }, [normalizedCharacter]);

  useEffect(() => {
    guidedPortalIdRef.current = guidedPortalId;
  }, [guidedPortalId]);

  useEffect(() => {
    onMoveIntentRef.current = onMoveIntent;
    lastSentIntentRef.current = null;
  }, [onMoveIntent]);

  useEffect(() => {
    pausedRef.current = paused;
    if (!paused) return;
    keysRef.current.clear();
    touchDirectionRef.current = { x: 0, y: 0 };
    pointerTargetRef.current = null;
    movingRef.current = false;
    const facing = normalizedFacing(facingRef.current) as HubFacing;
    lastSentIntentRef.current = { moveX: 0, moveY: 0, facing };
    const moveHandler = onMoveIntentRef.current;
    if (moveHandler) {
      sequenceRef.current += 1;
      moveHandler({ moveX: 0, moveY: 0, facing, sequence: sequenceRef.current });
    }
  }, [paused]);

  const visibleRemotePlayers = useMemo(() => {
    const seen = new Set<string>();
    const entries: PlazaRemotePlayer[] = [];
    for (const player of remotePlayers) {
      if (!player.playerId || !player.characterId || player.characterId === character.characterId) {
        continue;
      }
      if (seen.has(player.characterId)) continue;
      seen.add(player.characterId);
      const point = sanitizePlazaPoint({ x: player.x, y: player.y });
      entries.push({
        ...player,
        displayName: safeLabel(player.displayName, "기록자"),
        level: clampLevel(player.level),
        x: point.x,
        y: point.y,
        facing: normalizedFacing(player.facing) as HubFacing,
      });
    }
    return entries.slice(0, 119);
  }, [character.characterId, remotePlayers]);

  useEffect(() => {
    remotePlayersRef.current = visibleRemotePlayers;
    const activeIds = new Set<string>();
    for (const player of visibleRemotePlayers) {
      activeIds.add(player.characterId);
      const existing = remoteRenderPointsRef.current.get(player.characterId);
      if (!existing) {
        remoteRenderPointsRef.current.set(player.characterId, {
          x: player.x,
          y: player.y,
          targetX: player.x,
          targetY: player.y,
        });
        continue;
      }
      if (Math.hypot(player.x - existing.x, player.y - existing.y) > 320) {
        existing.x = player.x;
        existing.y = player.y;
      }
      existing.targetX = player.x;
      existing.targetY = player.y;
    }
    for (const characterId of remoteRenderPointsRef.current.keys()) {
      if (!activeIds.has(characterId)) {
        remoteRenderPointsRef.current.delete(characterId);
      }
    }
  }, [visibleRemotePlayers]);

  useEffect(() => {
    if (!localAuthoritativePosition) return;
    const authoritative = sanitizePlazaPoint(localAuthoritativePosition);
    const current = positionRef.current;
    const error = Math.hypot(authoritative.x - current.x, authoritative.y - current.y);
    if (error > 240) {
      positionRef.current = authoritative;
      pointerTargetRef.current = null;
    } else if (error > 8) {
      positionRef.current = {
        x: current.x + (authoritative.x - current.x) * 0.34,
        y: current.y + (authoritative.y - current.y) * 0.34,
      };
    }
  }, [localAuthoritativePosition]);

  const activatePortal = useCallback(
    (portal: PlazaPortalDefinition) => {
      if (onPortalActivate) {
        onPortalActivate(portal);
        return;
      }
      window.location.assign(portal.href);
    },
    [onPortalActivate],
  );

  const activateNearbyPortal = useCallback(() => {
    const portal = nearestPlazaPortal(positionRef.current);
    if (!portal) {
      setNotice("포탈의 빛 안으로 조금 더 가까이 이동하세요.");
      return;
    }
    activatePortal(portal);
  }, [activatePortal]);

  const guideToPortal = useCallback((portal: PlazaPortalDefinition) => {
    pointerTargetRef.current = { x: portal.approachX, y: portal.approachY };
    setGuidedPortalId(portal.id);
    setNotice(`${portal.name} 포탈까지 자동 이동합니다. 도착 후 입장을 눌러주세요.`);
    canvasRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    const canvas = canvasRef.current;
    if (!root || !canvas) return;

    const resize = () => {
      const rect = root.getBoundingClientRect();
      const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
      const width = Math.max(320, rect.width);
      const height = Math.max(320, rect.height);
      viewportRef.current = { width, height, dpr };
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    };

    const observer = new ResizeObserver(resize);
    observer.observe(root);
    resize();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const requiredPaths = new Set<string>([
      PLAZA_MAP_PATH,
      spritePath(
        normalizedCharacter.appearance?.spriteKey,
        normalizedCharacter.appearance?.equipped,
      ),
    ]);
    for (const player of visibleRemotePlayers) {
      requiredPaths.add(spritePath(player.appearance?.spriteKey));
    }
    for (const path of requiredPaths) {
      if (spriteImagesRef.current.has(path)) continue;
      const image = new Image();
      image.decoding = "async";
      image.src = path;
      spriteImagesRef.current.set(path, image);
    }
  }, [normalizedCharacter.appearance, visibleRemotePlayers]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (pausedRef.current) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("button, a, input, select, textarea") && event.key !== "Escape") {
        return;
      }
      const key = event.key.toLowerCase();
      if (["w", "a", "s", "d", "arrowup", "arrowleft", "arrowdown", "arrowright"].includes(key)) {
        event.preventDefault();
        pointerTargetRef.current = null;
        setGuidedPortalId(null);
        keysRef.current.add(key);
      }
      if ((key === "e" || key === "enter") && !event.repeat) {
        event.preventDefault();
        activateNearbyPortal();
      }
      const portal = PLAZA_PORTALS.find((entry) => entry.hotkey === key);
      if (portal && !event.repeat) {
        event.preventDefault();
        guideToPortal(portal);
      }
    };
    const onKeyUp = (event: KeyboardEvent) => keysRef.current.delete(event.key.toLowerCase());
    const clearKeys = () => {
      keysRef.current.clear();
      touchDirectionRef.current = { x: 0, y: 0 };
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", clearKeys);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", clearKeys);
    };
  }, [activateNearbyPortal, guideToPortal]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) return;
    let animationFrame = 0;
    let canvasCssScale = 1;
    const cacheCanvasCssScale = (renderedWidth: number, renderedHeight: number) => {
      const { width: logicalWidth, height: logicalHeight } = viewportRef.current;
      if (
        renderedWidth <= 0 ||
        renderedHeight <= 0 ||
        logicalWidth <= 0 ||
        logicalHeight <= 0
      ) {
        return;
      }
      canvasCssScale = Math.max(
        0.01,
        Math.min(renderedWidth / logicalWidth, renderedHeight / logicalHeight),
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

    const frame = (now: number) => {
      const previous = previousTimeRef.current || now;
      const dt = Math.min(0.05, Math.max(0, (now - previous) / 1000));
      previousTimeRef.current = now;
      const time = now / 1000;
      const keys = keysRef.current;
      let moveX =
        (keys.has("d") || keys.has("arrowright") ? 1 : 0) -
        (keys.has("a") || keys.has("arrowleft") ? 1 : 0);
      let moveY =
        (keys.has("s") || keys.has("arrowdown") ? 1 : 0) -
        (keys.has("w") || keys.has("arrowup") ? 1 : 0);
      if (pausedRef.current) {
        moveX = 0;
        moveY = 0;
      } else {
        moveX += touchDirectionRef.current.x;
        moveY += touchDirectionRef.current.y;
      }

      if (!pausedRef.current && Math.hypot(moveX, moveY) < 0.01 && pointerTargetRef.current) {
        const target = pointerTargetRef.current;
        const dx = target.x - positionRef.current.x;
        const dy = target.y - positionRef.current.y;
        const targetDistance = Math.hypot(dx, dy);
        if (targetDistance <= 8) {
          pointerTargetRef.current = null;
          moveX = 0;
          moveY = 0;
        } else {
          moveX = dx / targetDistance;
          moveY = dy / targetDistance;
        }
      }

      const magnitude = Math.hypot(moveX, moveY);
      if (magnitude > 0.01) {
        moveX /= Math.max(1, magnitude);
        moveY /= Math.max(1, magnitude);
        facingRef.current = plazaFacingForVector(moveX, moveY, facingRef.current);
        positionRef.current = resolvePlazaMovement(positionRef.current, {
          x: moveX * PLAYER_SPEED * dt,
          y: moveY * PLAYER_SPEED * dt,
        });
        movingRef.current = true;
      } else {
        movingRef.current = false;
      }

      const facing = normalizedFacing(facingRef.current) as HubFacing;
      const lastIntent = lastSentIntentRef.current;
      const intentChanged =
        !lastIntent ||
        Math.abs(lastIntent.moveX - moveX) > 0.015 ||
        Math.abs(lastIntent.moveY - moveY) > 0.015 ||
        lastIntent.facing !== facing;
      const moveHandler = onMoveIntentRef.current;
      if (
        moveHandler &&
        intentChanged &&
        now - sendTimeRef.current >= MOVEMENT_SEND_INTERVAL_MS
      ) {
        sendTimeRef.current = now;
        sequenceRef.current += 1;
        lastSentIntentRef.current = { moveX, moveY, facing };
        moveHandler({
          moveX,
          moveY,
          facing,
          sequence: sequenceRef.current,
        });
      }

      const nearest = nearestPlazaPortal(positionRef.current);
      const nextPortalId = nearest?.id ?? null;
      if (nearPortalIdRef.current !== nextPortalId) {
        nearPortalIdRef.current = nextPortalId;
        setNearPortalId(nextPortalId);
        if (nextPortalId) {
          setGuidedPortalId(null);
          setNotice(`${nearest?.name} 포탈에 도착했습니다.`);
        }
      }

      const { width, height, dpr } = viewportRef.current;
      const minCameraX = Math.min(PLAZA_WORLD_WIDTH / 2, width / 2);
      const maxCameraX = Math.max(PLAZA_WORLD_WIDTH / 2, PLAZA_WORLD_WIDTH - width / 2);
      const minCameraY = Math.min(PLAZA_WORLD_HEIGHT / 2, height / 2);
      const maxCameraY = Math.max(PLAZA_WORLD_HEIGHT / 2, PLAZA_WORLD_HEIGHT - height / 2);
      const desiredCameraX = Math.min(maxCameraX, Math.max(minCameraX, positionRef.current.x));
      const desiredCameraY = Math.min(maxCameraY, Math.max(minCameraY, positionRef.current.y));
      cameraRef.current.x += (desiredCameraX - cameraRef.current.x) * CAMERA_LERP;
      cameraRef.current.y += (desiredCameraY - cameraRef.current.y) * CAMERA_LERP;

      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, width, height);
      context.save();
      context.translate(
        Math.round(width / 2 - cameraRef.current.x),
        Math.round(height / 2 - cameraRef.current.y),
      );
      const plazaMap = spriteImagesRef.current.get(PLAZA_MAP_PATH);
      const plazaMapReady = Boolean(
        plazaMap?.complete && plazaMap.naturalWidth > 0 && plazaMap.naturalHeight > 0,
      );
      drawFloor(context, time, plazaMap);
      if (!plazaMapReady) {
        drawPlazaDecor(context, time);
        drawCentralSigil(context, time);
      }
      for (const portal of PLAZA_PORTALS) {
        drawPortal(
          context,
          portal,
          time,
          portal.id === (nearPortalIdRef.current ?? guidedPortalIdRef.current),
        );
      }

      const currentTime = Date.now();
      const remoteLerp = 1 - Math.exp(-dt * 11);
      const players: DrawPlayer[] = remotePlayersRef.current.map((player) => {
        const renderPoint = remoteRenderPointsRef.current.get(player.characterId);
        if (renderPoint) {
          renderPoint.x += (renderPoint.targetX - renderPoint.x) * remoteLerp;
          renderPoint.y += (renderPoint.targetY - renderPoint.y) * remoteLerp;
        }
        return {
          key: player.characterId,
          displayName: player.displayName,
          level: player.level,
          x: renderPoint?.x ?? player.x,
          y: renderPoint?.y ?? player.y,
          facing: player.facing,
          moving: player.moving,
          spriteKey: spritePath(player.appearance?.spriteKey),
          local: false,
          stale: typeof player.updatedAt === "number" && currentTime - player.updatedAt > 10_000,
        };
      });
      const localCharacter = normalizedCharacterRef.current;
      players.push({
        key: localCharacter.characterId,
        displayName: localCharacter.displayName,
        level: localCharacter.level,
        x: positionRef.current.x,
        y: positionRef.current.y,
        facing: facingRef.current,
        moving: movingRef.current,
        spriteKey: spritePath(
          localCharacter.appearance?.spriteKey,
          localCharacter.appearance?.equipped,
        ),
        local: true,
        stale: false,
      });
      players.sort((left, right) => left.y - right.y || Number(left.local) - Number(right.local));
      for (const player of players) {
        drawPlayer(
          context,
          player,
          spriteImagesRef.current.get(player.spriteKey),
          time,
          readableCanvasFontSize,
        );
      }
      context.restore();

      const vignette = context.createRadialGradient(
        width / 2,
        height / 2,
        Math.min(width, height) * 0.25,
        width / 2,
        height / 2,
        Math.max(width, height) * 0.72,
      );
      vignette.addColorStop(0, "rgba(0,0,0,0)");
      vignette.addColorStop(1, "rgba(0,0,0,.62)");
      context.fillStyle = vignette;
      context.fillRect(0, 0, width, height);
      animationFrame = window.requestAnimationFrame(frame);
    };

    animationFrame = window.requestAnimationFrame(frame);
    return () => {
      canvasResizeObserver.disconnect();
      window.cancelAnimationFrame(animationFrame);
      previousTimeRef.current = 0;
      const moveHandler = onMoveIntentRef.current;
      if (moveHandler) {
        sequenceRef.current += 1;
        moveHandler({
          moveX: 0,
          moveY: 0,
          facing: normalizedFacing(facingRef.current) as HubFacing,
          sequence: sequenceRef.current,
        });
      }
    };
  }, []);

  const handleCanvasPointer = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (pausedRef.current) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const { width, height } = viewportRef.current;
    const target = {
      x: cameraRef.current.x + ((event.clientX - rect.left) / rect.width) * width - width / 2,
      y: cameraRef.current.y + ((event.clientY - rect.top) / rect.height) * height - height / 2,
    };
    if (!isPlazaWalkable(target)) {
      setNotice("금빛 난간과 광장 시설물 바깥으로는 이동할 수 없습니다.");
      return;
    }
    pointerTargetRef.current = target;
    setGuidedPortalId(null);
    canvas.focus({ preventScroll: true });
  }, []);

  const setTouchDirection = useCallback((x: number, y: number) => {
    if (pausedRef.current) return;
    pointerTargetRef.current = null;
    setGuidedPortalId(null);
    touchDirectionRef.current = { x, y };
  }, []);

  const stopTouchDirection = useCallback(() => {
    touchDirectionRef.current = { x: 0, y: 0 };
  }, []);

  const nearPortal = nearPortalId ? plazaPortalById(nearPortalId) : null;

  return (
    <main
      ref={rootRef}
      className="plaza-hub"
      data-connection-state={connectionState}
      data-near-portal={nearPortalId ?? "none"}
      data-save-slot={normalizedCharacter.saveSlot}
      data-paused={paused ? "true" : "false"}
      inert={paused}
      aria-hidden={paused}
    >
      <canvas
        ref={canvasRef}
        className="plaza-hub-canvas"
        tabIndex={0}
        aria-label="무진도 공동 광장. WASD 또는 방향키로 이동하고 E 또는 Enter로 가까운 포탈을 이용합니다. 바닥을 누르면 해당 위치로 이동합니다."
        onPointerDown={handleCanvasPointer}
      />

      <header className="plaza-hub-header" aria-label="현재 광장 정보">
        <div className="plaza-hub-title">
          <small>MUJINDO SHARED SANCTUM</small>
          <strong>망각의 교차광장</strong>
          <span>끊어진 기억들이 다시 만나는 공동 성역</span>
        </div>
        <div className="plaza-hub-presence">
          <span className="plaza-hub-presence-dot" aria-hidden="true" />
          <div>
            <strong>{connectionLabel(connectionState)}</strong>
            <small>{Math.max(1, Math.floor(onlineCount))}명의 기록자 · 채널 01</small>
          </div>
        </div>
      </header>

      <section className="plaza-character-plate" aria-label="선택한 캐릭터">
        <small>RECORD 0{normalizedCharacter.saveSlot}</small>
        <strong>{normalizedCharacter.displayName}</strong>
        <span>LV.{normalizedCharacter.level}</span>
        {onExitToCharacterSelect ? (
          <button type="button" onClick={onExitToCharacterSelect}>
            캐릭터 변경
          </button>
        ) : null}
      </section>

      <nav className="plaza-portal-directory" aria-label="광장 포탈 안내">
        <div>
          <small>PORTAL DIRECTORY</small>
          <strong>이동할 포탈</strong>
        </div>
        {PLAZA_PORTALS.map((portal) => (
          <button
            type="button"
            key={portal.id}
            className={guidedPortalId === portal.id || nearPortalId === portal.id ? "is-active" : ""}
            style={{ "--portal-color": portal.hue } as React.CSSProperties}
            onClick={() => guideToPortal(portal)}
            aria-label={`${portal.name} 포탈 앞으로 이동`}
          >
            <kbd>{portal.hotkey}</kbd>
            <span>
              <strong>{portal.name}</strong>
              <small>{portal.englishName}</small>
            </span>
          </button>
        ))}
      </nav>

      <div className="plaza-hub-notice" role="status" aria-live="polite">
        <span aria-hidden="true">◆</span>
        {notice}
      </div>

      {nearPortal ? (
        <section
          className="plaza-portal-prompt"
          style={{ "--portal-color": nearPortal.hue } as React.CSSProperties}
          aria-label={`${nearPortal.name} 포탈`}
        >
          <small>{nearPortal.englishName}</small>
          <strong>{nearPortal.name}</strong>
          <p>{nearPortal.description}</p>
          <button type="button" onClick={() => activatePortal(nearPortal)}>
            <kbd>E</kbd>
            포탈 이용
          </button>
        </section>
      ) : null}

      <div className="plaza-touch-controls" aria-label="터치 이동 조작">
        <button
          type="button"
          className="is-up"
          aria-label="위로 이동"
          onPointerDown={() => setTouchDirection(0, -1)}
          onPointerUp={stopTouchDirection}
          onPointerCancel={stopTouchDirection}
          onPointerLeave={stopTouchDirection}
        >
          ▲
        </button>
        <button
          type="button"
          className="is-left"
          aria-label="왼쪽으로 이동"
          onPointerDown={() => setTouchDirection(-1, 0)}
          onPointerUp={stopTouchDirection}
          onPointerCancel={stopTouchDirection}
          onPointerLeave={stopTouchDirection}
        >
          ◀
        </button>
        <button
          type="button"
          className="is-down"
          aria-label="아래로 이동"
          onPointerDown={() => setTouchDirection(0, 1)}
          onPointerUp={stopTouchDirection}
          onPointerCancel={stopTouchDirection}
          onPointerLeave={stopTouchDirection}
        >
          ▼
        </button>
        <button
          type="button"
          className="is-right"
          aria-label="오른쪽으로 이동"
          onPointerDown={() => setTouchDirection(1, 0)}
          onPointerUp={stopTouchDirection}
          onPointerCancel={stopTouchDirection}
          onPointerLeave={stopTouchDirection}
        >
          ▶
        </button>
        <button type="button" className="is-action" onClick={activateNearbyPortal}>
          포탈
        </button>
      </div>

      <p className="plaza-control-hint">
        WASD / 방향키 이동 · 바닥 클릭 이동 · <kbd>E</kbd> 포탈 이용 · 숫자 1–4 포탈 안내
      </p>
    </main>
  );
}
