export const ROOM_DOOR_FRAME_COUNT = 4;
export const ROOM_DOOR_CLOSING_SECONDS = 0.2;
export const ROOM_DOOR_OPENING_SECONDS = 0.52;

export type RoomDoorPhase = "open" | "closing" | "closed" | "opening";

export type RoomDoorMotion = Readonly<{
  phase: RoomDoorPhase;
  elapsed: number;
}>;

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

const finiteStep = (deltaSeconds: number) =>
  Number.isFinite(deltaSeconds) ? Math.max(0, deltaSeconds) : 0;

export function createRoomDoorMotion(alreadyCleared: boolean): RoomDoorMotion {
  return alreadyCleared
    ? { phase: "open", elapsed: ROOM_DOOR_OPENING_SECONDS }
    : { phase: "closing", elapsed: 0 };
}

export function createClosedRoomDoorMotion(): RoomDoorMotion {
  return { phase: "closed", elapsed: ROOM_DOOR_CLOSING_SECONDS };
}

export function beginRoomDoorOpening(motion: RoomDoorMotion): RoomDoorMotion {
  if (motion.phase === "open" || motion.phase === "opening") return motion;
  return { phase: "opening", elapsed: 0 };
}

export function advanceRoomDoorMotion(
  motion: RoomDoorMotion,
  deltaSeconds: number,
): RoomDoorMotion {
  const step = finiteStep(deltaSeconds);
  if (step === 0) return motion;

  if (motion.phase === "closing") {
    const elapsed = Math.min(ROOM_DOOR_CLOSING_SECONDS, motion.elapsed + step);
    return elapsed >= ROOM_DOOR_CLOSING_SECONDS
      ? { phase: "closed", elapsed: ROOM_DOOR_CLOSING_SECONDS }
      : { phase: "closing", elapsed };
  }

  if (motion.phase === "opening") {
    const elapsed = Math.min(ROOM_DOOR_OPENING_SECONDS, motion.elapsed + step);
    return elapsed >= ROOM_DOOR_OPENING_SECONDS
      ? { phase: "open", elapsed: ROOM_DOOR_OPENING_SECONDS }
      : { phase: "opening", elapsed };
  }

  return motion;
}

/**
 * Atlas cells are authored from completely closed (0) to completely raised
 * (3). Closing deliberately traverses the same cells in reverse, so the art
 * cannot jitter between two independently drawn animations.
 */
export function roomDoorFrame(motion: RoomDoorMotion): number {
  if (motion.phase === "closed") return 0;
  if (motion.phase === "open") return ROOM_DOOR_FRAME_COUNT - 1;

  if (motion.phase === "opening") {
    const progress = clamp01(motion.elapsed / ROOM_DOOR_OPENING_SECONDS);
    return Math.min(
      ROOM_DOOR_FRAME_COUNT - 2,
      Math.floor(progress * (ROOM_DOOR_FRAME_COUNT - 1)),
    );
  }

  const progress = clamp01(motion.elapsed / ROOM_DOOR_CLOSING_SECONDS);
  return Math.max(
    ROOM_DOOR_FRAME_COUNT -
      1 -
      Math.min(ROOM_DOOR_FRAME_COUNT - 2, Math.floor(progress * (ROOM_DOOR_FRAME_COUNT - 1))),
    1,
  );
}

export function roomDoorsPassable(motion: RoomDoorMotion): boolean {
  return motion.phase === "open";
}
