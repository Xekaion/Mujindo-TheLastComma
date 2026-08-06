/**
 * Experience required to advance from the supplied player level.
 *
 * The opening remains quick enough to establish a build, then two late-game
 * ramps make additional augment stacks a deliberate long-term pursuit.
 */
export function experienceRequiredForLevel(level: number): number {
  const normalizedLevel = Math.min(
    999,
    Math.max(1, Math.floor(Number.isFinite(level) ? level : 1)),
  );
  const completedLevels = normalizedLevel - 1;
  const midgameLevels = Math.max(0, normalizedLevel - 18);
  const endgameLevels = Math.max(0, normalizedLevel - 45);
  const masteryLevels = Math.max(0, normalizedLevel - 80);

  const openingCurve =
    26 +
    completedLevels * 12 +
    Math.pow(completedLevels, 1.25) * 3;
  const midgameRamp = Math.pow(midgameLevels, 2) * 1.25;
  // Past level 45, the target grows multiplicatively. This keeps very late
  // augment stacks meaningful instead of letting linear XP bonuses erase the
  // pacing curve.
  const endgameRamp = (Math.pow(1.09, endgameLevels) - 1) * 2_000;
  const masteryRamp = Math.pow(masteryLevels, 2.55) * 0.45;

  return Math.floor(
    openingCurve + midgameRamp + endgameRamp + masteryRamp,
  );
}
