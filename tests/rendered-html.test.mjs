import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders character selection before any playable mode", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<html lang="ko">/i);
  assert.match(html, /<body class="game-viewport" data-game-aspect="16:9">/i);
  assert.match(html, /<title>무진도: 마지막 쉼표<\/title>/i);
  assert.match(html, /class="character-entry"/);
  assert.match(html, /data-character-entry-state="loading"/);
  assert.match(html, /aria-label="캐릭터 저장 슬롯"/);
  assert.equal((html.match(/data-character-slot="[123]"/g) ?? []).length, 3);
  assert.match(html, /class="character-entry-confirm"/);
  assert.doesNotMatch(html, /class="game-screen"/);
  assert.doesNotMatch(html, /Your site is taking shape|react-loading-skeleton/);
});

test("keeps the gated game shell, save system, profession system, and assets wired", async () => {
  const [game, css, page, flow, gate, layout] = await Promise.all([
    readFile(new URL("../app/GameCanvas.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/game.css", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/GameEntryFlow.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/CharacterEntryGate.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(page, /<GameEntryFlow[\s\S]{0,160}?accountName=/);
  assert.match(flow, /<CharacterEntryGate[\s\S]{0,180}?accountName=/);
  assert.match(flow, /<GameCanvas[\s\S]{0,160}?initialSaveSlot=\{selection\.slot\}/);
  assert.match(gate, /SAVE_SLOT_IDS\.map/);
  assert.match(gate, /migrateLegacySave\(\)/);
  assert.match(layout, /const title = "무진도: 마지막 쉼표"/);
  assert.match(layout, /icon: "\/favicon\.png"/);
  assert.match(game, /from "\.\/save-slots"/);
  assert.match(game, /from "\.\/professions"/);
  assert.match(game, /className="save-slot-grid"/);
  assert.match(game, /mode === "profession"/);
  assert.match(css, /\.save-slot-grid/);
  assert.match(css, /\.profession-modal/);
  assert.match(game, /className="profession-ceremony"/);
  assert.match(css, /profession-ascension-sigil-v1\.png/);

  await Promise.all([
    access(new URL("../public/assets/walk/withered-walk-v2.png", import.meta.url)),
    access(new URL("../public/assets/effects/summon-rift.png", import.meta.url)),
    access(new URL("../public/assets/effects/teleport-rift.png", import.meta.url)),
    access(new URL("../public/assets/effects/profession-ascension-sigil-v1.png", import.meta.url)),
    access(new URL("../public/assets/audio/sfx/profession-ascend.wav", import.meta.url)),
    access(new URL("../public/favicon.png", import.meta.url)),
  ]);
});
