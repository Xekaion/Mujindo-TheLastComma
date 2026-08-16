import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

const root = process.cwd();

async function importNicknameModule() {
  const source = await readFile(
    path.join(root, "app/character-nickname.ts"),
    "utf8",
  );
  const javascript = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: "app/character-nickname.ts",
  }).outputText;
  return import(
    `data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`
  );
}

class MemoryStorage {
  values = new Map();

  getItem(key) {
    return this.values.get(key) ?? null;
  }

  setItem(key, value) {
    this.values.set(key, String(value));
  }

  removeItem(key) {
    this.values.delete(key);
  }
}

test("character nickname policy canonicalizes equivalent names and rejects impersonation", async () => {
  const nickname = await importNicknameModule();

  assert.deepEqual(nickname.validateCharacterNickname("기억자01"), {
    ok: true,
    nickname: "기억자01",
    nicknameKey: "기억자01",
  });
  assert.deepEqual(nickname.validateCharacterNickname("Ａlice"), {
    ok: true,
    nickname: "Alice",
    nicknameKey: "alice",
  });
  assert.equal(
    nickname.characterNicknameKey("기억"),
    nickname.characterNicknameKey("기억"),
    "decomposed and composed Hangul must share one uniqueness key",
  );
  assert.equal(
    nickname.characterNicknameKey("ALICE"),
    nickname.characterNicknameKey("alice"),
    "Latin case variants must share one uniqueness key",
  );

  for (const [value, code] of [
    ["", "nickname_required"],
    ["가", "nickname_too_short"],
    ["123기록", "nickname_first_character"],
    ["기억 자", "nickname_whitespace"],
    ["기억_자", "nickname_characters"],
    ["기억🙂", "nickname_characters"],
    ["운영자", "nickname_reserved"],
    ["방랑자", "nickname_reserved"],
    ["GM42", "nickname_reserved"],
    ["가나다라마바사아자차카타파", "nickname_too_long"],
  ]) {
    assert.deepEqual(
      nickname.validateCharacterNickname(value),
      { ok: false, code },
      `${JSON.stringify(value)} should fail with ${code}`,
    );
  }
});

test("device nickname cache keeps three slot identities distinct", async () => {
  const nickname = await importNicknameModule();
  const storage = new MemoryStorage();

  assert.equal(nickname.writeCharacterNickname(1, "Alice", storage), true);
  assert.equal(nickname.writeCharacterNickname(2, "기억자", storage), true);
  assert.deepEqual(nickname.readCharacterNicknames(storage), [
    "Alice",
    "기억자",
    null,
  ]);
  assert.equal(
    nickname.isCharacterNicknameLocallyAvailable(3, "ＡＬＩＣＥ", storage),
    false,
  );
  assert.equal(
    nickname.isCharacterNicknameLocallyAvailable(1, "alice", storage),
    true,
    "an idempotent claim in the same slot remains available",
  );
  assert.equal(nickname.writeCharacterNickname(3, "x", storage), false);
  assert.equal(nickname.readCharacterNickname(3, storage), null);
  assert.equal(nickname.removeCharacterNickname(1, storage), true);
  assert.deepEqual(nickname.readCharacterNicknames(storage), [
    null,
    "기억자",
    null,
  ]);
});

test("nickname client falls back only when account authority is unavailable", async () => {
  const nickname = await importNicknameModule();
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (_url, init) =>
      init?.method === "GET"
        ? new Response(JSON.stringify({ available: true, authority: "device" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        : new Response(JSON.stringify({ error: "account_required" }), {
            status: 401,
            headers: { "content-type": "application/json" },
          });
    assert.deepEqual(await nickname.claimCharacterNickname(1, "기억자"), {
      authority: "device",
      nickname: "기억자",
      publicCharacterId: null,
    });

    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: "hub_identity_required" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    await assert.rejects(
      nickname.claimCharacterNickname(1, "기억자"),
      (error) =>
        error instanceof nickname.CharacterNicknameRequestError &&
        error.code === "hub_identity_required",
      "an expired required account session must not be downgraded to a device claim",
    );

    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: "nickname_taken" }), {
        status: 409,
        headers: { "content-type": "application/json" },
      });
    await assert.rejects(
      nickname.claimCharacterNickname(1, "기억자"),
      (error) =>
        error instanceof nickname.CharacterNicknameRequestError &&
        error.code === "nickname_taken",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
