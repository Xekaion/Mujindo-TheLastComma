"use client";

import { useEffect, useRef, useState } from "react";
import {
  ROOM_DOOR_SIDES,
  ROOM_DOOR_VISUALS,
  mirroredRoomDoorSide,
  roomDoorAtlasSourceRect,
  roomDoorCanvasRect,
  type RoomDoorBackdropKey,
  type RoomDoorSide,
} from "./room-door-visuals";
import {
  advanceRoomDoorMotion,
  beginRoomDoorOpening,
  createRoomDoorMotion,
  roomDoorFrame,
  type RoomDoorMotion,
  type RoomDoorPhase,
} from "./room-doors";
import {
  ROOM_ART_PATHS,
  ROOM_STAIR_ART_PATHS,
  resolveStairRoomArtKey,
  type RoomArtKey,
} from "./room-visuals";
import {
  ROOM_DOOR_SHOWCASE_ROOMS,
  type RoomDoorShowcaseRequest,
} from "./room-door-showcase";
import styles from "./RoomDoorShowcase.module.css";

const CANVAS_WIDTH = 1280;
const CANVAS_HEIGHT = 720;
const CLOSED_HOLD_SECONDS = 0.72;
const OPEN_HOLD_SECONDS = 0.9;
const SHOWCASE_RENDER_ORDER: readonly RoomDoorSide[] = [
  ...ROOM_DOOR_SIDES.filter((side) => side !== "south"),
  "south",
];

type LoadedAssets = Readonly<{
  backplate: HTMLImageElement;
  doors: HTMLImageElement;
}>;

type AnimationSnapshot = Readonly<{
  frame: number;
  phase: RoomDoorPhase | "fixed";
}>;

const loadImage = (source: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = async () => {
      try {
        await image.decode();
      } catch {
        // A loaded image remains drawable where decode() is unavailable.
      }
      if (image.naturalWidth && image.naturalHeight) resolve(image);
      else reject(new Error(`empty image: ${source}`));
    };
    image.onerror = () => reject(new Error(`failed image: ${source}`));
    image.src = source;
  });

function showcaseHref(
  request: RoomDoorShowcaseRequest,
  frame: number | null,
) {
  const search = new URLSearchParams({
    roomDoorShowcase: request.room,
    variant: request.variant,
    mirror: request.mirror ? "1" : "0",
  });
  if (frame !== null) search.set("frame", String(frame));
  return `/?${search.toString()}`;
}

