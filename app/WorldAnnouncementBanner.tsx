"use client";

import { useEffect, useRef, useState } from "react";
import { formatGearDisplayName } from "./equipment";
import { getRealtimeClient } from "./realtime-client";
import type { WorldLootAnnouncement } from "./pvp-protocol";

type WorldAnnouncementBannerProps = {
  suggestedName?: string | null;
};

export default function WorldAnnouncementBanner({
  suggestedName,
}: WorldAnnouncementBannerProps) {
  const [current, setCurrent] = useState<WorldLootAnnouncement | null>(null);
  const queueRef = useRef<WorldLootAnnouncement[]>([]);
  const seenRef = useRef(new Set<string>());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showingRef = useRef(false);

  useEffect(() => {
    const realtime = getRealtimeClient();
    const showNext = () => {
      if (timerRef.current || showingRef.current) return;
      const next = queueRef.current.shift();
      if (!next) return;
      showingRef.current = true;
      setCurrent(next);
      timerRef.current = setTimeout(
        () => {
          timerRef.current = null;
          showingRef.current = false;
          setCurrent(null);
          window.setTimeout(showNext, 260);
        },
        next.rarity === "cosmic" ? 7_200 : 5_800,
      );
    };
    const enqueue = (announcement: WorldLootAnnouncement) => {
      if (seenRef.current.has(announcement.id)) return;
      seenRef.current.add(announcement.id);
      if (seenRef.current.size > 80) {
        const first = seenRef.current.values().next().value;
        if (typeof first === "string") seenRef.current.delete(first);
      }
      queueRef.current.push(announcement);
      if (queueRef.current.length > 8) queueRef.current.shift();
      showNext();
    };
    const unsubscribe = realtime.subscribe((event) => {
      if (event.type === "world_announcement") enqueue(event.announcement);
      if (event.type === "connected") {
        const latest = event.recentAnnouncements.at(-1);
        if (latest && Date.now() - latest.createdAt < 90_000) enqueue(latest);
      }
    }, suggestedName);
    return () => {
      unsubscribe();
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
      showingRef.current = false;
    };
  }, [suggestedName]);

  if (!current) return null;
  const itemDisplayName = formatGearDisplayName({
    displayName: current.itemName,
    enhancement: current.enhancement,
  });

  return (
    <aside
      className={`world-announcement is-${current.rarity}`}
      role="status"
      aria-live="polite"
      aria-label={`${current.playerName}님이 ${itemDisplayName}을 획득했습니다`}
    >
      <span className="world-announcement-flare" aria-hidden="true" />
      <span className="world-announcement-rarity">
        {current.rarity === "cosmic" ? "우주 발견" : "신화 발견"}
      </span>
      <p>
        <strong>{current.playerName}</strong>님이
        <b>{itemDisplayName}</b>을 획득하셨습니다
      </p>
      <small>
        LV.{current.itemLevel}
        <i aria-hidden="true">WORLD</i>
      </small>
    </aside>
  );
}
