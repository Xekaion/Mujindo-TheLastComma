import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

const root = process.cwd();

async function importRoomDoors() {
  const relativePath = "app/room-doors.ts";
  const source = await readFile(path.join(root, relativePath), "utf8");
  const javascript = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: relativePath,
  }).outputText;
  return import(
    `data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`
  );
}

const doors = await importRoomDoors();

test("an uncleared room closes through the same four authored frames", () => {
  let motion = doors.createRoomDoorMotion(false);
  assert.equal(motion.phase, "closing");
  assert.equal(doors.roomDoorFrame(motion), 3);
  assert.equal(doors.roomDoorsPassable(motion), false);

  const frames = [doors.roomDoorFrame(motion)];
  for (let index = 0; index < 3; index += 1) {
    motion = doors.advanceRoomDoorMotion(
      motion,
      doors.ROOM_DOOR_CLOSING_SECONDS / 4,
    );
    frames.push(doors.roomDoorFrame(motion));
  }
  motion = doors.advanceRoomDoorMotion(
    motion,
    doors.ROOM_DOOR_CLOSING_SECONDS / 4,
  );
  frames.push(doors.roomDoorFrame(motion));

  assert.deepEqual(frames, [3, 3, 2, 1, 0]);
  assert.equal(motion.phase, "closed");
  assert.equal(doors.roomDoorsPassable(motion), false);
});

test("room clear raises four frames and unlocks traversal only when fully open", () => {
  let motion = doors.beginRoomDoorOpening(doors.createClosedRoomDoorMotion());
  const frames = [doors.roomDoorFrame(motion)];
  const passable = [doors.roomDoorsPassable(motion)];
  for (let index = 0; index < 4; index += 1) {
    motion = doors.advanceRoomDoorMotion(
      motion,
      doors.ROOM_DOOR_OPENING_SECONDS / 4,
    );
    frames.push(doors.roomDoorFrame(motion));
    passable.push(doors.roomDoorsPassable(motion));
  }

  assert.deepEqual(frames, [0, 0, 1, 2, 3]);
  assert.deepEqual(passable, [false, false, false, false, true]);
  assert.equal(motion.phase, "open");
});

test("door animation is refresh-rate invariant and invalid time cannot skip it", () => {
  const simulate = (hz) => {
    let motion = doors.beginRoomDoorOpening(doors.createClosedRoomDoorMotion());
    const step = 1 / hz;
    let elapsed = 0;
    while (elapsed < doors.ROOM_DOOR_OPENING_SECONDS) {
      const delta = Math.min(step, doors.ROOM_DOOR_OPENING_SECONDS - elapsed);
      motion = doors.advanceRoomDoorMotion(motion, delta);
      elapsed += delta;
    }
    return motion;
  };

  for (const hz of [30, 60, 144]) {
    const motion = simulate(hz);
    assert.equal(motion.phase, "open", `${hz}Hz`);
    assert.equal(doors.roomDoorFrame(motion), 3, `${hz}Hz`);
  }

  const opening = doors.beginRoomDoorOpening(doors.createClosedRoomDoorMotion());
  for (const invalid of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.deepEqual(doors.advanceRoomDoorMotion(opening, invalid), opening);
  }
});

test("cleared revisits are immediately open while a fresh world can start closed", () => {
  const revisited = doors.createRoomDoorMotion(true);
  assert.equal(revisited.phase, "open");
  assert.equal(doors.roomDoorFrame(revisited), 3);
  assert.equal(doors.roomDoorsPassable(revisited), true);

  const boot = doors.createClosedRoomDoorMotion();
  assert.equal(boot.phase, "closed");
  assert.equal(doors.roomDoorFrame(boot), 0);
});
