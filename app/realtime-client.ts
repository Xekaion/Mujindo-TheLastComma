"use client";

import {
  parseRealtimeServerMessage,
  sanitizePvpAppearance,
  type PvpAppearance,
  type PvpBuildProfile,
  type PvpInput,
  type RealtimeClientMessage,
  type RealtimeServerMessage,
  type WorldLootAnnouncement,
  type WorldLootRarity,
} from "./pvp-protocol";
import {
  readCharacterNickname,
  removeCharacterNickname,
  validateCharacterNickname,
  writeCharacterNickname,
  type CharacterNicknameSlot,
} from "./character-nickname";
import { readActiveSaveSlot } from "./save-slots";

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

const DEVICE_ID_KEY = "mujindo:online-device-id";
const FAST_POLL_MS = 50;
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

export type RealtimeCharacterIdentity = {
  characterSlot: CharacterNicknameSlot;
  displayName: string;
};

export function getLocalRealtimeCharacterIdentity(): RealtimeCharacterIdentity | null {
  if (typeof window === "undefined") return null;
  const characterSlot = readActiveSaveSlot();
  const cachedNickname = readCharacterNickname(characterSlot);
  const nickname = validateCharacterNickname(cachedNickname);
  return nickname.ok
    ? { characterSlot, displayName: nickname.nickname }
    : null;
}

/**
 * Compatibility accessor for existing realtime consumers. The account label
 * and the retired PVP-only name cache are intentionally ignored: the selected
 * character nickname is the only display-name source.
 */
