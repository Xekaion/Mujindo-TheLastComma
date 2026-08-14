import {
  SILENT_LIBRARIAN_RECOVERY_SECONDS,
  SILENT_LIBRARIAN_TELEGRAPH_SECONDS,
  SILENT_LIBRARIAN_WAVE_END_RADIUS,
  SILENT_LIBRARIAN_WAVE_START_RADIUS,
  silentLibrarianWaveProgress,
  silentLibrarianWaveRadius,
} from "./silent-librarian";

export const SILENT_LIBRARIAN_ECHO_VFX_PATH =
  "/assets/effects/silent-librarian-echo-v4.png";

const SHEET_COLUMNS = 4;
const SHEET_ROWS = 2;
const SHEET_CELL_SIZE = 128;
const TAU = Math.PI * 2;
const WAVE_SLOT_COUNT = 12;
const BOOK_FRAME_START = 0;
const WAVE_FRAME_START = 4;
const SEQUENCE_FRAME_COUNT = 4;

export type SilentLibrarianEchoPhase =
  | "echoWindup"
  | "echoWave"
  | "recover";

export type SilentLibrarianEchoStamp = {
  slotIndex: number;
  x: number;
  y: number;
  angle: number;
  size: number;
  alpha: number;
  frameIndex: 4 | 5 | 6 | 7;
  nextFrameIndex: 4 | 5 | 6 | 7;
  frameBlend: number;
};

type SilentLibrarianClipBounds = {
  left: number;
  right: number;
  top: number;
  bottom: number;
};

type DrawSilentLibrarianEchoOptions = {
  context: CanvasRenderingContext2D;
  image: HTMLImageElement | undefined;
  phase: string | undefined;
  remainingSeconds: number;
  x: number;
  y: number;
  seed: number;
  timeSeconds: number;
  clipBounds?: SilentLibrarianClipBounds;
};

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

const smoothstep = (value: number) => {
  const clamped = clamp01(value);
  return clamped * clamped * (3 - 2 * clamped);
};

const seededUnit = (seed: number, index: number, salt: number) => {
  const value = Math.sin((seed + 1) * 91.739 + index * 37.117 + salt * 11.731) * 43758.5453;
  return value - Math.floor(value);
};

export const silentLibrarianEchoStampCount = (radius: number) => {
  void radius;
  return WAVE_SLOT_COUNT;
};

const sequenceFramePair = <Start extends 0 | 4>(
  frameStart: Start,
  progress: number,
) => {
  const sequencePosition = clamp01(progress) * SEQUENCE_FRAME_COUNT;
  const frameOffset = Math.min(
    SEQUENCE_FRAME_COUNT - 1,
    Math.floor(sequencePosition),
  );
  const nextFrameOffset = Math.min(SEQUENCE_FRAME_COUNT - 1, frameOffset + 1);
  const frameBlend =
    frameOffset === nextFrameOffset
      ? 0
      : smoothstep(sequencePosition - frameOffset);

  return {
    frameIndex: frameStart + frameOffset,
    nextFrameIndex: frameStart + nextFrameOffset,
    frameBlend,
  };
};

/**
 * Every cast owns twelve stable authored-fragment slots. Slot identity and
 * angle never depend on the changing radius, so the wave expands continuously
 * instead of rebuilding the ring whenever its circumference crosses a count
 * threshold.
 */
export const silentLibrarianEchoStampLayout = ({
  radius,
  progress,
  seed,
  dissolveProgress = 0,
}: {
  radius: number;
  progress: number;
  seed: number;
  dissolveProgress?: number;
}): SilentLibrarianEchoStamp[] => {
  const safeProgress = clamp01(progress);
  const dissolve = clamp01(dissolveProgress);
  const baseAngle = seededUnit(seed, 0, 17) * TAU;
  const framePair = sequenceFramePair(WAVE_FRAME_START, safeProgress) as {
    frameIndex: 4 | 5 | 6 | 7;
    nextFrameIndex: 4 | 5 | 6 | 7;
    frameBlend: number;
  };

  return Array.from({ length: WAVE_SLOT_COUNT }, (_, index) => {
    const radialNoise = seededUnit(seed, index, 3);
    const angularNoise = seededUnit(seed, index, 5);
    const frameNoise = seededUnit(seed, index, 7);
    const angle =
      baseAngle +
      (index / WAVE_SLOT_COUNT) * TAU +
      (angularNoise - 0.5) * 0.08;
    const outwardDrift = dissolve * (6 + radialNoise * 10);
    const stampRadius = Math.max(0, radius) + (radialNoise - 0.5) * 8 + outwardDrift;

    return {
      slotIndex: index,
      x: Math.cos(angle) * stampRadius,
      y: Math.sin(angle) * stampRadius,
      angle: angle + Math.PI / 2 + (angularNoise - 0.5) * 0.34,
      size: SHEET_CELL_SIZE,
      alpha: (0.66 + frameNoise * 0.2) * (1 - dissolve * 0.5),
      ...framePair,
    };
  });
};

