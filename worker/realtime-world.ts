/// <reference types="@cloudflare/workers-types" />

import {
  PVP_ARENA_HEIGHT,
  PVP_ARENA_WIDTH,
  PVP_COUNTDOWN_MS,
  PVP_ROUND_DURATION_MS,
  PVP_SCORE_TO_WIN,
  parseRealtimeClientMessage,
  sanitizeDisplayName,
  type PvpInput,
  type PvpPhase,
  type PvpPlayerSnapshot,
  type PvpProjectileSnapshot,
  type RealtimeServerMessage,
  type WorldLootAnnouncement,
} from "../app/pvp-protocol";

type SessionRecord = {
  token: string;
  playerId: string;
  displayName: string;
  expiresAt: number;
};

type ConnectedPlayer = {
  id: string;
  displayName: string;
  sessionToken: string;
  socket: WebSocket | null;
  queued: boolean;
  matchId: string | null;
  lastLootAnnouncementAt: number;
  inputWindowStartedAt: number;
  inputCount: number;
};

type MatchPlayer = {
  id: string;
  name: string;
  side: 0 | 1;
  x: number;
  y: number;
  vx: number;
  vy: number;
  aimX: number;
  aimY: number;
  hp: number;
  maxHp: number;
  score: number;
  shotCooldownMs: number;
  dashCooldownMs: number;
  dashRemainingMs: number;
  invulnerableMs: number;
  respawnMs: number;
  disconnectedAt: number | null;
  input: PvpInput;
  lastInputSequence: number;
};

type MatchProjectile = PvpProjectileSnapshot & {
  lifeMs: number;
  damage: number;
};

type PvpMatch = {
  id: string;
  tick: number;
  phase: PvpPhase;
  startsAt: number;
  endsAt: number;
  finishedAt: number | null;
  winnerId: string | null;
  resultReason: "score" | "timeout" | "disconnect" | "draw" | null;
  players: [MatchPlayer, MatchPlayer];
  projectiles: MatchProjectile[];
  nextProjectileId: number;
};

const TICK_MS = 50;
const PLAYER_SPEED = 235;
const DASH_SPEED_MULTIPLIER = 3.15;
const DASH_DURATION_MS = 165;
const DASH_COOLDOWN_MS = 1_550;
const SHOT_COOLDOWN_MS = 360;
const PROJECTILE_SPEED = 650;
const PROJECTILE_DAMAGE = 18;
const PROJECTILE_RADIUS = 8;
const PROJECTILE_LIFE_MS = 1_650;
const RESPAWN_MS = 1_900;
const DISCONNECT_FORFEIT_MS = 10_000;
const MATCH_RETENTION_MS = 12_000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1_000;
const MAX_MESSAGE_BYTES = 2_048;
const MAX_INPUTS_PER_SECOND = 42;
const LOOT_ANNOUNCEMENT_COOLDOWN_MS = 3_000;
const ARENA_MARGIN_X = 88;
const ARENA_MARGIN_TOP = 112;
const ARENA_MARGIN_BOTTOM = 76;
const ARENA_OBSTACLES = [
  { x: 510, y: 360, radius: 66 },
  { x: 770, y: 360, radius: 66 },
] as const;

const idleInput = (): PvpInput => ({
  sequence: 0,
  moveX: 0,
  moveY: 0,
  aimX: 1,
  aimY: 0,
  fire: false,
  dash: false,
});

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.max(minimum, Math.min(maximum, value));

const distanceSquared = (ax: number, ay: number, bx: number, by: number): number => {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
};

const decodeTrustedName = (request: Request): string | null => {
  const trusted = request.headers.get("x-mujindo-player-name");
  return trusted ? sanitizeDisplayName(trusted) : null;
};

