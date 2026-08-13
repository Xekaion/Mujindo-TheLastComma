/**
 * Runtime contract for authored augment, legendary-power, and projectile VFX.
 *
 * Augment and legendary assets are transparent 2 x 2 sheets containing four
 * animation frames in reading order. Projectile assets use a denser 4 x 4,
 * 16-frame sheet so fast-moving shots remain fluid. GameCanvas keeps its old
 * vector drawing as a load-failure fallback, but available authored art wins.
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
  columns: number;
  rows: number;
  frames: number;
  anchorY: number;
  scale: number;
  blendMode: GlobalCompositeOperation;
}>;

const makeDefinition = (
  assetPath: string,
  options: Partial<
    Pick<
      GameplayVfxDefinition,
      "columns" | "rows" | "frames" | "anchorY" | "scale" | "blendMode"
    >
  > = {},
): GameplayVfxDefinition => ({
  assetPath,
  columns: options.columns ?? 2,
  rows: options.rows ?? 2,
  frames: options.frames ?? 4,
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
      makeDefinition(`/assets/effects/projectiles/${affinity}-v2.png`, {
        columns: 4,
        rows: 4,
        frames: 16,
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
  /** Cross-fade the current atlas cell into the next instead of hard stepping. */
  interpolateFrames?: boolean;
  endX?: number;
  endY?: number;
}>;

export type GameplayVfxFrameInterpolation = Readonly<{
  currentFrame: number;
  nextFrame: number;
  frameBlend: number;
}>;

// 30 fps maps cleanly onto the common 60 Hz render cadence (one sprite frame
// every two canvas frames), avoiding the uneven 2/3-frame holds of 24 fps.
export const PROJECTILE_VFX_FRAMES_PER_SECOND = 30;

/**
 * Convert projectile age to a stable sprite-sheet loop. Keeping the desired
 * frame rate separate from the sheet size prevents 16-frame art from being
 * raced through at the old four-frame cadence.
 */
export function loopingGameplayVfxProgress(
  elapsedSeconds: number,
  definition: GameplayVfxDefinition,
  framesPerSecond = PROJECTILE_VFX_FRAMES_PER_SECOND,
): number {
  if (
    !Number.isFinite(elapsedSeconds) ||
    !Number.isFinite(framesPerSecond) ||
    definition.frames <= 0 ||
    framesPerSecond <= 0
  ) {
    return 0;
  }
  const loops = (elapsedSeconds * framesPerSecond) / definition.frames;
  return ((loops % 1) + 1) % 1;
}

/**
 * Resolve the two neighbouring atlas cells and their temporal blend. This is
 * deliberately separate from canvas drawing so a 16-frame sheet is not merely
 * sampled with a visible Math.floor step at runtime.
 */
export function gameplayVfxFrameInterpolation(
  progress: number,
  definition: GameplayVfxDefinition,
  frameOffset = 0,
): GameplayVfxFrameInterpolation {
  const frames = Math.max(1, Math.trunc(definition.frames));
  const normalizedProgress = Number.isFinite(progress)
    ? Math.max(0, Math.min(0.999_999, progress))
    : 0;
  const framePosition = normalizedProgress * frames;
  const baseFrame = Math.floor(framePosition);
  const normalizedOffset = ((Math.trunc(frameOffset) % frames) + frames) % frames;
  const currentFrame = (baseFrame + normalizedOffset) % frames;
  return {
    currentFrame,
    nextFrame: (currentFrame + 1) % frames,
    frameBlend: framePosition - baseFrame,
  };
}

/** Draw an authored VFX sprite sheet. Returns false until it is loadable. */
export function drawGameplayVfxFrame(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement | undefined,
  definition: GameplayVfxDefinition,
  options: DrawGameplayVfxFrameOptions,
): boolean {
  if (
    !image?.complete ||
    image.naturalWidth <= 0 ||
    image.naturalHeight <= 0 ||
    image.naturalWidth % definition.columns !== 0 ||
    image.naturalHeight % definition.rows !== 0 ||
    definition.frames <= 0 ||
    definition.frames > definition.columns * definition.rows
  ) {
    return false;
  }

  const { currentFrame, nextFrame, frameBlend } = gameplayVfxFrameInterpolation(
    options.progress,
    definition,
    options.frameOffset,
  );
  const sourceWidth = image.naturalWidth / definition.columns;
  const sourceHeight = image.naturalHeight / definition.rows;
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
  const baseAlpha = Math.max(0, Math.min(1, options.alpha ?? 1));
  context.globalCompositeOperation = definition.blendMode;
  context.imageSmoothingEnabled = true;
  const drawFrame = (frame: number, alpha: number) => {
    const column = frame % definition.columns;
    const row = Math.floor(frame / definition.columns);
    context.globalAlpha = baseAlpha * alpha;
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
  };
  if (
    options.interpolateFrames &&
    nextFrame !== currentFrame &&
    frameBlend > 0.001
  ) {
    drawFrame(currentFrame, 1 - frameBlend);
    drawFrame(nextFrame, frameBlend);
  } else {
    drawFrame(currentFrame, 1);
  }
  context.restore();
  return true;
}
