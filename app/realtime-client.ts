"use client";

import {
  parseRealtimeServerMessage,
  sanitizeDisplayName,
  type PvpBuildProfile,
  type PvpInput,
  type RealtimeClientMessage,
  type RealtimeServerMessage,
  type WorldLootAnnouncement,
  type WorldLootRarity,
} from "./pvp-protocol";

export type RealtimeConnectionState =
  | "idle"
  | "connecting"
  | "online"
  | "reconnecting"
  | "offline";

export type RealtimeClientEvent =
  | RealtimeServerMessage
  | { type: "connection_state"; state: RealtimeConnectionState };

type RealtimeListener = (event: RealtimeClientEvent) => void;

type PendingMessage = {
  id: number;
  message: Exclude<RealtimeClientMessage, { type: "pvp_input" }>;
};

type SessionResponse = {
  token?: unknown;
  playerId?: unknown;
  displayName?: unknown;
  online?: unknown;
  recentAnnouncements?: unknown;
};

type SyncResponse = {
  messages?: unknown;
};

const DISPLAY_NAME_KEY = "mujindo:online-display-name";
const DEVICE_ID_KEY = "mujindo:online-device-id";
const FAST_POLL_MS = 90;
const FAST_POLL_MIN_GAP_MS = 24;
const FAST_POLL_JITTER_MS = 36;
const PASSIVE_POLL_MIN_MS = 800;
const PASSIVE_POLL_JITTER_MS = 150;
const REQUEST_TIMEOUT_MS = 10_000;
const PING_INTERVAL_MS = 6_000;
const MAX_SYNC_MESSAGES = 32;

const randomSuffix = () => Math.floor(1000 + Math.random() * 9000).toString();

const isWorldLootAnnouncement = (value: unknown): value is WorldLootAnnouncement => {
  if (!value || typeof value !== "object") return false;
  const announcement = value as Partial<WorldLootAnnouncement>;
  return (
    typeof announcement.id === "string" &&
    typeof announcement.sequence === "number" &&
    Number.isSafeInteger(announcement.sequence) &&
    typeof announcement.playerName === "string" &&
    typeof announcement.itemName === "string" &&
    (announcement.rarity === "mythic" || announcement.rarity === "cosmic") &&
    typeof announcement.itemLevel === "number" &&
    typeof announcement.enhancement === "number" &&
    typeof announcement.createdAt === "number"
  );
};

const isAbortError = (error: unknown): boolean =>
  error instanceof DOMException && error.name === "AbortError";

class SessionExpiredError extends Error {
  constructor() {
    super("realtime_session_expired");
    this.name = "SessionExpiredError";
  }
}

export function getLocalDisplayName(suggestedName?: string | null): string {
  if (typeof window === "undefined") {
    return sanitizeDisplayName(suggestedName ?? "이름 없는 방랑자");
  }
  const stored = window.localStorage.getItem(DISPLAY_NAME_KEY);
  if (stored) return sanitizeDisplayName(stored);
  const generated = sanitizeDisplayName(
    suggestedName && suggestedName !== "손님"
      ? suggestedName
      : `방랑자 ${randomSuffix()}`,
  );
  window.localStorage.setItem(DISPLAY_NAME_KEY, generated);
  return generated;
}

export function getRealtimeDeviceId(): string {
  if (typeof window === "undefined") return "server";
  const stored = window.localStorage.getItem(DEVICE_ID_KEY);
  if (stored) return stored;
  const generated =
    typeof window.crypto?.randomUUID === "function"
      ? window.crypto.randomUUID()
      : `device-${Date.now()}-${randomSuffix()}`;
  window.localStorage.setItem(DEVICE_ID_KEY, generated);
  return generated;
}

class RealtimeClient {
  private listeners = new Set<RealtimeListener>();
  private sessionToken: string | null = null;
  private sessionPromise: Promise<void> | null = null;
  private syncPromise: Promise<void> | null = null;
  private sessionController: AbortController | null = null;
  private syncController: AbortController | null = null;
  private pendingMessages: PendingMessage[] = [];
  private latestPvpInput: ({ type: "pvp_input" } & PvpInput) | null = null;
  private nextPendingId = 1;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private pollDueAt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempts = 0;
  private closedByClient = false;
  private desiredDisplayName: string | null = null;
  private state: RealtimeConnectionState = "idle";
  private playerId: string | null = null;
  private onlineCount = 0;
  private recentAnnouncements: WorldLootAnnouncement[] = [];
  private queueActive = false;
  private knownMatchId: string | null = null;
  private lastAnnouncementSequence = 0;
  private lastSyncStartedAt = 0;
  private lifecycle = 0;

