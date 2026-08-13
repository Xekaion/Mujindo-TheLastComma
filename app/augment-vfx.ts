/**
 * Runtime contract for authored augment, legendary-power, and projectile VFX.
 *
 * Every asset is a transparent 2 x 2 sheet containing four animation frames in
 * reading order.  GameCanvas keeps its old vector drawing as a load-failure
 * fallback, but an available authored image always wins.
 */

export const EFFECT_PRODUCING_AUGMENT_IDS = [
  "ember",
  "oil",
  "frost",
  "storm",
  "poison",
  "return",
  "void",
  "orbit",
  "time",
  "overcharge",
  "shrapnel",
  "ricochet",
  "ward",
] as const;

export type EffectProducingAugmentId =
  (typeof EFFECT_PRODUCING_AUGMENT_IDS)[number];

export const LEGENDARY_VFX_IDS = [
  "crescentEcho",
  "mirrorAegis",
  "hunterSigil",
  "starfallMantle",
  "lastMemory",
  "bloodwovenGrip",
  "ashboundGirdle",
  "phantomMarch",
  "riftStride",
  "commaResonance",
] as const;

export type LegendaryVfxId = (typeof LEGENDARY_VFX_IDS)[number];

export const PROJECTILE_VFX_AFFINITIES = [
  "arcane",
  "blood",
  "ember",
  "storm",
  "frost",
  "poison",
  "echo",
  "enemy",
  "witch",
  "boss",
] as const;

export type ProjectileVfxAffinity =
  (typeof PROJECTILE_VFX_AFFINITIES)[number];

export type GameplayVfxId =
  | `augment:${EffectProducingAugmentId}`
  | `legendary:${LegendaryVfxId}`
  | `projectile:${ProjectileVfxAffinity}`;

export type GameplayVfxDefinition = Readonly<{
  assetPath: string;
  columns: 2;
  rows: 2;
  frames: 4;
  anchorY: number;
  scale: number;
  blendMode: GlobalCompositeOperation;
}>;

const makeDefinition = (
  assetPath: string,
  options: Partial<
    Pick<GameplayVfxDefinition, "anchorY" | "scale" | "blendMode">
  > = {},
): GameplayVfxDefinition => ({
  assetPath,
  columns: 2,
  rows: 2,
  frames: 4,
  anchorY: options.anchorY ?? 0.5,
  scale: options.scale ?? 1,
  blendMode: options.blendMode ?? "lighter",
});

const augmentEntries = EFFECT_PRODUCING_AUGMENT_IDS.map(
  (id) =>
    [
      `augment:${id}`,
      makeDefinition(`/assets/effects/augments/${id}-v1.png`),
    ] as const,
);

const legendaryEntries = LEGENDARY_VFX_IDS.map(
  (id) =>
    [
      `legendary:${id}`,
      makeDefinition(`/assets/effects/legendary/${id}-v1.png`, {
        scale: id === "phantomMarch" ? 1.12 : 1,
      }),
    ] as const,
);

const projectileEntries = PROJECTILE_VFX_AFFINITIES.map(
  (affinity) =>
    [
      `projectile:${affinity}`,
      makeDefinition(`/assets/effects/projectiles/${affinity}-v1.png`, {
        anchorY: 0.5,
        scale: 3.5,
      }),
    ] as const,
);

export const GAMEPLAY_VFX_MANIFEST: Readonly<
  Record<GameplayVfxId, GameplayVfxDefinition>
> = Object.fromEntries([
  ...augmentEntries,
  ...legendaryEntries,
  ...projectileEntries,
]) as Record<GameplayVfxId, GameplayVfxDefinition>;

export const gameplayVfxImageKey = (id: GameplayVfxId) => `gameplay-vfx:${id}`;

export const gameplayVfxImageEntries = (): ReadonlyArray<
  readonly [string, string]
> =>
  Object.entries(GAMEPLAY_VFX_MANIFEST).map(([id, definition]) => [
    gameplayVfxImageKey(id as GameplayVfxId),
    definition.assetPath,
  ] as const);

export const augmentVfxId = (
  id: EffectProducingAugmentId,
): GameplayVfxId => `augment:${id}`;

export const legendaryVfxId = (id: LegendaryVfxId): GameplayVfxId =>
  `legendary:${id}`;

export const projectileVfxId = (
  affinity: ProjectileVfxAffinity,
): GameplayVfxId => `projectile:${affinity}`;

export const augmentIconAssetPath = (id: string) =>
  `/assets/augments/icons/${id}-v1.webp`;

export type DrawGameplayVfxFrameOptions = Readonly<{
  x: number;
  y: number;
  size: number;
  progress: number;
  angle?: number;
  alpha?: number;
  frameOffset?: number;
  endX?: number;
  endY?: number;
}>;

/** Draw an authored four-frame VFX sheet. Returns false until it is loadable. */
export function drawGameplayVfxFrame(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement | undefined,
  definition: GameplayVfxDefinition,
  options: DrawGameplayVfxFrameOptions,
): boolean {
  if (
    !image?.complete ||
    image.naturalWidth <= 0 ||
    image.naturalHeight <= 0
  ) {
    return false;
  }

  const normalizedProgress = Math.max(0, Math.min(0.999_999, options.progress));
  const frame =
    (Math.floor(normalizedProgress * definition.frames) +
      (options.frameOffset ?? 0)) %
    definition.frames;
  const sourceWidth = image.naturalWidth / definition.columns;
  const sourceHeight = image.naturalHeight / definition.rows;
  const column = frame % definition.columns;
  const row = Math.floor(frame / definition.columns);
  const hasBeamTarget =
    Number.isFinite(options.endX) && Number.isFinite(options.endY);
  const deltaX = hasBeamTarget ? options.endX! - options.x : 0;
  const deltaY = hasBeamTarget ? options.endY! - options.y : 0;
  const beamLength = hasBeamTarget ? Math.max(1, Math.hypot(deltaX, deltaY)) : 0;
  const drawWidth = hasBeamTarget
    ? beamLength
    : Math.max(1, options.size * definition.scale);
  const drawHeight = Math.max(1, options.size * definition.scale);

  context.save();
  context.translate(
    hasBeamTarget ? options.x + deltaX / 2 : options.x,
    hasBeamTarget ? options.y + deltaY / 2 : options.y,
  );
  context.rotate(hasBeamTarget ? Math.atan2(deltaY, deltaX) : options.angle ?? 0);
  context.globalAlpha = Math.max(0, Math.min(1, options.alpha ?? 1));
  context.globalCompositeOperation = definition.blendMode;
  context.imageSmoothingEnabled = true;
  context.drawImage(
    image,
    column * sourceWidth,
    row * sourceHeight,
    sourceWidth,
    sourceHeight,
    -drawWidth / 2,
    -drawHeight * definition.anchorY,
    drawWidth,
    drawHeight,
  );
  context.restore();
  return true;
}
