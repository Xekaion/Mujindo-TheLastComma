"use client";

import { useEffect, useRef, useState } from "react";
import { formatGearDisplayName } from "./equipment";
import { getRealtimeClient } from "./realtime-client";
import type { WorldLootAnnouncement, WorldLootRarity } from "./pvp-protocol";

type WorldAnnouncementBannerProps = {
  suggestedName?: string | null;
};

type AnnouncementPhase = "visible" | "leaving";
type AnnouncementStage = "idle" | AnnouncementPhase | "gap";

const WORLD_ANNOUNCEMENT_ASSETS = {
  mythic: "/assets/ui/world-announcement-mythic-v1.png",
  cosmic: "/assets/ui/world-announcement-cosmic-v1.png",
} as const satisfies Record<WorldLootRarity, string>;

const DISPLAY_DURATION_MS: Record<WorldLootRarity, number> = {
  mythic: 5_800,
  cosmic: 7_200,
};
const EXIT_DURATION_MS = 560;
const ANNOUNCEMENT_GAP_MS = 260;
const MAX_QUEUED_ANNOUNCEMENTS = 8;
const MAX_SEEN_ANNOUNCEMENTS = 80;
const RECENT_ANNOUNCEMENT_WINDOW_MS = 90_000;
const LOCAL_PREVIEW_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function readLocalPreviewAnnouncement(): WorldLootAnnouncement | null {
  if (!LOCAL_PREVIEW_HOSTS.has(window.location.hostname)) return null;
  const rarity = new URLSearchParams(window.location.search).get("worldAnnouncement");
  if (rarity !== "mythic" && rarity !== "cosmic") return null;

  return {
    id: `local-world-announcement-preview-${rarity}`,
    sequence: 0,
    playerName: "무명의 기록자",
    itemName:
      rarity === "cosmic"
        ? "끝나지 않은 쉼표 · 사건의 지평선"
        : "대조의 별무리의 추락 · 심홍 집행관의 견갑",
    rarity,
    itemLevel: 72,
    enhancement: rarity === "cosmic" ? 10 : 5,
    createdAt: Date.now(),
  };
}

