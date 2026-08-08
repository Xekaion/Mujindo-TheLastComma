"use client";

import {
  HUB_CHARACTER_SLOTS,
  HUB_HEARTBEAT_INTERVAL_MS,
  HUB_MAP_HEIGHT,
  HUB_MAP_WIDTH,
  HUB_NEARBY_RADIUS,
  HUB_PORTALS,
  HUB_ZONE_ID,
  isHubCharacterSlot,
  isHubFacing,
  normalizeHubAppearance,
  normalizeHubDisplayName,
  normalizeHubLevel,
  parseHubMoveIntent,
  type HubAppearance,
  type HubArrival,
  type HubCharacterSlot,
  type HubFacing,
  type HubMoveIntent,
  type HubPlayerSnapshot,
  type HubSnapshot,
} from "./hub-protocol";

export type HubConnectionState =
  | "idle"
  | "connecting"
  | "online"
  | "reconnecting"
  | "offline";

export type HubClientConfig = {
  characterSlot: HubCharacterSlot;
  displayName: string;
  level: number;
  appearance?: Partial<HubAppearance> | null;
  arrival?: HubArrival;
  /** Local two-client smoke testing only; ignored away from localhost. */
  developmentUser?: "A" | "B";
};

export type HubClientEvent =
  | { type: "connection"; state: HubConnectionState }
  | { type: "snapshot"; snapshot: HubSnapshot }
  | { type: "error"; code: string; retryable: boolean };

export type HubMoveIntentInput = {
  moveX: number;
  moveY: number;
  facing?: HubFacing;
};

type HubListener = (event: HubClientEvent) => void;
type UnknownRecord = Record<string, unknown>;

const ACTIVE_SYNC_MS = 100;
const IDLE_SYNC_MS = 240;
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_RECONNECT_MS = 8_000;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

function localDevelopmentUser(explicit?: "A" | "B"): "A" | "B" | null {
  if (typeof window === "undefined") return null;
  if (window.location.hostname !== "localhost" && window.location.hostname !== "127.0.0.1") {
    return null;
  }
  if (explicit === "A" || explicit === "B") return explicit;
  const queryValue = new URLSearchParams(window.location.search).get("demo");
  return queryValue === "A" || queryValue === "B" ? queryValue : null;
}

function requestHeaders(
  developmentUser: "A" | "B" | null,
  token?: string,
): Headers {
  const headers = new Headers({ "content-type": "application/json" });
  if (developmentUser) headers.set("x-mujindo-dev-user", developmentUser);
  if (token) headers.set("authorization", `Bearer ${token}`);
  return headers;
}

function normalizedConfig(value: HubClientConfig): HubClientConfig {
  if (!isHubCharacterSlot(value.characterSlot)) {
    throw new RangeError(`Invalid character slot: ${String(value.characterSlot)}`);
  }
  return {
    characterSlot: value.characterSlot,
    displayName: normalizeHubDisplayName(value.displayName),
    level: normalizeHubLevel(value.level),
    appearance: normalizeHubAppearance(value.appearance),
    arrival: value.arrival ?? "center",
    ...(value.developmentUser ? { developmentUser: value.developmentUser } : {}),
  };
}

function parsePlayerSnapshot(value: unknown): HubPlayerSnapshot | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.playerId !== "string" ||
    value.playerId.length < 8 ||
    value.playerId.length > 80 ||
    typeof value.characterId !== "string" ||
    value.characterId.length < 8 ||
    value.characterId.length > 80 ||
    typeof value.displayName !== "string" ||
    !isHubCharacterSlot(value.characterSlot) ||
    !isFiniteNumber(value.level) ||
    !isFiniteNumber(value.x) ||
    !isFiniteNumber(value.y) ||
    !isHubFacing(value.facing) ||
    typeof value.moving !== "boolean" ||
    !isFiniteNumber(value.updatedAt)
  ) {
    return null;
  }
  return {
    playerId: value.playerId,
    characterId: value.characterId,
    displayName: normalizeHubDisplayName(value.displayName),
    characterSlot: value.characterSlot,
    level: normalizeHubLevel(value.level),
    x: Math.max(0, Math.min(HUB_MAP_WIDTH, value.x)),
    y: Math.max(0, Math.min(HUB_MAP_HEIGHT, value.y)),
    facing: value.facing,
    moving: value.moving,
    appearance: normalizeHubAppearance(value.appearance),
    updatedAt: Math.max(0, Math.floor(value.updatedAt)),
  };
}

