import {
  EQUIPMENT_SLOTS,
  normalizeGearItem,
  rollGear,
  type EquipmentLoadout,
  type EquipmentSlot,
  type GearItem,
  type GearRarity,
  type GearSeed,
} from "./equipment";

export const MAX_DIVINE_FORGE_REROLLS = 3;

export type DivineForgeTargetRarity = Extract<GearRarity, "mythic" | "cosmic">;

export type DivineForgeRule = {
  targetRarity: DivineForgeTargetRarity;
  materialRarity: Extract<GearRarity, "legendary" | "mythic">;
  materialCount: 5;
  ashCost: number;
};

export const DIVINE_FORGE_RULES: Readonly<
  Record<DivineForgeTargetRarity, DivineForgeRule>
> = {
  mythic: {
    targetRarity: "mythic",
    materialRarity: "legendary",
    materialCount: 5,
    ashCost: 150_000,
  },
  cosmic: {
    targetRarity: "cosmic",
    materialRarity: "mythic",
    materialCount: 5,
    ashCost: 1_000_000,
  },
};

export type DivineForgeValidationCode =
  | "ready"
  | "invalid-target"
  | "reroll-limit"
  | "material-count"
  | "duplicate-material"
  | "target-as-material"
  | "invalid-material"
  | "insufficient-ash";

export type DivineForgeValidation = {
  ok: boolean;
  code: DivineForgeValidationCode;
  rule: DivineForgeRule | null;
};

export type DivineForgeResult = {
  before: GearItem;
  after: GearItem;
  consumed: GearItem[];
  ashCost: number;
};

export type DivineForgeTransactionInput = {
  inventory: readonly GearItem[];
  equipment: EquipmentLoadout;
  memoryAsh: number;
  targetId: string;
  materialIds: readonly string[];
  seed: GearSeed;
};

export type DivineForgeTransaction =
  | {
      ok: false;
      code:
        | "target-not-found"
        | Exclude<DivineForgeValidationCode, "ready">;
      validation: DivineForgeValidation | null;
    }
  | {
      ok: true;
      code: "ready";
      inventory: GearItem[];
      equipment: EquipmentLoadout;
      memoryAsh: number;
      equippedSlot: EquipmentSlot | null;
      result: DivineForgeResult;
    };

export function getDivineForgeRule(
  itemOrRarity: Pick<GearItem, "rarity"> | GearRarity,
): DivineForgeRule | null {
  const rarity =
    typeof itemOrRarity === "string" ? itemOrRarity : itemOrRarity.rarity;
  return rarity === "mythic" || rarity === "cosmic"
    ? DIVINE_FORGE_RULES[rarity]
    : null;
}

export function getDivineForgeRerollsRemaining(
  item: Pick<GearItem, "divineForgeRerolls">,
): number {
  return Math.max(0, MAX_DIVINE_FORGE_REROLLS - item.divineForgeRerolls);
}

export function isDivineForgeMaterialEligible(
  target: Pick<GearItem, "id" | "rarity" | "level">,
  material: Pick<GearItem, "id" | "rarity" | "level">,
): boolean {
  const rule = getDivineForgeRule(target);
  return Boolean(
    rule &&
      material.id !== target.id &&
      material.rarity === rule.materialRarity &&
      material.level > target.level,
  );
}

export function sortDivineForgeMaterials(
  materials: readonly GearItem[],
): GearItem[] {
  return [...materials].sort(
    (left, right) =>
      left.level - right.level ||
      left.enhancement - right.enhancement ||
      left.powerScore - right.powerScore ||
      left.id.localeCompare(right.id),
  );
}

export function validateDivineForgeAttempt(
  target: GearItem,
  materials: readonly GearItem[],
  memoryAsh: number,
): DivineForgeValidation {
  const rule = getDivineForgeRule(target);
  if (!rule) return { ok: false, code: "invalid-target", rule: null };
  if (target.divineForgeRerolls >= MAX_DIVINE_FORGE_REROLLS) {
    return { ok: false, code: "reroll-limit", rule };
  }
  if (materials.length !== rule.materialCount) {
    return { ok: false, code: "material-count", rule };
  }
  const materialIds = new Set(materials.map((item) => item.id));
  if (materialIds.size !== materials.length) {
    return { ok: false, code: "duplicate-material", rule };
  }
  if (materialIds.has(target.id)) {
    return { ok: false, code: "target-as-material", rule };
  }
  if (!materials.every((item) => isDivineForgeMaterialEligible(target, item))) {
    return { ok: false, code: "invalid-material", rule };
  }
  if (!Number.isFinite(memoryAsh) || memoryAsh < rule.ashCost) {
    return { ok: false, code: "insufficient-ash", rule };
  }
  return { ok: true, code: "ready", rule };
}

