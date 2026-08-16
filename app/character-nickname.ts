export const CHARACTER_NICKNAME_MIN_LENGTH = 2;
export const CHARACTER_NICKNAME_MAX_LENGTH = 12;
export const CHARACTER_NICKNAME_STORAGE_PREFIX =
  "mujindo:last-comma:character-nickname-v1:slot:";

export type CharacterNicknameErrorCode =
  | "nickname_required"
  | "nickname_too_short"
  | "nickname_too_long"
  | "nickname_first_character"
  | "nickname_whitespace"
  | "nickname_characters"
  | "nickname_reserved";

export type CharacterNicknameValidation =
  | {
      ok: true;
      nickname: string;
      nicknameKey: string;
    }
  | {
      ok: false;
      code: CharacterNicknameErrorCode;
    };

export type CharacterNicknameSlot = 1 | 2 | 3;

export type CharacterNicknameStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>;

const RESERVED_NICKNAME_KEYS = new Set([
  "gm",
  "admin",
  "administrator",
  "mod",
  "moderator",
  "steam",
  "mujindo",
  "운영자",
  "관리자",
  "개발자",
  "무진도",
  "방랑자",
  "기록자",
  "이름없는기록자",
]);

const hasReservedIdentity = (nicknameKey: string): boolean =>
  RESERVED_NICKNAME_KEYS.has(nicknameKey) ||
  /^(?:gm|admin|mod)\d*$/i.test(nicknameKey);

export function validateCharacterNickname(
  value: unknown,
): CharacterNicknameValidation {
  if (typeof value !== "string" || value.length === 0) {
    return { ok: false, code: "nickname_required" };
  }

  const nickname = value.normalize("NFKC");
  if (/\s/u.test(nickname)) {
    return { ok: false, code: "nickname_whitespace" };
  }

  const length = Array.from(nickname).length;
  if (length < CHARACTER_NICKNAME_MIN_LENGTH) {
    return { ok: false, code: "nickname_too_short" };
  }
  if (length > CHARACTER_NICKNAME_MAX_LENGTH) {
    return { ok: false, code: "nickname_too_long" };
  }
  if (!/^[A-Za-z가-힣]/u.test(nickname)) {
    return { ok: false, code: "nickname_first_character" };
  }
  if (!/^[A-Za-z가-힣][A-Za-z0-9가-힣]*$/u.test(nickname)) {
    return { ok: false, code: "nickname_characters" };
  }

  const nicknameKey = nickname.toLowerCase();
  if (hasReservedIdentity(nicknameKey)) {
    return { ok: false, code: "nickname_reserved" };
  }
  return { ok: true, nickname, nicknameKey };
}

export function characterNicknameKey(value: unknown): string | null {
  const validation = validateCharacterNickname(value);
  return validation.ok ? validation.nicknameKey : null;
}

export function isCharacterNicknameSlot(
  value: unknown,
): value is CharacterNicknameSlot {
  return value === 1 || value === 2 || value === 3;
}

export function characterNicknameStorageKey(
  slot: CharacterNicknameSlot,
): string {
  if (!isCharacterNicknameSlot(slot)) {
    throw new RangeError(`Invalid character nickname slot: ${String(slot)}`);
  }
  return `${CHARACTER_NICKNAME_STORAGE_PREFIX}${slot}`;
}

function browserStorage(): CharacterNicknameStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function resolveStorage(
  storage?: CharacterNicknameStorage | null,
): CharacterNicknameStorage | null {
  return storage === undefined ? browserStorage() : storage;
}

export function readCharacterNickname(
  slot: CharacterNicknameSlot,
  storage?: CharacterNicknameStorage | null,
): string | null {
  const target = resolveStorage(storage);
  if (!target) return null;
  try {
    const validation = validateCharacterNickname(
      target.getItem(characterNicknameStorageKey(slot)),
    );
    return validation.ok ? validation.nickname : null;
  } catch {
    return null;
  }
}

export function writeCharacterNickname(
  slot: CharacterNicknameSlot,
  nickname: string,
  storage?: CharacterNicknameStorage | null,
): boolean {
  const validation = validateCharacterNickname(nickname);
  if (!validation.ok) return false;
  const target = resolveStorage(storage);
  if (!target) return false;
  try {
    const key = characterNicknameStorageKey(slot);
    target.setItem(key, validation.nickname);
    return target.getItem(key) === validation.nickname;
  } catch {
    return false;
  }
}

export function removeCharacterNickname(
  slot: CharacterNicknameSlot,
  storage?: CharacterNicknameStorage | null,
): boolean {
  const target = resolveStorage(storage);
  if (!target) return false;
  try {
    const key = characterNicknameStorageKey(slot);
    target.removeItem(key);
    return target.getItem(key) === null;
  } catch {
    return false;
  }
}

export function readCharacterNicknames(
  storage?: CharacterNicknameStorage | null,
): Array<string | null> {
  return ([1, 2, 3] as const).map((slot) =>
    readCharacterNickname(slot, storage),
  );
}