export function parseHubSnapshot(value: unknown): HubSnapshot | null {
  if (!isRecord(value) || value.zone !== HUB_ZONE_ID) return null;
  const self = parsePlayerSnapshot(value.self);
  if (
    !self ||
    !Array.isArray(value.nearbyPlayers) ||
    !isFiniteNumber(value.serverTime) ||
    !isFiniteNumber(value.mapVersion) ||
    !isFiniteNumber(value.online)
  ) {
    return null;
  }
  const nearbyPlayers = value.nearbyPlayers
    .slice(0, 48)
    .map(parsePlayerSnapshot)
    .filter((player): player is HubPlayerSnapshot => player !== null)
    .filter((player) => player.playerId !== self.playerId);
  return {
    serverTime: Math.max(0, Math.floor(value.serverTime)),
    zone: HUB_ZONE_ID,
    mapVersion: Math.max(0, Math.floor(value.mapVersion)),
    online: Math.max(1, Math.floor(value.online)),
    self,
    nearbyPlayers,
    // Rendering uses the locally versioned definitions. A compromised payload
    // cannot inject arbitrary portal hrefs into navigation.
    portals: HUB_PORTALS,
    heartbeatIntervalMs:
      isFiniteNumber(value.heartbeatIntervalMs) && value.heartbeatIntervalMs >= 1_000
        ? Math.min(15_000, Math.floor(value.heartbeatIntervalMs))
        : HUB_HEARTBEAT_INTERVAL_MS,
  };
}

class HubSessionExpiredError extends Error {}

class HubRequestError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export class MemoryPlazaClient {
  private readonly listeners = new Set<HubListener>();
  private state: HubConnectionState = "idle";
  private config: HubClientConfig | null = null;
  private developmentUser: "A" | "B" | null = null;
  private token: string | null = null;
  private sequence = 0;
  private intent: Omit<HubMoveIntent, "sequence"> = {
    moveX: 0,
    moveY: 0,
    facing: 0,
  };
  private snapshot: HubSnapshot | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private controller: AbortController | null = null;
  private requestActive = false;
  private reconnectAttempt = 0;
  private generation = 0;

  subscribe(listener: HubListener): () => void {
    this.listeners.add(listener);
    listener({ type: "connection", state: this.state });
    if (this.snapshot) listener({ type: "snapshot", snapshot: this.snapshot });
    return () => this.listeners.delete(listener);
  }

  getState(): HubConnectionState {
    return this.state;
  }

  getSnapshot(): HubSnapshot | null {
    return this.snapshot;
  }

  async enter(config: HubClientConfig): Promise<void> {
    this.leave(false);
    this.config = normalizedConfig(config);
    this.developmentUser = localDevelopmentUser(config.developmentUser);
    this.generation += 1;
    const generation = this.generation;
    this.setState("connecting");
    try {
      await this.openSession(generation);
    } catch (error) {
      this.handleRequestFailure(error, generation);
    }
  }

  setMoveIntent(value: HubMoveIntentInput): void {
    const parsed = parseHubMoveIntent({
      sequence: this.sequence + 1,
      moveX: value.moveX,
      moveY: value.moveY,
      facing: value.facing ?? this.intent.facing,
      // Position/speed fields on callers are intentionally never forwarded.
    });
    if (!parsed) return;
    this.intent = {
      moveX: parsed.moveX,
      moveY: parsed.moveY,
      facing: parsed.facing,
    };
    if (this.token && !this.requestActive) this.schedule(0);
  }

  async updateAppearance(appearance: unknown, level: unknown): Promise<void> {
    if (!this.token) return;
    const generation = this.generation;
    try {
      const payload = await this.requestJson(
        "/api/hub/appearance",
        "PATCH",
        { appearance: normalizeHubAppearance(appearance), level: normalizeHubLevel(level) },
        this.token,
      );
      if (generation !== this.generation) return;
      this.acceptSnapshot(payload);
    } catch (error) {
      this.handleRequestFailure(error, generation);
    }
  }

  leave(notifyServer = true): void {
    const token = this.token;
    const developmentUser = this.developmentUser;
    this.generation += 1;
    this.controller?.abort();
    this.controller = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.requestActive = false;
    this.token = null;
    this.snapshot = null;
    this.sequence = 0;
    this.intent = { moveX: 0, moveY: 0, facing: 0 };
    this.config = null;
    this.reconnectAttempt = 0;
    this.setState("offline");
    if (notifyServer && token && typeof window !== "undefined") {
      void fetch("/api/hub/leave", {
        method: "POST",
        headers: requestHeaders(developmentUser, token),
        credentials: "same-origin",
        body: "{}",
        keepalive: true,
      }).catch(() => undefined);
    }
  }

