import type { GearRarity } from "./equipment";

export const GAME_AUDIO_SETTINGS_KEY = "mujindo:last-comma:audio-v1";
export const MAIN_BGM_URL = "/assets/audio/music/the-last-comma.mp3";

export type GameAudioSettings = {
  musicMuted: boolean;
  sfxMuted: boolean;
  musicVolume: number;
  sfxVolume: number;
};

type CueBus = "sfx" | "ui";

type CueDefinition = {
  path: string;
  gain: number;
  cooldownMs: number;
  maxVoices: number;
  priority: number;
  rateVariance: number;
  maxLatencyMs: number;
  bus: CueBus;
};

export const GAME_AUDIO_CUES = {
  uiConfirm: {
    path: "/assets/audio/sfx/ui-confirm.wav",
    gain: 0.46,
    cooldownMs: 70,
    maxVoices: 3,
    priority: 4,
    rateVariance: 0.015,
    maxLatencyMs: 450,
    bus: "ui",
  },
  uiBack: {
    path: "/assets/audio/sfx/ui-back.wav",
    gain: 0.42,
    cooldownMs: 80,
    maxVoices: 2,
    priority: 4,
    rateVariance: 0,
    maxLatencyMs: 450,
    bus: "ui",
  },
  playerShot: {
    path: "/assets/audio/sfx/player-shot.wav",
    gain: 0.32,
    cooldownMs: 72,
    maxVoices: 4,
    priority: 2,
    rateVariance: 0.028,
    maxLatencyMs: 180,
    bus: "sfx",
  },
  playerCrit: {
    path: "/assets/audio/sfx/player-crit.wav",
    gain: 0.47,
    cooldownMs: 105,
    maxVoices: 3,
    priority: 3,
    rateVariance: 0.02,
    maxLatencyMs: 240,
    bus: "sfx",
  },
  playerHit: {
    path: "/assets/audio/sfx/player-hit.wav",
    gain: 0.58,
    cooldownMs: 180,
    maxVoices: 2,
    priority: 5,
    rateVariance: 0.018,
    maxLatencyMs: 420,
    bus: "sfx",
  },
  playerDash: {
    path: "/assets/audio/sfx/player-dash.wav",
    gain: 0.4,
    cooldownMs: 140,
    maxVoices: 2,
    priority: 3,
    rateVariance: 0.025,
    maxLatencyMs: 260,
    bus: "sfx",
  },
  playerImpact: {
    path: "/assets/audio/sfx/player-impact.wav",
    gain: 0.26,
    cooldownMs: 54,
    maxVoices: 6,
    priority: 1,
    rateVariance: 0.04,
    maxLatencyMs: 150,
    bus: "sfx",
  },
  enemyShot: {
    path: "/assets/audio/sfx/enemy-shot.wav",
    gain: 0.3,
    cooldownMs: 82,
    maxVoices: 5,
    priority: 2,
    rateVariance: 0.035,
    maxLatencyMs: 180,
    bus: "sfx",
  },
  enemyDeath: {
    path: "/assets/audio/sfx/enemy-death.wav",
    gain: 0.38,
    cooldownMs: 78,
    maxVoices: 4,
    priority: 2,
    rateVariance: 0.045,
    maxLatencyMs: 260,
    bus: "sfx",
  },
  enemyDeathHeavy: {
    path: "/assets/audio/sfx/enemy-death-heavy.wav",
    gain: 0.61,
    cooldownMs: 160,
    maxVoices: 3,
    priority: 5,
    rateVariance: 0.018,
    maxLatencyMs: 550,
    bus: "sfx",
  },
  enemySummon: {
    path: "/assets/audio/sfx/enemy-summon.wav",
    gain: 0.52,
    cooldownMs: 190,
    maxVoices: 3,
    priority: 4,
    rateVariance: 0.02,
    maxLatencyMs: 500,
    bus: "sfx",
  },
  enemyTeleport: {
    path: "/assets/audio/sfx/enemy-teleport.wav",
    gain: 0.48,
    cooldownMs: 150,
    maxVoices: 3,
    priority: 4,
    rateVariance: 0.02,
    maxLatencyMs: 420,
    bus: "sfx",
  },
  enemyCharge: {
    path: "/assets/audio/sfx/enemy-charge.wav",
    gain: 0.55,
    cooldownMs: 260,
    maxVoices: 2,
    priority: 5,
    rateVariance: 0.012,
    maxLatencyMs: 620,
    bus: "sfx",
  },
  timeRift: {
    path: "/assets/audio/sfx/time-rift.wav",
    gain: 0.58,
    cooldownMs: 230,
    maxVoices: 3,
    priority: 5,
    rateVariance: 0.012,
    maxLatencyMs: 700,
    bus: "sfx",
  },
  memoryPickup: {
    path: "/assets/audio/sfx/memory-pickup.wav",
    gain: 0.29,
    cooldownMs: 72,
    maxVoices: 3,
    priority: 2,
    rateVariance: 0.035,
    maxLatencyMs: 180,
    bus: "sfx",
  },
  lootDrop: {
    path: "/assets/audio/sfx/loot-drop.wav",
    gain: 0.38,
    cooldownMs: 90,
    maxVoices: 4,
    priority: 3,
    rateVariance: 0.018,
    maxLatencyMs: 650,
    bus: "sfx",
  },
  lootRare: {
    path: "/assets/audio/sfx/loot-rare.wav",
    gain: 0.54,
    cooldownMs: 120,
    maxVoices: 3,
    priority: 5,
    rateVariance: 0.01,
    maxLatencyMs: 900,
    bus: "sfx",
  },
  lootLegendary: {
    path: "/assets/audio/sfx/loot-legendary.wav",
    gain: 0.7,
    cooldownMs: 180,
    maxVoices: 3,
    priority: 7,
    rateVariance: 0,
    maxLatencyMs: 1400,
    bus: "sfx",
  },
  professionAscend: {
    path: "/assets/audio/sfx/profession-ascend.wav",
    gain: 0.82,
    cooldownMs: 1800,
    maxVoices: 1,
    priority: 10,
    rateVariance: 0,
    maxLatencyMs: 2500,
    bus: "sfx",
  },
  roomClear: {
    path: "/assets/audio/sfx/room-clear.wav",
    gain: 0.57,
    cooldownMs: 550,
    maxVoices: 1,
    priority: 6,
    rateVariance: 0,
    maxLatencyMs: 1200,
    bus: "sfx",
  },
  bossAppear: {
    path: "/assets/audio/sfx/boss-appear.wav",
    gain: 0.78,
    cooldownMs: 1800,
    maxVoices: 1,
    priority: 9,
    rateVariance: 0,
    maxLatencyMs: 1800,
    bus: "sfx",
  },
  enhanceSuccess: {
    path: "/assets/audio/sfx/enhance-success.wav",
    gain: 0.62,
    cooldownMs: 300,
    maxVoices: 1,
    priority: 7,
    rateVariance: 0,
    maxLatencyMs: 1000,
    bus: "ui",
  },
  enhanceFail: {
    path: "/assets/audio/sfx/enhance-fail.wav",
    gain: 0.56,
    cooldownMs: 260,
    maxVoices: 1,
    priority: 6,
    rateVariance: 0,
    maxLatencyMs: 900,
    bus: "ui",
  },
  enhanceDestroy: {
    path: "/assets/audio/sfx/enhance-destroy.wav",
    gain: 0.72,
    cooldownMs: 500,
    maxVoices: 1,
    priority: 8,
    rateVariance: 0,
    maxLatencyMs: 1400,
    bus: "ui",
  },
  shelterRest: {
    path: "/assets/audio/sfx/shelter-rest.wav",
    gain: 0.56,
    cooldownMs: 1000,
    maxVoices: 1,
    priority: 6,
    rateVariance: 0,
    maxLatencyMs: 1200,
    bus: "sfx",
  },
  salvage: {
    path: "/assets/audio/sfx/salvage.wav",
    gain: 0.51,
    cooldownMs: 160,
    maxVoices: 2,
    priority: 5,
    rateVariance: 0.015,
    maxLatencyMs: 800,
    bus: "ui",
  },
} as const satisfies Record<string, CueDefinition>;

