export const SILENT_LIBRARIAN_KIND = 10 as const;
export const SILENT_LIBRARIAN_UNLOCK_DEPTH = 8;
export const SILENT_LIBRARIAN_MAX_PER_ROOM = 1;

export const SILENT_LIBRARIAN_TELEGRAPH_SECONDS = 0.95;
export const SILENT_LIBRARIAN_WAVE_SECONDS = 0.78;
export const SILENT_LIBRARIAN_RECOVERY_SECONDS = 0.72;
export const SILENT_LIBRARIAN_WAVE_START_RADIUS = 44;
export const SILENT_LIBRARIAN_WAVE_END_RADIUS = 340;
export const SILENT_LIBRARIAN_RING_HALF_WIDTH = 13;
export const SILENT_LIBRARIAN_DAMAGE_MULTIPLIER = 1.22;

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

export const silentLibrarianWaveProgress = (remainingSeconds: number) =>
  clamp01(1 - remainingSeconds / SILENT_LIBRARIAN_WAVE_SECONDS);

export const silentLibrarianWaveRadius = (remainingSeconds: number) => {
  const progress = silentLibrarianWaveProgress(remainingSeconds);
  const eased = 1 - Math.pow(1 - progress, 2);
  return (
    SILENT_LIBRARIAN_WAVE_START_RADIUS +
    (SILENT_LIBRARIAN_WAVE_END_RADIUS - SILENT_LIBRARIAN_WAVE_START_RADIUS) * eased
  );
};

export const sweptEchoRingHits = ({
  previousRadius,
  currentRadius,
  targetDistance,
  targetRadius,
}: {
  previousRadius: number;
  currentRadius: number;
  targetDistance: number;
  targetRadius: number;
}) => {
  const sweepStart = Math.min(previousRadius, currentRadius) - SILENT_LIBRARIAN_RING_HALF_WIDTH;
  const sweepEnd = Math.max(previousRadius, currentRadius) + SILENT_LIBRARIAN_RING_HALF_WIDTH;
  return (
    targetDistance + targetRadius >= sweepStart &&
    targetDistance - targetRadius <= sweepEnd
  );
};
