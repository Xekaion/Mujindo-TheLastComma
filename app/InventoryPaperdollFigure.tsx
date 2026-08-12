import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  EQUIPMENT_SLOT_LABELS,
  EQUIPMENT_SLOTS,
  GEAR_RARITIES,
  type EquipmentLoadout,
  type GearRarity,
} from "./equipment";
import {
  PAPERDOLL_BODY_PATH,
  PAPERDOLL_FRAME_HEIGHT,
  PAPERDOLL_FRAME_WIDTH,
  createPaperdollEquipmentSignature,
  drawPaperdollCharacter,
  isPaperdollBodyAtlasReady,
  isPaperdollLayerAtlasReady,
  paperdollLayerPathsForLoadout,
  paperdollLoadoutFromEquipment,
} from "./character-paperdoll";
import {
  EQUIPPED_RARITY_VFX_PATHS,
  drawEquippedRarityVfx,
  resolveEquippedRarityVfxPlan,
  type EquippedRarityVfxImageMap,
  type EquippedRarityVfxTier,
} from "./equipped-rarity-vfx";
import { createBrowserPaperdollImageStore } from "./paperdoll-image-store";

export type InventoryPaperdollFigureProps = Readonly<{
  equipment: EquipmentLoadout;
}>;

const PORTRAIT_DIRECTION = 0;
const PORTRAIT_IDLE_FRAME = 1;
const PORTRAIT_LOAD_POLL_MS = 40;
const PORTRAIT_LOAD_POLL_MAX_MS = 1_000;
const PORTRAIT_LOAD_TIMEOUT_MS = 36_000;
const PORTRAIT_RARITY_VFX_FRAME_MS = 1_000 / 11;
const MAX_PORTRAIT_DPR = 2;

function arePortraitSourcesReady(
  imageStore: ReturnType<typeof createBrowserPaperdollImageStore>,
  layerPaths: readonly string[],
) {
  const bodyAtlas = imageStore.get(PAPERDOLL_BODY_PATH);
  if (!isPaperdollBodyAtlasReady(bodyAtlas)) return false;
  return layerPaths.every((path) =>
    isPaperdollLayerAtlasReady(imageStore.get(path)),
  );
}

function strongestEquippedRarity(equipment: EquipmentLoadout): GearRarity {
  let rarity: GearRarity = "common";
  let rarityIndex = 0;
  for (const slot of EQUIPMENT_SLOTS) {
    const item = equipment[slot];
    if (!item) continue;
    const itemIndex = GEAR_RARITIES.indexOf(item.rarity);
    if (itemIndex > rarityIndex) {
      rarity = item.rarity;
      rarityIndex = itemIndex;
    }
  }
  return rarity;
}

function equippedAppearanceLabel(equipment: EquipmentLoadout): string {
  const equippedSlots = EQUIPMENT_SLOTS.filter((slot) => equipment[slot]);
  if (equippedSlots.length === 0) return "장비를 착용하지 않은 현재 캐릭터 전신 외형";
  return `현재 캐릭터 전신 외형. ${equippedSlots
    .map((slot) => EQUIPMENT_SLOT_LABELS[slot])
    .join(", ")} 장착 반영`;
}

/**
 * Inventory-only portrait viewport for the canonical ten-slot paperdoll.
 *
 * The same registered body and wearable atlases used in combat are sampled at
 * their exact coordinates. The wide 4:3 source cell is deliberately rendered
 * through a narrow portrait viewport: only transparent side gutters are
 * clipped, while even the widest weapon/offhand silhouettes remain inside the
 * safe center column.
 */
