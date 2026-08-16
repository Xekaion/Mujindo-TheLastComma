"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  type SaveSlotId,
  type SaveSlotSummary,
  type SaveRunPayload,
} from "./save-slots";
import "./character-entry.css";

type CharacterEntryGateProps = {
  accountName?: string | null;
  onEnter: (selection: CharacterEntrySelection) => void;
};

export type CharacterEntrySelection = {
  slot: SaveSlotId;
  occupied: boolean;
  /** Exact validated snapshot selected by the card; plaza must not re-resolve it. */
  save: SaveRunPayload | null;
};

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

const characterTitle = (summary: SaveSlotSummary | null, slot: SaveSlotId) => {
  if (!summary) return `새 캐릭터 ${String(slot).padStart(2, "0")}`;
  if (summary.profession) {
    return PROFESSION_TITLES[summary.profession] ?? summary.profession;
  }
  return "미전직 방랑자";
};

export default function CharacterEntryGate({
  accountName,
  onEnter,
}: CharacterEntryGateProps) {
  const [ready, setReady] = useState(false);
  const [selectedSlot, setSelectedSlot] = useState<SaveSlotId | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SaveSlotId | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const deleteDialogRef = useRef<HTMLElement | null>(null);
  const deleteTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [summaries, setSummaries] = useState<Array<SaveSlotSummary | null>>(() =>
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
    setSlotHasData(SAVE_SLOT_IDS.map((slot) => hasSaveSlotData(slot)));
    setRecoveryCandidates(readSaveRecoveryCandidates());
  }, []);

  useEffect(() => {
    // The legacy record is copied, never moved, and an occupied slot 1 is never
    // overwritten. Character selection therefore preserves the existing
    // three-slot migration contract before exposing an entry action.
    migrateLegacySave();
    const restoreTimer = window.setTimeout(() => {
      setSummaries(readSaveSlotSummaries());
      setSlotHasData(SAVE_SLOT_IDS.map((slot) => hasSaveSlotData(slot)));
      setRecoveryCandidates(readSaveRecoveryCandidates());
      setSelectedSlot(readActiveSaveSlot());
      setReady(true);
    }, 0);
    return () => window.clearTimeout(restoreTimer);
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
      const dialog = deleteDialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLButtonElement>("button:not([disabled])"),
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
        if (restoreTarget?.isConnected) {
          restoreTarget.focus({ preventScroll: true });
          return;
        }
        document
          .querySelector<HTMLButtonElement>(".character-entry-card-select[aria-pressed='true']")
          ?.focus({ preventScroll: true });
      });
    };
  }, [deleteTarget]);

  const selectedSummary = useMemo(
    () =>
      selectedSlot === null
        ? null
        : summaries[SAVE_SLOT_IDS.indexOf(selectedSlot)] ?? null,
    [selectedSlot, summaries],
  );

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
        return false;
      }
      setRecoveryError(null);
      refreshSummaries();
      return true;
    },
    [refreshSummaries],
  );

  const enterSelectedCharacter = useCallback(() => {
    if (!ready || selectedSlot === null) return;
    if (selectedHasUnreadableData) return;
    if (selectedSummary === null && selectedRecovery) {
      if (!restoreRecovery(selectedRecovery)) return;
      writeActiveSaveSlot(selectedSlot);
      const restoredSave = readSaveSlot(selectedSlot);
      if (!restoredSave) return;
      onEnter({ slot: selectedSlot, occupied: true, save: restoredSave });
      return;
    }
    writeActiveSaveSlot(selectedSlot);
    const selectedSave = readSaveSlot(selectedSlot);
    onEnter({
      slot: selectedSlot,
      occupied: selectedSave !== null,
      save: selectedSave,
    });
  }, [
    onEnter,
    ready,
    restoreRecovery,
    selectedHasUnreadableData,
    selectedRecovery,
    selectedSlot,
    selectedSummary,
  ]);

  const enterFreshCharacter = useCallback(
    (slot: SaveSlotId) => {
      setRecoveryError(null);
      writeActiveSaveSlot(slot);
      onEnter({ slot, occupied: false, save: null });
    },
    [onEnter],
  );

  const deleteCharacter = useCallback(() => {
    if (deleteTarget === null) return;
    if (!removeSaveSlot(deleteTarget)) {
      setDeleteError("저장소에 접근할 수 없어 캐릭터를 삭제하지 못했습니다.");
      return;
    }
    setDeleteTarget(null);
    setDeleteError(null);
    refreshSummaries();
  }, [deleteTarget, refreshSummaries]);

  return (
    <main className="character-entry" data-character-entry-state={ready ? "ready" : "loading"}>
      <div className="character-entry-backdrop" aria-hidden="true" />
      <div className="character-entry-vignette" aria-hidden="true" />
      <header
        className="character-entry-header"
        inert={deleteTarget !== null}
        aria-hidden={deleteTarget !== null}
      >
        <span>MUJINDO · ACCOUNT ARCHIVE</span>
        <h1>캐릭터 선택</h1>
        <p>
          원정에 사용할 기억 기록을 먼저 선택하세요. 선택한 캐릭터의 장비·증강·재화가
          마을과 모든 포탈에서 동일하게 이어집니다.
        </p>
      </header>

      <section
        className="character-entry-panel"
        aria-busy={!ready}
        inert={deleteTarget !== null}
        aria-hidden={deleteTarget !== null}
      >
        <div className="character-entry-account">
          <div>
            <small>접속 계정</small>
            <strong>{accountName?.trim() || "이름 없는 기록자"}</strong>
          </div>
          <span>{ready ? "3개 캐릭터 슬롯 동기화 완료" : "기억 기록 확인 중…"}</span>
        </div>

        <div className="character-entry-grid" aria-label="캐릭터 저장 슬롯">
          {SAVE_SLOT_IDS.map((slot, index) => {
            const summary = summaries[index];
            const recovery = recoveryBySlot.get(slot) ?? null;
            const unreadable = !summary && slotHasData[index];
            const selected = selectedSlot === slot;
            return (
              <article
                key={slot}
                className={`character-entry-card ${summary ? "is-occupied" : recovery ? "is-recoverable" : unreadable ? "is-unreadable" : "is-empty"} ${selected ? "is-selected" : ""}`}
                data-character-slot={slot}
                data-save-state={summary ? "occupied" : recovery ? "recoverable" : unreadable ? "unreadable" : "empty"}
              >
                <button
                  type="button"
                  className="character-entry-card-select"
                  aria-pressed={selected}
                  aria-label={`${slot}번 ${summary ? "캐릭터" : recovery ? "복구 가능한 캐릭터" : unreadable ? "보호 중인 손상 기록" : "빈 캐릭터 슬롯"} 선택`}
                  disabled={!ready}
                  onClick={() => setSelectedSlot(slot)}
                  onDoubleClick={() => {
                    setSelectedSlot(slot);
                    if (unreadable) return;
                    if (recovery) {
                      if (!restoreRecovery(recovery)) return;
                      writeActiveSaveSlot(slot);
                      const restoredSave = readSaveSlot(slot);
                      if (!restoredSave) return;
                      onEnter({ slot, occupied: true, save: restoredSave });
                      return;
                    }
                    writeActiveSaveSlot(slot);
                    const selectedSave = readSaveSlot(slot);
                    onEnter({
                      slot,
                      occupied: selectedSave !== null,
                      save: selectedSave,
                    });
                  }}
                >
                  <span className="character-entry-card-number">SLOT {String(slot).padStart(2, "0")}</span>
                  <span className="character-entry-portrait" aria-hidden="true">
                    <i />
                  </span>
                  <span className="character-entry-card-copy">
                    <strong>{characterTitle(summary ?? recovery?.summary ?? null, slot)}</strong>
                    {summary ? (
                      <>
                        <b>LV.{summary.level}</b>
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
                        <small>원본 형식 확인이 필요해 새 캐릭터 생성을 차단했습니다.</small>
                        <time>기록은 삭제되지 않았습니다.</time>
                      </>
                    ) : (
                      <>
                        <b>NEW CHARACTER</b>
                        <small>새로운 원정 기록을 생성합니다.</small>
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
                    aria-label={`${slot}번 캐릭터 삭제`}
                    onClick={(event) => {
                      deleteTriggerRef.current = event.currentTarget;
                      setDeleteError(null);
                      setDeleteTarget(slot);
                    }}
                  >
                    기록 삭제
                  </button>
                )}
                {!summary && recovery && (
                  <button
                    type="button"
                    className="character-entry-new-run"
                    onClick={() => enterFreshCharacter(slot)}
                  >
                    보호본 유지 · 새 캐릭터
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
              : selectedSummary
                ? `SLOT ${String(selectedSlot).padStart(2, "0")} · ${characterTitle(selectedSummary, selectedSlot)} 선택됨`
                : selectedRecovery
                  ? `SLOT ${String(selectedSlot).padStart(2, "0")} · LV.${selectedRecovery.summary.level} 보호본 복구 가능`
                  : selectedHasUnreadableData
                    ? `SLOT ${String(selectedSlot).padStart(2, "0")} · 원본 보호 중 (새 캐릭터 생성 차단)`
                : `SLOT ${String(selectedSlot).padStart(2, "0")} · 새 캐릭터 생성`}
          </p>
          {recoveryError ? (
            <p className="character-entry-recovery-error" role="alert">
              {recoveryError}
            </p>
          ) : null}
          <button
            type="button"
            className="character-entry-confirm"
            disabled={!ready || selectedSlot === null || selectedHasUnreadableData}
            onClick={enterSelectedCharacter}
          >
            <span>
              {selectedSummary
                ? "선택한 캐릭터로 입장"
                : selectedRecovery
                  ? `LV.${selectedRecovery.summary.level} 보호본 복구 후 입장`
                  : selectedHasUnreadableData
                    ? "원본 기록 보호 중"
                    : "새 캐릭터 생성 후 입장"}
            </span>
            <small>마을 광장으로 이동</small>
          </button>
        </footer>
      </section>

      <p
        className="character-entry-hint"
        inert={deleteTarget !== null}
        aria-hidden={deleteTarget !== null}
      >
        카드를 두 번 클릭하면 바로 입장할 수 있습니다.
      </p>

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
            <small>RECORD ERASURE</small>
            <h2 id="character-delete-title">{deleteTarget}번 캐릭터를 삭제할까요?</h2>
            <p id="character-delete-description">
              활성 원정 기록은 지워지지만 마지막 보호본은 남습니다. 다른 두 캐릭터의 저장
              데이터에는 영향을 주지 않습니다.
            </p>
            {deleteError ? <p className="character-entry-dialog-error" role="alert">{deleteError}</p> : null}
            <div>
              <button type="button" onClick={() => setDeleteTarget(null)} autoFocus>취소</button>
              <button type="button" className="is-danger" onClick={deleteCharacter}>캐릭터 삭제</button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