function affixSignature(item: Pick<GearItem, "affixes">): string {
  return item.affixes
    .map((affix) => `${affix.stat}:${affix.value}:${affix.rollPercent}`)
    .join("|");
}

/**
 * Replaces every random affix while preserving the target item's identity,
 * implicit slot option, legendary power, enhancement stage, and level.
 */
export function rerollDivineForgeItem(
  target: GearItem,
  seed: GearSeed,
): GearItem {
  const rule = getDivineForgeRule(target);
  if (!rule) throw new Error("Only mythic and cosmic gear can use the divine forge.");
  if (target.divineForgeRerolls >= MAX_DIVINE_FORGE_REROLLS) {
    throw new Error("This item has reached its divine-forge reroll limit.");
  }

  const previousSignature = affixSignature(target);
  let rolled = rollGear(`${String(seed)}|divine-forge|0`, {
    level: target.level,
    slot: target.slot,
    rarity: rule.targetRarity,
  });
  for (let salt = 1; salt <= 32 && affixSignature(rolled) === previousSignature; salt += 1) {
    rolled = rollGear(`${String(seed)}|divine-forge|${salt}`, {
      level: target.level,
      slot: target.slot,
      rarity: rule.targetRarity,
    });
  }

  const normalized = normalizeGearItem({
    ...target,
    affixes: rolled.affixes,
    divineForgeRerolls: target.divineForgeRerolls + 1,
  });
  if (!normalized) throw new Error("The divine forge produced invalid gear data.");
  return normalized;
}

/**
 * Validates and prepares one complete forge transaction without mutating the
 * caller's inventory, equipment, target, materials, or ash balance.
 */
export function applyDivineForgeTransaction(
  input: DivineForgeTransactionInput,
): DivineForgeTransaction {
  const inventoryIndex = input.inventory.findIndex(
    (item) => item.id === input.targetId,
  );
  const equippedSlot =
    EQUIPMENT_SLOTS.find(
      (slot) => input.equipment[slot]?.id === input.targetId,
    ) ?? null;
  const target =
    inventoryIndex >= 0
      ? input.inventory[inventoryIndex]
      : equippedSlot
        ? input.equipment[equippedSlot]
        : null;
  if (!target) {
    return { ok: false, code: "target-not-found", validation: null };
  }

  if (input.materialIds.length !== 5) {
    const validation = validateDivineForgeAttempt(
      target,
      [],
      input.memoryAsh,
    );
    return { ok: false, code: validation.code, validation };
  }

  const inventoryById = new Map(
    input.inventory.map((item) => [item.id, item] as const),
  );
  const materials = input.materialIds.flatMap((id) => {
    const material = inventoryById.get(id);
    return material ? [material] : [];
  });
  const validation = validateDivineForgeAttempt(
    target,
    materials,
    input.memoryAsh,
  );
  if (!validation.ok || !validation.rule) {
    return { ok: false, code: validation.code, validation };
  }

  const after = rerollDivineForgeItem(target, input.seed);
  const consumedIds = new Set(materials.map((item) => item.id));
  const inventory = input.inventory
    .filter((item) => !consumedIds.has(item.id))
    .map((item) => (item.id === target.id ? after : item));
  const equipment: EquipmentLoadout = { ...input.equipment };
  if (equippedSlot) equipment[equippedSlot] = after;

  return {
    ok: true,
    code: "ready",
    inventory,
    equipment,
    memoryAsh: input.memoryAsh - validation.rule.ashCost,
    equippedSlot,
    result: {
      before: target,
      after,
      consumed: [...materials],
      ashCost: validation.rule.ashCost,
    },
  };
}
