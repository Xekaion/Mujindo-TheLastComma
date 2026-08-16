"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
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
  PAPERDOLL_BODY_ATLAS_HEIGHT,
  PAPERDOLL_BODY_ATLAS_WIDTH,
  PAPERDOLL_BODY_PATH,
  PAPERDOLL_GROUND_ANCHOR_RATIO,
  PAPERDOLL_WORLD_RENDER_HEIGHT,
  PAPERDOLL_WORLD_RENDER_WIDTH,
  drawPaperdollCharacterDirectReport,
  isPaperdollBodyAtlasReady,
  paperdollLayerPathsForLoadout,
  paperdollLoadoutFromEquipment,
  paperdollLoadoutFromVisualGear,
  paperdollVisualCenterY,
  resolvePaperdollLayerInfo,
} from "./character-paperdoll";
import { createBrowserPaperdollImageStore } from "./paperdoll-image-store";
import {
  countPaperdollAlphaPixels,
  countPaperdollChangedPixels,
} from "./paperdoll-runtime-pixels";
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
  LEGENDARY_VFX_IDS,
  drawGameplayVfxFrame,
  gameplayVfxImageKey,
  legendaryVfxId,
  type GameplayVfxId,
} from "./augment-vfx";
import { playGameSfx } from "./game-audio";
import { advanceContinuousMovement } from "./legendary-runtime";
import {
  compactPositiveFieldInPlace,
  shouldProcessContinuousFrame,
} from "./runtime-performance";
import {
  MAX_PLAZA_BACKING_SCALE,
  canvasBackingDimensions,
} from "./canvas-performance";
import { EQUIPMENT_SLOTS, type EquipmentLoadout } from "./equipment";
import {
  PLAZA_DASH_DURATION_SECONDS,
  PLAZA_PHANTOM_ACTIVATION_SECONDS,
  PLAZA_PHANTOM_MOVE_MULTIPLIER,
  PLAZA_STARFALL_SECONDS,
  plazaDashDirection,
  resolvePlazaDashPowerVfxSpecs,
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
export const PLAZA_PORTAL_ART_PATHS: Readonly<Record<PlazaPortalId, string>> = {
  expedition: "/assets/plaza/portal-expedition-v2.png",
  duel: "/assets/plaza/portal-duel-v2.png",
  exchange: "/assets/plaza/portal-exchange-v2.png",
  caravan: "/assets/plaza/portal-caravan-v2.png",
};
export const PLAZA_PORTAL_DOORWAY_EFFECT_PATHS: Readonly<Record<PlazaPortalId, string>> = {
  expedition: "/assets/plaza/portal-expedition-effect-v3.png",
  duel: "/assets/plaza/portal-duel-effect-v3.png",
  exchange: "/assets/plaza/portal-exchange-effect-v3.png",
  caravan: "/assets/plaza/portal-caravan-effect-v3.png",
};
export const PLAZA_PLAYER_GROUND_OFFSET_Y = 8;
export const PLAZA_PLAYER_SHADOW_CENTER_OFFSET_Y = 18;
export const PLAZA_PLAYER_SHADOW_RADIUS_Y = 12;
/** Keep characters just outside the camera warm without drawing the whole plaza. */
export const PLAZA_REMOTE_RENDER_MARGIN = 220;
/** Hard upper bound for paperdoll work when many players overlap one screen. */
export const PLAZA_REMOTE_RENDER_LIMIT = 32;
/** Only the nearest players keep ten high-resolution wearable atlases resident. */
export const PLAZA_REMOTE_EQUIPMENT_DETAIL_LIMIT = 2;
export const PLAZA_KEYBOARD_INSPECT_RADIUS = 240;

/**
 * Canonical painter's order for the local actor stack. Keeping this explicit
 * prevents additive equipment effects from leaking above nearer actors or UI.
 */
export const PLAZA_PLAYER_RENDER_PASS_ORDER = [
  "ground-vfx",
  "shadow",
  "paperdoll",
  "equipped-vfx",
  "body-vfx",
  "foreground-vfx",
  "nameplate",
] as const;

export function plazaPlayerGroundAnchorY(playerY: number): number {
  return playerY + PLAZA_PLAYER_GROUND_OFFSET_Y;
}

export function plazaPlayerBodyCenterY(playerY: number): number {
  return paperdollVisualCenterY(
    plazaPlayerGroundAnchorY(playerY),
    PAPERDOLL_WORLD_RENDER_HEIGHT,
  );
}

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

/** Localhost visual QA override. It changes rendering only, never movement. */
export type PlazaPaperdollQaPose = Readonly<{
  key: string;
  direction: HubFacing;
  frame: 0 | 1 | 2 | 3;
}>;

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
  paperdollQaPose?: PlazaPaperdollQaPose;
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
  frameOverride?: number;
  gear: HubAppearance["gear"] | undefined;
  rarities: HubAppearance["rarities"] | undefined;
  /** Canonical local loadout; remote actors fall back to public visual fields. */
  loadout?: ReturnType<typeof paperdollLoadoutFromVisualGear>;
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
  delaySeconds: number;
  layer: "body" | "ground";
  renderPass: "ground" | "body" | "foreground";
  maxAlpha: number;
};

const PLAZA_SKILL_FALLBACK_COLORS = {
  [legendaryVfxId("crescentEcho")]: "#bdeeff",
  [legendaryVfxId("mirrorAegis")]: "#8fcaff",
  [legendaryVfxId("hunterSigil")]: "#ffb45e",
  [legendaryVfxId("starfallMantle")]: "#ffe69a",
  [legendaryVfxId("lastMemory")]: "#f2fff0",
  [legendaryVfxId("bloodwovenGrip")]: "#ff5d78",
  [legendaryVfxId("ashboundGirdle")]: "#ff9d63",
  [legendaryVfxId("phantomMarch")]: "#a68cff",
  [legendaryVfxId("riftStride")]: "#bd6cff",
  [legendaryVfxId("commaResonance")]: "#7df8ff",
} satisfies Partial<Record<GameplayVfxId, string>>;

function drawPlazaSkillEffect(
  context: CanvasRenderingContext2D,
  effect: PlazaSkillEffect,
  images: ReadonlyMap<string, HTMLImageElement>,
) {
  if (effect.delaySeconds > 0) return;
  const progress = Math.max(
    0,
    Math.min(0.999_999, 1 - effect.life / effect.duration),
  );
  const drawn = drawGameplayVfxFrame(
    context,
    images.get(gameplayVfxImageKey(effect.vfxId)),
    GAMEPLAY_VFX_MANIFEST[effect.vfxId],
    {
      x: effect.x,
      y: effect.y,
      size: effect.size,
      progress,
      angle: effect.angle,
      alpha: Math.sin(progress * Math.PI) * effect.maxAlpha,
      interpolateFrames: true,
    },
  );
  if (drawn) return;

  context.save();
  context.globalCompositeOperation = "lighter";
  context.globalAlpha = Math.sin(progress * Math.PI) * effect.maxAlpha;
  context.fillStyle = PLAZA_SKILL_FALLBACK_COLORS[effect.vfxId] ?? "#ffe69a";
  context.shadowColor = context.fillStyle;
  context.shadowBlur = 18;
  context.beginPath();
  context.arc(effect.x, effect.y, effect.size * 0.18, 0, Math.PI * 2);
  context.fill();
  context.restore();
}