export default function WorldAnnouncementBanner({
  suggestedName,
}: WorldAnnouncementBannerProps) {
  const [current, setCurrent] = useState<WorldLootAnnouncement | null>(null);
  const [phase, setPhase] = useState<AnnouncementPhase>("visible");
  const queueRef = useRef<WorldLootAnnouncement[]>([]);
  const seenRef = useRef(new Set<string>());
  const currentRef = useRef<WorldLootAnnouncement | null>(null);
  const stageRef = useRef<AnnouncementStage>("idle");
  const displayTimerRef = useRef<number | null>(null);
  const exitTimerRef = useRef<number | null>(null);
  const gapTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const realtime = getRealtimeClient();
    const seenAnnouncements = seenRef.current;
    let disposed = false;

    const clearTimer = (timer: { current: number | null }) => {
      if (timer.current === null) return;
      window.clearTimeout(timer.current);
      timer.current = null;
    };

    const clearAllTimers = () => {
      clearTimer(displayTimerRef);
      clearTimer(exitTimerRef);
      clearTimer(gapTimerRef);
    };

    function showNext() {
      if (disposed || stageRef.current !== "idle") return;
      const next = queueRef.current.shift();
      if (!next) return;

      stageRef.current = "visible";
      currentRef.current = next;
      setPhase("visible");
      setCurrent(next);
      displayTimerRef.current = window.setTimeout(
        beginExit,
        DISPLAY_DURATION_MS[next.rarity],
      );
    }

    function beginExit() {
      displayTimerRef.current = null;
      if (disposed || stageRef.current !== "visible") return;

      stageRef.current = "leaving";
      setPhase("leaving");
      exitTimerRef.current = window.setTimeout(finishExit, EXIT_DURATION_MS);
    }

    function finishExit() {
      exitTimerRef.current = null;
      if (disposed || stageRef.current !== "leaving") return;

      currentRef.current = null;
      setCurrent(null);
      stageRef.current = "gap";
      gapTimerRef.current = window.setTimeout(() => {
        gapTimerRef.current = null;
        if (disposed || stageRef.current !== "gap") return;
        stageRef.current = "idle";
        showNext();
      }, ANNOUNCEMENT_GAP_MS);
    }

    const enqueue = (announcement: WorldLootAnnouncement) => {
      if (seenAnnouncements.has(announcement.id)) return;
      seenAnnouncements.add(announcement.id);
      if (seenAnnouncements.size > MAX_SEEN_ANNOUNCEMENTS) {
        const first = seenAnnouncements.values().next().value;
        if (typeof first === "string") seenAnnouncements.delete(first);
      }

      queueRef.current.push(announcement);
      if (queueRef.current.length > MAX_QUEUED_ANNOUNCEMENTS) {
        queueRef.current.shift();
      }
      showNext();
    };

    const previewAnnouncement = readLocalPreviewAnnouncement();

    if (currentRef.current) {
      stageRef.current = "visible";
      setPhase("visible");
      setCurrent(currentRef.current);
      displayTimerRef.current = window.setTimeout(
        beginExit,
        DISPLAY_DURATION_MS[currentRef.current.rarity],
      );
    } else {
      stageRef.current = "idle";
      showNext();
    }

    if (previewAnnouncement) enqueue(previewAnnouncement);

    const unsubscribe = realtime.subscribe((event) => {
      if (event.type === "world_announcement") enqueue(event.announcement);
      if (event.type === "connected") {
        const latest = event.recentAnnouncements.at(-1);
        if (
          latest &&
          Date.now() - latest.createdAt < RECENT_ANNOUNCEMENT_WINDOW_MS
        ) {
          enqueue(latest);
        }
      }
    }, suggestedName);

    return () => {
      disposed = true;
      unsubscribe();
      clearAllTimers();
      stageRef.current = "idle";
      if (previewAnnouncement) {
        seenAnnouncements.delete(previewAnnouncement.id);
        queueRef.current = queueRef.current.filter(
          (announcement) => announcement.id !== previewAnnouncement.id,
        );
      }
    };
  }, [suggestedName]);

  if (!current) return null;
  const itemDisplayName = formatGearDisplayName({
    displayName: current.itemName,
    enhancement: current.enhancement,
  });
  const announcementLabel = `${current.playerName}님이 ${itemDisplayName}을 획득했습니다`;

  return (
    <aside
      className={`world-announcement is-${current.rarity}${phase === "leaving" ? " is-exiting" : " is-visible"}`}
      data-rarity={current.rarity}
      data-announcement-id={current.id}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-label={announcementLabel}
    >
      <span className="world-announcement-surface" aria-hidden="true">
        <span
          className="world-announcement-art world-announcement-atlas"
          style={{
            backgroundImage: `url("${WORLD_ANNOUNCEMENT_ASSETS[current.rarity]}")`,
          }}
        />
        <span className="world-announcement-particles">
          {Array.from({ length: 8 }, (_, index) => (
            <i key={index} />
          ))}
        </span>
      </span>
      <span className="world-announcement-rarity">
        {current.rarity === "cosmic" ? "우주 발견" : "신화 발견"}
      </span>
      <p className="world-announcement-copy">
        <strong title={current.playerName}>{current.playerName}</strong>
        <span className="world-announcement-copy-verb">님이</span>
        <b title={itemDisplayName}>{itemDisplayName}</b>
        <span className="world-announcement-copy-tail">을 획득하셨습니다</span>
      </p>
      <small className="world-announcement-meta">
        LV.{current.itemLevel}
        <i aria-hidden="true">WORLD</i>
      </small>
    </aside>
  );
}