  subscribe(listener: RealtimeListener, suggestedName?: string | null): () => void {
    this.listeners.add(listener);
    this.desiredDisplayName ??= getLocalDisplayName(suggestedName);
    listener({ type: "connection_state", state: this.state });
    if (this.sessionToken && this.playerId) {
      listener({
        type: "connected",
        playerId: this.playerId,
        displayName: this.getDisplayName(),
        online: this.onlineCount,
        recentAnnouncements: this.recentAnnouncements,
      });
    }
    void this.connect();
    return () => {
      this.listeners.delete(listener);
    };
  }

  getPlayerId(): string | null {
    return this.playerId;
  }

  getDisplayName(): string {
    this.desiredDisplayName ??= getLocalDisplayName();
    return this.desiredDisplayName;
  }

  setDisplayName(value: string): string {
    const displayName = sanitizeDisplayName(value);
    this.desiredDisplayName = displayName;
    if (typeof window !== "undefined") {
      window.localStorage.setItem(DISPLAY_NAME_KEY, displayName);
    }

    this.lifecycle += 1;
    this.abortRequests();
    this.clearPollTimer();
    this.clearReconnectTimer();
    this.sessionPromise = null;
    this.syncPromise = null;
    this.sessionToken = null;
    this.playerId = null;
    this.pendingMessages = [];
    this.latestPvpInput = null;
    this.queueActive = false;
    this.knownMatchId = null;
    this.closedByClient = false;
    void this.connect(true);
    return displayName;
  }

  joinQueue(profile: PvpBuildProfile): void {
    this.queueActive = true;
    this.send({ type: "queue", profile });
  }

  cancelQueue(): void {
    this.queueActive = false;
    this.send({ type: "cancel_queue" });
  }

  sendPvpInput(input: PvpInput): void {
    this.send({ type: "pvp_input", ...input });
  }

  announceLoot(payload: {
    acquisitionId: string;
    itemName: string;
    rarity: WorldLootRarity;
    itemLevel: number;
    enhancement: number;
  }): void {
    this.send({ type: "announce_loot", ...payload });
  }

  disconnect(): void {
    this.closedByClient = true;
    this.lifecycle += 1;
    this.clearPollTimer();
    this.clearReconnectTimer();
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.abortRequests();
    this.sessionPromise = null;
    this.syncPromise = null;
    this.latestPvpInput = null;
    this.queueActive = false;
    this.knownMatchId = null;
    this.setState("offline");
  }

  private async connect(force = false): Promise<void> {
    if (typeof window === "undefined") return;
    if (force) this.clearReconnectTimer();
    if (this.sessionPromise) return;

    this.closedByClient = false;
    if (this.sessionToken) {
      this.reconnectAttempts = 0;
      this.setState("online");
      this.ensurePingTimer();
      this.schedulePoll(0, true);
      return;
    }

    const lifecycle = this.lifecycle;
    this.setState(this.reconnectAttempts > 0 ? "reconnecting" : "connecting");
    const promise = this.openSession(lifecycle);
    this.sessionPromise = promise;
    try {
      await promise;
    } catch {
      if (
        lifecycle === this.lifecycle &&
        !this.closedByClient
      ) {
        this.scheduleReconnect();
      }
    } finally {
      if (this.sessionPromise === promise) this.sessionPromise = null;
    }
  }

