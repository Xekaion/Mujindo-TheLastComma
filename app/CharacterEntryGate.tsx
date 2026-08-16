"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CHARACTER_NICKNAME_MAX_LENGTH,
  CharacterNicknameRequestError,
  characterNicknameKey,
  checkCharacterNicknameAvailability,
  claimCharacterNickname,
  readAccountCharacterNicknames,
  readCharacterNicknames,
  removeCharacterNickname,
  validateCharacterNickname,
  writeCharacterNickname,
  type CharacterNicknameAuthority,
} from "./character-nickname";
import { PROFESSION_TITLES } from "./professions";
import {
  SAVE_SLOT_IDS,
  hasSaveSlotData,
  migrateLegacySave,
  readActiveSaveSlot,
  readSaveRecoveryCandidates,
  readSaveSlot,
  readSaveSlotSummaries,
  removeSaveSlot,
  restoreSaveRecoveryCandidate,
  writeActiveSaveSlot,
  type SaveRecoveryCandidate,
  type SaveRunPayload,
  type SaveSlotId,
  type SaveSlotSummary,
} from "./save-slots";
import "./character-entry.css";

type CharacterEntryGateProps = {
  accountName?: string | null;
  nicknameRejection?: CharacterNicknameRejection | null;
  onNicknameRejectionHandled?: () => void;
  onEnter: (selection: CharacterEntrySelection) => void;
};

export type CharacterNicknameRejection = {
  slot: SaveSlotId;
  nickname: string;
  code: "nickname_taken" | "nickname_required";
};

export type CharacterEntrySelection = {
  slot: SaveSlotId;
  occupied: boolean;
  displayName: string;
  /** Exact validated snapshot selected by the card; plaza must not re-resolve it. */
  save: SaveRunPayload | null;
};

type PendingCharacterEntry = {
  slot: SaveSlotId;
  occupied: boolean;
  save: SaveRunPayload | null;
};

type NicknameAvailability =
  | "idle"
  | "checking"
  | "available"
  | "device"
  | "taken"
  | "error";

const CHARACTER_ROSTER_TIMEOUT_MS = 5_000;

const validSavedAt = (timestamp: number) => {
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime()) ? date : null;
};

