"use client";

import {
  parseRealtimeServerMessage,
  sanitizeDisplayName,
  type PvpInput,
  type RealtimeClientMessage,
  type RealtimeServerMessage,
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

const DISPLAY_NAME_KEY = "mujindo:online-display-name";
const DEVICE_ID_KEY = "mujindo:online-device-id";
const MAX_PENDING_MESSAGES = 24;

const randomSuffix = () => Math.floor(1000 + Math.random() * 9000).toString();

export function getLocalDisplayName(suggestedName?: string | null): string {
  if (typeof window === "undefined") {
    return sanitizeDisplayName(suggestedName ?? "이름 없는 방랑자");
  }
  const stored = window.localStorage.getItem(DISPLAY_NAME_KEY);
  if (stored) return sanitizeDisplayName(stored);
  const generated = sanitizeDisplayName(
    suggestedName && suggestedName !== "하린"
      ? suggestedName
      : `방랑자-${randomSuffix()}`,
  );
  window.localStorage.setItem(DISPLAY_NAME_KEY, generated);
  return generated;
}

export function getRealtimeDeviceId(): string {
  if (typeof window === "undefined") return "server";
  const stored = window.localStorage.getItem(DEVICE_ID_KEY);
  if (stored) return stored;
  const generated = crypto.randomUUID();
  window.localStorage.setItem(DEVICE_ID_KEY, generated);
  return generated;
}

class RealtimeClient {
  private listeners = new Set<RealtimeListener>();
  private socket: WebSocket | null = null;
  private sessionToken: string | null = null;
  private sessionPromise: Promise<void> | null = null;
  private pendingMessages: RealtimeClientMessage[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempts = 0;
  private closedByClient = false;
  private desiredDisplayName: string | null = null;
  private state: RealtimeConnectionState = "idle";
  private playerId: string | null = null;

  subscribe(listener: RealtimeListener, suggestedName?: string | null): () => void {
    this.listeners.add(listener);
    this.desiredDisplayName ??= getLocalDisplayName(suggestedName);
    listener({ type: "connection_state", state: this.state });
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
    window.localStorage.setItem(DISPLAY_NAME_KEY, displayName);
    this.sessionToken = null;
    this.playerId = null;
    this.pendingMessages = [];
    this.closedByClient = false;
    if (this.socket) {
      this.socket.close(4000, "프로필을 갱신합니다.");
      this.socket = null;
    }
    void this.connect(true);
    return displayName;
  }

  joinQueue(): void {
    this.send({ type: "queue" });
  }

  cancelQueue(): void {
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
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.socket?.close(1000, "클라이언트 종료");
    this.socket = null;
    this.setState("offline");
  }

  private async connect(force = false): Promise<void> {
    if (typeof window === "undefined") return;
    if (!force && (this.socket?.readyState === WebSocket.OPEN || this.sessionPromise)) return;
    this.closedByClient = false;
    this.setState(this.reconnectAttempts > 0 ? "reconnecting" : "connecting");
    this.sessionPromise = this.openConnection();
    try {
      await this.sessionPromise;
    } finally {
      this.sessionPromise = null;
    }
  }

  private async openConnection(): Promise<void> {
    try {
      if (!this.sessionToken) {
        const response = await fetch("/api/realtime/session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            displayName: this.getDisplayName(),
            deviceId: getRealtimeDeviceId(),
          }),
        });
        if (!response.ok) throw new Error(`session_${response.status}`);
        const session = (await response.json()) as {
          token?: unknown;
          playerId?: unknown;
          displayName?: unknown;
        };
        if (typeof session.token !== "string" || typeof session.playerId !== "string") {
          throw new Error("invalid_session_response");
        }
        this.sessionToken = session.token;
        this.playerId = session.playerId;
        if (typeof session.displayName === "string") {
          this.desiredDisplayName = sanitizeDisplayName(session.displayName);
        }
      }

      const url = new URL("/api/realtime/socket", window.location.href);
      url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("token", this.sessionToken);
      const socket = new WebSocket(url);
      this.socket = socket;
      socket.addEventListener("open", () => {
        if (this.socket !== socket) return;
        this.reconnectAttempts = 0;
        this.setState("online");
        const pending = this.pendingMessages.splice(0);
        for (const message of pending) this.sendNow(message);
        if (this.pingTimer) clearInterval(this.pingTimer);
        this.pingTimer = setInterval(() => {
          this.sendNow({ type: "ping", clientTime: Date.now() });
        }, 8_000);
      });
      socket.addEventListener("message", (event) => {
        if (typeof event.data !== "string") return;
        let raw: unknown;
        try {
          raw = JSON.parse(event.data);
        } catch {
          return;
        }
        const message = parseRealtimeServerMessage(raw);
        if (!message) return;
        if (message.type === "connected") {
          this.playerId = message.playerId;
          this.desiredDisplayName = sanitizeDisplayName(message.displayName);
        }
        this.emit(message);
      });
      socket.addEventListener("close", (event) => {
        if (this.socket !== socket) return;
        this.socket = null;
        if (this.pingTimer) clearInterval(this.pingTimer);
        this.pingTimer = null;
        if (event.code === 4001 || event.code === 1008) this.sessionToken = null;
        if (!this.closedByClient && this.listeners.size > 0) this.scheduleReconnect();
      });
      socket.addEventListener("error", () => {
        if (this.socket === socket) socket.close();
      });
    } catch {
      if (!this.closedByClient && this.listeners.size > 0) this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectAttempts += 1;
    this.setState("reconnecting");
    const delay = Math.min(8_000, 450 * 2 ** Math.min(5, this.reconnectAttempts - 1));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect(true);
    }, delay);
  }

  private send(message: RealtimeClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.sendNow(message);
      return;
    }
    if (message.type !== "pvp_input") {
      this.pendingMessages.push(message);
      if (this.pendingMessages.length > MAX_PENDING_MESSAGES) this.pendingMessages.shift();
    }
    void this.connect();
  }

  private sendNow(message: RealtimeClientMessage): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(message));
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