export type GameAudioCue = keyof typeof GAME_AUDIO_CUES;

export type PlayGameSfxOptions = {
  gain?: number;
  playbackRate?: number;
  pan?: number;
  priority?: number;
};

const DEFAULT_SETTINGS: GameAudioSettings = {
  musicMuted: false,
  sfxMuted: false,
  musicVolume: 0.38,
  sfxVolume: 0.72,
};

const MAX_ACTIVE_VOICES = 24;

type ActiveVoice = {
  cue: GameAudioCue;
  source: AudioBufferSourceNode;
  startedAt: number;
  priority: number;
};

type AudioWindow = Window &
  typeof globalThis & {
    webkitAudioContext?: typeof AudioContext;
  };

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

const normalizeSettings = (value: unknown): GameAudioSettings => {
  if (!value || typeof value !== "object") return { ...DEFAULT_SETTINGS };
  const candidate = value as Partial<GameAudioSettings>;
  return {
    musicMuted:
      typeof candidate.musicMuted === "boolean"
        ? candidate.musicMuted
        : DEFAULT_SETTINGS.musicMuted,
    sfxMuted:
      typeof candidate.sfxMuted === "boolean"
        ? candidate.sfxMuted
        : DEFAULT_SETTINGS.sfxMuted,
    musicVolume:
      typeof candidate.musicVolume === "number" && Number.isFinite(candidate.musicVolume)
        ? clamp01(candidate.musicVolume)
        : DEFAULT_SETTINGS.musicVolume,
    sfxVolume:
      typeof candidate.sfxVolume === "number" && Number.isFinite(candidate.sfxVolume)
        ? clamp01(candidate.sfxVolume)
        : DEFAULT_SETTINGS.sfxVolume,
  };
};