export default function InventoryPaperdollFigure({
  equipment,
}: InventoryPaperdollFigureProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageStoreRef = useRef<ReturnType<
    typeof createBrowserPaperdollImageStore
  > | null>(null);
  const hasRenderedRef = useRef(false);
  const [hasRendered, setHasRendered] = useState(false);

  if (imageStoreRef.current === null) {
    imageStoreRef.current = createBrowserPaperdollImageStore();
  }

  const equipmentSignature = createPaperdollEquipmentSignature(equipment);
  const loadout = useMemo(
    () => paperdollLoadoutFromEquipment(equipment),
    // The HUD clones equipment for safe React snapshots. Its object identity
    // can therefore change while the ten visual fields remain identical.
    // The canonical signature is the actual portrait invalidation boundary.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [equipmentSignature],
  );
  const layerPaths = useMemo(
    () => paperdollLayerPathsForLoadout(loadout),
    [loadout],
  );
  const rarityVfxPlan = useMemo(
    () => resolveEquippedRarityVfxPlan(loadout),
    [loadout],
  );
  const portraitRarity = useMemo(
    () => strongestEquippedRarity(equipment),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [equipmentSignature],
  );
  const portraitLabel = useMemo(
    () => equippedAppearanceLabel(equipment),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [equipmentSignature],
  );

  useEffect(() => {
    const imageStore = imageStoreRef.current;
    return () => imageStore?.clear();
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    const imageStore = imageStoreRef.current;
    if (!host || !canvas || !imageStore) return undefined;

    let cancelled = false;
    let pollTimer: number | undefined;
    let pulseTimer: number | undefined;
    let animationFrame: number | undefined;
    let lastAnimationDrawAt = 0;
    let didTriggerSwapPulse = false;
    let reducedMotion = false;
    let pollDelay = PORTRAIT_LOAD_POLL_MS;
    const loadDeadline = Date.now() + PORTRAIT_LOAD_TIMEOUT_MS;
    const requiredPaths = [PAPERDOLL_BODY_PATH, ...layerPaths];
    const rarityVfxImages: Partial<
      Record<EquippedRarityVfxTier, HTMLImageElement>
    > = {};
    const rarityVfxImageList: HTMLImageElement[] = [];
    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    reducedMotion = motionQuery.matches;
    imageStore.reconcile(requiredPaths);

    const drawLoadedPortrait = (timeMs = performance.now()) => {
      if (cancelled) return false;
      if (!arePortraitSourcesReady(imageStore, layerPaths)) return false;
      const bodyAtlas = imageStore.get(PAPERDOLL_BODY_PATH)!;

      const bounds = host.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return false;
      const dpr = Math.min(
        MAX_PORTRAIT_DPR,
        Math.max(1, window.devicePixelRatio || 1),
      );
      const pixelWidth = Math.max(1, Math.round(bounds.width * dpr));
      const pixelHeight = Math.max(1, Math.round(bounds.height * dpr));
      if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
      if (canvas.height !== pixelHeight) canvas.height = pixelHeight;

      const context = canvas.getContext("2d");
      if (!context) return false;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, bounds.width, bounds.height);

      // 1.2× the viewport width is the audited no-crop height for the widest
      // v2 weapon/relic silhouette; the panel height remains the other bound.
      const portraitHeight = Math.max(
        1,
        Math.min(bounds.height * 0.965, bounds.width * 1.2),
      );
      const portraitWidth =
        portraitHeight * (PAPERDOLL_FRAME_WIDTH / PAPERDOLL_FRAME_HEIGHT);
      const drawn = drawPaperdollCharacter(context, {
        bodyAtlas,
        layerSources: imageStore.imageMap(),
        loadout,
        direction: PORTRAIT_DIRECTION,
        frame: PORTRAIT_IDLE_FRAME,
        x: bounds.width / 2,
        y: bounds.height * 0.975,
        width: portraitWidth,
        height: portraitHeight,
      });
      if (!drawn) return false;

      drawEquippedRarityVfx(context, {
        plan: rarityVfxPlan,
        images: rarityVfxImages satisfies EquippedRarityVfxImageMap,
        direction: PORTRAIT_DIRECTION,
        frame: PORTRAIT_IDLE_FRAME,
        timeMs,
        x: bounds.width / 2,
        y: bounds.height * 0.975,
        width: portraitWidth,
        height: portraitHeight,
        context: "portrait",
        reducedMotion,
      });

      if (!hasRenderedRef.current) {
        hasRenderedRef.current = true;
        setHasRendered(true);
      }
      // Re-adding on the next frame gives every successful equipment swap one
      // restrained, visible pulse without continuously animating the canvas.
      if (!didTriggerSwapPulse) {
        didTriggerSwapPulse = true;
        host.classList.remove("is-swapping");
        window.requestAnimationFrame(() => {
          if (cancelled) return;
          host.classList.add("is-swapping");
          pulseTimer = window.setTimeout(() => {
            host.classList.remove("is-swapping");
          }, 520);
        });
      }
      return true;
    };

    const stopRarityVfxAnimation = () => {
      if (animationFrame === undefined) return;
      window.cancelAnimationFrame(animationFrame);
      animationFrame = undefined;
    };

    const animateRarityVfx = (timeMs: number) => {
      if (cancelled || reducedMotion || rarityVfxPlan.pieces.length === 0) {
        animationFrame = undefined;
        return;
      }
      if (timeMs - lastAnimationDrawAt >= PORTRAIT_RARITY_VFX_FRAME_MS) {
        lastAnimationDrawAt = timeMs;
        drawLoadedPortrait(timeMs);
      }
      animationFrame = window.requestAnimationFrame(animateRarityVfx);
    };

    const startRarityVfxAnimation = () => {
      if (
        cancelled ||
        reducedMotion ||
        rarityVfxPlan.pieces.length === 0 ||
        animationFrame !== undefined
      ) return;
      lastAnimationDrawAt = 0;
      animationFrame = window.requestAnimationFrame(animateRarityVfx);
    };

    const handleMotionPreference = (event: MediaQueryListEvent) => {
      reducedMotion = event.matches;
      if (reducedMotion) stopRarityVfxAnimation();
      else startRarityVfxAnimation();
      drawLoadedPortrait(performance.now());
    };

    motionQuery.addEventListener("change", handleMotionPreference);

    if (rarityVfxPlan.pieces.length > 0) {
      const requiredTiers = new Set(
        rarityVfxPlan.pieces.map((piece) => piece.tier),
      );
      for (const tier of requiredTiers) {
        const image = new Image();
        rarityVfxImages[tier] = image;
        rarityVfxImageList.push(image);
        image.decoding = "async";
        image.onload = () => {
          if (cancelled) return;
          drawLoadedPortrait(performance.now());
          startRarityVfxAnimation();
        };
        image.src = EQUIPPED_RARITY_VFX_PATHS[tier];
      }
    }

    const pollUntilReady = () => {
      if (cancelled || drawLoadedPortrait()) return;
      if (Date.now() >= loadDeadline) return;
      pollTimer = window.setTimeout(pollUntilReady, pollDelay);
      pollDelay = Math.min(PORTRAIT_LOAD_POLL_MAX_MS, pollDelay * 2);
    };
    pollUntilReady();

    const resizeObserver = new ResizeObserver(() => {
      if (hasRenderedRef.current) drawLoadedPortrait();
    });
    resizeObserver.observe(host);

    return () => {
      cancelled = true;
      stopRarityVfxAnimation();
      resizeObserver.disconnect();
      motionQuery.removeEventListener("change", handleMotionPreference);
      for (const image of rarityVfxImageList) {
        image.onload = null;
        image.onerror = null;
        image.removeAttribute("src");
      }
      if (pollTimer !== undefined) window.clearTimeout(pollTimer);
      if (pulseTimer !== undefined) window.clearTimeout(pulseTimer);
    };
  }, [equipmentSignature, layerPaths, loadout, rarityVfxPlan]);

  return (
    <div
      ref={hostRef}
      className={`inventory-screen-paperdoll-figure${hasRendered ? " is-ready" : ""}`}
      data-paperdoll-rarity={portraitRarity}
      role="img"
      aria-label={portraitLabel}
    >
      <canvas
        ref={canvasRef}
        className="inventory-screen-paperdoll-canvas"
        aria-hidden="true"
      />
    </div>
  );
}
