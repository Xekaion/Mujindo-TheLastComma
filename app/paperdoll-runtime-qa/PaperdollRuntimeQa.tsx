"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import PlazaHub, { type PlazaPaperdollQaPose } from "../PlazaHub";
import { EQUIPMENT_SLOTS } from "../equipment";
import {
  PAPERDOLL_RUNTIME_QA_DIRECTION_COUNT,
  PAPERDOLL_RUNTIME_QA_FRAME_COUNT,
  PAPERDOLL_RUNTIME_QA_COMPOSITE_BUILDS,
  PAPERDOLL_RUNTIME_QA_COMPOSITE_TOTAL,
  PAPERDOLL_RUNTIME_QA_TOTAL,
  PAPERDOLL_RUNTIME_QA_VARIANT_COUNT,
  createPaperdollRuntimeQaCompositeEquipment,
  createPaperdollRuntimeQaEquipment,
  nextPaperdollRuntimeQaCompositeIndex,
  nextPaperdollRuntimeQaIndex,
  normalizePaperdollRuntimeQaCompositeIndex,
  normalizePaperdollRuntimeQaIndex,
  paperdollRuntimeQaCompositeIndexFor,
  paperdollRuntimeQaCompositeStateAt,
  paperdollRuntimeQaIndexFor,
  paperdollRuntimeQaStateAt,
  type PaperdollRuntimeQaMode,
} from "../paperdoll-runtime-qa";
import "./paperdoll-runtime-qa.css";

const DIRECTION_LABELS = ["S", "SW", "W", "NW", "N", "NE", "E", "SE"] as const;
const FRAME_LABELS = [
  "left contact",
  "neutral passing",
  "right contact",
  "neutral return",
] as const;

type PaperdollRuntimeQaProps = Readonly<{
  initialIndex: number;
  initialAutorun: boolean;
  mode: PaperdollRuntimeQaMode;
}>;

type PaperdollRuntimeQaPassStatus =
  | "idle"
  | "running"
  | "complete"
  | "failed"
  | "stopped";

type PaperdollRuntimeQaPass = Readonly<{
  status: PaperdollRuntimeQaPassStatus;
  runId: number;
  verifiedCount: number;
  duplicateCount: number;
  timeoutCount: number;
  visibleDirectionGroupCount: number;
  lastVerifiedKey: string;
  failure: string;
  stopReason: string;
}>;

const PAPERDOLL_RUNTIME_QA_POSE_TIMEOUT_MS = 8_000;
const PAPERDOLL_RUNTIME_QA_DIRECTION_GROUP_TOTAL =
  PAPERDOLL_RUNTIME_QA_TOTAL / PAPERDOLL_RUNTIME_QA_FRAME_COUNT;