export const silentLibrarianWindupRadius = (progress: number) =>
  SILENT_LIBRARIAN_WAVE_START_RADIUS + (1 - clamp01(progress)) * 30;

export const silentLibrarianWindupBookPlan = (progress: number) => {
  const framePair = sequenceFramePair(BOOK_FRAME_START, progress);
  return [
    {
      frameIndex: framePair.frameIndex,
      size: SHEET_CELL_SIZE,
      alpha: 1 - framePair.frameBlend,
      angle: 0,
    },
    {
      frameIndex: framePair.nextFrameIndex,
      size: SHEET_CELL_SIZE,
      alpha: framePair.frameBlend,
      angle: 0,
    },
  ];
};

const canDrawImage = (image: HTMLImageElement | undefined): image is HTMLImageElement =>
  Boolean(
    image?.complete &&
      image.naturalWidth === SHEET_COLUMNS * SHEET_CELL_SIZE &&
      image.naturalHeight === SHEET_ROWS * SHEET_CELL_SIZE,
  );

const drawSheetFrame = (
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  frameIndex: number,
  x: number,
  y: number,
  angle: number,
  alpha: number,
) => {
  if (alpha <= 0) return;
  const sourceWidth = SHEET_CELL_SIZE;
  const sourceHeight = SHEET_CELL_SIZE;
  context.save();
  context.translate(x, y);
  context.rotate(angle);
  context.globalAlpha *= clamp01(alpha);
  context.drawImage(
    image,
    (frameIndex % SHEET_COLUMNS) * sourceWidth,
    Math.floor(frameIndex / SHEET_COLUMNS) * sourceHeight,
    sourceWidth,
    sourceHeight,
    -SHEET_CELL_SIZE / 2,
    -SHEET_CELL_SIZE / 2,
    SHEET_CELL_SIZE,
    SHEET_CELL_SIZE,
  );
  context.restore();
};

const drawBrokenRing = (
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  alpha: number,
  timeSeconds: number,
  dashOffset: number,
) => {
  context.save();
  context.globalAlpha *= clamp01(alpha);
  context.lineCap = "butt";
  context.setLineDash([21, 9, 5, 11]);
  context.lineDashOffset = -(timeSeconds * 19 + dashOffset);

  context.strokeStyle = "rgba(9, 7, 5, 0.76)";
  context.lineWidth = 5;
  context.beginPath();
  context.arc(x, y, radius, 0, TAU);
  context.stroke();

  context.strokeStyle = "rgba(151, 105, 58, 0.96)";
  context.lineWidth = 2.25;
  context.beginPath();
  context.arc(x, y, radius, 0, TAU);
  context.stroke();

  context.setLineDash([8, 14, 3, 18]);
  context.lineDashOffset = timeSeconds * 13 + dashOffset * 0.7;
  context.strokeStyle = "rgba(142, 225, 211, 0.98)";
  context.lineWidth = 1.15;
  context.beginPath();
  context.arc(x, y, radius, 0, TAU);
  context.stroke();
  context.restore();
};

const drawRunicTicks = (
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  seed: number,
  progress: number,
  alpha: number,
) => {
  context.save();
  context.globalAlpha *= clamp01(alpha);
  context.lineWidth = 1.5;
  for (let index = 0; index < 12; index += 1) {
    const angle =
      (index / 12) * TAU +
      progress * 0.9 +
      (seededUnit(seed, index, 23) - 0.5) * 0.13;
    const inner = radius - 5 - (index % 3);
    const outer = radius + 3 + (index % 2) * 3;
    context.strokeStyle =
      index % 3 === 0
        ? "rgba(137, 224, 209, 0.98)"
        : "rgba(174, 133, 78, 0.9)";
    context.beginPath();
    context.moveTo(x + Math.cos(angle) * inner, y + Math.sin(angle) * inner);
    context.lineTo(x + Math.cos(angle) * outer, y + Math.sin(angle) * outer);
    context.stroke();
  }
  context.restore();
};

const drawConvergingMotes = (
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  seed: number,
  progress: number,
) => {
  context.save();
  for (let index = 0; index < 10; index += 1) {
    const phase = (index / 10 + progress * (0.52 + (index % 3) * 0.08)) % 1;
    const angle =
      seededUnit(seed, index, 31) * TAU + progress * (1.1 + (index % 2) * 0.35);
    const radius = 82 - phase * 51;
    const moteX = x + Math.cos(angle) * radius;
    const moteY = y + Math.sin(angle) * radius * 0.72 - 11;
    const size = 1 + (index % 3);
    context.globalAlpha = 0.28 + phase * 0.5;
    context.fillStyle =
      index % 4 === 0 ? "rgba(216, 234, 214, 0.96)" : "rgba(157, 112, 63, 0.94)";
    context.fillRect(Math.round(moteX), Math.round(moteY), size, Math.max(2, size + 1));
  }
  context.restore();
};

