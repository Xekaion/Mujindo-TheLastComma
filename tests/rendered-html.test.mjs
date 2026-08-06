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

test("server-renders the professional two-stage game title", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<html lang="ko">/i);
  assert.match(html, /<title>무진도: 마지막 쉼표<\/title>/i);
  assert.match(html, /class="menu-screen"/);
  assert.match(html, /data-menu-stage="landing"/);
  assert.match(html, /class="menu-primary-action"/);
  assert.match(html, /aria-label="무진도 기록 규모"/);
  assert.match(html, /50<\/strong> 무한 증강/);
  assert.match(
    html,
    /80<\/strong> 장비 원형 · (?:<!-- -->)?10(?:<!-- -->)?부위 · (?:<!-- -->)?8(?:<!-- -->)?등급/,
  );
  assert.match(html, /I 장비/);
  assert.doesNotMatch(html, /Your site is taking shape|react-loading-skeleton/);
});

test("keeps the game shell, save system, profession system, and assets wired", async () => {
  const [game, css, page, layout] = await Promise.all([
    readFile(new URL("../app/GameCanvas.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/game.css", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(page, /<GameCanvas \/>/);
  assert.match(layout, /const title = "무진도: 마지막 쉼표"/);
  assert.match(layout, /icon: "\/favicon\.png"/);
  assert.match(game, /from "\.\/save-slots"/);
  assert.match(game, /from "\.\/professions"/);
  assert.match(game, /className="save-slot-grid"/);
  assert.match(game, /mode === "profession"/);
  assert.match(css, /\.save-slot-grid/);
  assert.match(css, /\.profession-modal/);

  await Promise.all([
    access(new URL("../public/assets/walk/withered-walk-v2.png", import.meta.url)),
    access(new URL("../public/assets/effects/summon-rift.png", import.meta.url)),
    access(new URL("../public/assets/effects/teleport-rift.png", import.meta.url)),
    access(new URL("../public/favicon.png", import.meta.url)),
  ]);
});
