"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PROFESSION_TITLES } from "./professions";
import {
  SAVE_SLOT_IDS,
  migrateLegacySave,
  readActiveSaveSlot,
  readSaveSlotSummaries,
  removeSaveSlot,
  writeActiveSaveSlot,
  type SaveSlotId,
  type SaveSlotSummary,
} from "./save-slots";
import "./character-entry.css";

type CharacterEntryGateProps = {
  accountName?: string | null;
  onEnter: (selection: CharacterEntrySelection) => void;
};

export type CharacterEntrySelection = {
  slot: SaveSlotId;
  occupied: boolean;
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
  const deleteDialogRef = useRef<HTMLElement | null>(null);
  const deleteTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [summaries, setSummaries] = useState<Array<SaveSlotSummary | null>>(() =>
    SAVE_SLOT_IDS.map(() => null),
  );

  const refreshSummaries = useCallback(() => {
    setSummaries(readSaveSlotSummaries());
  }, []);

  useEffect(() => {
    // The legacy record is copied, never moved, and an occupied slot 1 is never
    // overwritten. Character selection therefore preserves the existing
    // three-slot migration contract before exposing an entry action.
    migrateLegacySave();
    const restoreTimer = window.setTimeout(() => {
      setSummaries(readSaveSlotSummaries());
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

  const enterSelectedCharacter = useCallback(() => {
    if (!ready || selectedSlot === null) return;
    writeActiveSaveSlot(selectedSlot);
    onEnter({ slot: selectedSlot, occupied: selectedSummary !== null });
  }, [onEnter, ready, selectedSlot, selectedSummary]);

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
            const selected = selectedSlot === slot;
            return (
              <article
                key={slot}
                className={`character-entry-card ${summary ? "is-occupied" : "is-empty"} ${selected ? "is-selected" : ""}`}
                data-character-slot={slot}
                data-save-state={summary ? "occupied" : "empty"}
              >
                <button
                  type="button"
                  className="character-entry-card-select"
                  aria-pressed={selected}
                  aria-label={`${slot}번 ${summary ? "캐릭터" : "빈 캐릭터 슬롯"} 선택`}
                  disabled={!ready}
                  onClick={() => setSelectedSlot(slot)}
                  onDoubleClick={() => {
                    setSelectedSlot(slot);
                    writeActiveSaveSlot(slot);
                    onEnter({ slot, occupied: summary !== null });
                  }}
                >
                  <span className="character-entry-card-number">SLOT {String(slot).padStart(2, "0")}</span>
                  <span className="character-entry-portrait" aria-hidden="true">
                    <i />
                  </span>
                  <span className="character-entry-card-copy">
                    <strong>{characterTitle(summary, slot)}</strong>
                    {summary ? (
                      <>
                        <b>LV.{summary.level}</b>
                        <small>방 돌파 {summary.roomsCleared} · 증강 {summary.augmentStacks}스택</small>
                        <small>장착 {summary.equippedItems} · 가방 {summary.inventoryItems}</small>
                        <time dateTime={validSavedAt(summary.savedAt)?.toISOString()}>
                          마지막 기록 {formatSavedAt(summary.savedAt)}
                        </time>
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
                {summary && (
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
                : `SLOT ${String(selectedSlot).padStart(2, "0")} · 새 캐릭터 생성`}
          </p>
          <button
            type="button"
            className="character-entry-confirm"
            disabled={!ready || selectedSlot === null}
            onClick={enterSelectedCharacter}
          >
            <span>{selectedSummary ? "선택한 캐릭터로 입장" : "새 캐릭터 생성 후 입장"}</span>
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
              이 슬롯의 원정 기록은 되돌릴 수 없습니다. 다른 두 캐릭터의 저장 데이터에는
              영향을 주지 않습니다.
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