export const drawSilentLibrarianEchoVfx = ({
  context,
  image,
  phase,
  remainingSeconds,
  x,
  y,
  seed,
  timeSeconds,
  clipBounds,
}: DrawSilentLibrarianEchoOptions) => {
  if (phase !== "echoWindup" && phase !== "echoWave" && phase !== "recover") {
    return false;
  }

  context.save();
  if (clipBounds) {
    context.beginPath();
    context.rect(
      clipBounds.left,
      clipBounds.top,
      clipBounds.right - clipBounds.left,
      clipBounds.bottom - clipBounds.top,
    );
    context.clip();
  }
  context.globalCompositeOperation = "source-over";
  context.shadowColor = "transparent";
  context.shadowBlur = 0;
  context.imageSmoothingEnabled = false;

  if (phase === "echoWindup") {
    const progress = clamp01(
      1 - remainingSeconds / SILENT_LIBRARIAN_TELEGRAPH_SECONDS,
    );
    const radius = silentLibrarianWindupRadius(progress);
    drawBrokenRing(context, x, y, radius, 0.58 + progress * 0.36, timeSeconds, seed);
    drawRunicTicks(context, x, y, radius, seed, progress, 0.5 + progress * 0.45);
    drawConvergingMotes(context, x, y, seed, progress);

    if (canDrawImage(image)) {
      const bookX = x;
      const bookY = y - 82 + Math.sin(timeSeconds * 5.4 + seed) * 2;
      for (const book of silentLibrarianWindupBookPlan(progress)) {
        if (book.alpha <= 0) continue;
        drawSheetFrame(
          context,
          image,
          book.frameIndex,
          bookX,
          bookY,
          book.angle,
          book.alpha * (0.78 + progress * 0.18),
        );
      }
    }
  } else if (phase === "echoWave") {
    const progress = silentLibrarianWaveProgress(remainingSeconds);
    const radius = silentLibrarianWaveRadius(remainingSeconds);
    const dissolve = clamp01((progress - 0.56) / 0.44);
    const waveAlpha = 1 - clamp01((progress - 0.9) / 0.1) * 0.2;

    drawBrokenRing(context, x, y, radius, waveAlpha, timeSeconds, seed + progress * 17);
    drawRunicTicks(context, x, y, radius, seed, progress, 0.62 * waveAlpha);

    if (canDrawImage(image)) {
      const stamps = silentLibrarianEchoStampLayout({
        radius,
        progress,
        seed,
        dissolveProgress: dissolve,
      });
      for (const stamp of stamps) {
        drawSheetFrame(
          context,
          image,
          stamp.frameIndex,
          x + stamp.x,
          y + stamp.y,
          stamp.angle,
          stamp.alpha * waveAlpha * (1 - stamp.frameBlend),
        );
        drawSheetFrame(
          context,
          image,
          stamp.nextFrameIndex,
          x + stamp.x,
          y + stamp.y,
          stamp.angle,
          stamp.alpha * waveAlpha * stamp.frameBlend,
        );
      }

      const releaseAlpha = 1 - clamp01(progress / 0.2);
      if (releaseAlpha > 0) {
        drawSheetFrame(
          context,
          image,
          3,
          x,
          y - 82,
          0,
          releaseAlpha * 0.9,
        );
      }
    }
  } else {
    const recoveryProgress = clamp01(
      1 - remainingSeconds / SILENT_LIBRARIAN_RECOVERY_SECONDS,
    );
    const recoveryAlpha = 1 - clamp01(recoveryProgress / 0.68);
    if (recoveryAlpha > 0 && canDrawImage(image)) {
      const stamps = silentLibrarianEchoStampLayout({
        radius: SILENT_LIBRARIAN_WAVE_END_RADIUS + recoveryProgress * 14,
        progress: 1,
        seed,
        dissolveProgress: 1,
      });
      for (const stamp of stamps) {
        drawSheetFrame(
          context,
          image,
          stamp.frameIndex,
          x + stamp.x,
          y + stamp.y,
          stamp.angle,
          stamp.alpha * recoveryAlpha * (1 - stamp.frameBlend),
        );
        drawSheetFrame(
          context,
          image,
          stamp.nextFrameIndex,
          x + stamp.x,
          y + stamp.y,
          stamp.angle,
          stamp.alpha * recoveryAlpha * stamp.frameBlend,
        );
      }
    }
  }

  context.restore();
  return true;
};
