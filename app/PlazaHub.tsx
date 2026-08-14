"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
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
  plazaPortalById,
  resolvePlazaMovement,
  resolvePlazaSweptMovement,
  sanitizePlazaPoint,
  type PlazaPoint,
  type PlazaPortalDefinition,
  type PlazaPortalId,
} from "./plaza-world";
import {
  CHARACTER_IDLE_FRAME,
  advanceCharacterWalkCycle,
  characterRenderFrameIndex,
  resolveCharacterMotion,
  settleCharacterWalkCycle,
} from "./character-motion";
import {
  PAPERDOLL_BODY_PATH,
  PAPERDOLL_WORLD_RENDER_HEIGHT,
  PAPERDOLL_WORLD_RENDER_WIDTH,
  drawPaperdollCharacterDirect,
  paperdollLayerPathsForLoadout,
  paperdollLoadoutFromVisualGear,
  paperdollVisualCenterY,
} from "./character-paperdoll";
import { createBrowserPaperdollImageStore } from "./paperdoll-image-store";
import {
  EQUIPPED_RARITY_VFX_PATHS,
  drawEquippedRarityVfx,
  resolveEquippedRarityVfxPlan,
  type EquippedRarityVfxImageMap,
  type EquippedRarityVfxTier,
} from "./equipped-rarity-vfx";
import {
  canvasClientPointToWorld,
  pickPlazaInspectablePlayer,
} from "./plaza-player-inspection";
import {
  HUB_DASH_COOLDOWN_MS,
  HUB_DASH_SPEED,
  HUB_PLAYER_SPEED,
  normalizeHubDungeonFloor,
  type HubAppearance,
  type HubCharacterSlot,
  type HubFacing,
  type HubPlayerSnapshot,
} from "./hub-protocol";
import {
  GAMEPLAY_VFX_MANIFEST,
  drawGameplayVfxFrame,
  gameplayVfxImageKey,
  legendaryVfxId,
  type GameplayVfxId,
} from "./augment-vfx";
import { playGameSfx } from "./game-audio";
import { advanceContinuousMovement } from "./legendary-runtime";
import type { EquipmentLoadout } from "./equipment";
import {
  PLAZA_DASH_DURATION_SECONDS,
  PLAZA_PHANTOM_ACTIVATION_SECONDS,
  PLAZA_PHANTOM_MOVE_MULTIPLIER,
  PLAZA_STARFALL_SECONDS,
  plazaDashDirection,
  resolvePlazaMobilityProfile,
} from "./plaza-skills";
// Keep optimistic movement aligned with the worker's authoritative budget.
const PLAYER_SPEED = HUB_PLAYER_SPEED;
const MOVEMENT_SEND_INTERVAL_MS = 66;
const CAMERA_RESPONSE_PER_SECOND = 8.4;
const LOCAL_CORRECTION_RESPONSE_PER_SECOND = 10;
const LOCAL_CORRECTION_DEAD_ZONE = 0.5;
const LOCAL_HARD_SNAP_DISTANCE = 240;
const REMOTE_SETTLE_DISTANCE = 0.75;
const PORTAL_PULSE_SECONDS = 2.4;
const PLAZA_MAP_PATH = "/assets/maps/memory-plaza-v1.png";
export const PLAZA_PLAYER_GROUND_OFFSET_Y = 8;
export const PLAZA_PLAYER_SHADOW_CENTER_OFFSET_Y = 18;
export const PLAZA_PLAYER_SHADOW_RADIUS_Y = 12;
/** Keep characters just outside the camera warm without drawing the whole plaza. */
export const PLAZA_REMOTE_RENDER_MARGIN = 220;
/** Hard upper bound for paperdoll work when many players overlap one screen. */
export const PLAZA_REMOTE_RENDER_LIMIT = 32;
/** Only the nearest players keep ten high-resolution wearable atlases resident. */
export const PLAZA_REMOTE_EQUIPMENT_DETAIL_LIMIT = 2;