export default function RoomDoorShowcase(request: RoomDoorShowcaseRequest) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [assets, setAssets] = useState<LoadedAssets | null>(null);
  const [assetError, setAssetError] = useState<string | null>(null);
  const [animation, setAnimation] = useState<AnimationSnapshot>(() => ({
    frame: request.fixedFrame ?? 5,
    phase: request.fixedFrame === null ? "closing" : "fixed",
  }));

  const roomArtKey = request.room as RoomArtKey;
  const stairRoomArtKey = resolveStairRoomArtKey(roomArtKey);
  const backdropKey: RoomDoorBackdropKey =
    request.variant === "stairs" ? stairRoomArtKey : roomArtKey;
  const backplatePath =
    request.variant === "stairs"
      ? ROOM_STAIR_ART_PATHS[stairRoomArtKey]
      : ROOM_ART_PATHS[roomArtKey];
  const doorVisual = ROOM_DOOR_VISUALS[backdropKey];

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      loadImage(backplatePath),
      loadImage(doorVisual.imagePath),
    ])
      .then(([backplate, doors]) => {
        if (!cancelled) setAssets({ backplate, doors });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setAssetError(error instanceof Error ? error.message : "asset load failed");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [backplatePath, doorVisual.imagePath]);

  useEffect(() => {
    if (request.fixedFrame !== null) return undefined;

    let motion: RoomDoorMotion = createRoomDoorMotion(false);
    let holdSeconds = 0;
    let previousTime = performance.now();
    let animationFrame = 0;
    let lastFrame = roomDoorFrame(motion);
    let lastPhase: RoomDoorPhase = motion.phase;

    const tick = (now: number) => {
      const deltaSeconds = Math.min(0.05, Math.max(0, (now - previousTime) / 1000));
      previousTime = now;

      if (motion.phase === "closing" || motion.phase === "opening") {
        motion = advanceRoomDoorMotion(motion, deltaSeconds);
        holdSeconds = 0;
      } else if (motion.phase === "closed") {
        holdSeconds += deltaSeconds;
        if (holdSeconds >= CLOSED_HOLD_SECONDS) {
          motion = beginRoomDoorOpening(motion);
          holdSeconds = 0;
        }
      } else {
        holdSeconds += deltaSeconds;
        if (holdSeconds >= OPEN_HOLD_SECONDS) {
          motion = createRoomDoorMotion(false);
          holdSeconds = 0;
        }
      }

      const nextFrame = roomDoorFrame(motion);
      if (nextFrame !== lastFrame || motion.phase !== lastPhase) {
        lastFrame = nextFrame;
        lastPhase = motion.phase;
        setAnimation({ frame: nextFrame, phase: motion.phase });
      }
      animationFrame = window.requestAnimationFrame(tick);
    };

    animationFrame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(animationFrame);
  }, [request.fixedFrame]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !assets) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    context.save();
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    if (request.mirror) {
      context.translate(CANVAS_WIDTH, 0);
      context.scale(-1, 1);
    }
    context.drawImage(
      assets.backplate,
      0,
      0,
      CANVAS_WIDTH,
      CANVAS_HEIGHT,
    );

    for (const physicalSide of SHOWCASE_RENDER_ORDER) {
      const authoredSide = request.mirror
        ? mirroredRoomDoorSide(physicalSide)
        : physicalSide;
      const crop = doorVisual.sides[authoredSide];
      const source = roomDoorAtlasSourceRect(
        authoredSide,
        animation.frame,
        crop,
      );
      const destination = roomDoorCanvasRect(
        crop,
        CANVAS_WIDTH,
        CANVAS_HEIGHT,
      );
      context.drawImage(
        assets.doors,
        source.x,
        source.y,
        source.width,
        source.height,
        destination.x,
        destination.y,
        destination.width,
        destination.height,
      );
    }
    context.restore();
  }, [animation.frame, assets, doorVisual, request.mirror]);

  return (
    <main
      className={styles.showcase}
      data-entry-view="local-room-door-showcase"
      data-room={request.room}
      data-variant={request.variant}
      data-frame={animation.frame}
      data-phase={animation.phase}
      data-mirror={request.mirror ? "1" : "0"}
    >
      <header className={styles.status}>
        <strong>ROOM DOOR PRODUCTION SHOWCASE</strong>
        <span>
          room={request.room} · variant={request.variant} · frame={animation.frame}
          {" · "}phase={animation.phase} · mirror={request.mirror ? "1" : "0"}
        </span>
      </header>

      <section className={styles.viewport} aria-label="Room door visual preview">
        <div className={styles.canvasFrame}>
          <canvas
            ref={canvasRef}
            className={styles.canvas}
            width={CANVAS_WIDTH}
            height={CANVAS_HEIGHT}
            role="img"
            aria-label={`${request.room} ${request.variant} room door frame ${animation.frame}`}
          />
          {!assets && !assetError && (
            <div className={styles.loading}>DECODING BACKPLATE + DOOR PATCHES…</div>
          )}
          {assetError && <div className={styles.error}>{assetError}</div>}
        </div>
      </section>

      <footer className={styles.controls}>
        <form className={styles.form} action="/" method="get">
          <label>
            Room
            <select name="roomDoorShowcase" defaultValue={request.room}>
              {ROOM_DOOR_SHOWCASE_ROOMS.map((room) => (
                <option key={room} value={room}>
                  {room}
                </option>
              ))}
            </select>
          </label>
          <label>
            Variant
            <select name="variant" defaultValue={request.variant}>
              <option value="base">base</option>
              <option value="stairs">stairs</option>
            </select>
          </label>
          <label>
            Frame
            <select
              name="frame"
              defaultValue={request.fixedFrame === null ? "" : String(request.fixedFrame)}
            >
              <option value="">auto cycle</option>
              {[0, 1, 2, 3, 4, 5].map((frame) => (
                <option key={frame} value={frame}>
                  {frame}
                </option>
              ))}
            </select>
          </label>
          <label>
            Mirror
            <select name="mirror" defaultValue={request.mirror ? "1" : "0"}>
              <option value="0">0</option>
              <option value="1">1</option>
            </select>
          </label>
          <button type="submit" data-audio-cue="none">
            APPLY
          </button>
        </form>
        <nav className={styles.frameLinks} aria-label="Door frame shortcuts">
          {[null, 0, 1, 2, 3, 4, 5].map((frame) => {
            const active = frame === request.fixedFrame;
            return (
              <a
                key={frame ?? "auto"}
                className={`${styles.frameLink}${active ? ` ${styles.frameLinkActive}` : ""}`}
                href={showcaseHref(request, frame)}
                aria-current={active ? "page" : undefined}
                data-audio-cue="none"
              >
                {frame === null ? "AUTO" : `F${frame}`}
              </a>
            );
          })}
        </nav>
      </footer>
    </main>
  );
}
