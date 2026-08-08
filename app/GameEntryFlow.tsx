"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import CharacterEntryGate, {
  type CharacterEntrySelection,
} from "./CharacterEntryGate";
import GameCanvas from "./GameCanvas";
import InventoryOverlay from "./InventoryOverlay";
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
  type HubAppearance,
  type HubArrival,
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
const TOWN_RETURN_SESSION_KEY = "mujindo:town-return-slot:v1";

const connectionForPlaza = (
  state: HubConnectionState,
): "offline" | "connecting" | "online" | "reconnecting" =>
  state === "idle" ? "offline" : state;

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
  const [saveRevision, setSaveRevision] = useState(0);

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
      arrival,
    });
    return () => {
      unsubscribe();
      client.leave();
      setHubSnapshot(null);
      setHubConnection("offline");
    };
  }, [arrival, displayName, dungeonFloor, hubAppearance, level, selection, view]);

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
    if (shopOpen) return;
    setInventoryCapacity(inventoryCapacityFor(readShopEntitlements()));
    setInventoryOpen(true);
  }, [shopOpen]);

  const openShopFromInventory = useCallback(() => {
    setInventoryOpen(false);
    setSelectedGearId(null);
    setShopOpen(true);
  }, []);

  useEffect(() => {
    if (!selection || view !== "plaza") return undefined;

    const handlePlazaInventoryKey = (event: KeyboardEvent) => {
      if (event.repeat || shopOpen) return;
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
  }, [inventoryOpen, selection, shopOpen, view]);

  const returnToCharacterSelect = useCallback(() => {
    setShopOpen(false);
    setInventoryOpen(false);
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
          },
        }}
        remotePlayers={hubSnapshot?.nearbyPlayers ?? []}
        onlineCount={hubSnapshot?.online ?? 1}
        localAuthoritativePosition={self ? { x: self.x, y: self.y } : null}
        connectionState={connectionForPlaza(hubConnection)}
        paused={shopOpen || inventoryOpen}
        onMoveIntent={moveInPlaza}
        onPortalActivate={activatePortal}
        onInventoryOpen={openInventory}
        onExitToCharacterSelect={returnToCharacterSelect}
      />
      {inventoryOpen && (
        <InventoryOverlay
          open
          readOnly
          equipment={equipment}
          inventory={inventory}
          inventoryCapacity={inventoryCapacity}
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
