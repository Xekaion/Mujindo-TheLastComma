import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

const root = process.cwd();

async function importShowcaseRequestModule() {
  const relativePath = "app/room-door-showcase.ts";
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

test("room door showcase is local-only and bypasses saves, storage, and hub entry", async () => {
  const request = await importShowcaseRequestModule();
  const local = request.resolveRoomDoorShowcaseRequest(
    {
      roomDoorShowcase: "roomBattle",
      variant: "stairs",
      frame: "3",
      mirror: "1",
    },
    "localhost:4317",
  );
  assert.deepEqual(local, {
    room: "roomBattle",
    variant: "stairs",
    fixedFrame: 3,
    mirror: true,
  });
  assert.equal(
    request.resolveRoomDoorShowcaseRequest(
      { roomDoorShowcase: "roomBattle" },
      "127.0.0.1:4317",
    )?.fixedFrame,
    null,
  );
  assert.equal(
    request.resolveRoomDoorShowcaseRequest(
      { roomDoorShowcase: "roomBattle" },
      "mujindo-last-comma.everyonestartup.chatgpt.site",
    ),
    null,
  );
  assert.equal(
    request.resolveRoomDoorShowcaseRequest(
      { roomDoorShowcase: "not-a-room" },
      "localhost:4317",
    ),
    null,
  );

  const page = await readFile(path.join(root, "app/page.tsx"), "utf8");
  const showcaseReturn = page.indexOf("return <RoomDoorShowcase {...showcase} />");
  const authRead = page.indexOf("const user = await getChatGPTUser()");
  assert.ok(showcaseReturn >= 0 && showcaseReturn < authRead);

  const component = await readFile(
    path.join(root, "app/RoomDoorShowcase.tsx"),
    "utf8",
  );
  for (const productionSymbol of [
    "ROOM_DOOR_VISUALS",
    "roomDoorAtlasFrameSourceRect",
  ]) {
    assert.match(component, new RegExp(`\\b${productionSymbol}\\b`));
  }
  assert.doesNotMatch(
    component,
    /ROOM_ART_PATHS|ROOM_STAIR_ART_PATHS|roomDoorAtlasSourceRect|roomDoorCanvasRect|ROOM_DOOR_SIDES/,
    "the showcase must draw a complete map cell instead of composing door patches",
  );
  assert.match(component, /type LoadedAssets = Readonly<\{\s*atlas: HTMLImageElement;\s*\}>/);
  assert.match(component, /\.then\(\(atlas\) => \{[\s\S]{0,100}?setAssets\(\{ atlas \}\)/);
  assert.match(
    component,
    /context\.drawImage\(\s*assets\.atlas,\s*source\.x,\s*source\.y,\s*source\.width,\s*source\.height,\s*0,\s*0,\s*CANVAS_WIDTH,\s*CANVAS_HEIGHT,?\s*\)/,
  );
  assert.match(component, /width=\{CANVAS_WIDTH\}/);
  assert.match(component, /height=\{CANVAS_HEIGHT\}/);
  assert.doesNotMatch(
    component,
    /localStorage|sessionStorage|readSaveSlot|getMemoryPlazaClient|CharacterEntryGate|GameCanvas/,
  );

  const audioProvider = await readFile(
    path.join(root, "app/GameAudioProvider.tsx"),
    "utf8",
  );
  const audioBypass = audioProvider.indexOf(
    "if (localShowcaseBrowserSnapshot()) return undefined;",
  );
  const audioInitialization = audioProvider.indexOf("const audio = getGameAudio()");
  assert.ok(audioBypass >= 0 && audioBypass < audioInitialization);
});