  private async openSession(lifecycle: number): Promise<void> {
    const controller = new AbortController();
    this.sessionController = controller;
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch("/api/realtime/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          displayName: this.getDisplayName(),
          deviceId: getRealtimeDeviceId(),
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`session_${response.status}`);
      const session = (await response.json()) as SessionResponse;
      if (typeof session.token !== "string" || typeof session.playerId !== "string") {
        throw new Error("invalid_session_response");
      }
      if (lifecycle !== this.lifecycle || this.closedByClient) return;

      const displayName =
        typeof session.displayName === "string"
          ? sanitizeDisplayName(session.displayName)
          : this.getDisplayName();
      const recentAnnouncements = Array.isArray(session.recentAnnouncements)
        ? session.recentAnnouncements.filter(isWorldLootAnnouncement)
        : [];
      for (const announcement of recentAnnouncements) {
        this.lastAnnouncementSequence = Math.max(
          this.lastAnnouncementSequence,
          announcement.sequence,
        );
      }

      this.sessionToken = session.token;
      this.playerId = session.playerId;
      this.desiredDisplayName = displayName;
      this.onlineCount =
        typeof session.online === "number" && Number.isFinite(session.online)
          ? Math.max(0, Math.floor(session.online))
          : 1;
      this.recentAnnouncements = recentAnnouncements;
      this.reconnectAttempts = 0;
      this.setState("online");
      this.emit({
        type: "connected",
        playerId: session.playerId,
        displayName,
        online: this.onlineCount,
        recentAnnouncements,
      });
      this.ensurePingTimer();
      this.schedulePoll(0, true);
    } finally {
      clearTimeout(timeout);
      if (this.sessionController === controller) this.sessionController = null;
    }
  }

  private async sync(lifecycle: number): Promise<void> {
    if (!this.sessionToken || this.syncPromise || this.closedByClient) return;

    const token = this.sessionToken;
    const sentPending = this.pendingMessages.slice(0, MAX_SYNC_MESSAGES);
    const sentInput = this.latestPvpInput;
    const messages: RealtimeClientMessage[] = sentPending.map(
      (pending) => pending.message,
    );
    if (sentInput) messages.push(sentInput);

    const controller = new AbortController();
    this.syncController = controller;
    this.lastSyncStartedAt = Date.now();
    const promise = this.performSync({
      lifecycle,
      token,
      controller,
      messages,
      sentPending,
      sentInput,
    });
    this.syncPromise = promise;
    try {
      await promise;
    } finally {
      if (this.syncPromise === promise) this.syncPromise = null;
    }
  }

  private async performSync(options: {
    lifecycle: number;
    token: string;
    controller: AbortController;
    messages: RealtimeClientMessage[];
    sentPending: PendingMessage[];
    sentInput: ({ type: "pvp_input" } & PvpInput) | null;
  }): Promise<void> {
    const {
      lifecycle,
      token,
      controller,
      messages,
      sentPending,
      sentInput,
    } = options;
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let succeeded = false;
    try {
      const response = await fetch("/api/realtime/sync", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          messages,
          knownMatchId: this.knownMatchId,
          lastAnnouncementSequence: this.lastAnnouncementSequence,
        }),
        signal: controller.signal,
      });
      if (response.status === 401) throw new SessionExpiredError();
      if (!response.ok) throw new Error(`sync_${response.status}`);
      const payload = (await response.json()) as SyncResponse;
      if (!Array.isArray(payload.messages)) {
        throw new Error("invalid_sync_response");
      }
      if (lifecycle !== this.lifecycle || this.closedByClient) return;

      const acknowledgedIds = new Set(sentPending.map((pending) => pending.id));
      this.pendingMessages = this.pendingMessages.filter(
        (pending) => !acknowledgedIds.has(pending.id),
      );
      if (
        sentInput &&
        this.latestPvpInput?.sequence === sentInput.sequence
      ) {
        this.latestPvpInput = null;
      }

      for (const rawMessage of payload.messages) {
        const message = parseRealtimeServerMessage(rawMessage);
        if (message) this.handleServerMessage(message);
      }
      this.reconnectAttempts = 0;
      this.setState("online");
      succeeded = true;
    } catch (error) {
      if (lifecycle !== this.lifecycle || this.closedByClient) return;
      if (error instanceof SessionExpiredError) {
        this.sessionToken = null;
        this.playerId = null;
        this.scheduleReconnect(true);
      } else if (!isAbortError(error) || controller.signal.aborted) {
        this.scheduleReconnect();
      }
    } finally {
      clearTimeout(timeout);
      if (this.syncController === controller) this.syncController = null;
      if (
        succeeded &&
        lifecycle === this.lifecycle &&
        !this.closedByClient &&
        !this.reconnectTimer
      ) {
        this.schedulePoll(this.nextPollDelay());
      }
    }
  }

  private handleServerMessage(message: RealtimeServerMessage): void {
    if (message.type === "connected") {
      this.playerId = message.playerId;
      this.desiredDisplayName = sanitizeDisplayName(message.displayName);
      this.onlineCount = message.online;
      this.recentAnnouncements = message.recentAnnouncements;
      for (const announcement of message.recentAnnouncements) {
        this.lastAnnouncementSequence = Math.max(
          this.lastAnnouncementSequence,
          announcement.sequence,
        );
      }
    } else if (message.type === "presence") {
      this.onlineCount = message.online;
    } else if (message.type === "queue_state") {
      this.queueActive = message.state === "queued";
    } else if (message.type === "match_found") {
      this.queueActive = false;
      this.knownMatchId = message.matchId;
    } else if (message.type === "pvp_snapshot") {
      this.queueActive = false;
      this.knownMatchId = message.matchId;
    } else if (message.type === "match_result") {
      if (!this.knownMatchId || this.knownMatchId === message.matchId) {
        this.knownMatchId = null;
      }
      this.queueActive = false;
      this.latestPvpInput = null;
    } else if (message.type === "world_announcement") {
      this.lastAnnouncementSequence = Math.max(
        this.lastAnnouncementSequence,
        message.announcement.sequence,
      );
      this.recentAnnouncements = [
        ...this.recentAnnouncements.filter(
          (announcement) => announcement.id !== message.announcement.id,
        ),
        message.announcement,
      ].slice(-12);
    }
    this.emit(message);
  }

  private send(message: RealtimeClientMessage): void {
    if (message.type === "pvp_input") {
      this.latestPvpInput = message;
    } else {
      this.enqueueReliable(message);
    }

    if (!this.sessionToken) {
      void this.connect();
      return;
    }
    if (this.syncPromise) return;

    if (message.type === "pvp_input") {
      const elapsed = Date.now() - this.lastSyncStartedAt;
      this.schedulePoll(Math.max(0, FAST_POLL_MS - elapsed), true);
    } else {
      this.schedulePoll(0, true);
    }
  }

  private enqueueReliable(
    message: Exclude<RealtimeClientMessage, { type: "pvp_input" }>,
  ): void {
    if (message.type === "ping") {
      this.pendingMessages = this.pendingMessages.filter(
        (pending) => pending.message.type !== "ping",
      );
    } else if (message.type === "queue" || message.type === "cancel_queue") {
      this.pendingMessages = this.pendingMessages.filter(
        (pending) =>
          pending.message.type !== "queue" &&
          pending.message.type !== "cancel_queue",
      );
    }
    this.pendingMessages.push({ id: this.nextPendingId++, message });
  }

  private ensurePingTimer(): void {
    if (this.pingTimer) return;
    this.pingTimer = setInterval(() => {
      if (this.closedByClient || !this.sessionToken) return;
      this.enqueueReliable({ type: "ping", clientTime: Date.now() });
      if (!this.syncPromise) this.schedulePoll(0, true);
    }, PING_INTERVAL_MS);
  }

  private nextPollDelay(): number {
    const hasUrgentWork =
      this.pendingMessages.length > 0 || this.latestPvpInput !== null;

    if (this.queueActive || this.knownMatchId || hasUrgentWork) {
      const elapsed = Math.max(0, Date.now() - this.lastSyncStartedAt);
      if (elapsed < FAST_POLL_MS) return FAST_POLL_MS - elapsed;

      return (
        FAST_POLL_MIN_GAP_MS +
        Math.floor(Math.random() * (FAST_POLL_JITTER_MS + 1))
      );
    }

    return (
      PASSIVE_POLL_MIN_MS +
      Math.floor(Math.random() * (PASSIVE_POLL_JITTER_MS + 1))
    );
  }

  private schedulePoll(delay: number, replaceLaterTimer = false): void {
    if (this.closedByClient || !this.sessionToken || this.reconnectTimer) return;
    const normalizedDelay = Math.max(0, delay);
    const dueAt = Date.now() + normalizedDelay;
    if (this.pollTimer) {
      if (!replaceLaterTimer || this.pollDueAt <= dueAt) return;
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.pollDueAt = dueAt;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      this.pollDueAt = 0;
      if (!this.syncPromise) void this.sync(this.lifecycle);
    }, normalizedDelay);
  }

  private scheduleReconnect(immediate = false): void {
    if (this.reconnectTimer || this.closedByClient) return;
    this.clearPollTimer();
    this.reconnectAttempts += 1;
    this.setState("reconnecting");
    const delay = immediate
      ? 0
      : Math.min(8_000, 450 * 2 ** Math.min(5, this.reconnectAttempts - 1));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closedByClient) return;
      if (this.sessionToken) {
        this.schedulePoll(0, true);
      } else {
        void this.connect(true);
      }
    }, delay);
  }

  private clearPollTimer(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    this.pollDueAt = 0;
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private abortRequests(): void {
    this.sessionController?.abort();
    this.syncController?.abort();
    this.sessionController = null;
    this.syncController = null;
  }

  private setState(state: RealtimeConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.emit({ type: "connection_state", state });
  }

  private emit(event: RealtimeClientEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

let realtimeClient: RealtimeClient | null = null;

export function getRealtimeClient(): RealtimeClient {
  realtimeClient ??= new RealtimeClient();
  return realtimeClient;
}
