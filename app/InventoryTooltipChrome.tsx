"use client";

import { useEffect, useRef } from "react";
import type { GearRarity } from "./equipment";

const FRAME_ATLAS_URL = "/assets/ui/rarity-frames-v6.png";
const FRAME_COUNT = 8;

const RARITY_INDEX: Record<GearRarity, number> = {
  common: 0,
  magic: 1,
  superior: 2,
  rare: 3,
  epic: 4,
  legendary: 5,
  mythic: 6,
  cosmic: 7,
};

const AURA_ATLAS_URLS: Partial<Record<GearRarity, string>> = {
  rare: "/assets/ui/inventory-rarity-aura-rare-v3.png",
  epic: "/assets/ui/inventory-rarity-aura-epic-v3.png",
  legendary: "/assets/ui/inventory-rarity-aura-legendary-v3.png",
  mythic: "/assets/ui/inventory-rarity-aura-mythic-v3.png",
  cosmic: "/assets/ui/inventory-rarity-aura-cosmic-v3.png",
};

const AURA_LOOP_MS: Partial<Record<GearRarity, number>> = {
  rare: 2_800,
  epic: 1_550,
  legendary: 780,
  mythic: 680,
  cosmic: 620,
};

type FrameLayout = {
  cell: number;
  part: number;
  railOffset: number;
  railSpan: number;
  scale: number;
};

type DrawRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

const STATIC_LAYOUT: FrameLayout = {
  cell: 320,
  part: 112,
  railOffset: 80,
  railSpan: 24,
  scale: 0.42,
};

const AURA_LAYOUT: FrameLayout = {
  cell: 384,
  part: 144,
  railOffset: 88,
  railSpan: 32,
  scale: 0.42,
};

const imageCache = new Map<string, Promise<HTMLImageElement>>();

