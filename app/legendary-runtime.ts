export type LegendaryCounterStep = {
  count: number;
  triggered: boolean;
};

export type TrackedShieldState = {
  shield: number;
  trackedShield: number;
};

export type TrackedShieldHit = TrackedShieldState & {
  damageAfterShield: number;
  absorbed: number;
};

const finiteNonNegative = (value: number) =>
  Number.isFinite(value) ? Math.max(0, value) : 0;

/**
 * Advances a deterministic proc counter. Corrupted/old-save values are clamped,
 * and a trigger always wraps to zero instead of leaking excess stacks.
 */
export function advanceLegendaryCounter(
  current: number,
  threshold: number,
): LegendaryCounterStep {
  const safeThreshold = Math.max(1, Math.floor(finiteNonNegative(threshold)));
  const safeCurrent = Math.min(
    safeThreshold - 1,
    Math.floor(finiteNonNegative(current)),
  );
  const next = safeCurrent + 1;
  return next >= safeThreshold
    ? { count: 0, triggered: true }
    : { count: next, triggered: false };
}

/** Removes only the still-unspent portion owned by one temporary shield source. */
export function removeTrackedShield(
  shield: number,
  trackedShield: number,
): TrackedShieldState {
  const safeShield = finiteNonNegative(shield);
  const removable = Math.min(safeShield, finiteNonNegative(trackedShield));
  return { shield: safeShield - removable, trackedShield: 0 };
}

/** Refreshes (never stacks) a temporary max-HP-ratio shield. */
export function refreshTrackedShield(
  shield: number,
  trackedShield: number,
  maxHp: number,
  maxHpRatio: number,
): TrackedShieldState {
  const withoutPrevious = removeTrackedShield(shield, trackedShield).shield;
  const granted = finiteNonNegative(maxHp) * finiteNonNegative(maxHpRatio);
  return {
    shield: withoutPrevious + granted,
    trackedShield: granted,
  };
}

/**
 * The tracked temporary portion is consumed first. This makes expiry safe: it
 * can never erase a shield granted by another augment or legendary item.
 */
export function absorbTrackedShield(
  shield: number,
  trackedShield: number,
  incomingDamage: number,
): TrackedShieldHit {
  const safeShield = finiteNonNegative(shield);
  const safeTracked = Math.min(safeShield, finiteNonNegative(trackedShield));
  const safeDamage = finiteNonNegative(incomingDamage);
  const absorbed = Math.min(safeShield, safeDamage);
  return {
    shield: safeShield - absorbed,
    trackedShield: Math.max(0, safeTracked - absorbed),
    damageAfterShield: safeDamage - absorbed,
    absorbed,
  };
}

/** Continuous movement is strict: one stationary update immediately resets it. */
export function advanceContinuousMovement(
  currentSeconds: number,
  deltaSeconds: number,
  moving: boolean,
  activationSeconds: number,
): number {
  if (!moving) return 0;
  const activation = Math.max(0, finiteNonNegative(activationSeconds));
  return Math.min(
    activation + 0.5,
    finiteNonNegative(currentSeconds) + finiteNonNegative(deltaSeconds),
  );
}