export function getLocalDisplayName(suggestedName?: string | null): string {
  void suggestedName;
  return getLocalRealtimeCharacterIdentity()?.displayName ?? "닉네임 미설정";
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
  private sessionCharacterSlot: CharacterNicknameSlot | null = null;
  private openingCharacterSlot: CharacterNicknameSlot | null = null;
  private sessionPromise: Promise<void> | null = null;
  private syncPromise: Promise<void> | null = null;
  private sessionController: AbortController | null = null;
  private syncController: AbortController | null = null;
  private pendingMessages: PendingMessage[] = [];
  private latestPvpInput: ({ type: "pvp_input" } & PvpInput) | null = null;
  /**
   * A dash is an edge, not a held input. Keep the sequence that raised it
   * separately so 30 Hz input sampling cannot overwrite the pulse before the
   * next HTTP sync. It is cleared only after a request carrying that sequence
   * succeeds; a newer press that happened while the request was in flight is
   * therefore never acknowledged by the older response.
   */
  private pendingPvpDashSequence: number | null = null;
  private pendingPvpDashVector: Pick<
    PvpInput,
    "moveX" | "moveY" | "aimX" | "aimY"
  > | null = null;
  private nextPendingId = 1;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private pollDueAt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempts = 0;
  private closedByClient = false;
  private desiredCharacterSlot: CharacterNicknameSlot | null = null;
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
    const identity = getLocalRealtimeCharacterIdentity();
    if (identity) {
      this.desiredCharacterSlot = identity.characterSlot;
      this.desiredDisplayName = identity.displayName;
    } else {
      this.desiredDisplayName ??= getLocalDisplayName(suggestedName);
    }
    listener({ type: "connection_state", state: this.state });
    if (
      identity &&
      this.sessionToken &&
      this.playerId &&
      this.sessionCharacterSlot === identity.characterSlot
    ) {
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

  joinQueue(profile: PvpBuildProfile, appearance?: PvpAppearance): void {
    this.queueActive = true;
    this.send({
      type: "queue",
      profile,
      appearance: sanitizePvpAppearance(appearance),
    });
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
    this.pendingPvpDashSequence = null;
    this.pendingPvpDashVector = null;
    this.queueActive = false;
    this.knownMatchId = null;
    this.setState("offline");
  }

  private async connect(force = false): Promise<void> {
    if (typeof window === "undefined") return;
    if (force) this.clearReconnectTimer();

    const identity = getLocalRealtimeCharacterIdentity();
    if (!identity) {
      if (this.sessionToken || this.sessionPromise) {
        this.resetSessionForCharacterChange();
      }
      this.desiredCharacterSlot = null;
      this.desiredDisplayName = null;
      this.setState("offline");
      return;
    }
    if (
      (this.sessionToken && this.sessionCharacterSlot !== identity.characterSlot) ||
      (this.sessionPromise && this.openingCharacterSlot !== identity.characterSlot)
    ) {
      this.resetSessionForCharacterChange();
    }
    this.desiredCharacterSlot = identity.characterSlot;
    this.desiredDisplayName = identity.displayName;
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
    this.openingCharacterSlot = identity.characterSlot;
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
      if (this.sessionPromise === promise) {
        this.sessionPromise = null;
        this.openingCharacterSlot = null;
      }
    }
  }

  private async openSession(lifecycle: number): Promise<void> {
    const identity = getLocalRealtimeCharacterIdentity();
    if (!identity) throw new Error("character_nickname_required");
    this.desiredCharacterSlot = identity.characterSlot;
    this.desiredDisplayName = identity.displayName;
    const controller = new AbortController();
    this.sessionController = controller;
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch("/api/realtime/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          characterSlot: identity.characterSlot,
          displayName: identity.displayName,
          deviceId: getRealtimeDeviceId(),
        }),
        signal: controller.signal,
      });
      if (response.status === 409) {
        const problem = (await response.clone().json().catch(() => null)) as {
          error?: unknown;
        } | null;
        if (problem?.error === "nickname_required") {
          removeCharacterNickname(identity.characterSlot);
        }
      }
      if (!response.ok) throw new Error(`session_${response.status}`);
      const session = (await response.json()) as SessionResponse;
      if (typeof session.token !== "string" || typeof session.playerId !== "string") {
        throw new Error("invalid_session_response");
      }
      if (lifecycle !== this.lifecycle || this.closedByClient) return;

      const serverNickname = validateCharacterNickname(session.displayName);
      if (!serverNickname.ok) throw new Error("invalid_character_nickname_response");
      const displayName = serverNickname.nickname;
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
      this.sessionCharacterSlot = identity.characterSlot;
      this.playerId = session.playerId;
      this.desiredDisplayName = displayName;
      if (
        this.desiredCharacterSlot !== null &&
        validateCharacterNickname(displayName).ok
      ) {
        writeCharacterNickname(this.desiredCharacterSlot, displayName);
      }
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
    const sentInput =
      this.latestPvpInput && this.pendingPvpDashVector
        ? {
            ...this.latestPvpInput,
            ...this.pendingPvpDashVector,
            dash: true,
          }
        : this.latestPvpInput;
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
      if (
        sentInput?.dash &&
        this.pendingPvpDashSequence !== null &&
        this.pendingPvpDashSequence <= sentInput.sequence
      ) {
        this.pendingPvpDashSequence = null;
        this.pendingPvpDashVector = null;
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
        this.sessionCharacterSlot = null;
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
      const serverNickname = validateCharacterNickname(message.displayName);
      this.desiredDisplayName = serverNickname.ok
        ? serverNickname.nickname
        : this.getDisplayName();
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
      this.pendingPvpDashSequence = null;
      this.pendingPvpDashVector = null;
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
      if (message.dash) {
        this.pendingPvpDashSequence = message.sequence;
        this.pendingPvpDashVector = {
          moveX: message.moveX,
          moveY: message.moveY,
          aimX: message.aimX,
          aimY: message.aimY,
        };
      }
      // Keep the newest raw held state. The sync payload overlays the pending
      // edge vector, so later coalesced samples cannot redirect a stationary
      // dash toward the boss before the request is sent.
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

  private resetSessionForCharacterChange(): void {
    this.lifecycle += 1;
    this.abortRequests();
    this.clearPollTimer();
    this.clearReconnectTimer();
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.sessionPromise = null;
    this.openingCharacterSlot = null;
    this.syncPromise = null;
    this.sessionToken = null;
    this.sessionCharacterSlot = null;
    this.playerId = null;
    this.pendingMessages = [];
    this.latestPvpInput = null;
    this.pendingPvpDashSequence = null;
    this.pendingPvpDashVector = null;
    this.queueActive = false;
    this.knownMatchId = null;
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