class GameAudioEngine {
  private settings: GameAudioSettings = { ...DEFAULT_SETTINGS };
  private hydrated = false;
  private context: AudioContext | null = null;
  private sfxBus: GainNode | null = null;
  private uiBus: GainNode | null = null;
  private music: HTMLAudioElement | null = null;
  private buffers = new Map<GameAudioCue, Promise<AudioBuffer | null>>();
  private activeVoices: ActiveVoice[] = [];
  private lastPlayedAt = new Map<GameAudioCue, number>();
  private listeners = new Set<(settings: GameAudioSettings) => void>();
  private preloadStarted = false;
  private visibilityHandlerInstalled = false;

  initialize(): void {
    if (typeof window === "undefined") return;
    this.hydrateSettings();
    this.ensureMusic();
    this.applySettings();
    this.installVisibilityHandler();
    void this.tryStartMusic();
  }

  getSettings(): GameAudioSettings {
    this.hydrateSettings();
    return { ...this.settings };
  }

  subscribe(listener: (settings: GameAudioSettings) => void): () => void {
    this.listeners.add(listener);
    listener(this.getSettings());
    return () => this.listeners.delete(listener);
  }

  setSettings(next: Partial<GameAudioSettings>): void {
    this.hydrateSettings();
    this.settings = normalizeSettings({ ...this.settings, ...next });
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(GAME_AUDIO_SETTINGS_KEY, JSON.stringify(this.settings));
      } catch {
        // Private browsing can reject persistence; live controls still work.
      }
    }
    this.applySettings();
    for (const listener of this.listeners) listener({ ...this.settings });
    if (!this.settings.musicMuted) void this.tryStartMusic();
  }

  async unlock(): Promise<void> {
    if (typeof window === "undefined") return;
    this.initialize();
    const context = this.ensureContext();
    if (context?.state === "suspended") {
      try {
        await context.resume();
      } catch {
        // A later pointer/key gesture will retry.
      }
    }
    void this.tryStartMusic();
    this.preloadAll();
  }

  play(cue: GameAudioCue, options: PlayGameSfxOptions = {}): void {
    if (typeof window === "undefined") return;
    this.hydrateSettings();
    if (this.settings.sfxMuted || this.settings.sfxVolume <= 0) return;
    const definition = GAME_AUDIO_CUES[cue];
    const requestedAt = performance.now();
    const previous = this.lastPlayedAt.get(cue) ?? -Infinity;
    if (requestedAt - previous < definition.cooldownMs) return;
    this.lastPlayedAt.set(cue, requestedAt);
    void this.playLoaded(cue, options, requestedAt);
  }

  private hydrateSettings(): void {
    if (this.hydrated || typeof window === "undefined") return;
    this.hydrated = true;
    try {
      const stored = window.localStorage.getItem(GAME_AUDIO_SETTINGS_KEY);
      if (stored) this.settings = normalizeSettings(JSON.parse(stored));
    } catch {
      this.settings = { ...DEFAULT_SETTINGS };
    }
  }

  private ensureMusic(): HTMLAudioElement | null {
    if (this.music || typeof window === "undefined") return this.music;
    const music = new Audio(MAIN_BGM_URL);
    music.loop = true;
    music.preload = "metadata";
    music.volume = this.settings.musicVolume;
    music.muted = this.settings.musicMuted;
    music.setAttribute("data-main-bgm", "the-last-comma");
    this.music = music;
    return music;
  }

  private ensureContext(): AudioContext | null {
    if (this.context || typeof window === "undefined") return this.context;
    const AudioContextConstructor =
      window.AudioContext ?? (window as AudioWindow).webkitAudioContext;
    if (!AudioContextConstructor) return null;
    const context = new AudioContextConstructor({ latencyHint: "interactive" });
    const sfxBus = context.createGain();
    const uiBus = context.createGain();
    sfxBus.connect(context.destination);
    uiBus.connect(context.destination);
    this.context = context;
    this.sfxBus = sfxBus;
    this.uiBus = uiBus;
    this.applySettings();
    return context;
  }

  private applySettings(): void {
    if (this.music) {
      this.music.volume = this.settings.musicVolume;
      this.music.muted = this.settings.musicMuted;
      if (this.settings.musicMuted) this.music.pause();
    }
    if (this.context && this.sfxBus && this.uiBus) {
      const now = this.context.currentTime;
      const target = this.settings.sfxMuted ? 0 : this.settings.sfxVolume;
      this.sfxBus.gain.setTargetAtTime(target, now, 0.012);
      this.uiBus.gain.setTargetAtTime(target * 0.84, now, 0.012);
    }
  }

  private async tryStartMusic(): Promise<void> {
    const music = this.ensureMusic();
    if (
      !music ||
      this.settings.musicMuted ||
      this.settings.musicVolume <= 0 ||
      (typeof document !== "undefined" && document.hidden)
    ) {
      return;
    }
    try {
      await music.play();
    } catch {
      // Expected before the browser receives its first user gesture.
    }
  }

  private installVisibilityHandler(): void {
    if (this.visibilityHandlerInstalled || typeof document === "undefined") return;
    this.visibilityHandlerInstalled = true;
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        this.music?.pause();
      } else if (!this.settings.musicMuted) {
        void this.tryStartMusic();
      }
    });
  }

  private preloadAll(): void {
    if (this.preloadStarted) return;
    this.preloadStarted = true;
    for (const cue of Object.keys(GAME_AUDIO_CUES) as GameAudioCue[]) {
      void this.loadBuffer(cue);
    }
  }

  private loadBuffer(cue: GameAudioCue): Promise<AudioBuffer | null> {
    const cached = this.buffers.get(cue);
    if (cached) return cached;
    const promise = (async () => {
      const context = this.ensureContext();
      if (!context) return null;
      try {
        const response = await fetch(GAME_AUDIO_CUES[cue].path, { cache: "force-cache" });
        if (!response.ok) return null;
        const bytes = await response.arrayBuffer();
        return await context.decodeAudioData(bytes.slice(0));
      } catch {
        return null;
      }
    })();
    this.buffers.set(cue, promise);
    return promise;
  }

  private async playLoaded(
    cue: GameAudioCue,
    options: PlayGameSfxOptions,
    requestedAt: number,
  ): Promise<void> {
    const context = this.ensureContext();
    if (!context) return;
    if (context.state === "suspended") {
      try {
        await context.resume();
      } catch {
        return;
      }
    }
    const definition = GAME_AUDIO_CUES[cue];
    const buffer = await this.loadBuffer(cue);
    if (!buffer || performance.now() - requestedAt > definition.maxLatencyMs) return;
    if (this.settings.sfxMuted || this.settings.sfxVolume <= 0) return;

    this.activeVoices = this.activeVoices.filter(
      (voice) => voice.source.buffer !== null,
    );
    const cueVoices = this.activeVoices.filter((voice) => voice.cue === cue);
    if (cueVoices.length >= definition.maxVoices) {
      this.stopVoice(cueVoices[0]);
    }

    const priority = options.priority ?? definition.priority;
    if (this.activeVoices.length >= MAX_ACTIVE_VOICES) {
      const candidate = [...this.activeVoices].sort(
        (left, right) => left.priority - right.priority || left.startedAt - right.startedAt,
      )[0];
      if (!candidate || candidate.priority > priority) return;
      this.stopVoice(candidate);
    }

    const source = context.createBufferSource();
    const gainNode = context.createGain();
    const panner = context.createStereoPanner();
    const variance = definition.rateVariance;
    const randomizedRate = 1 + (Math.random() * 2 - 1) * variance;
    source.buffer = buffer;
    source.playbackRate.value = Math.max(
      0.55,
      Math.min(1.8, (options.playbackRate ?? 1) * randomizedRate),
    );
    gainNode.gain.value = Math.max(
      0,
      Math.min(1.4, definition.gain * (options.gain ?? 1)),
    );
    panner.pan.value = Math.max(-1, Math.min(1, options.pan ?? 0));
    source.connect(gainNode);
    gainNode.connect(panner);
    panner.connect(definition.bus === "ui" ? this.uiBus! : this.sfxBus!);

    const voice: ActiveVoice = {
      cue,
      source,
      startedAt: performance.now(),
      priority,
    };
    this.activeVoices.push(voice);
    source.onended = () => {
      this.activeVoices = this.activeVoices.filter((active) => active !== voice);
      source.disconnect();
      gainNode.disconnect();
      panner.disconnect();
    };
    source.start();
  }

  private stopVoice(voice: ActiveVoice): void {
    this.activeVoices = this.activeVoices.filter((active) => active !== voice);
    try {
      voice.source.stop();
    } catch {
      // A voice that ended between selection and stopping needs no action.
    }
  }
}

