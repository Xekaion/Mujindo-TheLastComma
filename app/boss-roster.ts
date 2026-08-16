// Keep this module dependency-free so save migrations, deterministic tests,
// and worker-side tooling can evaluate the roster without loading UI modules.
const BLANK_CARTOGRAPHER_KIND = 5 as const;
const FINAL_BINDER_KIND = 9 as const;
const PALIMPSEST_ARCHIVIST_KIND = 11 as const;
const INKBOUND_MAGISTRATE_KIND = 12 as const;
const FORBIDDEN_INDEXER_KIND = 13 as const;
const FIRST_BOSS_ENDING_VERSION = 2;

export type BossKind =
  | typeof BLANK_CARTOGRAPHER_KIND
  | typeof FINAL_BINDER_KIND
  | typeof PALIMPSEST_ARCHIVIST_KIND
  | typeof INKBOUND_MAGISTRATE_KIND
  | typeof FORBIDDEN_INDEXER_KIND;

export function isBossKind(kind: number): kind is BossKind {
  return (
    kind === BLANK_CARTOGRAPHER_KIND ||
    kind === FINAL_BINDER_KIND ||
    kind === PALIMPSEST_ARCHIVIST_KIND ||
    kind === INKBOUND_MAGISTRATE_KIND ||
    kind === FORBIDDEN_INDEXER_KIND
  );
}

/**
 * The blank cartographer always owns the first ending and the Final Binder
 * remains the first post-ending encounter while the player stays on floor one.
 * Entering floor two promotes the Inkbound Magistrate to the first recurring
 * encounter. The Forbidden Indexer follows immediately after it, preserving
 * the established unlock encounter while keeping the expanded roster visible.
 */
export function bossKindForProgress(
  endingVersion: number,
  clearedBossRooms: number,
  dungeonFloor = 1,
): BossKind {
  if (endingVersion < FIRST_BOSS_ENDING_VERSION) {
    return BLANK_CARTOGRAPHER_KIND;
  }
  const postEndingBossIndex = Math.max(0, Math.floor(clearedBossRooms) - 1);
  const isDeepFloor = Number.isFinite(dungeonFloor) && Math.floor(dungeonFloor) >= 2;
  if (!isDeepFloor && postEndingBossIndex === 0) return FINAL_BINDER_KIND;
  if (isDeepFloor) {
    const deepSequence = [
      INKBOUND_MAGISTRATE_KIND,
      FORBIDDEN_INDEXER_KIND,
      PALIMPSEST_ARCHIVIST_KIND,
      BLANK_CARTOGRAPHER_KIND,
      FINAL_BINDER_KIND,
    ] as const;
    return deepSequence[postEndingBossIndex % deepSequence.length];
  }
  const recurringIndex = postEndingBossIndex - 1;
  const recurringSequence = [
    PALIMPSEST_ARCHIVIST_KIND,
    BLANK_CARTOGRAPHER_KIND,
    FINAL_BINDER_KIND,
  ] as const;
  return recurringSequence[recurringIndex % recurringSequence.length];
}
