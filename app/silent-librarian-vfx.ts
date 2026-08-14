import {
  SILENT_LIBRARIAN_RECOVERY_SECONDS,
  SILENT_LIBRARIAN_TELEGRAPH_SECONDS,
  SILENT_LIBRARIAN_WAVE_END_RADIUS,
  SILENT_LIBRARIAN_WAVE_SECONDS,
  SILENT_LIBRARIAN_WAVE_START_RADIUS,
  silentLibrarianWaveProgress,
  silentLibrarianWaveRadius,
} from "./silent-librarian";

export const SILENT_LIBRARIAN_ECHO_VFX_PATH =
  "/assets/effects/silent-librarian-echo-v3.png";

const SHEET_COLUMNS = 2;
const SHEET_ROWS = 2;
const TAU = Math.PI * 2;
const MIN_WAVE_STAMPS = 4;
const MAX_WAVE_STAMPS = 24;

export type SilentLibrarianEchoPhase =
  | "echoWindup"
  | "echoWave"
  | "recover";

export type SilentLibrarianEchoStamp = {
  x: number;
  y: number;
  angle: number;
  size: number;
  alpha: number;
  frameIndex: 2 | 3;
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

const seededUnit = (seed: number, index: number, salt: number) => {
  const value = Math.sin((seed + 1) * 91.739 + index * 37.117 + salt * 11.731) * 43758.5453;
  return value - Math.floor(value);
};

export const silentLibrarianEchoStampCount = (radius: number) =>
  Math.max(
    MIN_WAVE_STAMPS,
    Math.min(MAX_WAVE_STAMPS, Math.round((TAU * Math.max(0, radius)) / 88)),
  );

/**
 * The wave travels by moving fixed-size authored fragments around the gameplay
 * radius. Their world size never derives from radius; only their count and
 * positions change as the circumference expands.
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
  const count = silentLibrarianEchoStampCount(radius);
  const baseAngle = seededUnit(seed, 0, 17) * TAU + safeProgress * 0.22;

  return Array.from({ length: count }, (_, index) => {
    const radialNoise = seededUnit(seed, index, 3);
    const angularNoise = seededUnit(seed, index, 5);
    const frameNoise = seededUnit(seed, index, 7);
    const sizeStep = Math.floor(seededUnit(seed, index, 11) * 3);
    const angle =
      baseAngle +
      (index / count) * TAU +
      (angularNoise - 0.5) * Math.min(0.16, Math.PI / count);
    const outwardDrift = dissolve * (8 + radialNoise * 16);
    const stampRadius = radius + (radialNoise - 0.5) * 10 + outwardDrift;
    const frameIndex: 2 | 3 = frameNoise < dissolve ? 3 : 2;

    return {
      x: Math.cos(angle) * stampRadius,
      y: Math.sin(angle) * stampRadius,
      angle: angle + Math.PI / 2 + (angularNoise - 0.5) * 0.34,
      size: 70 + sizeStep * 4,
      alpha: (0.7 + frameNoise * 0.24) * (1 - dissolve * 0.42),
      frameIndex,
    };
  });
};

export const silentLibrarianWindupRadius = (progress: number) =>
  SILENT_LIBRARIAN_WAVE_START_RADIUS + (1 - clamp01(progress)) * 30;

export const silentLibrarianWindupBookPlan = (progress: number) => {
  const safeProgress = clamp01(progress);
  return [
    {
      frameIndex: 0 as const,
      size: 132,
      alpha: clamp01(1 - Math.max(0, safeProgress - 0.34) / 0.38),
      angle: -0.055 + safeProgress * 0.07,
    },
    {
      frameIndex: 1 as const,
      size: 132,
      alpha: clamp01((safeProgress - 0.24) / 0.4),
      angle: 0.04 - safeProgress * 0.055,
    },
  ];
};

const canDrawImage = (image: HTMLImageElement | undefined): image is HTMLImageElement =>
  Boolean(image?.complete && image.naturalWidth && image.naturalHeight);

const drawSheetFrame = (
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  frameIndex: number,
  x: number,
  y: number,
  size: number,
  angle: number,
  alpha: number,
) => {
  const sourceWidth = image.naturalWidth / SHEET_COLUMNS;
  const sourceHeight = image.naturalHeight / SHEET_ROWS;
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
    -size / 2,
    -size / 2,
    size,
    size,
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

  context.strokeStyle = "rgba(9, 7, 5, 0.94)";
  context.lineWidth = 10;
  context.beginPath();
  context.arc(x, y, radius, 0, TAU);
  context.stroke();

  context.strokeStyle = "rgba(151, 105, 58, 0.96)";
  context.lineWidth = 3.5;
  context.beginPath();
  context.arc(x, y, radius, 0, TAU);
  context.stroke();

  context.setLineDash([8, 14, 3, 18]);
  context.lineDashOffset = timeSeconds * 13 + dashOffset * 0.7;
  context.strokeStyle = "rgba(142, 225, 211, 0.98)";
  context.lineWidth = 2.15;
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
      const bookX = x + 50 - progress * 6;
      const bookY = y - 58 + Math.sin(timeSeconds * 5.4 + seed) * 2;
      for (const book of silentLibrarianWindupBookPlan(progress)) {
        if (book.alpha <= 0) continue;
        drawSheetFrame(
          context,
          image,
          book.frameIndex,
          bookX,
          bookY,
          book.size,
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
          stamp.size,
          stamp.angle,
          stamp.alpha * waveAlpha,
        );
      }

      const releaseAlpha = 1 - clamp01(progress / 0.2);
      if (releaseAlpha > 0) {
        drawSheetFrame(
          context,
          image,
          1,
          x + 44,
          y - 58,
          132,
          -0.015 + progress * 0.16,
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
          3,
          x + stamp.x,
          y + stamp.y,
          stamp.size,
          stamp.angle + recoveryProgress * 0.28,
          stamp.alpha * recoveryAlpha,
        );
      }
    }
  }

  context.restore();
  return true;
};