let singleton: GameAudioEngine | null = null;

export const getGameAudio = (): GameAudioEngine => {
  if (!singleton) singleton = new GameAudioEngine();
  return singleton;
};

export const playGameSfx = (
  cue: GameAudioCue,
  options?: PlayGameSfxOptions,
): void => getGameAudio().play(cue, options);

export const playGearRaritySfx = (
  rarity: GearRarity,
): void => {
  if (rarity === "common" || rarity === "magic" || rarity === "superior") {
    playGameSfx("lootDrop", {
      playbackRate: rarity === "common" ? 0.92 : rarity === "magic" ? 1 : 1.07,
      gain: rarity === "common" ? 0.78 : rarity === "magic" ? 0.9 : 1,
    });
    return;
  }
  if (rarity === "rare" || rarity === "epic") {
    playGameSfx("lootRare", {
      playbackRate: rarity === "rare" ? 0.96 : 1.08,
      gain: rarity === "rare" ? 0.92 : 1.08,
    });
    return;
  }
  playGameSfx("lootLegendary", {
    playbackRate: rarity === "legendary" ? 0.94 : rarity === "mythic" ? 1.04 : 1.14,
    gain: rarity === "legendary" ? 0.94 : rarity === "mythic" ? 1.08 : 1.2,
    priority: rarity === "cosmic" ? 10 : 8,
  });
};