function drawPlazaSkillEffectsForPass(
  context: CanvasRenderingContext2D,
  effects: readonly PlazaSkillEffect[],
  renderPass: PlazaSkillEffect["renderPass"],
  images: ReadonlyMap<string, HTMLImageElement>,
) {
  for (const effect of effects) {
    if (effect.renderPass !== renderPass) continue;
    drawPlazaSkillEffect(context, effect, images);
  }
}

function drawPlazaStarfallMantle(
  context: CanvasRenderingContext2D,
  x: number,
  playerY: number,
  time: number,
  remainingSeconds: number,
  images: ReadonlyMap<string, HTMLImageElement>,
) {
  if (remainingSeconds <= 0) return;
  const mantleVfxId = legendaryVfxId("starfallMantle");
  const bodyCenterY = plazaPlayerBodyCenterY(playerY);
  const endFade = Math.min(1, remainingSeconds / 0.32);
  const pulse = 0.42 + (Math.sin(time * 4.2) + 1) * 0.045;
  const mantleDrawn = drawGameplayVfxFrame(
    context,
    images.get(gameplayVfxImageKey(mantleVfxId)),
    GAMEPLAY_VFX_MANIFEST[mantleVfxId],
    {
      x,
      y: bodyCenterY,
      size: 90,
      progress: ((time * 1.05) % 1 + 1) % 1,
      alpha: pulse * endFade,
      interpolateFrames: true,
    },
  );
  if (mantleDrawn) return;

  context.save();
  context.globalCompositeOperation = "lighter";
  context.globalAlpha = pulse * endFade;
  context.fillStyle = "#ffeaa6";
  context.shadowColor = "#f8d98a";
  context.shadowBlur = 12;
  context.fillRect(x - 2, bodyCenterY - 2, 4, 4);
  context.restore();
}

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

function plazaDoorwayEffectLayout(portal: PlazaPortalDefinition) {
  if (portal.id === "expedition") {
    return { x: portal.x, y: portal.y - 20, width: 220, height: 220 };
  }
  if (portal.id === "duel") {
    return { x: portal.x - 80, y: portal.y - 60, width: 250, height: 250 };
  }
  if (portal.id === "exchange") {
    return { x: portal.x + 95, y: portal.y - 60, width: 250, height: 250 };
  }
  return { x: portal.x, y: portal.y - 15, width: 220, height: 220 };
}

function plazaPortalLabelPoint(portal: PlazaPortalDefinition): PlazaPoint {
  if (portal.id === "expedition") return { x: portal.x, y: portal.y + 180 };
  if (portal.id === "duel") return { x: portal.x + 140, y: portal.y - 160 };
  if (portal.id === "exchange") return { x: portal.x - 140, y: portal.y - 160 };
  return { x: portal.x, y: portal.y - 190 };
}

function plazaPortalAtDoorwayPoint(point: PlazaPoint): PlazaPortalDefinition | null {
  for (const portal of PLAZA_PORTALS) {
    const layout = plazaDoorwayEffectLayout(portal);
    if (
      Math.abs(point.x - layout.x) <= layout.width / 2 &&
      Math.abs(point.y - layout.y) <= layout.height / 2
    ) {
      return portal;
    }
  }
  return null;
}

function drawDoorwayEffectFallback(
  context: CanvasRenderingContext2D,
  portal: PlazaPortalDefinition,
  width: number,
  height: number,
  pulse: number,
) {
  context.save();
  context.globalCompositeOperation = "lighter";
  context.shadowColor = portal.hue;
  context.shadowBlur = 14 + pulse * 10;
  const rift = context.createRadialGradient(0, 0, 2, 0, 0, width * 0.24);
  rift.addColorStop(0, portal.accent);
  rift.addColorStop(0.2, `${portal.hue}c8`);
  rift.addColorStop(0.7, `${portal.hue}38`);
  rift.addColorStop(1, `${portal.hue}00`);
  context.fillStyle = rift;
  context.beginPath();
  context.ellipse(0, 0, width * 0.18, height * 0.38, 0, 0, Math.PI * 2);
  context.fill();

  context.strokeStyle = `${portal.accent}a8`;
  context.lineWidth = 1.5;
  context.setLineDash([3, 9]);
  context.lineDashOffset = -pulse * 12;
  context.beginPath();
  context.ellipse(0, 0, width * 0.15, height * 0.31, 0, 0, Math.PI * 2);
  context.stroke();
  context.restore();
}

function drawPortalGuidance(
  context: CanvasRenderingContext2D,
  portal: PlazaPortalDefinition,
  player: PlazaPoint,
  time: number,
  nearby: boolean,
  reducedMotion: boolean,
) {
  const approach = { x: portal.x, y: portal.y };
  const pulse = reducedMotion ? 0.72 : 0.58 + Math.sin(time * 3.4) * 0.14;
  context.save();
  context.globalCompositeOperation = "lighter";
  context.lineCap = "round";

  if (!nearby) {
    const route = context.createLinearGradient(player.x, player.y, approach.x, approach.y);
    route.addColorStop(0, `${portal.hue}00`);
    route.addColorStop(0.2, `${portal.hue}45`);
    route.addColorStop(1, `${portal.accent}c7`);
    context.strokeStyle = route;
    context.lineWidth = 4;
    context.setLineDash([3, 20]);
    context.lineDashOffset = reducedMotion ? 0 : -time * 54;
    context.beginPath();
    context.moveTo(player.x, player.y + 20);
    context.lineTo(approach.x, approach.y);
    context.stroke();
    context.setLineDash([]);
  }

  context.translate(approach.x, approach.y + 18);
  context.strokeStyle = portal.accent;
  context.globalAlpha = pulse;
  context.shadowColor = portal.hue;
  context.shadowBlur = nearby ? 24 : 14;
  context.lineWidth = nearby ? 4 : 2;
  context.beginPath();
  context.ellipse(0, 0, nearby ? 70 : 54, nearby ? 31 : 24, 0, 0, Math.PI * 2);
  context.stroke();
  context.globalAlpha *= 0.55;
  context.beginPath();
  context.ellipse(0, 0, nearby ? 47 : 34, nearby ? 20 : 15, 0, 0, Math.PI * 2);
  context.stroke();
  context.restore();
}