function resolveArenaCollision(player: MatchPlayer): void {
  player.x = clamp(player.x, ARENA_MARGIN_X, PVP_ARENA_WIDTH - ARENA_MARGIN_X);
  player.y = clamp(player.y, ARENA_MARGIN_TOP, PVP_ARENA_HEIGHT - ARENA_MARGIN_BOTTOM);
  for (const obstacle of ARENA_OBSTACLES) {
    const dx = player.x - obstacle.x;
    const dy = player.y - obstacle.y;
    const distance = Math.hypot(dx, dy);
    const minimumDistance = obstacle.radius + 27;
    if (distance >= minimumDistance) continue;
    const safeDistance = distance || 1;
    player.x = obstacle.x + (dx / safeDistance) * minimumDistance;
    player.y = obstacle.y + (dy / safeDistance) * minimumDistance;
  }
}

function projectileHitsObstacle(projectile: MatchProjectile): boolean {
  return ARENA_OBSTACLES.some(
    (obstacle) =>
      distanceSquared(projectile.x, projectile.y, obstacle.x, obstacle.y) <=
      (obstacle.radius + projectile.radius) ** 2,
  );
}

export class RealtimeWorld {
  private readonly state: DurableObjectState;
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly players = new Map<string, ConnectedPlayer>();
  private readonly sockets = new Map<WebSocket, ConnectedPlayer>();
  private readonly queue: string[] = [];
  private readonly matches = new Map<string, PvpMatch>();
  private readonly recentAnnouncements: WorldLootAnnouncement[] = [];
  private readonly acquisitionIds = new Map<string, number>();
  private announcementSequence = 0;
  private loop: ReturnType<typeof setInterval> | null = null;

