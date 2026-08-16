"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import CharacterEntryGate, {
  type CharacterNicknameRejection,
  type CharacterEntrySelection,
} from "./CharacterEntryGate";
import GameCanvas, {
  type LocalEnemyVfxShowcaseMode,
  type LocalLootVfxShowcaseMode,
} from "./GameCanvas";
import InventoryOverlay from "./InventoryOverlay";
import PlazaCharacterProfile from "./PlazaCharacterProfile";
import PlazaHub from "./PlazaHub";
import TownCaravanOverlay from "./TownCaravanOverlay";
import {
  normalizeAutoSalvageThreshold,
  readAutoSalvagePreference,
  writeAutoSalvagePreference,
  type AutoSalvageThreshold,
} from "./auto-salvage";
import {
  applyDivineForgeTransaction,
  type DivineForgeResult,
} from "./divine-forge";
import {
  EQUIPMENT_SLOTS,
  GEAR_RARITY_META,
  applySuccessfulGearEnhancement,
  canEquipGearAtLevel,
  calculateEquipmentCombatPower,
  formatGearDisplayName,
  getGearEnhancementRule,
  getGearRequiredLevel,
  getGearSalvageAshBreakdown,
  reconcileEquipmentLevelRequirements,
  type EquipmentLoadout,
  type EquipmentSlot,
  type GearItem,
} from "./equipment";
import {
  getMemoryPlazaClient,
  type HubConnectionState,
} from "./hub-client";
import {
  HUB_PALETTES,
  hubAppearanceFromLoadout,
  hubPublicEquipmentFromLoadout,
  type HubAppearance,
  type HubArrival,
  type HubCharacterProfile,
  type HubPlayerSnapshot,
  type HubSnapshot,
} from "./hub-protocol";
import {
  isSaveSlotId,
  normalizeDungeonFloor,
  readSaveSlot,
  writeSaveSlot,
  type SaveRunPayload,
} from "./save-slots";
import {
  readCharacterNickname,
  removeCharacterNickname,
} from "./character-nickname";
import { inventoryCapacityFor, readShopEntitlements } from "./shop";
import type { PlazaPortalDefinition } from "./plaza-world";
import { createPlazaSkillShowcaseEquipment } from "./plaza-skills";

type GameEntryFlowProps = {
  accountName?: string | null;
  returnToTown?: boolean;
  localVfxShowcaseRequested?: boolean;
};

type EntryView = "plaza" | "expedition";
type PlazaProfileState = {
  profile: HubCharacterProfile | null;
  loading: boolean;
  error: string | null;
};
type PlazaEquipmentSnapshot = {
  save: SaveRunPayload;
  equipment: EquipmentLoadout;
  inventory: GearItem[];
  memoryAsh: number;
};
type PlazaEnhancementConfirmation = {
  itemId: string;
  title: string;
  body: string;
};
type PlazaGearLocation = {
  item: GearItem;
  inventoryIndex: number;
  equippedSlot: EquipmentSlot | null;
};

function findPlazaGear(
  snapshot: PlazaEquipmentSnapshot,
  itemId: string,
): PlazaGearLocation | null {
  const inventoryIndex = snapshot.inventory.findIndex(
    (item) => item.id === itemId,
  );
  const equippedSlot =
    EQUIPMENT_SLOTS.find(
      (slot) => snapshot.equipment[slot]?.id === itemId,
    ) ?? null;
  const item =
    inventoryIndex >= 0
      ? snapshot.inventory[inventoryIndex]
      : equippedSlot
        ? snapshot.equipment[equippedSlot]
        : null;
  return item ? { item, inventoryIndex, equippedSlot } : null;
}

function divineForgeFailureMessage(code: string): string {
  if (code === "target-not-found") return "신의 대장간 대상을 찾을 수 없습니다.";
  if (code === "reroll-limit") {
    return "이 장비는 신의 대장간 최대 재련 3회를 모두 사용했습니다.";
  }
  if (code === "insufficient-ash") {
    return "신의 대장간에 바칠 기억의 재가 부족합니다.";
  }
  if (code === "material-count") return "조건을 충족하는 재료 장비 5개가 필요합니다.";
  return "신의 대장간 재료 조건이 달라졌습니다. 다시 확인해 주세요.";
}

const TOWN_RETURN_SESSION_KEY = "mujindo:town-return-slot:v1";
const LOCAL_VFX_SHOWCASE_HOSTS = [
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
] as const;
const LOCAL_LOOT_VFX_SHOWCASE_MODES: readonly LocalLootVfxShowcaseMode[] = [
  "common",
  "magic",
  "superior",
  "rare",
  "epic",
  "legendary",
  "mythic",
  "cosmic",
  "all",
];
const LOCAL_PLAZA_SKILL_SHOWCASE_EQUIPMENT =
  createPlazaSkillShowcaseEquipment();
const LOCAL_PLAZA_SKILL_SHOWCASE_APPEARANCE = {
  ...hubAppearanceFromLoadout(
    LOCAL_PLAZA_SKILL_SHOWCASE_EQUIPMENT,
    HUB_PALETTES[0],
  ),
  equipped: true,
};

const isLocalLootVfxShowcaseMode = (
  value: string | null,
): value is LocalLootVfxShowcaseMode =>
  LOCAL_LOOT_VFX_SHOWCASE_MODES.some((mode) => mode === value);