function drawPortal(
  context: CanvasRenderingContext2D,
  portal: PlazaPortalDefinition,
  time: number,
  selected: boolean,
  nearby: boolean,
  artwork: HTMLImageElement | undefined,
  reducedMotion: boolean,
) {
  const animatedTime = reducedMotion ? 0 : time;
  const phase = (animatedTime % PORTAL_PULSE_SECONDS) / PORTAL_PULSE_SECONDS;
  const pulse = 0.5 + Math.sin(phase * Math.PI * 2) * 0.5;
  const layout = plazaDoorwayEffectLayout(portal);
  context.save();
  context.translate(layout.x, layout.y);

  const artworkReady = Boolean(
    artwork?.complete && artwork.naturalWidth > 0 && artwork.naturalHeight > 0,
  );
  if (!artworkReady) {
    drawDoorwayEffectFallback(context, portal, layout.width, layout.height, pulse);
  } else if (artwork) {
    context.globalCompositeOperation = "screen";
    context.shadowColor = portal.hue;
    context.shadowBlur = selected ? 12 + pulse * 10 : 4;
    context.globalAlpha = (selected ? 0.96 : 0.76) * (0.94 + pulse * 0.06);
    context.drawImage(
      artwork,
      -layout.width / 2,
      -layout.height / 2,
      layout.width,
      layout.height,
    );
  }
  context.restore();

  const label = plazaPortalLabelPoint(portal);
  context.save();
  context.textAlign = "center";
  context.shadowColor = "#000";
  context.shadowBlur = 12;
  context.globalAlpha = selected ? 1 : 0.86;
  context.fillStyle = "#f2ead8";
  context.font = "700 24px 'Noto Serif KR', Georgia, serif";
  context.fillText(portal.name, label.x, label.y);
  const titleWidth = Math.min(132, context.measureText(portal.name).width + 46);
  context.strokeStyle = `${portal.hue}${selected ? "a8" : "5c"}`;
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(label.x - titleWidth, label.y - 7);
  context.lineTo(label.x - titleWidth * 0.52, label.y - 7);
  context.moveTo(label.x + titleWidth * 0.52, label.y - 7);
  context.lineTo(label.x + titleWidth, label.y - 7);
  context.stroke();
  context.fillStyle = portal.accent;
  context.font = "700 14px Pretendard, sans-serif";
  context.letterSpacing = "1.6px";
  context.fillText(
    selected ? (nearby ? "입장 준비 완료" : "경로 동기화 중") : portal.englishName,
    label.x,
    label.y + 22,
  );
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

type PlazaPlayerDrawPlan = Readonly<{
  alpha: number;
  frame: number;
  loadout: ReturnType<typeof paperdollLoadoutFromVisualGear>;
}>;

function createPlazaPlayerDrawPlan(player: DrawPlayer): PlazaPlayerDrawPlan {
  return {
    alpha: player.stale ? 0.44 : 1,
    frame:
      player.frameOverride ??
      characterRenderFrameIndex(
        player.facing,
        player.walkCycle,
        player.moving,
      ),
    loadout:
      player.loadout ??
      paperdollLoadoutFromVisualGear(
        player.gear,
        "common",
        0,
        player.rarities,
      ),
  };
}

/**
 * Rebuild the QA identity from the canonical loadout that the renderer is
 * actually about to draw.  Never echo the requested QA key: doing so would
 * let a stale or mismatched loadout satisfy the browser sweep.
 */
function paperdollQaRenderedKey(
  plan: PlazaPlayerDrawPlan,
  direction: number,
): string | null {
  const pieces = EQUIPMENT_SLOTS.flatMap((slot) => {
    const piece = plan.loadout[slot];
    return piece ? [piece] : [];
  });
  if (pieces.length === 1) {
    const [piece] = pieces;
    return `${piece.slot}/${String(piece.variant).padStart(2, "0")}/${direction}/${plan.frame}`;
  }
  if (pieces.length === EQUIPMENT_SLOTS.length) {
    const variants = pieces
      .map((piece) => String(piece.variant).padStart(2, "0"))
      .join("-");
    return `full/${variants}/${direction}/${plan.frame}`;
  }
  return null;
}

type PaperdollQaProbeCanvases = Readonly<{
  blankBodyAtlas: HTMLCanvasElement;
  layerDestination: HTMLCanvasElement;
  bodyBaseline: HTMLCanvasElement;
  compositeDestination: HTMLCanvasElement;
}>;

type PaperdollQaDestinationRender = Readonly<{
  complete: boolean;
  pixels: Uint8ClampedArray;
}>;

const EMPTY_PAPERDOLL_QA_PIXELS = new Uint8ClampedArray(0);

function createPaperdollQaCanvas(width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function createPaperdollQaProbeCanvases(): PaperdollQaProbeCanvases {
  return {
    // The direct renderer requires a registered body atlas. Keeping this atlas
    // transparent makes rear-pass equipment measurable without the mannequin
    // legitimately occluding it.
    blankBodyAtlas: createPaperdollQaCanvas(
      PAPERDOLL_BODY_ATLAS_WIDTH,
      PAPERDOLL_BODY_ATLAS_HEIGHT,
    ),
    layerDestination: createPaperdollQaCanvas(
      PAPERDOLL_WORLD_RENDER_WIDTH,
      PAPERDOLL_WORLD_RENDER_HEIGHT,
    ),
    bodyBaseline: createPaperdollQaCanvas(
      PAPERDOLL_WORLD_RENDER_WIDTH,
      PAPERDOLL_WORLD_RENDER_HEIGHT,
    ),
    compositeDestination: createPaperdollQaCanvas(
      PAPERDOLL_WORLD_RENDER_WIDTH,
      PAPERDOLL_WORLD_RENDER_HEIGHT,
    ),
  };
}

function resetPaperdollQaDestination(
  canvas: HTMLCanvasElement,
): CanvasRenderingContext2D | null {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.globalAlpha = 1;
  context.globalCompositeOperation = "source-over";
  context.imageSmoothingEnabled = false;
  context.clearRect(0, 0, canvas.width, canvas.height);
  return context;
}

function renderPaperdollQaDestination(
  destination: HTMLCanvasElement,
  bodyAtlas: CanvasImageSource,
  layerSources: ReadonlyMap<string, HTMLImageElement>,
  loadout: unknown,
  direction: number,
  frame: number,
  expectedLayerCount: number,
): PaperdollQaDestinationRender {
  const context = resetPaperdollQaDestination(destination);
  if (!context) {
    return { complete: false, pixels: EMPTY_PAPERDOLL_QA_PIXELS };
  }
  try {
    const result = drawPaperdollCharacterDirectReport(context, {
      bodyAtlas,
      layerSources,
      loadout,
      direction,
      frame,
      x: PAPERDOLL_WORLD_RENDER_WIDTH / 2,
      y: PAPERDOLL_WORLD_RENDER_HEIGHT * PAPERDOLL_GROUND_ANCHOR_RATIO,
      width: PAPERDOLL_WORLD_RENDER_WIDTH,
      height: PAPERDOLL_WORLD_RENDER_HEIGHT,
      alpha: 1,
    });
    const pixels = context.getImageData(
      0,
      0,
      PAPERDOLL_WORLD_RENDER_WIDTH,
      PAPERDOLL_WORLD_RENDER_HEIGHT,
    ).data;
    return {
      complete:
        result.drawn &&
        result.complete &&
        result.drawnLayerCount === expectedLayerCount,
      pixels,
    };
  } catch {
    return { complete: false, pixels: EMPTY_PAPERDOLL_QA_PIXELS };
  }
}

function drawPlazaPlayerShadow(
  context: CanvasRenderingContext2D,
  player: DrawPlayer,
) {
  const shadowWidth = player.local ? 34 : 30;
  context.save();
  context.globalAlpha = player.stale ? 0.44 : 1;
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
  context.restore();
}

function drawPlazaPlayerPaperdoll(
  context: CanvasRenderingContext2D,
  player: DrawPlayer,
  plan: PlazaPlayerDrawPlan,
  bodyImage: HTMLImageElement | undefined,
  layerSources: ReadonlyMap<string, HTMLImageElement>,
) {
  const result =
    bodyImage?.complete && bodyImage.naturalWidth > 0
      ? drawPaperdollCharacterDirectReport(context, {
        bodyAtlas: bodyImage,
        layerSources,
        loadout: plan.loadout,
        direction: player.facing,
        frame: plan.frame,
        x: player.x,
        y: plazaPlayerGroundAnchorY(player.y),
        width: PAPERDOLL_WORLD_RENDER_WIDTH,
        height: PAPERDOLL_WORLD_RENDER_HEIGHT,
        alpha: plan.alpha,
      })
      : { drawn: false, complete: false, drawnLayerCount: 0 };
  if (!result.drawn) {
    context.save();
    context.globalAlpha = plan.alpha;
    context.fillStyle = player.local ? "#9b3f43" : "#3b6973";
    context.beginPath();
    context.arc(player.x, player.y - 16, 24, 0, Math.PI * 2);
    context.fill();
    context.restore();
  }
  return result;
}

function drawPlazaPlayerEquippedVfx(
  context: CanvasRenderingContext2D,
  player: DrawPlayer,
  plan: PlazaPlayerDrawPlan,
  rarityVfxImages: EquippedRarityVfxImageMap,
  timeMs: number,
  appearanceDrawn: boolean,
) {
  // Coarse remote players intentionally carry no rarity map. That avoids both
  // hidden rarity disclosure and needless plan allocation for the other 29
  // visible players; only the local actor and two detailed remotes reach VFX.
  if (!appearanceDrawn || (!player.local && !player.rarities)) return;
  drawEquippedRarityVfx(context, {
    plan: resolveEquippedRarityVfxPlan(plan.loadout),
    images: rarityVfxImages,
    direction: player.facing,
    frame: plan.frame,
    timeMs,
    x: player.x,
    y: plazaPlayerGroundAnchorY(player.y),
    width: PAPERDOLL_WORLD_RENDER_WIDTH,
    height: PAPERDOLL_WORLD_RENDER_HEIGHT,
    context: player.local ? "plaza-local" : "plaza-remote",
    alpha: plan.alpha,
  });
}

function drawPlazaPlayerNameplate(
  context: CanvasRenderingContext2D,
  player: DrawPlayer,
  readableCanvasFontSize: (basePx: number, minimumCssPx: number) => number,
) {
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

function connectionEyebrow(state: PlazaConnectionState) {
  if (state === "online") return "SANCTUM ONLINE";
  if (state === "connecting") return "OPENING CHANNEL";
  if (state === "reconnecting") return "RESTORING CHANNEL";
  return "LOCAL SANCTUM";
}

function portalActionLabel(id: PlazaPortalId) {
  if (id === "expedition") return "원정으로 진입";
  if (id === "duel") return "결투장 입장";
  if (id === "exchange") return "거래소 열기";
  return "기억상단 살펴보기";
}

function portalDirectoryEyebrow(id: PlazaPortalId) {
  if (id === "expedition") return "ENDLESS GATE";
  if (id === "duel") return "DUEL GATE";
  if (id === "exchange") return "TRADE GATE";
  return "CARAVAN GATE";
}

function portalGuideStatus(
  id: PlazaPortalId,
  guidedPortalId: PlazaPortalId | null,
  nearPortalId: PlazaPortalId | null,
) {
  if (nearPortalId === id) return "공명 완료";
  if (guidedPortalId === id) return "길 안내 중";
  return "길 안내";
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
  paperdollQaPose,
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
  const [paperdollImageStore] = useState(createBrowserPaperdollImageStore);
  const paperdollImagesRef = useRef(paperdollImageStore);
  const paperdollPathSignatureRef = useRef("");
  const paperdollQaPoseRef = useRef(paperdollQaPose);
  const paperdollQaProbeCanvasesRef = useRef<PaperdollQaProbeCanvases | null>(
    null,
  );
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
  const reducedMotionRef = useRef(false);
  const onMoveIntentRef = useRef(onMoveIntent);
  const onDashIntentRef = useRef(onDashIntent);
  const onPlayerInspectRef = useRef(onPlayerInspect);
  const pausedRef = useRef(paused);
  const [nearPortalId, setNearPortalId] = useState<PlazaPortalId | null>(null);
  const [guidedPortalId, setGuidedPortalId] = useState<PlazaPortalId | null>(null);
  const [noticeEvent, setNoticeEvent] = useState({
    id: 0,
    message: "광장 중앙에서 네 갈래의 기억이 이어집니다.",
  });
  const announceNotice = useCallback((message: string) => {
    setNoticeEvent((current) => ({ id: current.id + 1, message }));
  }, []);
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
  const localPaperdollLoadout = useMemo(
    () =>
      equipment !== null
        ? paperdollLoadoutFromEquipment(equipment)
        : paperdollLoadoutFromVisualGear(
            characterGear,
            "common",
            0,
            characterRarities,
          ),
    [characterGear, characterRarities, equipment],
  );
  const localPaperdollLoadoutRef = useRef(localPaperdollLoadout);

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

  useLayoutEffect(() => {
    localPaperdollLoadoutRef.current = localPaperdollLoadout;
    const paperdollImages = paperdollImagesRef.current;
    const immediatePaths = new Set<string>(paperdollImages.keys());
    immediatePaths.add(PAPERDOLL_BODY_PATH);
    for (const path of paperdollLayerPathsForLoadout(localPaperdollLoadout)) {
      immediatePaths.add(path);
    }
    // Request newly equipped local layers in this commit, not on the next
    // 120 ms remote-visibility maintenance tick.  The next maintenance pass
    // removes any paths that only belonged to the previous local loadout.
    paperdollImages.reconcile(immediatePaths);
    paperdollPathSignatureRef.current = "";
  }, [localPaperdollLoadout]);

  useLayoutEffect(() => {
    paperdollQaPoseRef.current = paperdollQaPose;
    const root = rootRef.current;
    if (!root) return;
    if (!paperdollQaPose) {
      paperdollQaProbeCanvasesRef.current = null;
      root.removeAttribute("data-paperdoll-qa-expected-key");
      root.removeAttribute("data-paperdoll-qa-rendered-key");
      root.removeAttribute("data-paperdoll-qa-ready");
      root.removeAttribute("data-paperdoll-qa-direction");
      root.removeAttribute("data-paperdoll-qa-frame");
      root.removeAttribute("data-paperdoll-qa-expected-layer-count");
      root.removeAttribute(
        "data-paperdoll-qa-destination-verified-layer-count",
      );
      root.removeAttribute("data-paperdoll-qa-destination-alpha-pixel-count");
      root.removeAttribute("data-paperdoll-qa-body-comparison-complete");
      root.removeAttribute("data-paperdoll-qa-body-diff-pixel-count");
      return;
    }
    root.dataset.paperdollQaExpectedKey = paperdollQaPose.key;
    root.dataset.paperdollQaReady = "false";
    root.dataset.paperdollQaDirection = String(paperdollQaPose.direction);
    root.dataset.paperdollQaFrame = String(paperdollQaPose.frame);
    root.removeAttribute("data-paperdoll-qa-rendered-key");
    root.removeAttribute("data-paperdoll-qa-expected-layer-count");
    root.removeAttribute("data-paperdoll-qa-destination-verified-layer-count");
    root.removeAttribute("data-paperdoll-qa-destination-alpha-pixel-count");
    root.removeAttribute("data-paperdoll-qa-body-comparison-complete");
    root.removeAttribute("data-paperdoll-qa-body-diff-pixel-count");
  }, [paperdollQaPose]);

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

  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const syncPreference = () => {
      reducedMotionRef.current = preference.matches;
    };
    syncPreference();
    preference.addEventListener("change", syncPreference);
    return () => preference.removeEventListener("change", syncPreference);
  }, []);

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
        remoteWalkCyclesRef.current.delete(characterId);
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
      announceNotice("빛나는 벽면 출입구 안쪽으로 조금 더 가까이 이동하세요.");
      return;
    }
    activatePortal(portal);
  }, [activatePortal, announceNotice]);

  const guideToPortal = useCallback((portal: PlazaPortalDefinition) => {
    pointerTargetRef.current = { x: portal.x, y: portal.y };
    setGuidedPortalId(portal.id);
    announceNotice(`${portal.name} 출입구까지 자동 이동합니다. 문 앞에서 입장을 눌러주세요.`);
    canvasRef.current?.focus({ preventScroll: true });
  }, [announceNotice]);

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

  const renderedInspectablePlayers = useCallback((): PlazaRemotePlayer[] => (
    inspectableRemotePlayersRef.current.map((player) => {
      const rendered = remoteRenderPointsRef.current.get(player.characterId);
      return {
        ...player,
        x: rendered?.x ?? player.x,
        y: rendered?.y ?? player.y,
      };
    })
  ), []);

  const inspectPlayer = useCallback(
    (player: PlazaRemotePlayer | null, missingMessage: string) => {
      if (!player) {
        announceNotice(missingMessage);
        return false;
      }
      pointerTargetRef.current = null;
      setGuidedPortalId(null);
      announceNotice(`${player.displayName}의 공개 기록을 펼쳤습니다.`);
      canvasRef.current?.focus({ preventScroll: true });
      onPlayerInspectRef.current?.(player);
      return true;
    },
    [announceNotice],
  );

  const inspectNearestPlayer = useCallback(() => {
    const local = positionRef.current;
    let nearest: PlazaRemotePlayer | null = null;
    let nearestDistance = PLAZA_KEYBOARD_INSPECT_RADIUS;
    for (const player of renderedInspectablePlayers()) {
      const distance = Math.hypot(player.x - local.x, player.y - local.y);
      if (distance <= nearestDistance) {
        nearest = player;
        nearestDistance = distance;
      }
    }
    inspectPlayer(
      nearest,
      "가까운 기록자가 없습니다. 대상 가까이에서 F 또는 기록 버튼을 눌러주세요.",
    );
  }, [inspectPlayer, renderedInspectablePlayers]);

  useEffect(() => {
    const root = rootRef.current;
    const canvas = canvasRef.current;
    if (!root || !canvas) return;

    const resize = () => {
      const rect = root.getBoundingClientRect();
      const width = Math.max(1, root.clientWidth);
      const height = Math.max(1, root.clientHeight);
      const renderedScale = Math.max(
        0.01,
        Math.min(rect.width / width, rect.height / height),
      );
      const backing = canvasBackingDimensions(
        width,
        height,
        width * renderedScale,
        height * renderedScale,
        window.devicePixelRatio || 1,
        MAX_PLAZA_BACKING_SCALE,
      );
      viewportRef.current = { width, height, dpr: backing.scale };
      if (canvas.width !== backing.width) canvas.width = backing.width;
      if (canvas.height !== backing.height) canvas.height = backing.height;
      canvas.style.width = "100%";
      canvas.style.height = "100%";
    };

    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
    observer?.observe(root);
    window.addEventListener("resize", resize);
    resize();
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", resize);
    };
  }, []);

  useEffect(() => {
    const images = sceneImagesRef.current;
    const ownedImages: Array<
      readonly [string, HTMLImageElement, () => void]
    > = [];
    const sceneAssetPaths = new Set([
      PLAZA_MAP_PATH,
      ...Object.values(PLAZA_PORTAL_ART_PATHS),
      ...Object.values(PLAZA_PORTAL_DOORWAY_EFFECT_PATHS),
    ]);
    for (const path of sceneAssetPaths) {
      if (images.has(path)) continue;
      const image = new Image();
      image.decoding = "async";
      image.fetchPriority = path === PLAZA_MAP_PATH ? "high" : "auto";
      const handleImageError = () => {
        if (images.get(path) === image) images.delete(path);
      };
      image.addEventListener("error", handleImageError, { once: true });
      image.src = path;
      images.set(path, image);
      ownedImages.push([path, image, handleImageError]);
    }
    return () => {
      for (const [path, image, handleImageError] of ownedImages) {
        if (images.get(path) === image) images.delete(path);
        image.removeEventListener("error", handleImageError);
        image.onload = null;
        image.onerror = null;
        image.removeAttribute("src");
      }
    };
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
    for (const powerId of LEGENDARY_VFX_IDS) {
      const vfxId = legendaryVfxId(powerId);
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
      if (key === "f" && !event.repeat) {
        event.preventDefault();
        inspectNearestPlayer();
      }
      if (key === "escape" && guidedPortalIdRef.current && !event.repeat) {
        event.preventDefault();
        pointerTargetRef.current = null;
        setGuidedPortalId(null);
        announceNotice("포탈 길 안내를 취소했습니다.");
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
  }, [activateNearbyPortal, announceNotice, guideToPortal, inspectNearestPlayer, queueDash]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const paperdollImages = paperdollImagesRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) return;
    let animationFrame = 0;
    const readableCanvasFontSize = (basePx: number, minimumCssPx: number) => {
      void minimumCssPx;
      return basePx;
    };
    let renderableRemotePlayers: readonly PlazaRemotePlayer[] = [];
    let detailedRemotePlayerIds = new Set<string>();
    let nextRemoteVisibilityCheckAt = 0;
    let lastProcessedFrameAt = Number.NEGATIVE_INFINITY;
    let viewportVignette: CanvasGradient | null = null;
    let viewportVignetteKey = "";

    const getViewportVignette = (width: number, height: number, dpr: number) => {
      const key = `${width}x${height}@${dpr}`;
      if (viewportVignette && viewportVignetteKey === key) {
        return viewportVignette;
      }
      viewportVignette = context.createRadialGradient(
        width / 2,
        height / 2,
        Math.min(width, height) * 0.25,
        width / 2,
        height / 2,
        Math.max(width, height) * 0.72,
      );
      viewportVignette.addColorStop(0, "rgba(0,0,0,0)");
      viewportVignette.addColorStop(1, "rgba(0,0,0,.62)");
      viewportVignetteKey = key;
      return viewportVignette;
    };

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
        localPaperdollLoadoutRef.current,
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
      if (!shouldProcessContinuousFrame(lastProcessedFrameAt, now)) {
        animationFrame = window.requestAnimationFrame(frame);
        return;
      }
      lastProcessedFrameAt = now;
      if (pausedRef.current || document.hidden) {
        previousTimeRef.current = now;
        animationFrame = window.requestAnimationFrame(frame);
        return;
      }
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
      for (const effect of skillEffectsRef.current) {
        const activeSeconds = Math.max(0, dt - effect.delaySeconds);
        effect.delaySeconds = Math.max(0, effect.delaySeconds - dt);
        effect.life -= activeSeconds;
      }
      compactPositiveFieldInPlace(skillEffectsRef.current, "life");

      if (dashQueuedRef.current && !pausedRef.current && dashCooldownRef.current <= 0) {
        dashQueuedRef.current = false;
        dashDirectionRef.current = plazaDashDirection(
          moveX,
          moveY,
          facingRef.current,
        );
        dashTimeRef.current = PLAZA_DASH_DURATION_SECONDS;
        const dashDirection = dashDirectionRef.current;
        const dashAngle = Math.atan2(dashDirection.y, dashDirection.x);
        const dashRight = { x: -dashDirection.y, y: dashDirection.x };
        const dashPowerVfxSpecs = resolvePlazaDashPowerVfxSpecs(mobility.equippedPowerIds);
        for (const spec of dashPowerVfxSpecs) {
          const anchorY =
            spec.layer === "body"
              ? plazaPlayerBodyCenterY(positionRef.current.y)
              : plazaPlayerGroundAnchorY(positionRef.current.y);
          skillEffectsRef.current.push({
            id: ++skillEffectIdRef.current,
            vfxId: legendaryVfxId(spec.powerId),
            x:
              positionRef.current.x +
              dashDirection.x * spec.forwardOffset +
              dashRight.x * spec.lateralOffset,
            y:
              anchorY +
              dashDirection.y * spec.forwardOffset +
              dashRight.y * spec.lateralOffset,
            size: spec.size,
            life: spec.durationSeconds,
            duration: spec.durationSeconds,
            angle: dashAngle + spec.angleOffset,
            delaySeconds: spec.delaySeconds,
            layer: spec.layer,
            renderPass: spec.renderPass,
            maxAlpha: spec.maxAlpha,
          });
        }
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
          playGameSfx("playerDash", { playbackRate: 1.28, gain: 0.7 });
        }
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
            y: plazaPlayerGroundAnchorY(positionRef.current.y),
            size: 52,
            life: 0.3,
            duration: 0.3,
            angle: Math.atan2(direction.y, direction.x),
            delaySeconds: 0,
            layer: "ground",
            renderPass: "ground",
            maxAlpha: 0.48,
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

      const playerDeltaX = positionRef.current.x - previousPosition.x;
      const playerDeltaY = positionRef.current.y - previousPosition.y;
      if (playerDeltaX !== 0 || playerDeltaY !== 0) {
        for (const effect of skillEffectsRef.current) {
          if (effect.layer !== "body") continue;
          effect.x += playerDeltaX;
          effect.y += playerDeltaY;
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
          y: plazaPlayerGroundAnchorY(previousPosition.y),
          size: 74,
          life: 0.95,
          duration: 0.95,
          angle: Math.atan2(
            positionRef.current.y - previousPosition.y,
            positionRef.current.x - previousPosition.x,
          ),
          delaySeconds: 0,
          layer: "ground",
          renderPass: "ground",
          maxAlpha: 0.46,
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
          announceNotice(`${nearest?.name} 출입구 앞에 도착했습니다.`);
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
      const focusedPortalId = nearPortalIdRef.current ?? guidedPortalIdRef.current;
      const focusedPortal = focusedPortalId ? plazaPortalById(focusedPortalId) : null;
      if (focusedPortal) {
        drawPortalGuidance(
          context,
          focusedPortal,
          positionRef.current,
          time,
          nearPortalIdRef.current === focusedPortal.id,
          reducedMotionRef.current,
        );
      }
      for (const portal of PLAZA_PORTALS) {
        drawPortal(
          context,
          portal,
          time,
          portal.id === focusedPortalId,
          portal.id === nearPortalIdRef.current,
          sceneImagesRef.current.get(PLAZA_PORTAL_DOORWAY_EFFECT_PATHS[portal.id]),
          reducedMotionRef.current,
        );
      }

      drawPlazaSkillEffectsForPass(
        context,
        skillEffectsRef.current,
        "ground",
        skillVfxImagesRef.current,
      );

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
      const localQaPose = paperdollQaPoseRef.current;
      players.push({
        key: localCharacter.characterId,
        displayName: localCharacter.displayName,
        level: localCharacter.level,
        x: positionRef.current.x,
        y: positionRef.current.y,
        facing: localQaPose?.direction ?? facingRef.current,
        moving: movingRef.current,
        walkCycle: walkCycleRef.current,
        frameOverride: localQaPose?.frame,
        gear: localCharacter.appearance?.gear,
        rarities: localCharacter.appearance?.rarities,
        loadout: localPaperdollLoadoutRef.current,
        local: true,
        stale: false,
      });
      players.sort((left, right) => left.y - right.y || Number(left.local) - Number(right.local));
      for (const player of players) {
        const drawPlan = createPlazaPlayerDrawPlan(player);
        const bodyImage = paperdollImages.get(PAPERDOLL_BODY_PATH);
        const layerSources = paperdollImages.imageMap();
        drawPlazaPlayerShadow(context, player);
        const appearanceDrawResult = drawPlazaPlayerPaperdoll(
          context,
          player,
          drawPlan,
          bodyImage,
          layerSources,
        );
        const appearanceDrawn = appearanceDrawResult.drawn;
        if (player.local && localQaPose) {
          const resolvedLayers = resolvePaperdollLayerInfo(
            drawPlan.loadout,
            player.facing,
            layerSources,
          );
          const expectedLayerCount = paperdollLayerPathsForLoadout(
            drawPlan.loadout,
          ).length;
          let probeCanvases = paperdollQaProbeCanvasesRef.current;
          if (!probeCanvases) {
            probeCanvases = createPaperdollQaProbeCanvases();
            paperdollQaProbeCanvasesRef.current = probeCanvases;
          }
          let destinationVerifiedLayerCount = 0;
          let destinationAlphaPixelCount = 0;
          for (const layer of resolvedLayers) {
            const piece = drawPlan.loadout[layer.slot];
            if (!piece) continue;
            const destinationRender = renderPaperdollQaDestination(
              probeCanvases.layerDestination,
              probeCanvases.blankBodyAtlas,
              layerSources,
              { [layer.slot]: piece },
              player.facing,
              drawPlan.frame,
              1,
            );
            if (!destinationRender.complete) continue;
            const alphaPixelCount = countPaperdollAlphaPixels(
              destinationRender.pixels,
            );
            if (alphaPixelCount <= 0) continue;
            destinationVerifiedLayerCount += 1;
            destinationAlphaPixelCount += alphaPixelCount;
          }
          let bodyComparisonComplete = false;
          let bodyDiffPixelCount = 0;
          if (bodyImage) {
            const bodyBaseline = renderPaperdollQaDestination(
              probeCanvases.bodyBaseline,
              bodyImage,
              layerSources,
              {},
              player.facing,
              drawPlan.frame,
              0,
            );
            const compositeDestination = renderPaperdollQaDestination(
              probeCanvases.compositeDestination,
              bodyImage,
              layerSources,
              drawPlan.loadout,
              player.facing,
              drawPlan.frame,
              expectedLayerCount,
            );
            if (bodyBaseline.complete && compositeDestination.complete) {
              bodyDiffPixelCount = countPaperdollChangedPixels(
                bodyBaseline.pixels,
                compositeDestination.pixels,
              );
              bodyComparisonComplete = true;
            }
          }
          const renderedKey = paperdollQaRenderedKey(
            drawPlan,
            player.facing,
          );
          const qaReady = Boolean(
            appearanceDrawn &&
              appearanceDrawResult.complete &&
              appearanceDrawResult.drawnLayerCount === expectedLayerCount &&
              renderedKey === localQaPose.key &&
              isPaperdollBodyAtlasReady(bodyImage) &&
              expectedLayerCount > 0 &&
              destinationVerifiedLayerCount === expectedLayerCount &&
              destinationAlphaPixelCount > 0 &&
              bodyComparisonComplete &&
              bodyDiffPixelCount > 0 &&
              resolvedLayers.length === expectedLayerCount &&
              resolvedLayers.every((layer) => layer.ready),
          );
          const root = rootRef.current;
          if (
            root?.dataset.paperdollQaExpectedKey === localQaPose.key
          ) {
            root.dataset.paperdollQaExpectedLayerCount = String(expectedLayerCount);
            root.dataset.paperdollQaDestinationVerifiedLayerCount = String(
              destinationVerifiedLayerCount,
            );
            root.dataset.paperdollQaDestinationAlphaPixelCount = String(
              destinationAlphaPixelCount,
            );
            root.dataset.paperdollQaBodyComparisonComplete = String(
              bodyComparisonComplete,
            );
            root.dataset.paperdollQaBodyDiffPixelCount = String(
              bodyDiffPixelCount,
            );
            root.dataset.paperdollQaReady = String(qaReady);
            if (qaReady && renderedKey) {
              root.dataset.paperdollQaRenderedKey = renderedKey;
            } else {
              root.removeAttribute("data-paperdoll-qa-rendered-key");
            }
          }
        }
        drawPlazaPlayerEquippedVfx(
          context,
          player,
          drawPlan,
          rarityVfxImagesRef.current,
          now,
          appearanceDrawn,
        );
        if (!player.local) continue;
        drawPlazaSkillEffectsForPass(
          context,
          skillEffectsRef.current,
          "body",
          skillVfxImagesRef.current,
        );
        drawPlazaStarfallMantle(
          context,
          player.x,
          player.y,
          time,
          starfallMantleTimeRef.current,
          skillVfxImagesRef.current,
        );
        drawPlazaSkillEffectsForPass(
          context,
          skillEffectsRef.current,
          "foreground",
          skillVfxImagesRef.current,
        );
      }
      for (const player of players) {
        drawPlazaPlayerNameplate(
          context,
          player,
          readableCanvasFontSize,
        );
      }
      context.restore();

      context.fillStyle = getViewportVignette(width, height, dpr);
      context.fillRect(0, 0, width, height);
      animationFrame = window.requestAnimationFrame(frame);
    };

    animationFrame = window.requestAnimationFrame(frame);
    return () => {
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
  }, [announceNotice]);

  const handleCanvasPointer = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (pausedRef.current) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const target = canvasClientPointToWorld(
      event.clientX,
      event.clientY,
      canvas.getBoundingClientRect(),
      viewportRef.current,
      cameraRef.current,
    );
    if (event.pointerType !== "mouse") {
      const touchedPlayer = pickPlazaInspectablePlayer(
        renderedInspectablePlayers(),
        target,
      );
      if (touchedPlayer) {
        inspectPlayer(touchedPlayer, "");
        return;
      }
    }
    const doorwayPortal = plazaPortalAtDoorwayPoint(target);
    if (doorwayPortal) {
      guideToPortal(doorwayPortal);
      return;
    }
    if (!isPlazaWalkable(target)) {
      announceNotice("금빛 난간과 광장 시설물 바깥으로는 이동할 수 없습니다.");
      return;
    }
    pointerTargetRef.current = target;
    setGuidedPortalId(null);
    canvas.focus({ preventScroll: true });
  }, [announceNotice, guideToPortal, inspectPlayer, renderedInspectablePlayers]);

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
      const player = pickPlazaInspectablePlayer(renderedInspectablePlayers(), worldPoint);
      inspectPlayer(
        player,
        "다른 기록자를 우클릭하거나 가까이에서 F를 누르면 기록을 확인할 수 있습니다.",
      );
    },
    [inspectPlayer, renderedInspectablePlayers],
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
        data-paperdoll-qa-canvas={paperdollQaPose ? "true" : undefined}
        tabIndex={0}
        aria-label="무진도 공동 광장. WASD 또는 방향키로 이동하고 Space로 회피하며 E 또는 Enter로 가까운 빛나는 벽면 문을 이용합니다. F는 가까운 기록자를 확인합니다. 바닥이나 문을 누르면 이동하고, 터치로 다른 플레이어를 누르거나 마우스로 우클릭하면 캐릭터 정보를 확인합니다."
        onPointerDown={handleCanvasPointer}
        onContextMenu={handleCanvasContextMenu}
      />

      <header className="plaza-hub-header" aria-label="현재 광장 정보">
        <div className="plaza-hub-title">
          <span className="plaza-location-crest" aria-hidden="true">
            <i />
          </span>
          <div>
            <small lang="en">MUJINDO SHARED SANCTUM</small>
            <strong>망각의 교차광장</strong>
            <span>끊어진 기억들이 다시 만나는 공동 성역</span>
          </div>
        </div>
        <div className="plaza-hub-presence">
          <span className="plaza-hub-presence-dot" aria-hidden="true" />
          <div>
            <small lang="en">{connectionEyebrow(connectionState)}</small>
            <strong>{connectionLabel(connectionState)}</strong>
            <span>CH 01 · {Math.max(1, Math.floor(onlineCount))}명</span>
          </div>
        </div>
      </header>

      <section className="plaza-character-plate" aria-label="선택한 캐릭터">
        <span className="plaza-character-seal" aria-hidden="true">
          {normalizedCharacter.saveSlot}
        </span>
        <div className="plaza-character-identity">
          <small lang="en">RECORD 0{normalizedCharacter.saveSlot}</small>
          <strong>{normalizedCharacter.displayName}</strong>
          <span>
            <b>LV.{normalizedCharacter.level}</b>
            <i>최고 {normalizedCharacter.dungeonFloor}층</i>
          </span>
        </div>
        <div className="plaza-character-actions">
          {onSelfInspect ? (
            <button type="button" onClick={onSelfInspect} aria-label="캐릭터 정보 열기">
              <span aria-hidden="true">✦</span>
              <small>기록</small>
            </button>
          ) : null}
          {onInventoryOpen ? (
            <button
              type="button"
              onClick={onInventoryOpen}
              aria-keyshortcuts="I"
              aria-label="장비 관리"
            >
              <span aria-hidden="true">◇</span>
              <small>장비</small>
              <kbd>I</kbd>
            </button>
          ) : null}
          {onExitToCharacterSelect ? (
            <button type="button" onClick={onExitToCharacterSelect} aria-label="캐릭터 변경">
              <span aria-hidden="true">↶</span>
              <small>변경</small>
            </button>
          ) : null}
        </div>
      </section>

      <nav className="plaza-portal-directory" aria-label="광장 출입구 안내">
        <div className="plaza-portal-directory__heading">
          <span aria-hidden="true" />
          <small lang="en">MEMORY COMPASS</small>
          <strong>갈림길을 선택하십시오</strong>
          <span aria-hidden="true" />
        </div>
        {PLAZA_PORTALS.map((portal) => (
          <button
            type="button"
            key={portal.id}
            className={guidedPortalId === portal.id || nearPortalId === portal.id ? "is-active" : ""}
            data-portal-id={portal.id}
            style={
              {
                "--portal-color": portal.hue,
                "--portal-art": `url("${PLAZA_PORTAL_ART_PATHS[portal.id]}")`,
              } as React.CSSProperties
            }
            onClick={() => guideToPortal(portal)}
            aria-label={`${portal.name} 포탈 길 안내. ${portalGuideStatus(portal.id, guidedPortalId, nearPortalId)}`}
            aria-keyshortcuts={portal.hotkey}
            aria-describedby={`plaza-gate-status-${portal.id}`}
            title={portal.englishName}
          >
            <span className="plaza-gate-art" aria-hidden="true" />
            <span className="plaza-gate-copy">
              <small lang="en">{portalDirectoryEyebrow(portal.id)}</small>
              <strong>{portal.name}</strong>
              <em id={`plaza-gate-status-${portal.id}`}>
                {portalGuideStatus(portal.id, guidedPortalId, nearPortalId)}
              </em>
            </span>
            <kbd>{portal.hotkey}</kbd>
          </button>
        ))}
      </nav>

      <div className="plaza-hub-notice" role="status" aria-live="polite" aria-atomic="true">
        <div key={noticeEvent.id} className="plaza-hub-notice__event">
          <span aria-hidden="true">✦</span>
          <p>{noticeEvent.message}</p>
        </div>
      </div>

      {nearPortal ? (
        <section
          className="plaza-portal-prompt"
          data-portal-id={nearPortal.id}
          style={
            {
              "--portal-color": nearPortal.hue,
              "--portal-art": `url("${PLAZA_PORTAL_ART_PATHS[nearPortal.id]}")`,
            } as React.CSSProperties
          }
          aria-label={`${nearPortal.name} 포탈`}
        >
          <span className="plaza-portal-prompt__art" aria-hidden="true" />
          <div className="plaza-portal-prompt__copy">
            <small lang="en">GATE RESONANCE · {nearPortal.englishName}</small>
            <strong>{nearPortal.name}</strong>
            <p>{nearPortal.description}</p>
          </div>
          <button
            type="button"
            onClick={() => activatePortal(nearPortal)}
            aria-keyshortcuts="E Enter"
          >
            <kbd>E</kbd>
            <span>{portalActionLabel(nearPortal.id)}</span>
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
        <button
          type="button"
          className="is-action"
          onClick={activateNearbyPortal}
          aria-label="가까운 빛나는 문 이용"
        >
          문
        </button>
        <button
          type="button"
          className="is-dash"
          aria-label="회피 대시"
          aria-keyshortcuts="Space"
          onPointerDown={(event) => {
            event.preventDefault();
            queueDash();
          }}
        >
          회피
        </button>
        <button
          type="button"
          className="is-inspect"
          aria-label="가까운 기록자 정보 보기"
          aria-keyshortcuts="F"
          onClick={inspectNearestPlayer}
        >
          기록
        </button>
      </div>

      <p className="plaza-control-hint" aria-label="조작 안내">
        <span><kbd>WASD</kbd> 이동</span>
        <span><kbd>Space</kbd> 회피</span>
        <span><kbd>E</kbd> 문 이용</span>
        <span><kbd>F</kbd> 기록</span>
        <span><kbd>1—4</kbd> 길 안내</span>
      </p>
    </main>
  );
}