export function isCharacterNicknameLocallyAvailable(
  slot: CharacterNicknameSlot,
  nickname: string,
  storage?: CharacterNicknameStorage | null,
): boolean {
  const candidateKey = characterNicknameKey(nickname);
  if (!candidateKey) return false;
  return ([1, 2, 3] as const).every((otherSlot) => {
    if (otherSlot === slot) return true;
    const otherName = readCharacterNickname(otherSlot, storage);
    return characterNicknameKey(otherName) !== candidateKey;
  });
}

export type CharacterNicknameAuthority = "account" | "device";

export type CharacterNicknameRosterEntry = {
  slot: CharacterNicknameSlot;
  publicCharacterId: string;
  nickname: string;
};

export class CharacterNicknameRequestError extends Error {
  constructor(readonly code: string, message?: string) {
    super(message || code);
    this.name = "CharacterNicknameRequestError";
  }
}

async function responsePayload(response: Response): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await response.json();
    return typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export async function readAccountCharacterNicknames(
  signal?: AbortSignal,
): Promise<{
  authority: CharacterNicknameAuthority;
  characters: CharacterNicknameRosterEntry[];
}> {
  try {
    const response = await fetch("/api/hub/characters", {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      signal,
    });
    const payload = await responsePayload(response);
    if (
      response.status === 503 ||
      (response.status === 401 && payload.error === "account_required")
    ) {
      return { authority: "device", characters: [] };
    }
    if (!response.ok) {
      throw new CharacterNicknameRequestError(
        typeof payload.error === "string" ? payload.error : "nickname_check_failed",
      );
    }
    const characters = Array.isArray(payload.characters)
      ? payload.characters.flatMap((entry) => {
          if (typeof entry !== "object" || entry === null) return [];
          const record = entry as Record<string, unknown>;
          const validation = validateCharacterNickname(record.nickname);
          if (
            !isCharacterNicknameSlot(record.slot) ||
            typeof record.publicCharacterId !== "string" ||
            !validation.ok
          ) {
            return [];
          }
          return [{
            slot: record.slot,
            publicCharacterId: record.publicCharacterId,
            nickname: validation.nickname,
          }];
        })
      : [];
    return { authority: "account", characters };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    if (error instanceof CharacterNicknameRequestError) throw error;
    return { authority: "device", characters: [] };
  }
}

export async function checkCharacterNicknameAvailability(
  slot: CharacterNicknameSlot,
  nickname: string,
  signal?: AbortSignal,
): Promise<{ available: boolean; authority: CharacterNicknameAuthority }> {
  const validation = validateCharacterNickname(nickname);
  if (!validation.ok) {
    throw new CharacterNicknameRequestError(validation.code);
  }
  try {
    const query = new URLSearchParams({
      nickname: validation.nickname,
      slot: String(slot),
    });
    const response = await fetch(`/api/hub/characters?${query}`, {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      signal,
    });
    if (response.status === 503) {
      return { available: true, authority: "device" };
    }
    const payload = await responsePayload(response);
    if (!response.ok) {
      throw new CharacterNicknameRequestError(
        typeof payload.error === "string" ? payload.error : "nickname_check_failed",
      );
    }
    return {
      available: payload.available === true,
      authority: payload.authority === "account" ? "account" : "device",
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    if (error instanceof CharacterNicknameRequestError) throw error;
    return { available: true, authority: "device" };
  }
}

export async function claimCharacterNickname(
  slot: CharacterNicknameSlot,
  nickname: string,
  signal?: AbortSignal,
): Promise<{
  authority: CharacterNicknameAuthority;
  nickname: string;
  publicCharacterId: string | null;
}> {
  const validation = validateCharacterNickname(nickname);
  if (!validation.ok) {
    throw new CharacterNicknameRequestError(validation.code);
  }
  try {
    const response = await fetch("/api/hub/characters", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slot, nickname: validation.nickname }),
      signal,
    });
    const payload = await responsePayload(response);
    if (response.status === 503) {
      return {
        authority: "device",
        nickname: validation.nickname,
        publicCharacterId: null,
      };
    }
    if (response.status === 401 && payload.error === "account_required") {
      const availability = await checkCharacterNicknameAvailability(
        slot,
        validation.nickname,
        signal,
      );
      if (!availability.available) {
        throw new CharacterNicknameRequestError("nickname_taken");
      }
      return {
        authority: "device",
        nickname: validation.nickname,
        publicCharacterId: null,
      };
    }
    if (!response.ok) {
      throw new CharacterNicknameRequestError(
        typeof payload.error === "string" ? payload.error : "nickname_claim_failed",
      );
    }
    const claimed = validateCharacterNickname(payload.nickname);
    if (!claimed.ok || typeof payload.publicCharacterId !== "string") {
      throw new CharacterNicknameRequestError("nickname_claim_failed");
    }
    return {
      authority: "account",
      nickname: claimed.nickname,
      publicCharacterId: payload.publicCharacterId,
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    if (error instanceof CharacterNicknameRequestError) throw error;
    return {
      authority: "device",
      nickname: validation.nickname,
      publicCharacterId: null,
    };
  }
}