const connectionForPlaza = (
  state: HubConnectionState,
): "offline" | "connecting" | "online" | "reconnecting" =>
  state === "idle" ? "offline" : state;

function publicProfileErrorMessage(error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  if (code === "character_not_available") {
    return "상대가 광장을 떠났거나 캐릭터 정보 확인 거리 밖으로 이동했습니다.";
  }
  if (code === "rate_limited") {
    return "캐릭터 정보를 너무 자주 확인했습니다. 잠시 후 다시 시도해 주세요.";
  }
  if (code === "invalid_hub_session") {
    return "광장 연결이 갱신되고 있습니다. 잠시 후 다시 시도해 주세요.";
  }
  return "공개 기록을 불러오지 못했습니다. 상대가 광장에 있는지 확인해 주세요.";
}

/**
 * The selected local save controls PvE progress and visuals. Multiplayer only
 * receives an allowlisted appearance summary; item data and client positions
 * never become server authority.
 */
export default function GameEntryFlow({
  accountName,
  returnToTown = false,
  localVfxShowcaseRequested = false,
}: GameEntryFlowProps) {
  const [selection, setSelection] = useState<CharacterEntrySelection | null>(null);
  const [nicknameRejection, setNicknameRejection] =
    useState<CharacterNicknameRejection | null>(null);
  const [localEnemyVfxShowcase, setLocalEnemyVfxShowcase] =
    useState<LocalEnemyVfxShowcaseMode | null>(null);
  const [localLootVfxShowcase, setLocalLootVfxShowcase] =
    useState<LocalLootVfxShowcaseMode | null>(null);
  const [localEndingUiShowcase, setLocalEndingUiShowcase] = useState(false);
  const [localPlazaMotionShowcase, setLocalPlazaMotionShowcase] = useState(false);
  const [localVfxShowcaseChecked, setLocalVfxShowcaseChecked] = useState(
    !localVfxShowcaseRequested,
  );
  const [view, setView] = useState<EntryView>("plaza");
  const [shopOpen, setShopOpen] = useState(false);
  const [inventoryOpen, setInventoryOpen] = useState(false);
  const [selectedGearId, setSelectedGearId] = useState<string | null>(null);
  const [plazaInventoryNotice, setPlazaInventoryNotice] = useState<string | null>(null);
  const [plazaEnhancementConfirmation, setPlazaEnhancementConfirmation] =
    useState<PlazaEnhancementConfirmation | null>(null);
  const [inventoryCapacity, setInventoryCapacity] = useState(() =>
    inventoryCapacityFor(readShopEntitlements(null)),
  );
  const [arrival, setArrival] = useState<HubArrival>("center");
  const [hubConnection, setHubConnection] =
    useState<HubConnectionState>("idle");
  const [hubSnapshot, setHubSnapshot] = useState<HubSnapshot | null>(null);
  const [profileState, setProfileState] = useState<PlazaProfileState | null>(null);
  const [saveRevision, setSaveRevision] = useState(0);
  const plazaSaveSnapshotRef = useRef<SaveRunPayload | null>(null);
  const profileRequestIdRef = useRef(0);
  const lastInspectedPlayerRef = useRef<HubPlayerSnapshot | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const isLocalHost = LOCAL_VFX_SHOWCASE_HOSTS.some(
        (hostname) => hostname === window.location.hostname,
      );
      if (isLocalHost) {
        const search = new URLSearchParams(window.location.search);
        const requestedEnemyMode = search.get("enemyVfxShowcase");
        const requestedLootMode = search.get("lootVfxShowcase");
        const requestedEndingUiShowcase = search.get("endingUiShowcase");
        const requestedPlazaMotionShowcase = search.get("plazaMotionShowcase");
        if (
          requestedEnemyMode === "margin-severer" ||
          requestedEnemyMode === "silent-librarian" ||
          requestedEnemyMode === "forbidden-indexer"
        ) {
          setLocalEnemyVfxShowcase(requestedEnemyMode);
        }
        if (isLocalLootVfxShowcaseMode(requestedLootMode)) {
          setLocalLootVfxShowcase(requestedLootMode);
        }
        if (requestedEndingUiShowcase === "1") {
          setLocalEndingUiShowcase(true);
        }
        if (requestedPlazaMotionShowcase === "1") {
          setLocalPlazaMotionShowcase(true);
        }
      }
      setLocalVfxShowcaseChecked(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (
      !localVfxShowcaseChecked ||
      localEnemyVfxShowcase ||
      localLootVfxShowcase ||
      localEndingUiShowcase ||
      localPlazaMotionShowcase ||
      !returnToTown ||
      selection !== null
    ) {
      return;
    }
    const timer = window.setTimeout(() => {
      let slot: number | null = null;
      try {
        const stored = window.sessionStorage.getItem(TOWN_RETURN_SESSION_KEY);
        window.sessionStorage.removeItem(TOWN_RETURN_SESSION_KEY);
        slot = stored === null ? null : Number(stored);
      } catch {
        slot = null;
      }
      if (!isSaveSlotId(slot)) return;
      const save = readSaveSlot(slot);
      const displayName = readCharacterNickname(slot);
      if (!displayName) return;
      plazaSaveSnapshotRef.current = save;
      setSelection({ slot, occupied: save !== null, displayName, save });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [
    localEnemyVfxShowcase,
    localLootVfxShowcase,
    localEndingUiShowcase,
    localPlazaMotionShowcase,
    localVfxShowcaseChecked,
    returnToTown,
    selection,
  ]);

  const enterCharacter = useCallback((next: CharacterEntrySelection) => {
    setNicknameRejection(null);
    plazaSaveSnapshotRef.current = next.save;
    setSaveRevision(0);
    setSelection(next);
    setView("plaza");
    setArrival("center");
    setShopOpen(false);
    setInventoryOpen(false);
    setPlazaInventoryNotice(null);
    setPlazaEnhancementConfirmation(null);
    setProfileState(null);
    profileRequestIdRef.current += 1;
    lastInspectedPlayerRef.current = null;
    setSelectedGearId(null);
    setInventoryCapacity(inventoryCapacityFor(readShopEntitlements()));
  }, []);

  const savedCharacter = useMemo(() => {
    // Returning from an expedition increments the revision so this cached
    // local-save snapshot is refreshed before the plaza is drawn again.
    void saveRevision;
    if (!selection) return null;
    // The entry card and plaza must use the same validated snapshot. A second
    // localStorage read during the React view transition can otherwise observe
    // a stale browser value even though the card already summarized the newer
    // equipment. After an expedition return, prefer the newly persisted save.
    if (saveRevision === 0 && selection.save) return selection.save;
    // Re-read after returning from an expedition so the plaza immediately
    // reflects newly saved levels and equipment.
    return readSaveSlot(selection.slot);
  }, [saveRevision, selection]);

  useEffect(() => {
    if (
      !selection ||
      selection.slot !== 1 ||
      !savedCharacter ||
      savedCharacter.player.level !== 82 ||
      savedCharacter.player.profession !== "fang" ||
      savedCharacter.codexMemoryAshGrant160kV1 === true
    ) {
      return;
    }
    const currentMemoryAsh = Math.max(
      0,
      Math.floor(Number(savedCharacter.player.memoryAsh) || 0),
    );
    const grantedSave = {
      ...savedCharacter,
      savedAt: Date.now(),
      codexMemoryAshGrant160kV1: true,
      player: {
        ...savedCharacter.player,
        memoryAsh: currentMemoryAsh + 160_000,
      },
    };
    if (!writeSaveSlot(selection.slot, grantedSave)) return;
    plazaSaveSnapshotRef.current = grantedSave;
    const revisionTimer = window.setTimeout(() => {
      setSaveRevision((revision) => revision + 1);
    }, 0);
    return () => window.clearTimeout(revisionTimer);
  }, [savedCharacter, selection]);

  const reconciledGear = useMemo(
    () => reconcileEquipmentLevelRequirements(
      savedCharacter?.player.level ?? 1,
      savedCharacter?.player.equipment,
      savedCharacter?.player.inventory,
    ),
    [savedCharacter],
  );
  const equipment = reconciledGear.equipment;
  const inventory = reconciledGear.inventory;
  const memoryAsh = Math.max(
    0,
    Math.floor(Number(savedCharacter?.player.memoryAsh) || 0),
  );
  const autoSalvageMaxRarity = useMemo<AutoSalvageThreshold>(() => {
    void saveRevision;
    if (!selection) return null;
    const preference = readAutoSalvagePreference(selection.slot);
    return preference === undefined
      ? normalizeAutoSalvageThreshold(
          savedCharacter?.player.autoSalvageMaxRarity,
        )
      : preference;
  }, [saveRevision, savedCharacter, selection]);
  const equippedPower = useMemo(
    () => calculateEquipmentCombatPower(equipment),
    [equipment],
  );
  const publicEquipment = useMemo(
    () => hubPublicEquipmentFromLoadout(equipment),
    [equipment],
  );

  const hubAppearance = useMemo<HubAppearance>(() => {
    const slotIndex = selection ? selection.slot - 1 : 0;
    return hubAppearanceFromLoadout(
      equipment,
      HUB_PALETTES[slotIndex] ?? "scarlet",
    );
  }, [equipment, selection]);

  const level = savedCharacter?.player.level ?? 1;
  const dungeonFloor = normalizeDungeonFloor(
    savedCharacter?.world?.dungeonFloor,
  );
  const inventoryCount = inventory.length;
  const displayName = selection?.displayName ?? "기록자";
  const hubPublishedProfileRef = useRef({
    level,
    dungeonFloor,
    appearance: hubAppearance,
    publicEquipment,
  });
  useEffect(() => {
    hubPublishedProfileRef.current = {
      level,
      dungeonFloor,
      appearance: hubAppearance,
      publicEquipment,
    };
  }, [dungeonFloor, hubAppearance, level, publicEquipment]);

  useEffect(() => {
    if (!selection || view !== "plaza") return;
    const client = getMemoryPlazaClient();
    const publishedProfile = hubPublishedProfileRef.current;
    const unsubscribe = client.subscribe((event) => {
      if (event.type === "connection") setHubConnection(event.state);
      if (event.type === "snapshot") setHubSnapshot(event.snapshot);
      if (event.type === "error" && !event.retryable) {
        if (
          event.code === "nickname_taken" ||
          event.code === "nickname_required"
        ) {
          removeCharacterNickname(selection.slot);
          setNicknameRejection({
            slot: selection.slot,
            nickname: selection.displayName,
            code: event.code,
          });
          setSelection(null);
          return;
        }
        setHubConnection("offline");
      }
    });
    void client.enter({
      characterSlot: selection.slot,
      displayName,
      level: publishedProfile.level,
      dungeonFloor: publishedProfile.dungeonFloor,
      appearance: publishedProfile.appearance,
      publicEquipment: publishedProfile.publicEquipment,
      arrival,
    });
    return () => {
      unsubscribe();
      client.leave();
      setHubSnapshot(null);
      setHubConnection("offline");
    };
  }, [arrival, displayName, selection, view]);

  useEffect(() => {
    if (!selection || view !== "plaza" || hubConnection !== "online") return;
    void getMemoryPlazaClient().updateAppearance(
      hubAppearance,
      level,
      dungeonFloor,
      publicEquipment,
    );
  }, [
    dungeonFloor,
    hubAppearance,
    hubConnection,
    level,
    publicEquipment,
    selection,
    view,
  ]);

  const moveInPlaza = useCallback((intent: {
    moveX: number;
    moveY: number;
    facing: number;
  }) => {
    const facing = Math.max(0, Math.min(7, Math.floor(intent.facing))) as
      | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
    getMemoryPlazaClient().setMoveIntent({
      moveX: intent.moveX,
      moveY: intent.moveY,
      facing,
    });
  }, []);

  const dashInPlaza = useCallback(() => {
    getMemoryPlazaClient().queueDash();
  }, []);

  const rememberTownReturn = useCallback(() => {
    if (!selection) return;
    try {
      window.sessionStorage.setItem(
        TOWN_RETURN_SESSION_KEY,
        String(selection.slot),
      );
    } catch {
      // A blocked session store only means the player will select again.
    }
  }, [selection]);

  const activatePortal = useCallback(
    (portal: PlazaPortalDefinition) => {
      if (!selection) return;
      setInventoryOpen(false);
      setSelectedGearId(null);
      setPlazaInventoryNotice(null);
      setPlazaEnhancementConfirmation(null);
      if (portal.id === "expedition") {
        setArrival("expedition");
        setView("expedition");
        return;
      }
      if (portal.id === "caravan") {
        setShopOpen(true);
        return;
      }

      const destination = new URL(portal.href, window.location.origin);
      rememberTownReturn();
      destination.searchParams.set("from", "plaza");
      destination.searchParams.set("slot", String(selection.slot));
      const demo = new URLSearchParams(window.location.search).get("demo");
      if (demo === "A" || demo === "B") destination.searchParams.set("demo", demo);
      window.location.assign(`${destination.pathname}${destination.search}`);
    },
    [rememberTownReturn, selection],
  );

  const openMarketFromCaravan = useCallback(() => {
    if (!selection) return;
    rememberTownReturn();
    const destination = new URL("/market", window.location.origin);
    destination.searchParams.set("tab", "gold");
    destination.searchParams.set("from", "plaza");
    destination.searchParams.set("slot", String(selection.slot));
    window.location.assign(`${destination.pathname}${destination.search}`);
  }, [rememberTownReturn, selection]);

  const openInventory = useCallback(() => {
    if (shopOpen || profileState !== null) return;
    setInventoryCapacity(inventoryCapacityFor(readShopEntitlements()));
    setPlazaInventoryNotice(null);
    setPlazaEnhancementConfirmation(null);
    setInventoryOpen(true);
  }, [profileState, shopOpen]);

  const closeCharacterProfile = useCallback(() => {
    profileRequestIdRef.current += 1;
    lastInspectedPlayerRef.current = null;
    setProfileState(null);
  }, []);

  const inspectRemoteCharacter = useCallback((player: HubPlayerSnapshot) => {
    const requestId = profileRequestIdRef.current + 1;
    profileRequestIdRef.current = requestId;
    lastInspectedPlayerRef.current = player;
    setProfileState({ profile: null, loading: true, error: null });
    void getMemoryPlazaClient()
      .inspectCharacterProfile(player.characterId)
      .then((profile) => {
        if (profileRequestIdRef.current !== requestId) return;
        setProfileState({ profile, loading: false, error: null });
      })
      .catch((error: unknown) => {
        if (profileRequestIdRef.current !== requestId) return;
        setProfileState({
          profile: null,
          loading: false,
          error: publicProfileErrorMessage(error),
        });
      });
  }, []);

  const retryRemoteCharacterProfile = useCallback(() => {
    const player = lastInspectedPlayerRef.current;
    if (player) inspectRemoteCharacter(player);
  }, [inspectRemoteCharacter]);

  const openShopFromInventory = useCallback(() => {
    setInventoryOpen(false);
    setSelectedGearId(null);
    setPlazaInventoryNotice(null);
    setPlazaEnhancementConfirmation(null);
    setShopOpen(true);
  }, []);

  const readPlazaEquipmentSnapshot = useCallback(
    (): PlazaEquipmentSnapshot | null => {
      if (!selection) return null;
      const storedSave = readSaveSlot(selection.slot);
      let save = plazaSaveSnapshotRef.current ?? selection.save;
      if (storedSave && (!save || storedSave.savedAt > save.savedAt)) {
        save = storedSave;
      }
      if (!save) {
        setPlazaInventoryNotice("관리할 캐릭터 기록이 아직 없습니다.");
        return null;
      }

      plazaSaveSnapshotRef.current = save;
      const reconciled = reconcileEquipmentLevelRequirements(
        save.player.level,
        save.player.equipment,
        save.player.inventory,
      );
      return {
        save,
        equipment: { ...reconciled.equipment },
        inventory: [...reconciled.inventory],
        memoryAsh: Math.max(
          0,
          Math.floor(Number(save.player.memoryAsh) || 0),
        ),
      };
    },
    [selection],
  );

  const commitPlazaEquipment = useCallback(
    (snapshot: PlazaEquipmentSnapshot, successMessage: string): boolean => {
      if (!selection) return false;
      const nextSave: SaveRunPayload = {
        ...snapshot.save,
        savedAt: Math.max(Date.now(), snapshot.save.savedAt + 1),
        // Plaza equipment mutations change combat power outside the expedition
        // runtime. Invalidate the cached rating so the next load recomputes it.
        expeditionPowerRatingVersion: undefined,
        player: {
          ...snapshot.save.player,
          equipment: snapshot.equipment,
          inventory: snapshot.inventory,
          memoryAsh: snapshot.memoryAsh,
        },
      };
      if (!writeSaveSlot(selection.slot, nextSave)) {
        setPlazaInventoryNotice(
          "기록 저장에 실패했습니다. 변경 사항은 적용되지 않았습니다.",
        );
        return false;
      }

      plazaSaveSnapshotRef.current = nextSave;
      setSaveRevision((revision) => revision + 1);
      setPlazaInventoryNotice(successMessage);
      return true;
    },
    [selection],
  );

  const equipPlazaGear = useCallback(
    (itemId: string) => {
      const snapshot = readPlazaEquipmentSnapshot();
      if (!snapshot) return;
      const itemIndex = snapshot.inventory.findIndex(
        (item) => item.id === itemId,
      );
      if (itemIndex < 0) return;
      const item = snapshot.inventory[itemIndex];
      if (!canEquipGearAtLevel(snapshot.save.player.level, item)) {
        setSelectedGearId(item.id);
        setPlazaInventoryNotice(
          `착용 필요 레벨 부족 · 아이템 레벨 ${item.level} 장비는 캐릭터 LV.${getGearRequiredLevel(item)}부터 장착할 수 있습니다.`,
        );
        return;
      }

      const replaced = snapshot.equipment[item.slot];
      snapshot.equipment[item.slot] = item;
      snapshot.inventory.splice(itemIndex, 1);
      if (replaced) snapshot.inventory.push(replaced);
      if (
        commitPlazaEquipment(
          snapshot,
          `${formatGearDisplayName(item)} 장착 · 광장 기록에 저장했습니다.`,
        )
      ) {
        setSelectedGearId(replaced?.id ?? null);
      }
    },
    [commitPlazaEquipment, readPlazaEquipmentSnapshot],
  );

  const unequipPlazaGear = useCallback(
    (slot: EquipmentSlot) => {
      const snapshot = readPlazaEquipmentSnapshot();
      if (!snapshot) return;
      const item = snapshot.equipment[slot];
      if (!item) return;
      if (snapshot.inventory.length >= inventoryCapacity) {
        setPlazaInventoryNotice(
          `가방 ${inventoryCapacity}칸이 가득 차 장비를 해제할 수 없습니다.`,
        );
        return;
      }

      snapshot.equipment[slot] = null;
      snapshot.inventory.push(item);
      if (
        commitPlazaEquipment(
          snapshot,
          `${formatGearDisplayName(item)} 장착 해제 · 가방으로 이동했습니다.`,
        )
      ) {
        setSelectedGearId(item.id);
      }
    },
    [commitPlazaEquipment, inventoryCapacity, readPlazaEquipmentSnapshot],
  );

  const salvagePlazaGear = useCallback(
    (itemId: string) => {
      const snapshot = readPlazaEquipmentSnapshot();
      if (!snapshot) return;
      const itemIndex = snapshot.inventory.findIndex(
        (item) => item.id === itemId,
      );
      if (itemIndex < 0) return;
      const [item] = snapshot.inventory.splice(itemIndex, 1);
      const ash = getGearSalvageAshBreakdown(item);
      snapshot.memoryAsh += ash.total;
      const refundMessage =
        ash.enhancementRefund > 0
          ? ` · 강화 비용 ${ash.enhancementRefund.toLocaleString("ko-KR")}개 환급`
          : "";
      if (
        commitPlazaEquipment(
          snapshot,
          `${formatGearDisplayName(item)} 분해 · 기억의 재 ${ash.total.toLocaleString("ko-KR")}개 획득${refundMessage}`,
        )
      ) {
        setSelectedGearId(null);
      }
    },
    [commitPlazaEquipment, readPlazaEquipmentSnapshot],
  );

  const salvageManyPlazaGear = useCallback(
    (itemIds: string[]) => {
      const snapshot = readPlazaEquipmentSnapshot();
      if (!snapshot) return;
      const requestedIds = new Set(itemIds);
      const items = snapshot.inventory.filter((item) => requestedIds.has(item.id));
      if (items.length === 0) return;
      const ash = items.reduce(
        (total, item) => {
          const breakdown = getGearSalvageAshBreakdown(item);
          return {
            total: total.total + breakdown.total,
            enhancementRefund:
              total.enhancementRefund + breakdown.enhancementRefund,
          };
        },
        { total: 0, enhancementRefund: 0 },
      );
      snapshot.inventory = snapshot.inventory.filter(
        (item) => !requestedIds.has(item.id),
      );
      snapshot.memoryAsh += ash.total;
      const refundMessage =
        ash.enhancementRefund > 0
          ? ` · 강화 비용 ${ash.enhancementRefund.toLocaleString("ko-KR")}개 환급`
          : "";
      if (
        commitPlazaEquipment(
          snapshot,
          `장비 ${items.length}개 분해 · 기억의 재 ${ash.total.toLocaleString("ko-KR")}개 획득${refundMessage}`,
        ) &&
        selectedGearId &&
        requestedIds.has(selectedGearId)
      ) {
        setSelectedGearId(null);
      }
    },
    [commitPlazaEquipment, readPlazaEquipmentSnapshot, selectedGearId],
  );

  const changePlazaAutoSalvage = useCallback(
    (threshold: AutoSalvageThreshold) => {
      if (!selection) return;
      const normalized = normalizeAutoSalvageThreshold(threshold);
      if (!writeAutoSalvagePreference(selection.slot, normalized)) {
        setPlazaInventoryNotice("자동 분해 설정을 저장하지 못했습니다.");
        return;
      }
      setSaveRevision((revision) => revision + 1);
      setPlazaInventoryNotice(
        normalized === null
          ? "장비 자동 분해를 해제했습니다."
          : `${GEAR_RARITY_META[normalized].label} 이하 자동 분해 활성화 · 새 장비만 변환 · 전설 이상 보호`,
      );
    },
    [selection],
  );

  const performPlazaEnhancement = useCallback(
    (itemId: string) => {
      const snapshot = readPlazaEquipmentSnapshot();
      if (!snapshot) return;
      const location = findPlazaGear(snapshot, itemId);
      if (!location) {
        setPlazaInventoryNotice("강화할 장비를 찾을 수 없습니다.");
        setSelectedGearId(null);
        return;
      }
      const { item, inventoryIndex, equippedSlot } = location;
      const rule = getGearEnhancementRule(item);
      if (!rule) {
        setPlazaInventoryNotice(
          `${formatGearDisplayName(item)}은 이미 최대 +10 강화입니다.`,
        );
        return;
      }
      if (snapshot.memoryAsh < rule.ashCost) {
        setPlazaInventoryNotice(
          `기억의 재가 ${(rule.ashCost - snapshot.memoryAsh).toLocaleString("ko-KR")}개 부족합니다.`,
        );
        return;
      }

      snapshot.memoryAsh -= rule.ashCost;
      const roll = Math.random() * 100;
      let nextSelectedGearId: string | null = item.id;
      let message: string;
      if (roll < rule.successPercent) {
        const enhancementResult = applySuccessfulGearEnhancement(
          item,
          Math.random(),
        );
        if (!enhancementResult) {
          snapshot.memoryAsh += rule.ashCost;
          setPlazaInventoryNotice(
            "강화 배분 정보를 확인할 수 없어 시도를 취소했습니다.",
          );
          return;
        }
        const enhancedItem = enhancementResult.item;
        if (inventoryIndex >= 0) snapshot.inventory[inventoryIndex] = enhancedItem;
        else if (equippedSlot) snapshot.equipment[equippedSlot] = enhancedItem;
        message = `강화 성공 · ${formatGearDisplayName(enhancedItem)} · ${enhancementResult.optionLabel} ${enhancementResult.gainLabel} · 광장 기록에 저장했습니다.`;
      } else if (roll < rule.successPercent + rule.destroyPercent) {
        if (inventoryIndex >= 0) snapshot.inventory.splice(inventoryIndex, 1);
        else if (equippedSlot) snapshot.equipment[equippedSlot] = null;
        nextSelectedGearId = null;
        message = `강화 파괴 · ${formatGearDisplayName(item)}이 기억의 재로 흩어졌습니다.`;
      } else {
        message = `강화 실패 · ${formatGearDisplayName(item)} 유지 · 기억의 재 ${rule.ashCost.toLocaleString("ko-KR")}개 소모`;
      }

      if (commitPlazaEquipment(snapshot, message)) {
        setSelectedGearId(nextSelectedGearId);
      }
    },
    [commitPlazaEquipment, readPlazaEquipmentSnapshot],
  );

  const enhancePlazaGear = useCallback(
    (itemId: string) => {
      const snapshot = readPlazaEquipmentSnapshot();
      if (!snapshot) return;
      const location = findPlazaGear(snapshot, itemId);
      if (!location) return;
      const rule = getGearEnhancementRule(location.item);
      if (!rule) {
        setPlazaInventoryNotice(
          `${formatGearDisplayName(location.item)}은 이미 최대 +10 강화입니다.`,
        );
        return;
      }
      if (snapshot.memoryAsh < rule.ashCost) {
        setPlazaInventoryNotice(
          `기억의 재가 ${(rule.ashCost - snapshot.memoryAsh).toLocaleString("ko-KR")}개 부족합니다.`,
        );
        return;
      }
      if (rule.destroyPercent <= 0) {
        performPlazaEnhancement(itemId);
        return;
      }

      setPlazaEnhancementConfirmation({
        itemId,
        title: `${formatGearDisplayName(location.item)} → +${rule.target}`,
        body: `성공하면 기본 옵션 포함 ${location.item.affixes.length + 1}개 중 하나가 무작위로 상승하며 같은 옵션이 중복 당첨될 수 있습니다. 성공 ${rule.successPercent}% · 실패 시 유지 ${rule.failurePercent}% · 파괴 ${rule.destroyPercent}%입니다. 기억의 재 ${rule.ashCost.toLocaleString("ko-KR")}개를 사용해 강화를 시도할까요?`,
      });
    },
    [performPlazaEnhancement, readPlazaEquipmentSnapshot],
  );

  const rerollPlazaDivineForge = useCallback(
    (itemId: string, materialIds: readonly string[]): DivineForgeResult | null => {
      const snapshot = readPlazaEquipmentSnapshot();
      if (!snapshot) return null;
      const transaction = applyDivineForgeTransaction({
        inventory: snapshot.inventory,
        equipment: snapshot.equipment,
        memoryAsh: snapshot.memoryAsh,
        targetId: itemId,
        materialIds,
        seed: `${itemId}:${Date.now()}:${Math.random()}`,
      });
      if (!transaction.ok) {
        setPlazaInventoryNotice(divineForgeFailureMessage(transaction.code));
        return null;
      }

      snapshot.inventory = transaction.inventory;
      snapshot.equipment = transaction.equipment;
      snapshot.memoryAsh = transaction.memoryAsh;
      if (
        !commitPlazaEquipment(
          snapshot,
          `신의 대장간 재련 완료 · ${formatGearDisplayName(transaction.result.after)} · ${transaction.result.after.divineForgeRerolls}/3회`,
        )
      ) {
        return null;
      }
      setSelectedGearId(transaction.result.after.id);
      return transaction.result;
    },
    [commitPlazaEquipment, readPlazaEquipmentSnapshot],
  );

  useEffect(() => {
    if (!selection || view !== "plaza") return undefined;

    const handlePlazaInventoryKey = (event: KeyboardEvent) => {
      if (event.repeat) return;
      const key = event.key.toLowerCase();
      if (plazaEnhancementConfirmation) {
        if (key === "escape") {
          event.preventDefault();
          setPlazaEnhancementConfirmation(null);
        }
        return;
      }
      if (shopOpen || profileState !== null) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, select, textarea, [contenteditable='true']")) {
        return;
      }

      if (key === "i") {
        event.preventDefault();
        if (!inventoryOpen) setPlazaInventoryNotice(null);
        setInventoryOpen(!inventoryOpen);
        return;
      }
      if (key === "escape" && inventoryOpen) {
        event.preventDefault();
        setInventoryOpen(false);
        setSelectedGearId(null);
        setPlazaInventoryNotice(null);
      }
    };

    window.addEventListener("keydown", handlePlazaInventoryKey);
    return () => window.removeEventListener("keydown", handlePlazaInventoryKey);
  }, [
    inventoryOpen,
    plazaEnhancementConfirmation,
    profileState,
    selection,
    shopOpen,
    view,
  ]);

  const returnToCharacterSelect = useCallback(() => {
    setShopOpen(false);
    setInventoryOpen(false);
    setPlazaInventoryNotice(null);
    setPlazaEnhancementConfirmation(null);
    setProfileState(null);
    profileRequestIdRef.current += 1;
    lastInspectedPlayerRef.current = null;
    setSelectedGearId(null);
    setHubSnapshot(null);
    plazaSaveSnapshotRef.current = null;
    setSelection(null);
    setView("plaza");
    setArrival("center");
  }, []);

  if (!localVfxShowcaseChecked) {
    return (
      <div
        className="game-entry-flow"
        data-entry-view="local-vfx-showcase-checking"
        aria-hidden="true"
      />
    );
  }

  if (localEnemyVfxShowcase || localLootVfxShowcase || localEndingUiShowcase) {
    return (
      <div
        className="game-entry-flow"
        data-entry-view={
          localEnemyVfxShowcase
            ? "local-enemy-vfx-showcase"
            : localLootVfxShowcase
              ? "local-loot-vfx-showcase"
              : "local-ending-ui-showcase"
        }
      >
        <GameCanvas
          localEnemyVfxShowcase={localEnemyVfxShowcase ?? undefined}
          localLootVfxShowcase={localLootVfxShowcase ?? undefined}
          localEndingUiShowcase={localEndingUiShowcase}
        />
      </div>
    );
  }

  if (localPlazaMotionShowcase) {
    return (
      <div
        className="game-entry-flow"
        data-entry-view="local-plaza-motion-showcase"
      >
        <PlazaHub
          character={{
            characterId: "local-plaza-motion-showcase",
            displayName: "GROUND QA",
            level: 99,
            dungeonFloor: 99,
            saveSlot: 1,
            appearance: LOCAL_PLAZA_SKILL_SHOWCASE_APPEARANCE,
          }}
          equipment={LOCAL_PLAZA_SKILL_SHOWCASE_EQUIPMENT}
          connectionState="offline"
        />
      </div>
    );
  }

  if (selection === null) {
    return (
      <CharacterEntryGate
        accountName={accountName}
        nicknameRejection={nicknameRejection}
        onNicknameRejectionHandled={() => setNicknameRejection(null)}
        onEnter={enterCharacter}
      />
    );
  }

  if (view === "expedition") {
    return (
      <div
        className="game-entry-flow"
        data-entry-save-slot={selection.slot}
        data-entry-save-state={selection.occupied ? "occupied" : "empty"}
        data-entry-view="expedition"
      >
        <GameCanvas
          initialSaveSlot={selection.slot}
          onReturnToPlaza={() => {
            plazaSaveSnapshotRef.current = readSaveSlot(selection.slot);
            setArrival("expedition");
            setSaveRevision((revision) => revision + 1);
            setView("plaza");
          }}
        />
      </div>
    );
  }

  const self = hubSnapshot?.self;
  const inspectSelfCharacter = () => {
    profileRequestIdRef.current += 1;
    lastInspectedPlayerRef.current = null;
    setProfileState({
      profile: {
        characterId: self?.characterId ?? `local-character-slot-${selection.slot}`,
        displayName: self?.displayName ?? displayName,
        level: self?.level ?? level,
        dungeonFloor: self?.dungeonFloor ?? dungeonFloor,
        publicEquipment,
        updatedAt: self?.updatedAt ?? Date.now(),
      },
      loading: false,
      error: null,
    });
  };
  return (
    <div
      className="game-entry-flow"
      data-entry-save-slot={selection.slot}
      data-entry-save-state={selection.occupied ? "occupied" : "empty"}
      data-entry-view="plaza"
    >
      <PlazaHub
        character={{
          characterId: self?.characterId ?? `local-character-slot-${selection.slot}`,
          displayName: self?.displayName ?? displayName,
          level: self?.level ?? level,
          dungeonFloor: self?.dungeonFloor ?? dungeonFloor,
          saveSlot: selection.slot,
          appearance: {
            spriteKey: hubAppearance.spriteKey,
            equipped: hubAppearance.spriteKey === "harin-equipped",
            palette: hubAppearance.palette,
            gear: hubAppearance.gear,
            rarities: hubAppearance.rarities,
          },
        }}
        equipment={equipment}
        remotePlayers={hubSnapshot?.nearbyPlayers ?? []}
        onlineCount={hubSnapshot?.online ?? 1}
        localAuthoritativePosition={self ? { x: self.x, y: self.y } : null}
        localAuthoritativeMoving={self?.moving ?? false}
        connectionState={connectionForPlaza(hubConnection)}
        paused={shopOpen || inventoryOpen || profileState !== null}
        onMoveIntent={moveInPlaza}
        onDashIntent={dashInPlaza}
        onPortalActivate={activatePortal}
        onPlayerInspect={inspectRemoteCharacter}
        onSelfInspect={inspectSelfCharacter}
        onInventoryOpen={openInventory}
        onExitToCharacterSelect={returnToCharacterSelect}
      />
      {profileState && (
        <PlazaCharacterProfile
          open
          profile={profileState.profile}
          loading={profileState.loading}
          error={profileState.error}
          onClose={closeCharacterProfile}
          onRetry={profileState.error ? retryRemoteCharacterProfile : undefined}
        />
      )}
      {inventoryOpen && (
        <InventoryOverlay
          open
          equipment={equipment}
          inventory={inventory}
          inventoryCapacity={inventoryCapacity}
          playerLevel={level}
          memoryAsh={memoryAsh}
          equippedPower={equippedPower}
          selectedGearId={selectedGearId}
          autoSalvageMaxRarity={autoSalvageMaxRarity}
          operationNotice={plazaInventoryNotice}
          onClose={() => {
            setInventoryOpen(false);
            setSelectedGearId(null);
            setPlazaInventoryNotice(null);
            setPlazaEnhancementConfirmation(null);
          }}
          onSelect={setSelectedGearId}
          onOpenShop={openShopFromInventory}
          onEquip={equipPlazaGear}
          onUnequip={unequipPlazaGear}
          onSalvage={salvagePlazaGear}
          onSalvageMany={salvageManyPlazaGear}
          onAutoSalvageMaxRarityChange={changePlazaAutoSalvage}
          onEnhance={enhancePlazaGear}
          onDivineForgeReroll={rerollPlazaDivineForge}
        />
      )}
      {plazaEnhancementConfirmation && (
        <div
          className="game-confirmation-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setPlazaEnhancementConfirmation(null);
            }
          }}
        >
          <section
            className="game-confirmation-dialog is-danger"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="plaza-enhancement-confirmation-title"
            aria-describedby="plaza-enhancement-confirmation-body"
          >
            <span className="game-confirmation-sigil" aria-hidden="true">⌁</span>
            <small>FORGE WARNING</small>
            <h2 id="plaza-enhancement-confirmation-title">
              {plazaEnhancementConfirmation.title}
            </h2>
            <p id="plaza-enhancement-confirmation-body">
              {plazaEnhancementConfirmation.body}
            </p>
            <div className="game-confirmation-actions">
              <button
                type="button"
                onClick={() => setPlazaEnhancementConfirmation(null)}
                autoFocus
              >
                취소
              </button>
              <button
                type="button"
                className="is-confirm"
                onClick={() => {
                  const itemId = plazaEnhancementConfirmation.itemId;
                  setPlazaEnhancementConfirmation(null);
                  performPlazaEnhancement(itemId);
                }}
              >
                강화 시도
              </button>
            </div>
            <span className="game-confirmation-hint">ESC 취소</span>
          </section>
        </div>
      )}
      {shopOpen && (
        <TownCaravanOverlay
          open
          inventoryCount={inventoryCount}
          onClose={() => {
            setInventoryCapacity(inventoryCapacityFor(readShopEntitlements()));
            setShopOpen(false);
          }}
          onOpenMarket={openMarketFromCaravan}
        />
      )}
    </div>
  );
}
