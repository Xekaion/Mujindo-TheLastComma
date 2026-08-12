"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import CharacterEntryGate, {
  type CharacterEntrySelection,
} from "./CharacterEntryGate";
import GameCanvas from "./GameCanvas";
import InventoryOverlay from "./InventoryOverlay";
import PlazaCharacterProfile from "./PlazaCharacterProfile";
import PlazaHub from "./PlazaHub";
import TownCaravanOverlay from "./TownCaravanOverlay";
import {
  calculateEquipmentCombatPower,
  normalizeEquipment,
  normalizeGearItem,
  type GearItem,
} from "./equipment";
import {
  getMemoryPlazaClient,
  type HubConnectionState,
} from "./hub-client";
import {
  HUB_PALETTES,
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
} from "./save-slots";
import { inventoryCapacityFor, readShopEntitlements } from "./shop";
import type { PlazaPortalDefinition } from "./plaza-world";

type GameEntryFlowProps = {
  accountName?: string | null;
  returnToTown?: boolean;
};

type EntryView = "plaza" | "expedition";
type PlazaProfileState = {
  profile: HubCharacterProfile | null;
  loading: boolean;
  error: string | null;
};
const TOWN_RETURN_SESSION_KEY = "mujindo:town-return-slot:v1";

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
}: GameEntryFlowProps) {
  const [selection, setSelection] = useState<CharacterEntrySelection | null>(null);
  const [view, setView] = useState<EntryView>("plaza");
  const [shopOpen, setShopOpen] = useState(false);
  const [inventoryOpen, setInventoryOpen] = useState(false);
  const [selectedGearId, setSelectedGearId] = useState<string | null>(null);
  const [inventoryCapacity, setInventoryCapacity] = useState(() =>
    inventoryCapacityFor(readShopEntitlements()),
  );
  const [arrival, setArrival] = useState<HubArrival>("center");
  const [hubConnection, setHubConnection] =
    useState<HubConnectionState>("idle");
  const [hubSnapshot, setHubSnapshot] = useState<HubSnapshot | null>(null);
  const [profileState, setProfileState] = useState<PlazaProfileState | null>(null);
  const [saveRevision, setSaveRevision] = useState(0);
  const profileRequestIdRef = useRef(0);
  const lastInspectedPlayerRef = useRef<HubPlayerSnapshot | null>(null);

  useEffect(() => {
    if (!returnToTown || selection !== null) return;
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
      setSelection({ slot, occupied: readSaveSlot(slot) !== null });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [returnToTown, selection]);

  const enterCharacter = useCallback((next: CharacterEntrySelection) => {
    setSelection(next);
    setView("plaza");
    setArrival("center");
    setShopOpen(false);
    setInventoryOpen(false);
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
    // Re-read after returning from an expedition so the plaza immediately
    // reflects newly saved levels and equipment.
    return readSaveSlot(selection.slot);
  }, [saveRevision, selection]);

  const equipment = useMemo(
    () => normalizeEquipment(savedCharacter?.player.equipment),
    [savedCharacter],
  );
  const inventory = useMemo(
    () =>
      Array.isArray(savedCharacter?.player.inventory)
        ? savedCharacter.player.inventory
            .map((item) => normalizeGearItem(item))
            .filter((item): item is GearItem => item !== null)
        : [],
    [savedCharacter],
  );
  const memoryAsh = Math.max(
    0,
    Math.floor(Number(savedCharacter?.player.memoryAsh) || 0),
  );
  const equippedPower = useMemo(
    () => calculateEquipmentCombatPower(equipment),
    [equipment],
  );
  const publicEquipment = useMemo(
    () => hubPublicEquipmentFromLoadout(equipment),
    [equipment],
  );

  const hubAppearance = useMemo<HubAppearance>(() => {
    const entries = Object.entries(equipment);
    const equipped = entries.some(([, item]) => item !== null);
    const gear = Object.fromEntries(
      entries.map(([slot, item]) => [
        slot,
        item ? Math.max(0, Math.min(9, Math.floor(item.iconIndex / 10))) : null,
      ]),
    ) as HubAppearance["gear"];
    const slotIndex = selection ? selection.slot - 1 : 0;
    return {
      spriteKey: equipped ? "harin-equipped" : "harin",
      palette: HUB_PALETTES[slotIndex] ?? "scarlet",
      gear,
    };
  }, [equipment, selection]);

  const level = savedCharacter?.player.level ?? 1;
  const dungeonFloor = normalizeDungeonFloor(
    savedCharacter?.world?.dungeonFloor,
  );
  const inventoryCount = inventory.length;
  const displayName = accountName?.trim() || "이름 없는 기록자";

  useEffect(() => {
    if (!selection || view !== "plaza") return;
    const client = getMemoryPlazaClient();
    const unsubscribe = client.subscribe((event) => {
      if (event.type === "connection") setHubConnection(event.state);
      if (event.type === "snapshot") setHubSnapshot(event.snapshot);
      if (event.type === "error" && !event.retryable) setHubConnection("offline");
    });
    void client.enter({
      characterSlot: selection.slot,
      displayName,
      level,
      dungeonFloor,
      appearance: hubAppearance,
      publicEquipment,
      arrival,
    });
    return () => {
      unsubscribe();
      client.leave();
      setHubSnapshot(null);
      setHubConnection("offline");
    };
  }, [arrival, displayName, dungeonFloor, hubAppearance, level, publicEquipment, selection, view]);

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
    setShopOpen(true);
  }, []);

  useEffect(() => {
    if (!selection || view !== "plaza") return undefined;

    const handlePlazaInventoryKey = (event: KeyboardEvent) => {
      if (event.repeat || shopOpen || profileState !== null) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, select, textarea, [contenteditable='true']")) {
        return;
      }

      const key = event.key.toLowerCase();
      if (key === "i") {
        event.preventDefault();
        setInventoryOpen((current) => !current);
        return;
      }
      if (key === "escape" && inventoryOpen) {
        event.preventDefault();
        setInventoryOpen(false);
        setSelectedGearId(null);
      }
    };

    window.addEventListener("keydown", handlePlazaInventoryKey);
    return () => window.removeEventListener("keydown", handlePlazaInventoryKey);
  }, [inventoryOpen, profileState, selection, shopOpen, view]);

  const returnToCharacterSelect = useCallback(() => {
    setShopOpen(false);
    setInventoryOpen(false);
    setProfileState(null);
    profileRequestIdRef.current += 1;
    lastInspectedPlayerRef.current = null;
    setSelectedGearId(null);
    setHubSnapshot(null);
    setSelection(null);
    setView("plaza");
    setArrival("center");
  }, []);

  if (selection === null) {
    return <CharacterEntryGate accountName={accountName} onEnter={enterCharacter} />;
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
            spriteKey: self?.appearance.spriteKey ?? hubAppearance.spriteKey,
            equipped: hubAppearance.spriteKey === "harin-equipped",
            palette: self?.appearance.palette ?? hubAppearance.palette,
            gear: self?.appearance.gear ?? hubAppearance.gear,
          },
        }}
        remotePlayers={hubSnapshot?.nearbyPlayers ?? []}
        onlineCount={hubSnapshot?.online ?? 1}
        localAuthoritativePosition={self ? { x: self.x, y: self.y } : null}
        connectionState={connectionForPlaza(hubConnection)}
        paused={shopOpen || inventoryOpen || profileState !== null}
        onMoveIntent={moveInPlaza}
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
          readOnly
          equipment={equipment}
          inventory={inventory}
          inventoryCapacity={inventoryCapacity}
          playerLevel={level}
          memoryAsh={memoryAsh}
          equippedPower={equippedPower}
          selectedGearId={selectedGearId}
          autoSalvageMaxRarity={null}
          onClose={() => {
            setInventoryOpen(false);
            setSelectedGearId(null);
          }}
          onSelect={setSelectedGearId}
          onOpenShop={openShopFromInventory}
          onEquip={() => undefined}
          onUnequip={() => undefined}
          onSalvage={() => undefined}
          onSalvageMany={() => undefined}
          onAutoSalvageMaxRarityChange={() => undefined}
          onEnhance={() => undefined}
        />
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