const formatSavedAt = (timestamp: number) => {
  const date = validSavedAt(timestamp);
  if (!date) return "날짜 미상";
  return new Intl.DateTimeFormat("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
};

const characterProfession = (
  summary: SaveSlotSummary | null,
): string => {
  if (!summary) return "새 원정자";
  if (summary.profession) {
    return PROFESSION_TITLES[summary.profession] ?? summary.profession;
  }
  return "미전직 방랑자";
};

const nicknameErrorMessage = (code: string): string => {
  const messages: Record<string, string> = {
    nickname_required: "캐릭터 닉네임을 입력해 주세요.",
    nickname_too_short: "닉네임은 2자 이상이어야 합니다.",
    nickname_too_long: `닉네임은 ${CHARACTER_NICKNAME_MAX_LENGTH}자까지 사용할 수 있습니다.`,
    nickname_first_character: "첫 글자는 한글 또는 영문이어야 합니다.",
    nickname_whitespace: "닉네임에는 공백을 사용할 수 없습니다.",
    nickname_characters: "한글·영문·숫자만 사용할 수 있습니다.",
    nickname_reserved: "운영 또는 시스템 명칭과 혼동될 수 있는 닉네임입니다.",
    nickname_taken: "이미 다른 캐릭터가 사용 중인 닉네임입니다.",
    slot_occupied: "이 슬롯은 이미 다른 서버 닉네임에 귀속되어 있습니다.",
    nickname_check_failed: "중복 확인에 실패했습니다. 잠시 후 다시 시도해 주세요.",
    nickname_claim_failed: "닉네임을 확정하지 못했습니다. 다시 시도해 주세요.",
    nickname_storage_failed: "이 기기에 캐릭터 이름을 저장하지 못했습니다.",
  };
  return messages[code] ?? "닉네임을 확인하지 못했습니다. 다시 시도해 주세요.";
};

export default function CharacterEntryGate({
  accountName,
  nicknameRejection = null,
  onNicknameRejectionHandled,
  onEnter,
}: CharacterEntryGateProps) {
  const [ready, setReady] = useState(false);
  const [selectedSlot, setSelectedSlot] = useState<SaveSlotId | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SaveSlotId | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [entryBusy, setEntryBusy] = useState(false);
  const [nicknameTarget, setNicknameTarget] =
    useState<PendingCharacterEntry | null>(null);
  const [nicknameDraft, setNicknameDraft] = useState("");
  const [nicknameError, setNicknameError] = useState<string | null>(null);
  const [nicknameAvailability, setNicknameAvailability] =
    useState<NicknameAvailability>("idle");
  const [nicknameAuthority, setNicknameAuthority] =
    useState<CharacterNicknameAuthority>("device");
  const [nicknameComposing, setNicknameComposing] = useState(false);
  const deleteDialogRef = useRef<HTMLElement | null>(null);
  const deleteTriggerRef = useRef<HTMLButtonElement | null>(null);
  const nicknameDialogRef = useRef<HTMLElement | null>(null);
  const nicknameInputRef = useRef<HTMLInputElement | null>(null);
  const nicknameTriggerRef = useRef<HTMLElement | null>(null);
  const nicknameCheckSequenceRef = useRef(0);
  const [summaries, setSummaries] = useState<Array<SaveSlotSummary | null>>(() =>
    SAVE_SLOT_IDS.map(() => null),
  );
  const [slotNicknames, setSlotNicknames] = useState<Array<string | null>>(() =>
    SAVE_SLOT_IDS.map(() => null),
  );
  const [slotHasData, setSlotHasData] = useState<boolean[]>(() =>
    SAVE_SLOT_IDS.map(() => false),
  );
  const [recoveryCandidates, setRecoveryCandidates] = useState<
    SaveRecoveryCandidate[]
  >([]);

  const refreshSummaries = useCallback(() => {
    setSummaries(readSaveSlotSummaries());
    setSlotNicknames(readCharacterNicknames());
    setSlotHasData(SAVE_SLOT_IDS.map((slot) => hasSaveSlotData(slot)));
    setRecoveryCandidates(readSaveRecoveryCandidates());
  }, []);

  useEffect(() => {
    // The legacy record is copied, never moved, and an occupied slot 1 is never
    // overwritten. Character identity is stored separately so restoring an old
    // checkpoint can never roll a nickname back or clone it into another slot.
    migrateLegacySave();
    const controller = new AbortController();
    let disposed = false;
    let rosterTimeout: number | null = null;
    const restoreTimer = window.setTimeout(() => {
      void (async () => {
        const localNicknames = readCharacterNicknames();
        rosterTimeout = window.setTimeout(
          () => controller.abort(),
          CHARACTER_ROSTER_TIMEOUT_MS,
        );
        try {
          const roster = await readAccountCharacterNicknames(controller.signal);
          setNicknameAuthority(roster.authority);
          if (roster.authority === "account") {
            for (const slot of SAVE_SLOT_IDS) removeCharacterNickname(slot);
            localNicknames.fill(null);
          }
          for (const character of roster.characters) {
            localNicknames[character.slot - 1] = character.nickname;
            writeCharacterNickname(character.slot, character.nickname);
          }
        } catch (error) {
          if (
            disposed &&
            error instanceof DOMException &&
            error.name === "AbortError"
          ) {
            return;
          }
          setNicknameAuthority("device");
        } finally {
          if (rosterTimeout !== null) window.clearTimeout(rosterTimeout);
        }
        if (disposed) return;
        setSummaries(readSaveSlotSummaries());
        setSlotNicknames(localNicknames);
        setSlotHasData(SAVE_SLOT_IDS.map((slot) => hasSaveSlotData(slot)));
        setRecoveryCandidates(readSaveRecoveryCandidates());
        setSelectedSlot(readActiveSaveSlot());
        setReady(true);
      })();
    }, 0);
    return () => {
      disposed = true;
      controller.abort();
      window.clearTimeout(restoreTimer);
      if (rosterTimeout !== null) window.clearTimeout(rosterTimeout);
    };
  }, []);

  useEffect(() => {
    if (deleteTarget === null) return;
    const restoreTarget = deleteTriggerRef.current;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setDeleteTarget(null);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        deleteDialogRef.current?.querySelectorAll<HTMLButtonElement>(
          "button:not([disabled])",
        ) ?? [],
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", closeOnEscape, true);
    return () => {
      window.removeEventListener("keydown", closeOnEscape, true);
      window.requestAnimationFrame(() => {
        if (restoreTarget?.isConnected) restoreTarget.focus({ preventScroll: true });
      });
    };
  }, [deleteTarget]);

  useEffect(() => {
    if (nicknameTarget === null) return;
    const restoreTarget = nicknameTriggerRef.current;
    const focusTimer = window.requestAnimationFrame(() => {
      nicknameInputRef.current?.focus({ preventScroll: true });
      nicknameInputRef.current?.select();
    });
    const trapDialogFocus = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (entryBusy) return;
        event.preventDefault();
        setNicknameTarget(null);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        nicknameDialogRef.current?.querySelectorAll<HTMLElement>(
          "input:not([disabled]),button:not([disabled])",
        ) ?? [],
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", trapDialogFocus, true);
    return () => {
      window.cancelAnimationFrame(focusTimer);
      window.removeEventListener("keydown", trapDialogFocus, true);
      window.requestAnimationFrame(() => {
        if (restoreTarget?.isConnected) restoreTarget.focus({ preventScroll: true });
      });
    };
  }, [entryBusy, nicknameTarget]);

  useEffect(() => {
    const sequence = nicknameCheckSequenceRef.current + 1;
    nicknameCheckSequenceRef.current = sequence;
    if (!nicknameTarget || nicknameComposing || entryBusy) return;
    const validation = validateCharacterNickname(nicknameDraft);
    if (!validation.ok) {
      const resetTimer = window.setTimeout(
        () => setNicknameAvailability("idle"),
        0,
      );
      return () => window.clearTimeout(resetTimer);
    }
    const duplicateOnDevice = slotNicknames.some((nickname, index) =>
      index + 1 !== nicknameTarget.slot &&
      characterNicknameKey(nickname) === validation.nicknameKey,
    );
    if (duplicateOnDevice) {
      const duplicateTimer = window.setTimeout(
        () => setNicknameAvailability("taken"),
        0,
      );
      return () => window.clearTimeout(duplicateTimer);
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setNicknameAvailability("checking");
      void checkCharacterNicknameAvailability(
        nicknameTarget.slot,
        validation.nickname,
        controller.signal,
      )
        .then((result) => {
          if (nicknameCheckSequenceRef.current !== sequence) return;
          setNicknameAuthority(result.authority);
          setNicknameAvailability(
            !result.available
              ? "taken"
              : result.authority === "account"
                ? "available"
                : "device",
          );
        })
        .catch((error) => {
          if (error instanceof DOMException && error.name === "AbortError") return;
          if (nicknameCheckSequenceRef.current === sequence) {
            setNicknameAvailability("error");
          }
        });
    }, 350);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [
    entryBusy,
    nicknameComposing,
    nicknameDraft,
    nicknameTarget,
    slotNicknames,
  ]);

  const selectedSummary = useMemo(
    () =>
      selectedSlot === null
        ? null
        : summaries[SAVE_SLOT_IDS.indexOf(selectedSlot)] ?? null,
    [selectedSlot, summaries],
  );
  const selectedNickname =
    selectedSlot === null
      ? null
      : slotNicknames[SAVE_SLOT_IDS.indexOf(selectedSlot)] ?? null;

  const recoveryBySlot = useMemo(() => {
    const next = new Map<SaveSlotId, SaveRecoveryCandidate>();
    for (const candidate of recoveryCandidates) {
      if (!next.has(candidate.slot)) next.set(candidate.slot, candidate);
    }
    return next;
  }, [recoveryCandidates]);

  const selectedRecovery =
    selectedSlot === null ? null : recoveryBySlot.get(selectedSlot) ?? null;
  const selectedHasUnreadableData =
    selectedSlot !== null &&
    selectedSummary === null &&
    slotHasData[SAVE_SLOT_IDS.indexOf(selectedSlot)];
  const modalOpen = deleteTarget !== null || nicknameTarget !== null;

  const restoreRecovery = useCallback(
    (candidate: SaveRecoveryCandidate) => {
      if (
        !restoreSaveRecoveryCandidate(
          candidate.slot,
          candidate.generation,
          candidate.slot,
        )
      ) {
        setRecoveryError(
          "보호된 기록을 복구하지 못했습니다. 기존 데이터는 변경하지 않았습니다.",
        );
        return null;
      }
      setRecoveryError(null);
      refreshSummaries();
      return readSaveSlot(candidate.slot);
    },
    [refreshSummaries],
  );

  const openNicknameDialog = useCallback(
    (
      target: PendingCharacterEntry,
      initialError: string | null = null,
      initialAvailability: NicknameAvailability = "idle",
      initialNickname?: string,
    ) => {
      const currentNickname =
        initialNickname ??
        slotNicknames[SAVE_SLOT_IDS.indexOf(target.slot)] ??
        "";
      setNicknameTarget(target);
      setNicknameDraft(currentNickname);
      setNicknameError(initialError);
      setNicknameAvailability(initialAvailability);
    },
    [slotNicknames],
  );

  useEffect(() => {
    if (!ready || nicknameRejection === null) return;
    const timer = window.setTimeout(() => {
      const save = readSaveSlot(nicknameRejection.slot);
      setSelectedSlot(nicknameRejection.slot);
      nicknameTriggerRef.current = null;
      openNicknameDialog(
        {
          slot: nicknameRejection.slot,
          occupied: save !== null,
          save,
        },
        nicknameErrorMessage(nicknameRejection.code),
        nicknameRejection.code === "nickname_taken" ? "taken" : "idle",
        nicknameRejection.nickname,
      );
      onNicknameRejectionHandled?.();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [
    nicknameRejection,
    onNicknameRejectionHandled,
    openNicknameDialog,
    ready,
  ]);

  const claimAndEnter = useCallback(
    async (target: PendingCharacterEntry, nickname: string) => {
      setEntryBusy(true);
      setNicknameError(null);
      try {
        const claimed = await claimCharacterNickname(target.slot, nickname);
        setNicknameAuthority(claimed.authority);
        const mirroredLocally = writeCharacterNickname(
          target.slot,
          claimed.nickname,
        );
        if (!mirroredLocally && claimed.authority === "device") {
          throw new CharacterNicknameRequestError("nickname_storage_failed");
        }
        setSlotNicknames((current) =>
          current.map((value, index) =>
            index + 1 === target.slot ? claimed.nickname : value,
          ),
        );
        writeActiveSaveSlot(target.slot);
        setNicknameTarget(null);
        onEnter({
          slot: target.slot,
          occupied: target.occupied,
          displayName: claimed.nickname,
          save: target.save,
        });
        return true;
      } catch (error) {
        const code =
          error instanceof CharacterNicknameRequestError
            ? error.code
            : "nickname_claim_failed";
        openNicknameDialog(
          target,
          nicknameErrorMessage(code),
          code === "nickname_taken" ? "taken" : "error",
        );
        window.requestAnimationFrame(() => nicknameInputRef.current?.focus());
        return false;
      } finally {
        setEntryBusy(false);
      }
    },
    [onEnter, openNicknameDialog],
  );

  const beginCharacterEntry = useCallback(
    (target: PendingCharacterEntry, trigger?: HTMLElement | null) => {
      if (!ready || entryBusy) return;
      nicknameTriggerRef.current = trigger ?? null;
      const nickname =
        slotNicknames[SAVE_SLOT_IDS.indexOf(target.slot)] ?? null;
      if (!nickname) {
        openNicknameDialog(target);
        return;
      }
      void claimAndEnter(target, nickname);
    },
    [claimAndEnter, entryBusy, openNicknameDialog, ready, slotNicknames],
  );

  const enterSelectedCharacter = useCallback(
    (trigger?: HTMLElement | null) => {
      if (!ready || selectedSlot === null || selectedHasUnreadableData) return;
      if (selectedSummary === null && selectedRecovery) {
        const restoredSave = restoreRecovery(selectedRecovery);
        if (!restoredSave) return;
        beginCharacterEntry(
          { slot: selectedSlot, occupied: true, save: restoredSave },
          trigger,
        );
        return;
      }
      const selectedSave = readSaveSlot(selectedSlot);
      beginCharacterEntry(
        {
          slot: selectedSlot,
          occupied: selectedSave !== null,
          save: selectedSave,
        },
        trigger,
      );
    },
    [
      beginCharacterEntry,
      ready,
      restoreRecovery,
      selectedHasUnreadableData,
      selectedRecovery,
      selectedSlot,
      selectedSummary,
    ],
  );

  const enterFreshCharacter = useCallback(
    (slot: SaveSlotId, trigger?: HTMLElement | null) => {
      setRecoveryError(null);
      beginCharacterEntry({ slot, occupied: false, save: null }, trigger);
    },
    [beginCharacterEntry],
  );

  const submitNickname = useCallback(async () => {
    if (!nicknameTarget || nicknameComposing || entryBusy) return;
    const validation = validateCharacterNickname(nicknameDraft);
    if (!validation.ok) {
      setNicknameError(nicknameErrorMessage(validation.code));
      setNicknameAvailability("idle");
      nicknameInputRef.current?.focus();
      return;
    }
    const duplicateOnDevice = slotNicknames.some((nickname, index) =>
      index + 1 !== nicknameTarget.slot &&
      characterNicknameKey(nickname) === validation.nicknameKey,
    );
    if (duplicateOnDevice || nicknameAvailability === "taken") {
      setNicknameError(nicknameErrorMessage("nickname_taken"));
      setNicknameAvailability("taken");
      nicknameInputRef.current?.focus();
      return;
    }
    await claimAndEnter(nicknameTarget, validation.nickname);
  }, [
    claimAndEnter,
    entryBusy,
    nicknameAvailability,
    nicknameComposing,
    nicknameDraft,
    nicknameTarget,
    slotNicknames,
  ]);

  const deleteCharacterRecord = useCallback(() => {
    if (deleteTarget === null) return;
    if (!removeSaveSlot(deleteTarget)) {
      setDeleteError("저장소에 접근할 수 없어 원정 기록을 삭제하지 못했습니다.");
      return;
    }
    setDeleteTarget(null);
    setDeleteError(null);
    refreshSummaries();
  }, [deleteTarget, refreshSummaries]);

  const nicknameLength = Array.from(nicknameDraft.normalize("NFKC")).length;
  const nicknameStatusCopy =
    nicknameAvailability === "checking"
      ? "서버에서 중복 여부를 확인하고 있습니다…"
      : nicknameAvailability === "available"
        ? "사용할 수 있습니다. 이 계정의 캐릭터로 전역 예약됩니다."
        : nicknameAvailability === "device"
          ? "사용할 수 있습니다. Steam 연동 전에는 이 기기의 3개 슬롯에서 보호됩니다."
          : nicknameAvailability === "taken"
            ? "이미 사용 중인 닉네임입니다."
            : nicknameAvailability === "error"
              ? "중복 확인이 지연되고 있습니다. 확정할 때 다시 검사합니다."
              : "2~12자 · 첫 글자 한글/영문 · 이후 한글/영문/숫자";

  return (
    <main className="character-entry" data-character-entry-state={ready ? "ready" : "loading"}>
      <div className="character-entry-backdrop" aria-hidden="true" />
      <div className="character-entry-vignette" aria-hidden="true" />
      <header
        className="character-entry-header"
        inert={modalOpen}
        aria-hidden={modalOpen}
      >
        <span>MUJINDO · ACCOUNT ARCHIVE</span>
        <h1>캐릭터 선택</h1>
        <p>
          Steam 프로필명과 캐릭터 닉네임은 별개입니다. 계정은 소유권만 증명하고,
          세 슬롯의 캐릭터 이름은 각각 생성할 때 정합니다.
        </p>
      </header>

      <section
        className="character-entry-panel"
        aria-busy={!ready || entryBusy}
        inert={modalOpen}
        aria-hidden={modalOpen}
      >
        <div className="character-entry-account">
          <div>
            <small>플랫폼 계정</small>
            <strong>{accountName?.trim() || "게스트 기록 보관함"}</strong>
          </div>
          <span>
            {ready
              ? nicknameAuthority === "account"
                ? "계정 귀속 · 3개 캐릭터 슬롯"
                : "기기 보관 · Steam 연동 시 서버 확정"
              : "캐릭터 신원 확인 중…"}
          </span>
        </div>

        <div className="character-entry-grid" aria-label="캐릭터 저장 슬롯">
          {SAVE_SLOT_IDS.map((slot, index) => {
            const summary = summaries[index];
            const nickname = slotNicknames[index];
            const recovery = recoveryBySlot.get(slot) ?? null;
            const unreadable = !summary && slotHasData[index];
            const selected = selectedSlot === slot;
            const registered = Boolean(nickname);
            const state = summary
              ? "occupied"
              : recovery
                ? "recoverable"
                : unreadable
                  ? "unreadable"
                  : registered
                    ? "registered"
                    : "empty";
            return (
              <article
                key={slot}
                className={`character-entry-card is-${state} ${selected ? "is-selected" : ""}`}
                data-character-slot={slot}
                data-save-state={state}
              >
                <button
                  type="button"
                  className="character-entry-card-select"
                  aria-pressed={selected}
                  aria-label={`${slot}번 ${nickname ? `${nickname} 캐릭터` : summary ? "이름 설정이 필요한 캐릭터" : recovery ? "복구 가능한 캐릭터" : unreadable ? "보호 중인 손상 기록" : "빈 캐릭터 슬롯"} 선택`}
                  disabled={!ready || entryBusy}
                  onClick={() => setSelectedSlot(slot)}
                  onDoubleClick={(event) => {
                    setSelectedSlot(slot);
                    if (unreadable) return;
                    if (recovery && !summary) {
                      const restoredSave = restoreRecovery(recovery);
                      if (!restoredSave) return;
                      beginCharacterEntry(
                        { slot, occupied: true, save: restoredSave },
                        event.currentTarget,
                      );
                      return;
                    }
                    const selectedSave = readSaveSlot(slot);
                    beginCharacterEntry(
                      {
                        slot,
                        occupied: selectedSave !== null,
                        save: selectedSave,
                      },
                      event.currentTarget,
                    );
                  }}
                >
                  <span className="character-entry-card-number">SLOT {String(slot).padStart(2, "0")}</span>
                  <span className="character-entry-portrait" aria-hidden="true"><i /></span>
                  <span className="character-entry-card-copy">
                    <strong>{nickname || `이름 설정 필요 · SLOT ${String(slot).padStart(2, "0")}`}</strong>
                    {summary ? (
                      <>
                        <b>{characterProfession(summary)} · LV.{summary.level}</b>
                        <small>지하 {summary.dungeonFloor}층 · 증강 {summary.augmentStacks}스택</small>
                        <small>장착 {summary.equippedItems} · 가방 {summary.inventoryItems}</small>
                        <time dateTime={validSavedAt(summary.savedAt)?.toISOString()}>
                          마지막 기록 {formatSavedAt(summary.savedAt)}
                        </time>
                      </>
                    ) : recovery ? (
                      <>
                        <b>RECOVERY AVAILABLE · LV.{recovery.summary.level}</b>
                        <small>삭제·덮어쓰기 전 마지막 보호본이 남아 있습니다.</small>
                        <time dateTime={validSavedAt(recovery.summary.savedAt)?.toISOString()}>
                          보호 시점 {formatSavedAt(recovery.summary.savedAt)}
                        </time>
                      </>
                    ) : unreadable ? (
                      <>
                        <b>RECORD PROTECTED</b>
                        <small>원본 형식 확인이 필요해 새 원정 생성을 차단했습니다.</small>
                        <time>기록은 삭제되지 않았습니다.</time>
                      </>
                    ) : registered ? (
                      <>
                        <b>REGISTERED CHARACTER</b>
                        <small>캐릭터 신원은 유지되고 이 기기의 원정 기록은 비어 있습니다.</small>
                        <time>새 원정 준비 완료</time>
                      </>
                    ) : (
                      <>
                        <b>NEW CHARACTER</b>
                        <small>닉네임을 정한 뒤 새로운 캐릭터를 생성합니다.</small>
                        <time>저장된 기억 없음</time>
                      </>
                    )}
                  </span>
                  <span className="character-entry-check" aria-hidden="true">✓</span>
                </button>
                {(summary || unreadable) && (
                  <button
                    type="button"
                    className="character-entry-delete"
                    aria-label={`${slot}번 캐릭터의 이 기기 원정 기록 삭제`}
                    onClick={(event) => {
                      deleteTriggerRef.current = event.currentTarget;
                      setDeleteError(null);
                      setDeleteTarget(slot);
                    }}
                  >
                    원정 기록 삭제
                  </button>
                )}
                {!summary && recovery && (
                  <button
                    type="button"
                    className="character-entry-new-run"
                    onClick={(event) => enterFreshCharacter(slot, event.currentTarget)}
                  >
                    보호본 유지 · 새 원정
                  </button>
                )}
              </article>
            );
          })}
        </div>

        <footer className="character-entry-footer">
          <p>
            {selectedSlot === null
              ? "입장할 캐릭터를 선택하세요."
              : selectedHasUnreadableData
                ? `SLOT ${String(selectedSlot).padStart(2, "0")} · 원본 보호 중 (새 원정 차단)`
                : selectedNickname
                  ? `SLOT ${String(selectedSlot).padStart(2, "0")} · ${selectedNickname} 선택됨`
                  : `SLOT ${String(selectedSlot).padStart(2, "0")} · 닉네임 설정 필요`}
          </p>
          {recoveryError ? <p className="character-entry-recovery-error" role="alert">{recoveryError}</p> : null}
          <button
            type="button"
            className="character-entry-confirm"
            disabled={!ready || entryBusy || selectedSlot === null || selectedHasUnreadableData}
            onClick={(event) => enterSelectedCharacter(event.currentTarget)}
          >
            <span>
              {entryBusy
                ? "캐릭터 신원 확인 중…"
                : selectedSummary
                  ? selectedNickname
                    ? "선택한 캐릭터로 입장"
                    : "닉네임 설정 후 입장"
                  : selectedRecovery
                    ? `LV.${selectedRecovery.summary.level} 보호본 복구 후 입장`
                    : selectedHasUnreadableData
                      ? "원본 기록 보호 중"
                      : selectedNickname
                        ? "새 원정 시작"
                        : "닉네임 설정 · 캐릭터 생성"}
            </span>
            <small>마을 광장으로 이동</small>
          </button>
        </footer>
      </section>

      <p className="character-entry-hint" inert={modalOpen} aria-hidden={modalOpen}>
        빈 슬롯과 기존 무명 캐릭터는 닉네임 확정 후 입장합니다.
      </p>

      {nicknameTarget !== null && (
        <div className="character-entry-dialog-backdrop" role="presentation">
          <section
            ref={nicknameDialogRef}
            className="character-entry-dialog character-nickname-dialog"
            role="dialog"
            aria-modal="true"
            aria-busy={entryBusy}
            aria-labelledby="character-nickname-title"
            aria-describedby="character-nickname-description character-nickname-rules character-nickname-status"
          >
            <small>CHARACTER INSCRIPTION · SLOT {String(nicknameTarget.slot).padStart(2, "0")}</small>
            <h2 id="character-nickname-title">캐릭터 닉네임 설정</h2>
            <p id="character-nickname-description">
              Steam 프로필명은 자동 사용하지 않습니다. 이 이름은 캐릭터에만 표시되며,
              Steam 연동 계정에서는 서버 전체 중복 검사를 거쳐 고유하게 예약됩니다.
            </p>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (!nicknameComposing) void submitNickname();
              }}
            >
              <label htmlFor="character-nickname-input">캐릭터 닉네임</label>
              <div className="character-nickname-field">
                <input
                  ref={nicknameInputRef}
                  id="character-nickname-input"
                  value={nicknameDraft}
                  maxLength={CHARACTER_NICKNAME_MAX_LENGTH}
                  disabled={entryBusy}
                  spellCheck={false}
                  autoCapitalize="none"
                  autoComplete="off"
                  enterKeyHint="done"
                  aria-invalid={Boolean(nicknameError) || nicknameAvailability === "taken"}
                  aria-describedby="character-nickname-rules character-nickname-status character-nickname-error"
                  onCompositionStart={() => setNicknameComposing(true)}
                  onCompositionEnd={(event) => {
                    setNicknameComposing(false);
                    setNicknameDraft(event.currentTarget.value);
                  }}
                  onChange={(event) => {
                    setNicknameDraft(event.target.value);
                    setNicknameError(null);
                    setNicknameAvailability("idle");
                  }}
                />
                <span aria-label={`${nicknameLength} / ${CHARACTER_NICKNAME_MAX_LENGTH}자`}>
                  {nicknameLength}/{CHARACTER_NICKNAME_MAX_LENGTH}
                </span>
              </div>
              <p id="character-nickname-rules" className="character-nickname-rules">
                영문 대소문자·전각 문자·조합형 한글은 같은 이름으로 판정합니다.
              </p>
              <p
                id="character-nickname-status"
                className={`character-nickname-status is-${nicknameAvailability}`}
                role="status"
                aria-live="polite"
                aria-atomic="true"
              >
                {nicknameStatusCopy}
              </p>
              <p id="character-nickname-error" className="character-entry-dialog-error" role={nicknameError ? "alert" : undefined}>
                {nicknameError ?? ""}
              </p>
              <div>
                <button
                  type="button"
                  disabled={entryBusy}
                  onClick={() => setNicknameTarget(null)}
                >
                  취소
                </button>
                <button
                  type="submit"
                  className="is-confirm"
                  disabled={entryBusy || nicknameComposing || nicknameAvailability === "checking" || nicknameAvailability === "taken"}
                >
                  {entryBusy ? "고유성 확정 중…" : "이 이름으로 생성"}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}

      {deleteTarget !== null && (
        <div className="character-entry-dialog-backdrop" role="presentation">
          <section
            ref={deleteDialogRef}
            className="character-entry-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="character-delete-title"
            aria-describedby="character-delete-description"
          >
            <small>LOCAL RECORD ERASURE</small>
            <h2 id="character-delete-title">{deleteTarget}번 캐릭터의 원정 기록을 삭제할까요?</h2>
            <p id="character-delete-description">
              이 기기의 활성 원정 기록만 지우며 마지막 보호본과 캐릭터 닉네임·계정 귀속은
              유지합니다. 다른 두 캐릭터의 데이터에는 영향을 주지 않습니다.
            </p>
            {deleteError ? <p className="character-entry-dialog-error" role="alert">{deleteError}</p> : null}
            <div>
              <button type="button" onClick={() => setDeleteTarget(null)} autoFocus>취소</button>
              <button type="button" className="is-danger" onClick={deleteCharacterRecord}>원정 기록 삭제</button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