  constructor(state: DurableObjectState) {
    this.state = state;
    this.state.blockConcurrencyWhile(async () => {
      const [announcements, sequence] = await Promise.all([
        this.state.storage.get<WorldLootAnnouncement[]>("world:recent-announcements"),
        this.state.storage.get<number>("world:announcement-sequence"),
      ]);
      if (Array.isArray(announcements)) {
        this.recentAnnouncements.push(...announcements.slice(-12));
      }
      if (typeof sequence === "number" && Number.isSafeInteger(sequence)) {
        this.announcementSequence = Math.max(0, sequence);
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/session") && request.method === "POST") {
      return this.createSession(request);
    }
    if (url.pathname.endsWith("/socket")) {
      return this.openSocket(request);
    }
    if (url.pathname.endsWith("/health")) {
      return json({
        ok: true,
        online: this.onlineCount(),
        queued: this.queue.length,
        matches: this.matches.size,
      });
    }
    return json({ error: "not_found" }, 404);
  }

  private async createSession(request: Request): Promise<Response> {
    let requestedName: unknown = null;
    try {
      const parsed = (await request.json()) as { displayName?: unknown };
      requestedName = parsed.displayName;
    } catch {
      // An empty body is valid; a safe generated client name is used below.
    }
    const displayName = decodeTrustedName(request) ?? sanitizeDisplayName(requestedName);
    const token = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
    const session: SessionRecord = {
      token,
      playerId: crypto.randomUUID(),
      displayName,
      expiresAt: Date.now() + SESSION_TTL_MS,
    };
    this.sessions.set(token, session);
    await this.state.storage.put(`session:${token}`, session);
    this.ensureLoop();
    return json({
      token: session.token,
      playerId: session.playerId,
      displayName: session.displayName,
      expiresAt: session.expiresAt,
    });
  }

  private async openSocket(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("origin");
    if (origin && origin !== url.origin) return json({ error: "invalid_origin" }, 403);
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return json({ error: "websocket_required" }, 426);
    }
    const token = url.searchParams.get("token") ?? "";
    const session =
      this.sessions.get(token) ??
      (await this.state.storage.get<SessionRecord>(`session:${token}`));
    if (!session || session.expiresAt <= Date.now()) {
      this.sessions.delete(token);
      await this.state.storage.delete(`session:${token}`);
      return json({ error: "invalid_session" }, 401);
    }
    this.sessions.set(token, session);

    const pair = new WebSocketPair();
    const clientSocket = pair[0];
    const serverSocket = pair[1];
    serverSocket.accept();

    let player = this.players.get(session.playerId);
    if (!player) {
      player = {
        id: session.playerId,
        displayName: session.displayName,
        sessionToken: token,
        socket: null,
        queued: false,
        matchId: null,
        lastLootAnnouncementAt: 0,
        inputWindowStartedAt: Date.now(),
        inputCount: 0,
      };
      this.players.set(player.id, player);
    }
    if (player.socket && player.socket !== serverSocket) {
      try {
        player.socket.close(4000, "다른 연결로 전환되었습니다.");
      } catch {
        // The previous edge socket may already be gone.
      }
      this.sockets.delete(player.socket);
    }
    player.displayName = session.displayName;
    player.sessionToken = token;
    player.socket = serverSocket;
    this.sockets.set(serverSocket, player);
    this.restoreMatchConnection(player);

    serverSocket.addEventListener("message", (event) => {
      this.handleSocketMessage(player!, event.data);
    });
    serverSocket.addEventListener("close", () => this.handleSocketClose(serverSocket));
    serverSocket.addEventListener("error", () => this.handleSocketClose(serverSocket));

    this.send(player, {
      type: "connected",
      playerId: player.id,
      displayName: player.displayName,
      online: this.onlineCount(),
      recentAnnouncements: this.recentAnnouncements.slice(-6),
    });
    this.broadcastPresence();
    this.ensureLoop();

    return new Response(null, { status: 101, webSocket: clientSocket });
  }

  private handleSocketMessage(player: ConnectedPlayer, data: string | ArrayBuffer): void {
    const raw = typeof data === "string" ? data : new TextDecoder().decode(data);
    if (new TextEncoder().encode(raw).byteLength > MAX_MESSAGE_BYTES) {
      this.sendError(player, "message_too_large", "메시지 크기 제한을 초과했습니다.");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.sendError(player, "invalid_json", "해석할 수 없는 메시지입니다.");
      return;
    }
    const message = parseRealtimeClientMessage(parsed);
    if (!message) {
      this.sendError(player, "invalid_message", "허용되지 않은 요청입니다.");
      return;
    }
    switch (message.type) {
      case "queue":
        this.joinQueue(player);
        break;
      case "cancel_queue":
        this.leaveQueue(player);
        break;
      case "pvp_input":
        this.receiveInput(player, message);
        break;
      case "announce_loot":
        this.publishLoot(player, message);
        break;
      case "ping":
        this.send(player, {
          type: "pong",
          clientTime: message.clientTime,
          serverTime: Date.now(),
        });
        break;
    }
  }

  private handleSocketClose(socket: WebSocket): void {
    const player = this.sockets.get(socket);
    if (!player || player.socket !== socket) return;
    this.sockets.delete(socket);
    player.socket = null;
    if (player.queued) this.leaveQueue(player, false);
    if (player.matchId) {
      const match = this.matches.get(player.matchId);
      const matchPlayer = match?.players.find((candidate) => candidate.id === player.id);
      if (matchPlayer && matchPlayer.disconnectedAt === null) {
        matchPlayer.disconnectedAt = Date.now();
      }
    }
    this.broadcastPresence();
  }

  private restoreMatchConnection(player: ConnectedPlayer): void {
    if (!player.matchId) return;
    const match = this.matches.get(player.matchId);
    const matchPlayer = match?.players.find((candidate) => candidate.id === player.id);
    if (!match || !matchPlayer) {
      player.matchId = null;
      return;
    }
    matchPlayer.disconnectedAt = null;
    const opponent = match.players.find((candidate) => candidate.id !== player.id)!;
    this.send(player, {
      type: "match_found",
      matchId: match.id,
      opponentName: opponent.name,
      side: matchPlayer.side,
      startsAt: match.startsAt,
      durationMs: PVP_ROUND_DURATION_MS,
      scoreToWin: PVP_SCORE_TO_WIN,
    });
    this.sendSnapshot(match, player);
  }

  private joinQueue(player: ConnectedPlayer): void {
    if (!player.socket) return;
    if (player.matchId) this.detachFromFinishedMatch(player);
    if (player.matchId) {
      this.sendError(player, "match_in_progress", "진행 중인 결투가 있습니다.");
      return;
    }
    if (!player.queued) {
      player.queued = true;
      this.queue.push(player.id);
    }
    this.sendQueuePositions();
    this.makeMatches();
  }

  private leaveQueue(player: ConnectedPlayer, notify = true): void {
    player.queued = false;
    let index = this.queue.indexOf(player.id);
    while (index >= 0) {
      this.queue.splice(index, 1);
      index = this.queue.indexOf(player.id);
    }
    if (notify) this.send(player, { type: "queue_state", state: "idle" });
    this.sendQueuePositions();
  }

  private sendQueuePositions(): void {
    this.queue.forEach((playerId, index) => {
      const player = this.players.get(playerId);
      if (player?.socket && player.queued) {
        this.send(player, { type: "queue_state", state: "queued", position: index + 1 });
      }
    });
  }

  private makeMatches(): void {
    while (true) {
      const candidates: ConnectedPlayer[] = [];
      while (this.queue.length > 0 && candidates.length < 2) {
        const playerId = this.queue.shift()!;
        const player = this.players.get(playerId);
        if (!player?.socket || !player.queued || player.matchId) continue;
        candidates.push(player);
      }
      if (candidates.length < 2) {
        if (candidates[0]) this.queue.unshift(candidates[0].id);
        break;
      }
      this.createMatch(candidates[0], candidates[1]);
    }
    this.sendQueuePositions();
  }

  private createMatch(left: ConnectedPlayer, right: ConnectedPlayer): void {
    left.queued = false;
    right.queued = false;
    const now = Date.now();
    const matchId = crypto.randomUUID();
    const makeMatchPlayer = (
      player: ConnectedPlayer,
      side: 0 | 1,
    ): MatchPlayer => ({
      id: player.id,
      name: player.displayName,
      side,
      x: side === 0 ? 250 : PVP_ARENA_WIDTH - 250,
      y: PVP_ARENA_HEIGHT / 2,
      vx: 0,
      vy: 0,
      aimX: side === 0 ? 1 : -1,
      aimY: 0,
      hp: 100,
      maxHp: 100,
      score: 0,
      shotCooldownMs: 500,
      dashCooldownMs: 0,
      dashRemainingMs: 0,
      invulnerableMs: 850,
      respawnMs: 0,
      disconnectedAt: null,
      input: idleInput(),
      lastInputSequence: 0,
    });
    const match: PvpMatch = {
      id: matchId,
      tick: 0,
      phase: "countdown",
      startsAt: now + PVP_COUNTDOWN_MS,
      endsAt: now + PVP_COUNTDOWN_MS + PVP_ROUND_DURATION_MS,
      finishedAt: null,
      winnerId: null,
      resultReason: null,
      players: [makeMatchPlayer(left, 0), makeMatchPlayer(right, 1)],
      projectiles: [],
      nextProjectileId: 1,
    };
    this.matches.set(match.id, match);
    left.matchId = match.id;
    right.matchId = match.id;
    for (const [player, opponent, side] of [
      [left, right, 0],
      [right, left, 1],
    ] as const) {
      this.send(player, {
        type: "match_found",
        matchId,
        opponentName: opponent.displayName,
        side,
        startsAt: match.startsAt,
        durationMs: PVP_ROUND_DURATION_MS,
        scoreToWin: PVP_SCORE_TO_WIN,
      });
    }
    this.sendSnapshot(match);
  }

  private receiveInput(player: ConnectedPlayer, input: PvpInput): void {
    if (!player.matchId) return;
    const now = Date.now();
    if (now - player.inputWindowStartedAt >= 1_000) {
      player.inputWindowStartedAt = now;
      player.inputCount = 0;
    }
    player.inputCount += 1;
    if (player.inputCount > MAX_INPUTS_PER_SECOND) return;
    const match = this.matches.get(player.matchId);
    const matchPlayer = match?.players.find((candidate) => candidate.id === player.id);
    if (!matchPlayer || input.sequence <= matchPlayer.lastInputSequence) return;
    matchPlayer.lastInputSequence = input.sequence;
    matchPlayer.input = input;
    matchPlayer.aimX = input.aimX;
    matchPlayer.aimY = input.aimY;
  }

  private publishLoot(
    player: ConnectedPlayer,
    message: Extract<ReturnType<typeof parseRealtimeClientMessage>, { type: "announce_loot" }>,
  ): void {
    if (!message) return;
    const now = Date.now();
    if (now - player.lastLootAnnouncementAt < LOOT_ANNOUNCEMENT_COOLDOWN_MS) return;
    if (this.acquisitionIds.has(message.acquisitionId)) return;
    player.lastLootAnnouncementAt = now;
    this.acquisitionIds.set(message.acquisitionId, now);
    this.announcementSequence += 1;
    const announcement: WorldLootAnnouncement = {
      id: crypto.randomUUID(),
      sequence: this.announcementSequence,
      playerName: player.displayName,
      itemName: message.itemName,
      rarity: message.rarity,
      itemLevel: message.itemLevel,
      enhancement: message.enhancement,
      createdAt: now,
    };
    this.recentAnnouncements.push(announcement);
    if (this.recentAnnouncements.length > 12) this.recentAnnouncements.shift();
    this.state.waitUntil(
      this.state.storage.put({
        "world:recent-announcements": this.recentAnnouncements,
        "world:announcement-sequence": this.announcementSequence,
      }),
    );
    this.broadcast({ type: "world_announcement", announcement });
  }

  private ensureLoop(): void {
    if (this.loop) return;
    this.loop = setInterval(() => this.tick(), TICK_MS);
  }

  private tick(): void {
    const now = Date.now();
    for (const match of this.matches.values()) this.stepMatch(match, now);
    this.cleanup(now);
    if (this.matches.size === 0 && this.sockets.size === 0 && this.sessions.size === 0) {
      if (this.loop) clearInterval(this.loop);
      this.loop = null;
    }
  }

  private stepMatch(match: PvpMatch, now: number): void {
    match.tick += 1;
    if (match.phase === "countdown") {
      if (now >= match.startsAt) match.phase = "playing";
      this.sendSnapshot(match);
      return;
    }
    if (match.phase === "finished") {
      if (match.tick % 2 === 0) this.sendSnapshot(match);
      return;
    }

    for (const player of match.players) {
      if (
        player.disconnectedAt !== null &&
        now - player.disconnectedAt >= DISCONNECT_FORFEIT_MS
      ) {
        const opponent = match.players.find((candidate) => candidate.id !== player.id)!;
        this.finishMatch(match, opponent.id, "disconnect", now);
        return;
      }
    }
    if (now >= match.endsAt) {
      const [left, right] = match.players;
      if (left.score === right.score) this.finishMatch(match, null, "draw", now);
      else this.finishMatch(match, left.score > right.score ? left.id : right.id, "timeout", now);
      return;
    }

    const deltaSeconds = TICK_MS / 1_000;
    for (const player of match.players) {
      player.shotCooldownMs = Math.max(0, player.shotCooldownMs - TICK_MS);
      player.dashCooldownMs = Math.max(0, player.dashCooldownMs - TICK_MS);
      player.dashRemainingMs = Math.max(0, player.dashRemainingMs - TICK_MS);
      player.invulnerableMs = Math.max(0, player.invulnerableMs - TICK_MS);
      if (player.respawnMs > 0) {
        player.respawnMs = Math.max(0, player.respawnMs - TICK_MS);
        if (player.respawnMs === 0) this.respawnPlayer(player);
        continue;
      }
      if (player.input.dash && player.dashCooldownMs <= 0) {
        player.dashRemainingMs = DASH_DURATION_MS;
        player.dashCooldownMs = DASH_COOLDOWN_MS;
        player.invulnerableMs = DASH_DURATION_MS + 70;
      }
      player.input = { ...player.input, dash: false };
      const speed =
        PLAYER_SPEED * (player.dashRemainingMs > 0 ? DASH_SPEED_MULTIPLIER : 1);
      player.vx = player.input.moveX * speed;
      player.vy = player.input.moveY * speed;
      player.x += player.vx * deltaSeconds;
      player.y += player.vy * deltaSeconds;
      resolveArenaCollision(player);

      if (player.input.fire && player.shotCooldownMs <= 0 && player.dashRemainingMs <= 0) {
        player.shotCooldownMs = SHOT_COOLDOWN_MS;
        match.projectiles.push({
          id: match.nextProjectileId++,
          ownerId: player.id,
          x: player.x + player.aimX * 32,
          y: player.y + player.aimY * 32,
          vx: player.aimX * PROJECTILE_SPEED,
          vy: player.aimY * PROJECTILE_SPEED,
          radius: PROJECTILE_RADIUS,
          lifeMs: PROJECTILE_LIFE_MS,
          damage: PROJECTILE_DAMAGE,
        });
      }
    }

    const liveProjectiles: MatchProjectile[] = [];
    for (const projectile of match.projectiles) {
      projectile.lifeMs -= TICK_MS;
      projectile.x += projectile.vx * deltaSeconds;
      projectile.y += projectile.vy * deltaSeconds;
      if (
        projectile.lifeMs <= 0 ||
        projectile.x < 0 ||
        projectile.x > PVP_ARENA_WIDTH ||
        projectile.y < 0 ||
        projectile.y > PVP_ARENA_HEIGHT ||
        projectileHitsObstacle(projectile)
      ) {
        continue;
      }
      const target = match.players.find(
        (candidate) => candidate.id !== projectile.ownerId && candidate.respawnMs <= 0,
      );
      if (
        target &&
        target.invulnerableMs <= 0 &&
        distanceSquared(projectile.x, projectile.y, target.x, target.y) <=
          (projectile.radius + 25) ** 2
      ) {
        target.hp = Math.max(0, target.hp - projectile.damage);
        if (target.hp <= 0) {
          const owner = match.players.find((candidate) => candidate.id === projectile.ownerId);
          if (owner) {
            owner.score += 1;
            if (owner.score >= PVP_SCORE_TO_WIN) {
              this.finishMatch(match, owner.id, "score", now);
              return;
            }
          }
          target.respawnMs = RESPAWN_MS;
          target.vx = 0;
          target.vy = 0;
        }
        continue;
      }
      liveProjectiles.push(projectile);
    }
    match.projectiles = liveProjectiles;
    this.sendSnapshot(match);
  }

  private respawnPlayer(player: MatchPlayer): void {
    player.x = player.side === 0 ? 250 : PVP_ARENA_WIDTH - 250;
    player.y = PVP_ARENA_HEIGHT / 2;
    player.hp = player.maxHp;
    player.invulnerableMs = 900;
    player.shotCooldownMs = 450;
  }

  private finishMatch(
    match: PvpMatch,
    winnerId: string | null,
    reason: "score" | "timeout" | "disconnect" | "draw",
    now: number,
  ): void {
    if (match.phase === "finished") return;
    match.phase = "finished";
    match.finishedAt = now;
    match.winnerId = winnerId;
    match.resultReason = reason;
    match.projectiles = [];
    this.sendSnapshot(match);
    for (const participant of match.players) {
      const player = this.players.get(participant.id);
      if (player) {
        this.send(player, {
          type: "match_result",
          matchId: match.id,
          winnerId,
          reason,
        });
      }
    }
  }

  private detachFromFinishedMatch(player: ConnectedPlayer): void {
    if (!player.matchId) return;
    const match = this.matches.get(player.matchId);
    if (!match || match.phase === "finished") player.matchId = null;
  }

  private sendSnapshot(match: PvpMatch, onlyPlayer?: ConnectedPlayer): void {
    const now = Date.now();
    const message: RealtimeServerMessage = {
      type: "pvp_snapshot",
      matchId: match.id,
      tick: match.tick,
      serverTime: now,
      phase: match.phase,
      startsAt: match.startsAt,
      remainingMs:
        match.phase === "countdown"
          ? PVP_ROUND_DURATION_MS
          : Math.max(0, match.endsAt - now),
      winnerId: match.winnerId,
      players: match.players.map<PvpPlayerSnapshot>((player) => ({
        id: player.id,
        name: player.name,
        side: player.side,
        x: Math.round(player.x * 10) / 10,
        y: Math.round(player.y * 10) / 10,
        vx: Math.round(player.vx * 10) / 10,
        vy: Math.round(player.vy * 10) / 10,
        aimX: player.aimX,
        aimY: player.aimY,
        hp: player.hp,
        maxHp: player.maxHp,
        score: player.score,
        dashCooldownMs: player.dashCooldownMs,
        respawnMs: player.respawnMs,
        connected: player.disconnectedAt === null,
        lastInputSequence: player.lastInputSequence,
      })),
      projectiles: match.projectiles.map(({ lifeMs: _lifeMs, damage: _damage, ...projectile }) =>
        projectile,
      ),
    };
    if (onlyPlayer) {
      this.send(onlyPlayer, message);
      return;
    }
    for (const participant of match.players) {
      const player = this.players.get(participant.id);
      if (player) this.send(player, message);
    }
  }

  private cleanup(now: number): void {
    for (const [token, session] of this.sessions) {
      if (session.expiresAt <= now) {
        this.sessions.delete(token);
        this.state.waitUntil(this.state.storage.delete(`session:${token}`));
      }
    }
    for (const [acquisitionId, createdAt] of this.acquisitionIds) {
      if (now - createdAt > SESSION_TTL_MS) this.acquisitionIds.delete(acquisitionId);
    }
    for (const [matchId, match] of this.matches) {
      if (!match.finishedAt || now - match.finishedAt < MATCH_RETENTION_MS) continue;
      for (const participant of match.players) {
        const player = this.players.get(participant.id);
        if (player?.matchId === matchId) {
          player.matchId = null;
          this.send(player, { type: "queue_state", state: "idle" });
        }
      }
      this.matches.delete(matchId);
    }
    for (const [playerId, player] of this.players) {
      const session = this.sessions.get(player.sessionToken);
      if (!player.socket && !player.matchId && !player.queued && !session) {
        this.players.delete(playerId);
      }
    }
  }

  private onlineCount(): number {
    return [...this.players.values()].filter((player) => player.socket !== null).length;
  }

  private broadcastPresence(): void {
    this.broadcast({ type: "presence", online: this.onlineCount() });
  }

  private broadcast(message: RealtimeServerMessage): void {
    for (const player of this.players.values()) this.send(player, message);
  }

  private send(player: ConnectedPlayer, message: RealtimeServerMessage): void {
    if (!player.socket || player.socket.readyState !== WebSocket.OPEN) return;
    try {
      player.socket.send(JSON.stringify(message));
    } catch {
      // Closing edge sockets are removed by their close/error listeners.
    }
  }

  private sendError(player: ConnectedPlayer, code: string, message: string): void {
    this.send(player, { type: "error", code, message });
  }
}

export const PVP_SERVER_RULES = {
  tickMs: TICK_MS,
  playerSpeed: PLAYER_SPEED,
  dashCooldownMs: DASH_COOLDOWN_MS,
  shotCooldownMs: SHOT_COOLDOWN_MS,
  projectileDamage: PROJECTILE_DAMAGE,
  obstacles: ARENA_OBSTACLES,
} as const;