  private emit(event: HubClientEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private setState(state: HubConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.emit({ type: "connection", state });
  }

  private async openSession(generation: number): Promise<void> {
    if (!this.config) return;
    const payload = await this.requestJson(
      "/api/hub/session",
      "POST",
      {
        characterSlot: this.config.characterSlot,
        displayName: this.config.displayName,
        level: this.config.level,
        appearance: normalizeHubAppearance(this.config.appearance),
        arrival: this.config.arrival,
      },
    );
    if (generation !== this.generation || !isRecord(payload) || typeof payload.token !== "string") {
      return;
    }
    if (!/^[a-f0-9]{64}$/i.test(payload.token)) throw new Error("invalid_hub_token");
    const snapshot = parseHubSnapshot(payload);
    if (!snapshot) throw new Error("invalid_hub_snapshot");
    this.token = payload.token;
    this.snapshot = snapshot;
    this.reconnectAttempt = 0;
    this.setState("online");
    this.emit({ type: "snapshot", snapshot });
    this.schedule(0);
  }

  private schedule(delay: number): void {
    if (this.timer) clearTimeout(this.timer);
    const generation = this.generation;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.poll(generation);
    }, Math.max(0, delay));
  }

  private async poll(generation: number): Promise<void> {
    if (generation !== this.generation || !this.token || this.requestActive) return;
    this.requestActive = true;
    const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
    try {
      const payload = hidden
        ? await this.requestJson("/api/hub/heartbeat", "POST", {}, this.token)
        : await this.requestJson(
            "/api/hub/sync",
            "POST",
            { sequence: ++this.sequence, ...this.intent },
            this.token,
          );
      if (generation !== this.generation) return;
      this.acceptSnapshot(payload);
      this.reconnectAttempt = 0;
      this.setState("online");
    } catch (error) {
      this.handleRequestFailure(error, generation);
      return;
    } finally {
      this.requestActive = false;
    }
    if (generation !== this.generation) return;
    const moving = Math.hypot(this.intent.moveX, this.intent.moveY) >= 0.05;
    this.schedule(hidden ? HUB_HEARTBEAT_INTERVAL_MS : moving ? ACTIVE_SYNC_MS : IDLE_SYNC_MS);
  }

  private acceptSnapshot(value: unknown): void {
    const snapshot = parseHubSnapshot(value);
    if (!snapshot) throw new Error("invalid_hub_snapshot");
    this.snapshot = snapshot;
    this.emit({ type: "snapshot", snapshot });
  }

  private handleRequestFailure(error: unknown, generation: number): void {
    if (generation !== this.generation) return;
    const expired = error instanceof HubSessionExpiredError;
    const retryable =
      expired || !(error instanceof HubRequestError) || error.retryable;
    if (expired) this.token = null;
    const code = error instanceof Error ? error.message : "hub_request_failed";
    this.emit({ type: "error", code, retryable });
    if (!retryable) {
      this.setState("offline");
      return;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (!this.config) return;
    this.setState("reconnecting");
    this.reconnectAttempt += 1;
    const delay = Math.min(MAX_RECONNECT_MS, 350 * 2 ** Math.min(5, this.reconnectAttempt));
    this.scheduleReconnectAttempt(delay, this.generation);
  }

  private scheduleReconnectAttempt(delay: number, generation: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (generation !== this.generation || !this.config) return;
      if (this.token) {
        this.schedule(0);
        return;
      }
      void this.openSession(generation).catch((error) =>
        this.handleRequestFailure(error, generation),
      );
    }, delay);
  }

  private async requestJson(
    url: string,
    method: "POST" | "PATCH",
    body: unknown,
    token?: string,
  ): Promise<unknown> {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method,
        headers: requestHeaders(this.developmentUser, token),
        credentials: "same-origin",
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => null);
      if (response.status === 401 && token) throw new HubSessionExpiredError();
      if (!response.ok) {
        const code = isRecord(payload) && typeof payload.error === "string"
          ? payload.error
          : `hub_http_${response.status}`;
        const retryable =
          response.status === 408 ||
          response.status === 425 ||
          response.status === 429 ||
          response.status >= 500 ||
          (isRecord(payload) && payload.retryable === true);
        throw new HubRequestError(code, retryable);
      }
      return payload;
    } finally {
      clearTimeout(timeout);
      if (this.controller === controller) this.controller = null;
    }
  }
}

let sharedClient: MemoryPlazaClient | null = null;

export function getMemoryPlazaClient(): MemoryPlazaClient {
  sharedClient ??= new MemoryPlazaClient();
  return sharedClient;
}

export const HUB_CLIENT_RULES = {
  characterSlots: HUB_CHARACTER_SLOTS,
  nearbyRadius: HUB_NEARBY_RADIUS,
  activeSyncMs: ACTIVE_SYNC_MS,
  idleSyncMs: IDLE_SYNC_MS,
  sendsClientPosition: false,
  persistsBearerToken: false,
} as const;
