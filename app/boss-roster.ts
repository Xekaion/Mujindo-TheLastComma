// Keep this module dependency-free so save migrations, deterministic tests,
// and worker-side tooling can evaluate the roster without loading UI modules.
const BLANK_CARTOGRAPHER_KIND = 5 as const;
const FINAL_BINDER_KIND = 9 as const;
const PALIMPSEST_ARCHIVIST_KIND = 11 as const;
const FIRST_BOSS_ENDING_VERSION = 2;

export type BossKind =
  | typeof BLANK_CARTOGRAPHER_KIND
  | typeof FINAL_BINDER_KIND
  | typeof PALIMPSEST_ARCHIVIST_KIND;

export function isBossKind(kind: number): kind is BossKind {
  return (
    kind === BLANK_CARTOGRAPHER_KIND ||
    kind === FINAL_BINDER_KIND ||
    kind === PALIMPSEST_ARCHIVIST_KIND
  );
}

/**
 * The blank cartographer always owns the first ending. Afterwards the new boss
 * is guaranteed next. The Archivist then joins a three-boss rotation without
 * changing either the story boss or the first post-ending encounter.
 */
export function bossKindForProgress(
  endingVersion: number,
  clearedBossRooms: number,
): BossKind {
  if (endingVersion < FIRST_BOSS_ENDING_VERSION) {
    return BLANK_CARTOGRAPHER_KIND;
  }
  const postEndingBossIndex = Math.max(0, Math.floor(clearedBossRooms) - 1);
  const postEndingSequence = [
    FINAL_BINDER_KIND,
    PALIMPSEST_ARCHIVIST_KIND,
    BLANK_CARTOGRAPHER_KIND,
  ] as const;
  return postEndingSequence[postEndingBossIndex % postEndingSequence.length];
}