export default function PaperdollRuntimeQa({
  initialIndex,
  initialAutorun,
  mode,
}: PaperdollRuntimeQaProps) {
  const compositeMode = mode === "composite";
  const total = compositeMode
    ? PAPERDOLL_RUNTIME_QA_COMPOSITE_TOTAL
    : PAPERDOLL_RUNTIME_QA_TOTAL;
  const expectedLayerCount = compositeMode ? EQUIPMENT_SLOTS.length : 1;
  const normalizeIndex = compositeMode
    ? normalizePaperdollRuntimeQaCompositeIndex
    : normalizePaperdollRuntimeQaIndex;
  const qaRootRef = useRef<HTMLElement | null>(null);
  const activeRunIdRef = useRef(initialAutorun ? 1 : 0);
  const verifiedKeysRef = useRef(new Set<string>());
  const visibleDirectionGroupsRef = useRef(new Set<string>());
  const [index, setIndex] = useState(() =>
    initialAutorun ? 0 : normalizeIndex(initialIndex),
  );
  const [jumpDraft, setJumpDraft] = useState(() => String(index + 1));
  const [poseEpoch, setPoseEpoch] = useState(() => initialAutorun ? 1 : 0);
  const [pass, setPass] = useState<PaperdollRuntimeQaPass>(() => ({
    status: initialAutorun ? "running" : "idle",
    runId: initialAutorun ? 1 : 0,
    verifiedCount: 0,
    duplicateCount: 0,
    timeoutCount: 0,
    visibleDirectionGroupCount: 0,
    lastVerifiedKey: "",
    failure: "",
    stopReason: "",
  }));
  const singleState = useMemo(
    () => (compositeMode ? null : paperdollRuntimeQaStateAt(index)),
    [compositeMode, index],
  );
  const compositeState = useMemo(
    () => (compositeMode ? paperdollRuntimeQaCompositeStateAt(index) : null),
    [compositeMode, index],
  );
  const state = singleState ?? compositeState;
  if (!state) throw new Error("Paperdoll runtime QA state is unavailable");
  const singleSlot = singleState?.slot;
  const singleVariant = singleState?.variant;
  const compositeBuildIndex = compositeState?.buildIndex;
  const equipment = useMemo(
    () => {
      if (compositeMode && compositeBuildIndex !== undefined) {
        return createPaperdollRuntimeQaCompositeEquipment(
          PAPERDOLL_RUNTIME_QA_COMPOSITE_BUILDS[compositeBuildIndex].variants,
        );
      }
      if (singleSlot && singleVariant !== undefined) {
        return createPaperdollRuntimeQaEquipment(singleSlot, singleVariant);
      }
      throw new Error("Paperdoll runtime QA equipment state is unavailable");
    },
    [compositeBuildIndex, compositeMode, singleSlot, singleVariant],
  );
  const pose = useMemo<PlazaPaperdollQaPose>(
    () => {
      // Recreate the same first pose when a full pass restarts so PlazaHub's
      // layout effect clears any ready flag left by the previous run.
      void poseEpoch;
      return {
        key: state.key,
        direction: state.direction,
        frame: state.frame,
      };
    },
    [poseEpoch, state.direction, state.frame, state.key],
  );

  useEffect(() => {
    if (pass.status === "running") return;
    const url = new URL(window.location.href);
    url.searchParams.set("index", String(index));
    url.searchParams.delete("slot");
    url.searchParams.delete("variant");
    url.searchParams.delete("direction");
    url.searchParams.delete("frame");
    if (pass.status === "complete" || pass.status === "failed") {
      url.searchParams.set("autorun", "1");
    } else {
      url.searchParams.delete("autorun");
    }
    window.history.replaceState(window.history.state, "", url);
  }, [index, pass.status]);

  useEffect(() => {
    if (pass.status !== "running") return;
    const url = new URL(window.location.href);
    url.searchParams.set("index", "0");
    url.searchParams.set("autorun", "1");
    url.searchParams.delete("slot");
    url.searchParams.delete("variant");
    url.searchParams.delete("direction");
    url.searchParams.delete("frame");
    window.history.replaceState(window.history.state, "", url);
  }, [pass.runId, pass.status]);

  const stopFullPass = (reason: string) => {
    // Invalidate the old observer synchronously. React may not run its effect
    // cleanup until after another mutation microtask has already fired.
    activeRunIdRef.current += 1;
    setPass((current) =>
      current.status === "running"
        ? { ...current, status: "stopped", stopReason: reason }
        : current,
    );
  };

  const navigateTo = (requestedIndex: number, manual = true) => {
    if (manual) stopFullPass("manual-selection");
    const nextIndex = normalizeIndex(requestedIndex);
    setIndex(nextIndex);
    setJumpDraft(String(nextIndex + 1));
  };

  const startFullPass = () => {
    const nextRunId = activeRunIdRef.current + 1;
    activeRunIdRef.current = nextRunId;
    verifiedKeysRef.current = new Set<string>();
    visibleDirectionGroupsRef.current = new Set<string>();
    setIndex(0);
    setJumpDraft("1");
    setPoseEpoch((current) => current + 1);
    setPass(() => ({
      status: "running",
      runId: nextRunId,
      verifiedCount: 0,
      duplicateCount: 0,
      timeoutCount: 0,
      visibleDirectionGroupCount: 0,
      lastVerifiedKey: "",
      failure: "",
      stopReason: "",
    }));
  };

  const selectPose = (
    slot: (typeof EQUIPMENT_SLOTS)[number],
    variant: number,
    direction: number,
    frame: number,
  ) => {
    navigateTo(paperdollRuntimeQaIndexFor(slot, variant, direction, frame));
  };

  const selectCompositePose = (
    buildIndex: number,
    direction: number,
    frame: number,
  ) => {
    navigateTo(
      paperdollRuntimeQaCompositeIndexFor(buildIndex, direction, frame),
    );
  };

  const goPrevious = () => {
    navigateTo(
      index === 0 ? total - 1 : index - 1,
    );
  };
  const goNext = () => {
    navigateTo((index + 1) % total);
  };
  const jumpTo = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const requestedPosition = Number(jumpDraft);
    navigateTo(requestedPosition - 1);
  };

  useEffect(() => {
    if (pass.status !== "running") return;
    const root = qaRootRef.current;
    if (!root) return;
    const expectedKey = state.key;
    const expectedIndex = state.index;
    const runId = pass.runId;
    let settled = false;
    let observer: MutationObserver | null = null;
    let initialCheckFrame = 0;
    let timeoutId = 0;

    const cleanup = () => {
      observer?.disconnect();
      observer = null;
      if (initialCheckFrame) window.cancelAnimationFrame(initialCheckFrame);
      if (timeoutId) window.clearTimeout(timeoutId);
    };
    const fail = (reason: string, kind: "failure" | "duplicate" | "timeout") => {
      if (settled || activeRunIdRef.current !== runId) return;
      settled = true;
      cleanup();
      setPass((current) => {
        if (current.status !== "running" || current.runId !== runId) return current;
        return {
          ...current,
          status: "failed",
          duplicateCount:
            current.duplicateCount + (kind === "duplicate" ? 1 : 0),
          timeoutCount: current.timeoutCount + (kind === "timeout" ? 1 : 0),
          failure: reason,
        };
      });
    };
    const verifyCurrentPose = () => {
      if (settled || activeRunIdRef.current !== runId) return;
      const plaza = root.querySelector<HTMLElement>("main.plaza-hub");
      if (!plaza) return;
      if (root.dataset.qaExpectedKey !== expectedKey) return;
      if (plaza.dataset.paperdollQaExpectedKey !== expectedKey) return;
      if (plaza.dataset.paperdollQaReady !== "true") return;
      if (plaza.dataset.paperdollQaRenderedKey !== expectedKey) return;
      if (
        plaza.dataset.paperdollQaExpectedLayerCount !==
        String(expectedLayerCount)
      ) return;
      if (
        plaza.dataset.paperdollQaDestinationVerifiedLayerCount !==
        String(expectedLayerCount)
      ) return;
      const destinationAlphaPixelCount = Number(
        plaza.dataset.paperdollQaDestinationAlphaPixelCount,
      );
      if (
        !Number.isSafeInteger(destinationAlphaPixelCount) ||
        destinationAlphaPixelCount <= 0
      ) return;
      if (plaza.dataset.paperdollQaBodyComparisonComplete !== "true") return;
      const bodyDiffPixelCount = Number(
        plaza.dataset.paperdollQaBodyDiffPixelCount,
      );
      if (!Number.isSafeInteger(bodyDiffPixelCount) || bodyDiffPixelCount <= 0) {
        return;
      }

      const verifiedKeys = verifiedKeysRef.current;
      if (verifiedKeys.has(expectedKey)) {
        fail(`duplicate:${expectedKey}`, "duplicate");
        return;
      }
      if (verifiedKeys.size !== expectedIndex) {
        fail(
          `out-of-order:${expectedKey}:expected-${verifiedKeys.size}:received-${expectedIndex}`,
          "failure",
        );
        return;
      }

      const visibleDirectionGroups = visibleDirectionGroupsRef.current;
      if (!compositeMode && bodyDiffPixelCount > 0) {
        visibleDirectionGroups.add(
          expectedKey.slice(0, expectedKey.lastIndexOf("/")),
        );
      }

      settled = true;
      cleanup();
      verifiedKeys.add(expectedKey);
      const verifiedCount = verifiedKeys.size;
      const nextIndex = compositeMode
        ? nextPaperdollRuntimeQaCompositeIndex(expectedIndex)
        : nextPaperdollRuntimeQaIndex(expectedIndex);
      if (
        nextIndex === null &&
        !compositeMode &&
        visibleDirectionGroups.size !== PAPERDOLL_RUNTIME_QA_DIRECTION_GROUP_TOTAL
      ) {
        setPass((current) => {
          if (current.status !== "running" || current.runId !== runId) return current;
          return {
            ...current,
            status: "failed",
            verifiedCount,
            visibleDirectionGroupCount: visibleDirectionGroups.size,
            lastVerifiedKey: expectedKey,
            failure:
              `missing-visible-direction-groups:` +
              `${PAPERDOLL_RUNTIME_QA_DIRECTION_GROUP_TOTAL - visibleDirectionGroups.size}`,
          };
        });
        return;
      }
      setPass((current) => {
        if (current.status !== "running" || current.runId !== runId) return current;
        return {
          ...current,
          status: nextIndex === null ? "complete" : "running",
          verifiedCount,
          visibleDirectionGroupCount: visibleDirectionGroups.size,
          lastVerifiedKey: expectedKey,
        };
      });
      if (nextIndex !== null) {
        setIndex(nextIndex);
        setJumpDraft(String(nextIndex + 1));
      }
    };

    observer = new MutationObserver(verifyCurrentPose);
    observer.observe(root, {
      attributes: true,
      subtree: true,
      attributeFilter: [
        "data-qa-expected-key",
        "data-paperdoll-qa-expected-key",
        "data-paperdoll-qa-rendered-key",
        "data-paperdoll-qa-ready",
      ],
    });
    // The child's layout effect resets readiness before this parent effect.
    // Checking on the next animation frame therefore accepts only a draw from
    // this pose commit, never a stale ready flag from the previous key/run.
    initialCheckFrame = window.requestAnimationFrame(verifyCurrentPose);
    timeoutId = window.setTimeout(
      () => fail(`timeout:${expectedKey}`, "timeout"),
      PAPERDOLL_RUNTIME_QA_POSE_TIMEOUT_MS,
    );
    return cleanup;
  }, [
    compositeMode,
    expectedLayerCount,
    pass.runId,
    pass.status,
    poseEpoch,
    state.index,
    state.key,
  ]);

  return (
    <section
      ref={qaRootRef}
      className="paperdoll-runtime-qa"
      data-paperdoll-runtime-qa="true"
      data-qa-index={state.index}
      data-qa-position={state.index + 1}
      data-qa-total={total}
      data-qa-mode={mode}
      data-qa-item-index={state.itemIndex}
      data-qa-slot={singleState?.slot}
      data-qa-variant={singleState?.variant}
      data-qa-build-index={compositeState?.buildIndex}
      data-qa-direction={state.direction}
      data-qa-frame={state.frame}
      data-qa-expected-key={state.key}
      data-qa-autorun={pass.status === "running" ? "true" : "false"}
      data-qa-pass-status={pass.status}
      data-qa-pass-run-id={pass.runId}
      data-qa-verified-count={pass.verifiedCount}
      data-qa-pass-complete={pass.status === "complete" ? "true" : "false"}
      data-qa-pass-failed={pass.status === "failed" ? "true" : "false"}
      data-qa-duplicate-count={pass.duplicateCount}
      data-qa-timeout-count={pass.timeoutCount}
      data-qa-visible-direction-groups={pass.visibleDirectionGroupCount}
      data-qa-expected-direction-groups={
        compositeMode ? 0 : PAPERDOLL_RUNTIME_QA_DIRECTION_GROUP_TOTAL
      }
      data-qa-missing-direction-groups={
        compositeMode
          ? 0
          : PAPERDOLL_RUNTIME_QA_DIRECTION_GROUP_TOTAL -
            pass.visibleDirectionGroupCount
      }
      data-qa-pass-failure={pass.failure || "none"}
      data-qa-stop-reason={pass.stopReason || "none"}
      data-qa-last-verified-key={pass.lastVerifiedKey || "none"}
    >
      <PlazaHub
        character={{
          characterId: "paperdoll-runtime-qa",
          displayName: "PAPERDOLL QA",
          level: 100,
          dungeonFloor: 100,
          saveSlot: 1,
        }}
        equipment={equipment}
        connectionState="offline"
        onlineCount={1}
        paperdollQaPose={pose}
      />

      <aside className="paperdoll-runtime-qa__controls" data-qa-controls="true">
        <header>
          <small>ACTUAL PLAZA RENDERER</small>
          <strong data-qa-active-key={state.key}>{state.key}</strong>
          <span>
            <b data-qa-progress-current={state.index + 1}>{state.index + 1}</b>
            {" / "}
            <b data-qa-progress-total={total}>
              {total}
            </b>
          </span>
        </header>

        <div className="paperdoll-runtime-qa__autorun">
          <button
            type="button"
            data-qa-start-full-pass="true"
            onClick={startFullPass}
          >
            Start full pass
          </button>
          <button
            type="button"
            data-qa-stop-full-pass="true"
            disabled={pass.status !== "running"}
            onClick={() => stopFullPass("manual-stop")}
          >
            Stop
          </button>
          <output data-qa-pass-output="true">
            {pass.status} · {pass.verifiedCount}/{total}
          </output>
        </div>

        {singleState ? (
          <div className="paperdoll-runtime-qa__selectors">
            <label>
              Slot
              <select
                value={singleState.slot}
                data-qa-select="slot"
                onChange={(event) =>
                  selectPose(
                    event.currentTarget.value as (typeof EQUIPMENT_SLOTS)[number],
                    singleState.variant,
                    singleState.direction,
                    singleState.frame,
                  )
                }
              >
                {EQUIPMENT_SLOTS.map((slot) => (
                  <option key={slot} value={slot}>{slot}</option>
                ))}
              </select>
            </label>

            <label>
              Variant
              <select
                value={singleState.variant}
                data-qa-select="variant"
                onChange={(event) =>
                  selectPose(
                    singleState.slot,
                    Number(event.currentTarget.value),
                    singleState.direction,
                    singleState.frame,
                  )
                }
              >
                {Array.from(
                  { length: PAPERDOLL_RUNTIME_QA_VARIANT_COUNT },
                  (_, variant) => (
                    <option key={variant} value={variant}>
                      {String(variant).padStart(2, "0")}
                    </option>
                  ),
                )}
              </select>
            </label>

            <label>
              Direction
              <select
                value={singleState.direction}
                data-qa-select="direction"
                onChange={(event) =>
                  selectPose(
                    singleState.slot,
                    singleState.variant,
                    Number(event.currentTarget.value),
                    singleState.frame,
                  )
                }
              >
                {Array.from(
                  { length: PAPERDOLL_RUNTIME_QA_DIRECTION_COUNT },
                  (_, direction) => (
                    <option key={direction} value={direction}>
                      {direction} · {DIRECTION_LABELS[direction]}
                    </option>
                  ),
                )}
              </select>
            </label>

            <label>
              Frame
              <select
                value={singleState.frame}
                data-qa-select="frame"
                onChange={(event) =>
                  selectPose(
                    singleState.slot,
                    singleState.variant,
                    singleState.direction,
                    Number(event.currentTarget.value),
                  )
                }
              >
                {Array.from(
                  { length: PAPERDOLL_RUNTIME_QA_FRAME_COUNT },
                  (_, frame) => (
                    <option key={frame} value={frame}>
                      {frame} · {FRAME_LABELS[frame]}
                    </option>
                  ),
                )}
              </select>
            </label>
          </div>
        ) : compositeState ? (
          <div className="paperdoll-runtime-qa__selectors">
            <label>
              Build
              <select
                value={compositeState.buildIndex}
                data-qa-select="build"
                onChange={(event) =>
                  selectCompositePose(
                    Number(event.currentTarget.value),
                    compositeState.direction,
                    compositeState.frame,
                  )
                }
              >
                {PAPERDOLL_RUNTIME_QA_COMPOSITE_BUILDS.map((build, buildIndex) => (
                  <option key={build.label} value={buildIndex}>{build.label}</option>
                ))}
              </select>
            </label>

            <label>
              Direction
              <select
                value={compositeState.direction}
                data-qa-select="direction"
                onChange={(event) =>
                  selectCompositePose(
                    compositeState.buildIndex,
                    Number(event.currentTarget.value),
                    compositeState.frame,
                  )
                }
              >
                {Array.from(
                  { length: PAPERDOLL_RUNTIME_QA_DIRECTION_COUNT },
                  (_, direction) => (
                    <option key={direction} value={direction}>
                      {direction} · {DIRECTION_LABELS[direction]}
                    </option>
                  ),
                )}
              </select>
            </label>

            <label>
              Frame
              <select
                value={compositeState.frame}
                data-qa-select="frame"
                onChange={(event) =>
                  selectCompositePose(
                    compositeState.buildIndex,
                    compositeState.direction,
                    Number(event.currentTarget.value),
                  )
                }
              >
                {Array.from(
                  { length: PAPERDOLL_RUNTIME_QA_FRAME_COUNT },
                  (_, frame) => (
                    <option key={frame} value={frame}>
                      {frame} · {FRAME_LABELS[frame]}
                    </option>
                  ),
                )}
              </select>
            </label>
          </div>
        ) : null}

        <div className="paperdoll-runtime-qa__navigation">
          <button type="button" data-qa-prev="true" onClick={goPrevious}>
            Prev
          </button>
          <form onSubmit={jumpTo}>
            <label>
              Jump
              <input
                type="number"
                min={1}
                max={total}
                value={jumpDraft}
                data-qa-jump-input="true"
                onChange={(event) => setJumpDraft(event.currentTarget.value)}
              />
            </label>
            <button type="submit" data-qa-jump="true">Go</button>
          </form>
          <button type="button" data-qa-next="true" onClick={goNext}>
            Next
          </button>
        </div>

        <p>
          {singleState?.baseName ?? compositeState?.label} ·{" "}
          {DIRECTION_LABELS[state.direction]} · {FRAME_LABELS[state.frame]}
        </p>
      </aside>
    </section>
  );
}