function loadImage(url: string) {
  const cached = imageCache.get(url);
  if (cached) return cached;

  const promise = new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Failed to load inventory tooltip chrome: ${url}`));
    image.src = url;
  });
  imageCache.set(url, promise);
  return promise;
}

function drawPart(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  sourceX: number,
  sourceY: number,
  sourceSize: number,
  targetX: number,
  targetY: number,
  targetSize: number,
) {
  context.drawImage(
    image,
    sourceX,
    sourceY,
    sourceSize,
    sourceSize,
    targetX,
    targetY,
    targetSize,
    targetSize,
  );
}

function drawTiledHorizontal(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  sourceX: number,
  sourceY: number,
  sourceWidth: number,
  sourceHeight: number,
  targetStart: number,
  targetEnd: number,
  targetY: number,
  scale: number,
) {
  const tileWidth = sourceWidth * scale;
  const tileHeight = sourceHeight * scale;
  for (let x = targetStart; x < targetEnd - 0.01; x += tileWidth) {
    const width = Math.min(tileWidth, targetEnd - x);
    context.drawImage(
      image,
      sourceX,
      sourceY,
      sourceWidth * (width / tileWidth),
      sourceHeight,
      x,
      targetY,
      width,
      tileHeight,
    );
  }
}

function drawTiledVertical(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  sourceX: number,
  sourceY: number,
  sourceWidth: number,
  sourceHeight: number,
  targetX: number,
  targetStart: number,
  targetEnd: number,
  scale: number,
) {
  const tileWidth = sourceWidth * scale;
  const tileHeight = sourceHeight * scale;
  for (let y = targetStart; y < targetEnd - 0.01; y += tileHeight) {
    const height = Math.min(tileHeight, targetEnd - y);
    context.drawImage(
      image,
      sourceX,
      sourceY,
      sourceWidth,
      sourceHeight * (height / tileHeight),
      targetX,
      y,
      tileWidth,
      height,
    );
  }
}

/**
 * Rebuild a variable-size panel from fixed-size authored frame cells.
 * Corners and four cardinal crests are never stretched. Only short, crest-free
 * rail samples are repeated between them, so tall tooltips retain the exact
 * ornament proportions of the square inventory art.
 */
function drawPanelChrome(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  sourceCellX: number,
  sourceCellY: number,
  target: DrawRect,
  layout: FrameLayout,
) {
  const { cell, part, railOffset, railSpan, scale } = layout;
  const sourceFar = cell - part;
  const sourceCenter = (cell - part) / 2;
  const targetPart = part * scale;
  const targetFarX = target.x + target.width - targetPart;
  const targetFarY = target.y + target.height - targetPart;
  const targetCenterX = target.x + (target.width - targetPart) / 2;
  const targetCenterY = target.y + (target.height - targetPart) / 2;
  const railInset = targetPart * 0.62;

  // Rail fragments are repeated at their native aspect ratio. The fixed
  // corners and cardinal crests drawn below conceal every tile junction.
  drawTiledHorizontal(
    context,
    image,
    sourceCellX + railOffset,
    sourceCellY,
    railSpan,
    part,
    target.x + railInset,
    target.x + target.width - railInset,
    target.y,
    scale,
  );
  drawTiledHorizontal(
    context,
    image,
    sourceCellX + railOffset,
    sourceCellY + sourceFar,
    railSpan,
    part,
    target.x + railInset,
    target.x + target.width - railInset,
    targetFarY,
    scale,
  );
  drawTiledVertical(
    context,
    image,
    sourceCellX,
    sourceCellY + railOffset,
    part,
    railSpan,
    target.x,
    target.y + railInset,
    target.y + target.height - railInset,
    scale,
  );
  drawTiledVertical(
    context,
    image,
    sourceCellX + sourceFar,
    sourceCellY + railOffset,
    part,
    railSpan,
    targetFarX,
    target.y + railInset,
    target.y + target.height - railInset,
    scale,
  );

  const fixedParts = [
    [0, 0, target.x, target.y],
    [sourceCenter, 0, targetCenterX, target.y],
    [sourceFar, 0, targetFarX, target.y],
    [sourceFar, sourceCenter, targetFarX, targetCenterY],
    [sourceFar, sourceFar, targetFarX, targetFarY],
    [sourceCenter, sourceFar, targetCenterX, targetFarY],
    [0, sourceFar, target.x, targetFarY],
    [0, sourceCenter, target.x, targetCenterY],
  ] as const;

  for (const [partX, partY, targetX, targetY] of fixedParts) {
    drawPart(
      context,
      image,
      sourceCellX + partX,
      sourceCellY + partY,
      part,
      targetX,
      targetY,
      targetPart,
    );
  }
}

function resizeCanvas(canvas: HTMLCanvasElement) {
  const cssWidth = canvas.clientWidth;
  const cssHeight = canvas.clientHeight;
  const rect = canvas.getBoundingClientRect();
  const displayScale = cssWidth > 0 ? rect.width / cssWidth : 1;
  const pixelRatio = Math.min(2, Math.max(1, window.devicePixelRatio * displayScale));
  const width = Math.max(1, Math.round(cssWidth * pixelRatio));
  const height = Math.max(1, Math.round(cssHeight * pixelRatio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  return { cssWidth, cssHeight, pixelRatio };
}

export default function InventoryTooltipChrome({ rarity }: { rarity: GearRarity }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const context = canvas.getContext("2d", { alpha: true });
    if (!context) return;

    const auraUrl = AURA_ATLAS_URLS[rarity];
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let cancelled = false;
    let timer: number | undefined;
    let auraFrame = 0;
    let frameImage: HTMLImageElement | null = null;
    let auraImage: HTMLImageElement | null = null;

    const render = () => {
      if (cancelled || !frameImage) return;
      const { cssWidth, cssHeight, pixelRatio } = resizeCanvas(canvas);
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      context.clearRect(0, 0, cssWidth, cssHeight);
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";

      if (auraImage) {
        const auraColumn = auraFrame % 4;
        const auraRow = Math.floor(auraFrame / 4);
        context.save();
        context.globalAlpha = 0.92;
        context.globalCompositeOperation = "screen";
        drawPanelChrome(
          context,
          auraImage,
          auraColumn * AURA_LAYOUT.cell,
          auraRow * AURA_LAYOUT.cell,
          { x: 0, y: 0, width: cssWidth, height: cssHeight },
          AURA_LAYOUT,
        );
        context.restore();
      }

      drawPanelChrome(
        context,
        frameImage,
        RARITY_INDEX[rarity] * STATIC_LAYOUT.cell,
        0,
        { x: 12, y: 12, width: cssWidth - 24, height: cssHeight - 24 },
        STATIC_LAYOUT,
      );
    };

    const scheduleAuraFrame = () => {
      window.clearTimeout(timer);
      if (!auraImage || reducedMotion.matches || cancelled) return;
      const frameDuration = (AURA_LOOP_MS[rarity] ?? 2_800) / FRAME_COUNT;
      timer = window.setTimeout(() => {
        if (!document.hidden) {
          auraFrame = (auraFrame + 1) % FRAME_COUNT;
          render();
        }
        scheduleAuraFrame();
      }, frameDuration);
    };

    const handleMotionChange = () => {
      auraFrame = 0;
      render();
      scheduleAuraFrame();
    };

    const resizeObserver = new ResizeObserver(render);
    resizeObserver.observe(canvas);
    reducedMotion.addEventListener("change", handleMotionChange);

    const auraPromise = auraUrl
      ? loadImage(auraUrl).catch(() => null)
      : Promise.resolve(null);

    Promise.all([loadImage(FRAME_ATLAS_URL), auraPromise]).then(([loadedFrame, loadedAura]) => {
      if (cancelled) return;
      frameImage = loadedFrame;
      auraImage = loadedAura;
      render();
      scheduleAuraFrame();
    }).catch(() => {
      // The tooltip remains fully usable if a decorative raster cannot load.
    });

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      resizeObserver.disconnect();
      reducedMotion.removeEventListener("change", handleMotionChange);
    };
  }, [rarity]);

  return (
    <canvas
      ref={canvasRef}
      className={`inventory-screen-tooltip-chrome inventory-screen-tooltip-chrome--${rarity}`}
      data-frame-layout="fixed-corners-tiled-rails-cardinal-crests"
      aria-hidden="true"
    />
  );
}