export type PlazaCharacterIdentity = {
  characterId: string;
  displayName: string;
  level: number;
  dungeonFloor: number;
  saveSlot: HubCharacterSlot;
  appearance?: Partial<HubAppearance> & { equipped?: boolean };
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
  /** Local-only loadout. It is never copied into the public hub profile. */
  equipment?: EquipmentLoadout | null;
  remotePlayers?: readonly PlazaRemotePlayer[];
  onlineCount?: number;
  initialPosition?: PlazaPoint;
  localAuthoritativePosition?: PlazaPoint | null;
  localAuthoritativeMoving?: boolean;
  connectionState?: PlazaConnectionState;
  paused?: boolean;
  onMoveIntent?: (intent: PlazaMoveIntent) => void;
  onDashIntent?: () => void;
  onPortalActivate?: (portal: PlazaPortalDefinition) => void;
  onPlayerInspect?: (player: PlazaRemotePlayer) => void;
  onSelfInspect?: () => void;
  onInventoryOpen?: () => void;
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
  walkCycle: number;
  gear: HubAppearance["gear"] | undefined;
  rarities: HubAppearance["rarities"] | undefined;
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

type PlazaSkillEffect = {
  id: number;
  vfxId: GameplayVfxId;
  x: number;
  y: number;
  size: number;
  life: number;
  duration: number;
  angle: number;
};

const PLAZA_MOBILITY_VFX_IDS = [
  legendaryVfxId("starfallMantle"),
  legendaryVfxId("riftStride"),
  legendaryVfxId("phantomMarch"),
] as const;

export function isPlazaPointNearViewport(
  point: PlazaPoint,
  camera: PlazaPoint,
  viewport: Pick<ViewportState, "width" | "height">,
  margin = PLAZA_REMOTE_RENDER_MARGIN,
): boolean {
  const safeMargin = Number.isFinite(margin) ? Math.max(0, margin) : 0;
  return (
    Math.abs(point.x - camera.x) <= viewport.width / 2 + safeMargin &&
    Math.abs(point.y - camera.y) <= viewport.height / 2 + safeMargin
  );
}

export function selectPlazaRemotePlayersForRender(
  players: readonly PlazaRemotePlayer[],
  camera: PlazaPoint,
  viewport: Pick<ViewportState, "width" | "height">,
  limit = PLAZA_REMOTE_RENDER_LIMIT,
): readonly PlazaRemotePlayer[] {
  const safeLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
  return players
    .filter((player) => isPlazaPointNearViewport(player, camera, viewport))
    .sort((left, right) => {
      const leftDistance = Math.hypot(left.x - camera.x, left.y - camera.y);
      const rightDistance = Math.hypot(right.x - camera.x, right.y - camera.y);
      return leftDistance - rightDistance || left.characterId.localeCompare(right.characterId);
    })
    .slice(0, safeLimit);
}

const safeLabel = (value: string, fallback: string) => {
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return normalized.slice(0, 24) || fallback;
};

const clampLevel = (level: number) =>
  Math.min(999, Math.max(1, Number.isFinite(level) ? Math.floor(level) : 1));

const normalizedFacing = (facing: number) =>
  ((Number.isFinite(facing) ? Math.floor(facing) : 0) % 8 + 8) % 8;

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
  bodyImage: HTMLImageElement | undefined,
  layerSources: ReadonlyMap<string, HTMLImageElement>,
  rarityVfxImages: EquippedRarityVfxImageMap,
  timeMs: number,
  readableCanvasFontSize: (basePx: number, minimumCssPx: number) => number,
) {
  const shadowWidth = player.local ? 34 : 30;
  context.fillStyle = "rgba(0, 0, 0, .58)";
  context.beginPath();
  context.ellipse(
    player.x,
    player.y + PLAZA_PLAYER_SHADOW_CENTER_OFFSET_Y,
    shadowWidth,
    PLAZA_PLAYER_SHADOW_RADIUS_Y,
    0,
    0,
    Math.PI * 2,
  );
  context.fill();

  const alpha = player.stale ? 0.44 : 1;
  const frame = characterRenderFrameIndex(
    player.facing,
    player.walkCycle,
    player.moving,
  );
  const loadout = paperdollLoadoutFromVisualGear(
    player.gear,
    "common",
    0,
    player.rarities,
  );
  const appearanceDrawn = Boolean(
    bodyImage?.complete &&
      bodyImage.naturalWidth > 0 &&
      drawPaperdollCharacterDirect(context, {
        bodyAtlas: bodyImage,
        layerSources,
        loadout,
        direction: player.facing,
        frame,
        x: player.x,
        y: player.y + PLAZA_PLAYER_GROUND_OFFSET_Y,
        width: PAPERDOLL_WORLD_RENDER_WIDTH,
        height: PAPERDOLL_WORLD_RENDER_HEIGHT,
        alpha,
      }),
  );
  // Coarse remote players intentionally carry no rarity map. That avoids both
  // hidden rarity disclosure and needless plan allocation for the other 29
  // visible players; only the local actor and two detailed remotes reach VFX.
  if (appearanceDrawn && player.rarities) {
    drawEquippedRarityVfx(context, {
      plan: resolveEquippedRarityVfxPlan(loadout),
      images: rarityVfxImages,
      direction: player.facing,
      frame,
      timeMs,
      x: player.x,
      y: player.y + PLAZA_PLAYER_GROUND_OFFSET_Y,
      width: PAPERDOLL_WORLD_RENDER_WIDTH,
      height: PAPERDOLL_WORLD_RENDER_HEIGHT,
      context: player.local ? "plaza-local" : "plaza-remote",
      alpha,
    });
  }
  if (!appearanceDrawn) {
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
  context.fillText(
    `${player.displayName} · LV.${player.level}`,
    player.x,
    player.y - 105,
  );
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
  equipment = null,
  remotePlayers = [],
  onlineCount = remotePlayers.length + 1,
  initialPosition = PLAZA_SPAWN_POINT,
  localAuthoritativePosition = null,
  localAuthoritativeMoving = false,
  connectionState = "offline",
  paused = false,
  onMoveIntent,
  onDashIntent,
  onPortalActivate,
  onPlayerInspect,
  onSelfInspect,
  onInventoryOpen,
  onExitToCharacterSelect,
}: PlazaHubProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rootRef = useRef<HTMLElement | null>(null);
  const positionRef = useRef<PlazaPoint>(sanitizePlazaPoint(initialPosition));
  const cameraRef = useRef<PlazaPoint>(sanitizePlazaPoint(initialPosition));
  const authoritativePositionRef = useRef<PlazaPoint | null>(
    localAuthoritativePosition
      ? sanitizePlazaPoint(localAuthoritativePosition)
      : null,
  );
  const authoritativeMovingRef = useRef(localAuthoritativeMoving);
  const facingRef = useRef(4);
  const movingRef = useRef(false);
  const walkCycleRef = useRef<number>(CHARACTER_IDLE_FRAME);
  const pointerTargetRef = useRef<PlazaPoint | null>(null);
  const keysRef = useRef(new Set<string>());
  const touchDirectionRef = useRef<PlazaPoint>({ x: 0, y: 0 });
  const dashQueuedRef = useRef(false);
  const dashTimeRef = useRef(0);
  const dashCooldownRef = useRef(0);
  const dashDirectionRef = useRef<PlazaPoint>({ x: 0, y: -1 });
  const starfallMantleTimeRef = useRef(0);
  const riftTrailCooldownRef = useRef(0);
  const phantomMoveTimeRef = useRef(0);
  const phantomTrailCooldownRef = useRef(0);
  const skillEffectIdRef = useRef(0);
  const skillEffectsRef = useRef<PlazaSkillEffect[]>([]);
  const viewportRef = useRef<ViewportState>({ width: 1280, height: 720, dpr: 1 });
  const sceneImagesRef = useRef(new Map<string, HTMLImageElement>());
  const paperdollImagesRef = useRef(createBrowserPaperdollImageStore());
  const paperdollPathSignatureRef = useRef("");
  const rarityVfxImagesRef = useRef<
    Partial<Record<EquippedRarityVfxTier, HTMLImageElement>>
  >({});
  const skillVfxImagesRef = useRef(new Map<string, HTMLImageElement>());
  const remotePlayersRef = useRef(remotePlayers);
  const inspectableRemotePlayersRef = useRef<readonly PlazaRemotePlayer[]>([]);
  const remoteRenderPointsRef = useRef(new Map<string, RemoteRenderPoint>());
  const remoteWalkCyclesRef = useRef(new Map<string, number>());
  const previousTimeRef = useRef(0);
  const sendTimeRef = useRef(0);
  const sequenceRef = useRef(0);
  const lastSentIntentRef = useRef<Omit<PlazaMoveIntent, "sequence"> | null>(null);
  const nearPortalIdRef = useRef<PlazaPortalId | null>(null);
  const guidedPortalIdRef = useRef<PlazaPortalId | null>(null);
  const onMoveIntentRef = useRef(onMoveIntent);
  const onDashIntentRef = useRef(onDashIntent);
  const onPlayerInspectRef = useRef(onPlayerInspect);
  const pausedRef = useRef(paused);
  const [nearPortalId, setNearPortalId] = useState<PlazaPortalId | null>(null);
  const [guidedPortalId, setGuidedPortalId] = useState<PlazaPortalId | null>(null);
  const [notice, setNotice] = useState("광장 중앙에서 네 갈래의 기억이 이어집니다.");
  const mobilityProfile = useMemo(
    () => resolvePlazaMobilityProfile(equipment),
    [equipment],
  );
  const mobilityProfileRef = useRef(mobilityProfile);
  const characterSpriteKey = character.appearance?.spriteKey;
  const characterEquipped = character.appearance?.equipped;
  const characterPalette = character.appearance?.palette;
  const characterGear = character.appearance?.gear;
  const characterRarities = character.appearance?.rarities;

  const normalizedCharacter = useMemo(
    () => ({
      characterId: character.characterId,
      displayName: safeLabel(character.displayName, "이름 없는 기록자"),
      level: clampLevel(character.level),
      dungeonFloor: normalizeHubDungeonFloor(character.dungeonFloor),
      saveSlot: character.saveSlot,
      appearance: characterSpriteKey !== undefined ||
        characterEquipped !== undefined ||
        characterGear !== undefined ||
        characterRarities !== undefined
        ? {
            spriteKey: characterSpriteKey,
            equipped: characterEquipped,
            palette: characterPalette,
            gear: characterGear,
            rarities: characterRarities,
          }
        : undefined,
    }),
    [
      characterEquipped,
      characterGear,
      characterPalette,
      characterRarities,
      characterSpriteKey,
      character.characterId,
      character.displayName,
      character.dungeonFloor,
      character.level,
      character.saveSlot,
    ],
  );
  const normalizedCharacterRef = useRef(normalizedCharacter);

  useEffect(() => {
    normalizedCharacterRef.current = normalizedCharacter;
  }, [normalizedCharacter]);

  useEffect(() => {
    mobilityProfileRef.current = mobilityProfile;
  }, [mobilityProfile]);

  useEffect(() => {
    guidedPortalIdRef.current = guidedPortalId;
  }, [guidedPortalId]);

  useEffect(() => {
    onMoveIntentRef.current = onMoveIntent;
    lastSentIntentRef.current = null;
  }, [onMoveIntent]);

  useEffect(() => {
    onDashIntentRef.current = onDashIntent;
  }, [onDashIntent]);

  useEffect(() => {
    onPlayerInspectRef.current = onPlayerInspect;
  }, [onPlayerInspect]);

  useEffect(() => {
    pausedRef.current = paused;
    if (!paused) return;
    keysRef.current.clear();
    touchDirectionRef.current = { x: 0, y: 0 };
    pointerTargetRef.current = null;
    dashQueuedRef.current = false;
    dashTimeRef.current = 0;
    movingRef.current = false;
    walkCycleRef.current = settleCharacterWalkCycle(walkCycleRef.current);
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
        dungeonFloor: normalizeHubDungeonFloor(player.dungeonFloor),
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
        remoteWalkCyclesRef.current.set(player.characterId, CHARACTER_IDLE_FRAME);
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
    authoritativePositionRef.current = localAuthoritativePosition
      ? sanitizePlazaPoint(localAuthoritativePosition)
      : null;
    authoritativeMovingRef.current = Boolean(localAuthoritativeMoving);
  }, [localAuthoritativeMoving, localAuthoritativePosition]);

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

  const queueDash = useCallback(() => {
    if (
      pausedRef.current ||
      dashQueuedRef.current ||
      dashTimeRef.current > 0 ||
      dashCooldownRef.current > 0
    ) {
      return;
    }
    dashQueuedRef.current = true;
    pointerTargetRef.current = null;
    setGuidedPortalId(null);
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
    for (const path of [PLAZA_MAP_PATH]) {
      if (sceneImagesRef.current.has(path)) continue;
      const image = new Image();
      image.decoding = "async";
      image.addEventListener("error", () => sceneImagesRef.current.delete(path), {
        once: true,
      });
      image.src = path;
      sceneImagesRef.current.set(path, image);
    }
  }, []);

  useEffect(() => {
    const images = rarityVfxImagesRef.current;
    const ownedImages: Array<readonly [EquippedRarityVfxTier, HTMLImageElement]> = [];
    for (const [tier, path] of Object.entries(EQUIPPED_RARITY_VFX_PATHS) as Array<
      readonly [EquippedRarityVfxTier, string]
    >) {
      const image = new Image();
      image.decoding = "async";
      image.addEventListener(
        "error",
        () => {
          if (images[tier] === image) delete images[tier];
        },
        { once: true },
      );
      image.src = path;
      images[tier] = image;
      ownedImages.push([tier, image]);
    }
    return () => {
      for (const [tier, image] of ownedImages) {
        if (images[tier] === image) delete images[tier];
        image.src = "";
      }
    };
  }, []);

  useEffect(() => {
    const images = skillVfxImagesRef.current;
    const ownedImages: Array<readonly [string, HTMLImageElement]> = [];
    for (const vfxId of PLAZA_MOBILITY_VFX_IDS) {
      const key = gameplayVfxImageKey(vfxId);
      const image = new Image();
      image.decoding = "async";
      image.addEventListener(
        "error",
        () => {
          if (images.get(key) === image) images.delete(key);
        },
        { once: true },
      );
      image.src = GAMEPLAY_VFX_MANIFEST[vfxId].assetPath;
      images.set(key, image);
      ownedImages.push([key, image]);
    }
    return () => {
      for (const [key, image] of ownedImages) {
        if (images.get(key) === image) images.delete(key);
        image.src = "";
      }
    };
  }, []);

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
      if (key === " " && !event.repeat) {
        event.preventDefault();
        queueDash();
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
      dashQueuedRef.current = false;
      dashTimeRef.current = 0;
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", clearKeys);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", clearKeys);
    };
  }, [activateNearbyPortal, guideToPortal, queueDash]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const paperdollImages = paperdollImagesRef.current;
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
    let renderableRemotePlayers: readonly PlazaRemotePlayer[] = [];
    let detailedRemotePlayerIds = new Set<string>();
    let nextRemoteVisibilityCheckAt = 0;

    const refreshRenderableRemotePlayers = (now: number) => {
      if (now < nextRemoteVisibilityCheckAt) return;
      nextRemoteVisibilityCheckAt = now + 120;
      renderableRemotePlayers = selectPlazaRemotePlayersForRender(
        remotePlayersRef.current,
        cameraRef.current,
        viewportRef.current,
      );
      inspectableRemotePlayersRef.current = renderableRemotePlayers;
      detailedRemotePlayerIds = new Set(
        renderableRemotePlayers
          .slice(0, PLAZA_REMOTE_EQUIPMENT_DETAIL_LIMIT)
          .map((player) => player.characterId),
      );

      const requiredLayerPaths = new Set<string>([PAPERDOLL_BODY_PATH]);
      for (const path of paperdollLayerPathsForLoadout(
        paperdollLoadoutFromVisualGear(
          normalizedCharacterRef.current.appearance?.gear,
          "common",
          0,
          normalizedCharacterRef.current.appearance?.rarities,
        ),
      )) requiredLayerPaths.add(path);
      for (const player of renderableRemotePlayers.slice(
        0,
        PLAZA_REMOTE_EQUIPMENT_DETAIL_LIMIT,
      )) {
        for (const path of paperdollLayerPathsForLoadout(
          paperdollLoadoutFromVisualGear(
            player.appearance?.gear,
            "common",
            0,
            player.appearance?.rarities,
          ),
        )) requiredLayerPaths.add(path);
      }
      const pathSignature = [...requiredLayerPaths].sort().join("|");
      if (pathSignature === paperdollPathSignatureRef.current) return;
      paperdollPathSignatureRef.current = pathSignature;
      paperdollImages.reconcile(requiredLayerPaths);
    };

    const frame = (now: number) => {
      const previous = previousTimeRef.current || now;
      const dt = Math.min(0.05, Math.max(0, (now - previous) / 1000));
      previousTimeRef.current = now;
      const time = now / 1000;
      const authoritativeTarget = authoritativePositionRef.current;
      if (
        authoritativeTarget &&
        Math.hypot(
          authoritativeTarget.x - positionRef.current.x,
          authoritativeTarget.y - positionRef.current.y,
        ) > LOCAL_HARD_SNAP_DISTANCE
      ) {
        positionRef.current = { ...authoritativeTarget };
        cameraRef.current = { ...authoritativeTarget };
        pointerTargetRef.current = null;
        movingRef.current = false;
        walkCycleRef.current = settleCharacterWalkCycle(walkCycleRef.current);
      }
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
      const hasMovementInput = magnitude > 0.01;
      if (hasMovementInput) {
        moveX /= Math.max(1, magnitude);
        moveY /= Math.max(1, magnitude);
      }

      const mobility = mobilityProfileRef.current;
      const usesServerAuthority = Boolean(onDashIntentRef.current);
      dashCooldownRef.current = Math.max(0, dashCooldownRef.current - dt);
      riftTrailCooldownRef.current = Math.max(0, riftTrailCooldownRef.current - dt);
      phantomTrailCooldownRef.current = Math.max(0, phantomTrailCooldownRef.current - dt);
      starfallMantleTimeRef.current = Math.max(0, starfallMantleTimeRef.current - dt);
      for (const effect of skillEffectsRef.current) effect.life -= dt;
      skillEffectsRef.current = skillEffectsRef.current.filter((effect) => effect.life > 0);

      if (dashQueuedRef.current && !pausedRef.current && dashCooldownRef.current <= 0) {
        dashQueuedRef.current = false;
        dashDirectionRef.current = plazaDashDirection(
          moveX,
          moveY,
          facingRef.current,
        );
        dashTimeRef.current = PLAZA_DASH_DURATION_SECONDS;
        // The worker accepts the fastest legitimate RiftStride cadence but
        // never trusts arbitrary client cooldown claims. Online prediction
        // keeps a small transport margin so a second local dash cannot race
        // the server timestamp that acknowledged the first one.
        dashCooldownRef.current = Math.max(
          mobility.dashCooldownSeconds,
          HUB_DASH_COOLDOWN_MS / 1_000 + (usesServerAuthority ? 0.1 : 0),
        );
        if (mobility.hasRiftStride) riftTrailCooldownRef.current = 0;
        if (mobility.hasStarfallMantle) {
          starfallMantleTimeRef.current = PLAZA_STARFALL_SECONDS;
          skillEffectsRef.current.push({
            id: ++skillEffectIdRef.current,
            vfxId: legendaryVfxId("starfallMantle"),
            x: positionRef.current.x,
            y: paperdollVisualCenterY(
              positionRef.current.y + PLAZA_PLAYER_GROUND_OFFSET_Y,
              PAPERDOLL_WORLD_RENDER_HEIGHT,
            ),
            size: 118,
            life: 0.54,
            duration: 0.54,
            angle: 0,
          });
          playGameSfx("playerDash", { playbackRate: 1.28, gain: 0.7 });
        }
        const dashDirection = dashDirectionRef.current;
        playGameSfx("playerDash", {
          pan: Math.max(-0.45, Math.min(0.45, dashDirection.x * 0.45)),
        });
        onDashIntentRef.current?.();
      } else if (dashQueuedRef.current && dashCooldownRef.current > 0) {
        dashQueuedRef.current = false;
      }

      const previousPosition = { ...positionRef.current };
      const dashStepSeconds = Math.min(dt, dashTimeRef.current);
      const isDashing = dashStepSeconds > 0;
      const phantomMarchActive =
        mobility.hasPhantomMarch &&
        phantomMoveTimeRef.current >= PLAZA_PHANTOM_ACTIVATION_SECONDS;
      if (isDashing) {
        const direction = dashDirectionRef.current;
        // Online geometry is fixed at the server-authored 900px/s. The local
        // QA/offline fallback may still preview legitimate equipment speed.
        const dashSpeed = usesServerAuthority ? HUB_DASH_SPEED : mobility.dashSpeed;
        positionRef.current = resolvePlazaSweptMovement(positionRef.current, {
          x: direction.x * dashSpeed * dashStepSeconds,
          y: direction.y * dashSpeed * dashStepSeconds,
        });
        dashTimeRef.current = Math.max(0, dashTimeRef.current - dashStepSeconds);
        if (mobility.hasRiftStride && riftTrailCooldownRef.current <= 0) {
          riftTrailCooldownRef.current = 0.055;
          skillEffectsRef.current.push({
            id: ++skillEffectIdRef.current,
            vfxId: legendaryVfxId("riftStride"),
            x: positionRef.current.x,
            y: positionRef.current.y + PLAZA_PLAYER_GROUND_OFFSET_Y,
            size: 52,
            life: 0.3,
            duration: 0.3,
            angle: Math.atan2(direction.y, direction.x),
          });
        }
      } else if (hasMovementInput) {
        const movementMultiplier = usesServerAuthority
          ? 1
          : mobility.moveSpeedMultiplier *
            (phantomMarchActive ? PLAZA_PHANTOM_MOVE_MULTIPLIER : 1);
        positionRef.current = resolvePlazaMovement(positionRef.current, {
          x: moveX * PLAYER_SPEED * movementMultiplier * dt,
          y: moveY * PLAYER_SPEED * movementMultiplier * dt,
        });
      }

      if (
        !hasMovementInput &&
        !isDashing &&
        authoritativeTarget &&
        !authoritativeMovingRef.current
      ) {
        const correctionX = authoritativeTarget.x - positionRef.current.x;
        const correctionY = authoritativeTarget.y - positionRef.current.y;
        const correctionDistance = Math.hypot(correctionX, correctionY);
        if (correctionDistance <= LOCAL_CORRECTION_DEAD_ZONE) {
          positionRef.current = { ...authoritativeTarget };
        } else {
          const correctionAlpha = 1 - Math.exp(-dt * LOCAL_CORRECTION_RESPONSE_PER_SECOND);
          positionRef.current = resolvePlazaMovement(positionRef.current, {
            x: correctionX * correctionAlpha,
            y: correctionY * correctionAlpha,
          });
        }
      }

      const motion = resolveCharacterMotion(
        positionRef.current.x - previousPosition.x,
        positionRef.current.y - previousPosition.y,
        facingRef.current,
        0.01,
      );
      phantomMoveTimeRef.current = advanceContinuousMovement(
        phantomMoveTimeRef.current,
        dt,
        mobility.hasPhantomMarch && motion.moving,
        PLAZA_PHANTOM_ACTIVATION_SECONDS,
      );
      const phantomMarchNowActive =
        mobility.hasPhantomMarch &&
        phantomMoveTimeRef.current >= PLAZA_PHANTOM_ACTIVATION_SECONDS;
      if (
        phantomMarchNowActive &&
        motion.moving &&
        phantomTrailCooldownRef.current <= 0
      ) {
        phantomTrailCooldownRef.current = 0.4;
        skillEffectsRef.current.push({
          id: ++skillEffectIdRef.current,
          vfxId: legendaryVfxId("phantomMarch"),
          x: previousPosition.x,
          y: previousPosition.y + PLAZA_PLAYER_GROUND_OFFSET_Y,
          size: 74,
          life: 0.95,
          duration: 0.95,
          angle: Math.atan2(
            positionRef.current.y - previousPosition.y,
            positionRef.current.x - previousPosition.x,
          ),
        });
      }
      if (motion.moving) {
        if (hasMovementInput || isDashing) {
          // Tiny authoritative settling steps must not turn the character back
          // toward an older server sample after the player releases a key.
          facingRef.current = motion.facing;
        }
        movingRef.current = true;
        walkCycleRef.current = advanceCharacterWalkCycle(
          walkCycleRef.current,
          motion.distance,
          isDashing ? 220 : undefined,
          dt,
        );
      } else {
        movingRef.current = false;
        walkCycleRef.current = settleCharacterWalkCycle(walkCycleRef.current);
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
      const cameraLerp = 1 - Math.exp(-dt * CAMERA_RESPONSE_PER_SECOND);
      cameraRef.current.x += (desiredCameraX - cameraRef.current.x) * cameraLerp;
      cameraRef.current.y += (desiredCameraY - cameraRef.current.y) * cameraLerp;
      refreshRenderableRemotePlayers(now);

      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, width, height);
      context.save();
      context.translate(
        Math.round(width / 2 - cameraRef.current.x),
        Math.round(height / 2 - cameraRef.current.y),
      );
      const plazaMap = sceneImagesRef.current.get(PLAZA_MAP_PATH);
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

      for (const effect of skillEffectsRef.current) {
        const progress = Math.max(
          0,
          Math.min(0.999_999, 1 - effect.life / effect.duration),
        );
        const drawn = drawGameplayVfxFrame(
          context,
          skillVfxImagesRef.current.get(gameplayVfxImageKey(effect.vfxId)),
          GAMEPLAY_VFX_MANIFEST[effect.vfxId],
          {
            x: effect.x,
            y: effect.y,
            size: effect.size,
            progress,
            angle: effect.angle,
            alpha: Math.min(1, Math.sin(progress * Math.PI) * 1.38),
            interpolateFrames: true,
          },
        );
        if (!drawn) {
          context.save();
          context.globalCompositeOperation = "lighter";
          context.globalAlpha = Math.sin(progress * Math.PI) * 0.72;
          context.fillStyle = effect.vfxId === legendaryVfxId("riftStride")
            ? "#bd6cff"
            : effect.vfxId === legendaryVfxId("phantomMarch")
              ? "#a68cff"
              : "#ffe69a";
          context.shadowColor = context.fillStyle;
          context.shadowBlur = 18;
          context.beginPath();
          context.arc(effect.x, effect.y, effect.size * 0.18, 0, Math.PI * 2);
          context.fill();
          context.restore();
        }
      }

      const currentTime = Date.now();
      const remoteLerp = 1 - Math.exp(-dt * 11);
      const players: DrawPlayer[] = renderableRemotePlayers.map((player) => {
        const renderPoint = remoteRenderPointsRef.current.get(player.characterId);
        let previousRenderX = renderPoint?.x ?? player.x;
        let previousRenderY = renderPoint?.y ?? player.y;
        if (renderPoint) {
          const remainingDistance = Math.hypot(
            renderPoint.targetX - renderPoint.x,
            renderPoint.targetY - renderPoint.y,
          );
          if (!player.moving && remainingDistance <= REMOTE_SETTLE_DISTANCE) {
            renderPoint.x = renderPoint.targetX;
            renderPoint.y = renderPoint.targetY;
            previousRenderX = renderPoint.x;
            previousRenderY = renderPoint.y;
          } else {
            renderPoint.x += (renderPoint.targetX - renderPoint.x) * remoteLerp;
            renderPoint.y += (renderPoint.targetY - renderPoint.y) * remoteLerp;
          }
        }
        const remoteMotion = resolveCharacterMotion(
          (renderPoint?.x ?? player.x) - previousRenderX,
          (renderPoint?.y ?? player.y) - previousRenderY,
          player.facing,
          0.01,
        );
        const previousWalkCycle =
          remoteWalkCyclesRef.current.get(player.characterId) ?? CHARACTER_IDLE_FRAME;
        const walkCycle = remoteMotion.moving
          ? advanceCharacterWalkCycle(
              previousWalkCycle,
              remoteMotion.distance,
              undefined,
              dt,
            )
          : settleCharacterWalkCycle(previousWalkCycle);
        remoteWalkCyclesRef.current.set(player.characterId, walkCycle);
        return {
          key: player.characterId,
          displayName: player.displayName,
          level: player.level,
          x: renderPoint?.x ?? player.x,
          y: renderPoint?.y ?? player.y,
          facing: remoteMotion.moving ? remoteMotion.facing : player.facing,
          moving: remoteMotion.moving,
          walkCycle,
          gear: detailedRemotePlayerIds.has(player.characterId)
            ? player.appearance.gear
            : undefined,
          rarities: detailedRemotePlayerIds.has(player.characterId)
            ? player.appearance.rarities
            : undefined,
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
        walkCycle: walkCycleRef.current,
        gear: localCharacter.appearance?.gear,
        rarities: localCharacter.appearance?.rarities,
        local: true,
        stale: false,
      });
      players.sort((left, right) => left.y - right.y || Number(left.local) - Number(right.local));
      for (const player of players) {
        drawPlayer(
          context,
          player,
          paperdollImages.get(PAPERDOLL_BODY_PATH),
          paperdollImages.imageMap(),
          rarityVfxImagesRef.current,
          now,
          readableCanvasFontSize,
        );
      }
      if (starfallMantleTimeRef.current > 0) {
        const mantleVfxId = legendaryVfxId("starfallMantle");
        const bodyCenterY = paperdollVisualCenterY(
          positionRef.current.y + PLAZA_PLAYER_GROUND_OFFSET_Y,
          PAPERDOLL_WORLD_RENDER_HEIGHT,
        );
        const mantleDrawn = drawGameplayVfxFrame(
          context,
          skillVfxImagesRef.current.get(gameplayVfxImageKey(mantleVfxId)),
          GAMEPLAY_VFX_MANIFEST[mantleVfxId],
          {
            x: positionRef.current.x,
            y: bodyCenterY,
            size: 108,
            progress: ((time * 1.4) % 1 + 1) % 1,
            alpha: 0.92,
            interpolateFrames: true,
          },
        );
        if (!mantleDrawn) {
          context.save();
          context.globalCompositeOperation = "lighter";
          context.fillStyle = "#ffeaa6";
          context.shadowColor = "#f8d98a";
          context.shadowBlur = 16;
          context.fillRect(positionRef.current.x - 2, bodyCenterY - 2, 4, 4);
          context.restore();
        }
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
      paperdollPathSignatureRef.current = "";
      paperdollImages.clear();
      previousTimeRef.current = 0;
      dashQueuedRef.current = false;
      dashTimeRef.current = 0;
      skillEffectsRef.current = [];
      starfallMantleTimeRef.current = 0;
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

  const handleCanvasContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLCanvasElement>) => {
      event.preventDefault();
      if (pausedRef.current) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const worldPoint = canvasClientPointToWorld(
        event.clientX,
        event.clientY,
        canvas.getBoundingClientRect(),
        viewportRef.current,
        cameraRef.current,
      );
      const inspectablePlayers = inspectableRemotePlayersRef.current.map((player) => {
        const rendered = remoteRenderPointsRef.current.get(player.characterId);
        return {
          ...player,
          x: rendered?.x ?? player.x,
          y: rendered?.y ?? player.y,
        };
      });
      const player = pickPlazaInspectablePlayer(inspectablePlayers, worldPoint);
      if (!player) {
        setNotice("다른 기록자를 우클릭하면 캐릭터 정보를 확인할 수 있습니다.");
        return;
      }
      pointerTargetRef.current = null;
      setGuidedPortalId(null);
      setNotice(`${player.displayName}의 공개 기록을 펼쳤습니다.`);
      canvas.focus({ preventScroll: true });
      onPlayerInspectRef.current?.(player);
    },
    [],
  );

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
        aria-label="무진도 공동 광장. WASD 또는 방향키로 이동하고 Space로 회피하며 E 또는 Enter로 가까운 포탈을 이용합니다. 바닥을 누르면 이동하고 다른 플레이어를 우클릭하면 캐릭터 정보를 확인합니다."
        onPointerDown={handleCanvasPointer}
        onContextMenu={handleCanvasContextMenu}
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
        {onSelfInspect ? (
          <button type="button" onClick={onSelfInspect}>
            캐릭터 정보
          </button>
        ) : null}
        {onInventoryOpen ? (
          <button
            type="button"
            onClick={onInventoryOpen}
            aria-keyshortcuts="I"
          >
            장비 확인 · I
          </button>
        ) : null}
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
        <button
          type="button"
          className="is-dash"
          aria-label="회피 대시"
          onPointerDown={(event) => {
            event.preventDefault();
            queueDash();
          }}
        >
          회피
        </button>
      </div>

      <p className="plaza-control-hint">
        WASD / 방향키 이동 · <kbd>Space</kbd> 회피 · <kbd>I</kbd> 장비 확인 · <kbd>E</kbd> 포탈 이용 · 숫자 1–4 포탈 안내
      </p>
    </main>
  );
}
