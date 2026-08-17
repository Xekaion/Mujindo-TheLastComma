"use client";

import {
  useEffect,
  useState,
  useSyncExternalStore,
  type ChangeEvent,
  type ReactNode,
} from "react";
import "./audio-controls.css";
import {
  GAME_AUDIO_CUES,
  getGameAudio,
  playGameSfx,
  type GameAudioCue,
  type GameAudioSettings,
} from "./game-audio";
import {
  ROOM_DOOR_SHOWCASE_ROOMS,
  isLocalRoomDoorShowcaseHost,
} from "./room-door-showcase";
import { isLocalPvpShowcaseRequest } from "./pvp-showcase";

type GameAudioProviderProps = {
  children: ReactNode;
};

const FALLBACK_SETTINGS: GameAudioSettings = {
  musicMuted: false,
  sfxMuted: false,
  musicVolume: 0.38,
  sfxVolume: 0.72,
};

const isGameAudioCue = (value: string): value is GameAudioCue =>
  Object.prototype.hasOwnProperty.call(GAME_AUDIO_CUES, value);

const percent = (value: number) => Math.round(value * 100);

const LOCAL_LOOT_VFX_SHOWCASE_MODES = new Set([
  "common",
  "magic",
  "superior",
  "rare",
  "epic",
  "legendary",
  "mythic",
  "cosmic",
  "crop-icons",
  "all",
]);
const LOCAL_ENEMY_VFX_SHOWCASE_MODES = new Set([
  "margin-severer",
  "silent-librarian",
  "forbidden-indexer",
]);
const LOCAL_SHOWCASE_HOSTNAMES = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
]);

const subscribeToLocalShowcaseLocation = () => () => undefined;
const isLocalShowcaseHost = () =>
  isLocalRoomDoorShowcaseHost(window.location.host) ||
  LOCAL_SHOWCASE_HOSTNAMES.has(window.location.hostname.toLowerCase());
const localShowcaseBrowserSnapshot = () => {
  if (!isLocalShowcaseHost()) return false;

  const search = new URLSearchParams(window.location.search);
  const lootMode = search.get("lootVfxShowcase");
  const enemyMode = search.get("enemyVfxShowcase");
  const roomMode = search.get("roomDoorShowcase");
  return (
    (lootMode !== null && LOCAL_LOOT_VFX_SHOWCASE_MODES.has(lootMode)) ||
    (enemyMode !== null && LOCAL_ENEMY_VFX_SHOWCASE_MODES.has(enemyMode)) ||
    search.get("plazaMotionShowcase") === "1" ||
    isLocalPvpShowcaseRequest(
      search.get("pvpShowcase"),
      window.location.hostname,
    ) ||
    (roomMode !== null && ROOM_DOOR_SHOWCASE_ROOMS.some((room) => room === roomMode))
  );
};
const localAudioDockShowcaseBrowserSnapshot = () =>
  isLocalShowcaseHost() &&
  new URLSearchParams(window.location.search).get("audioDockShowcase") === "1";
const localShowcaseServerSnapshot = () => false;

export default function GameAudioProvider({ children }: GameAudioProviderProps) {
  const [settings, setSettings] = useState<GameAudioSettings>(FALLBACK_SETTINGS);
  const [panelOpen, setPanelOpen] = useState(false);
  const localShowcaseBypass = useSyncExternalStore(
    subscribeToLocalShowcaseLocation,
    localShowcaseBrowserSnapshot,
    localShowcaseServerSnapshot,
  );
  const localAudioDockShowcase = useSyncExternalStore(
    subscribeToLocalShowcaseLocation,
    localAudioDockShowcaseBrowserSnapshot,
    localShowcaseServerSnapshot,
  );

  useEffect(() => {
    if (localShowcaseBrowserSnapshot() || localAudioDockShowcase) return undefined;

    const audio = getGameAudio();
    const unsubscribe = audio.subscribe(setSettings);
    audio.initialize();

    const unlock = () => {
      void audio.unlock();
    };
    const handleGlobalClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const interactive = target.closest<HTMLElement>(
        "button, a[href], [role='button'], input[type='checkbox'], input[type='radio']",
      );
      if (
        !interactive ||
        interactive.matches(":disabled, [aria-disabled='true']") ||
        interactive.dataset.audioCue === "none"
      ) {
        return;
      }
      const requestedCue = interactive.dataset.audioCue;
      playGameSfx(
        requestedCue && isGameAudioCue(requestedCue) ? requestedCue : "uiConfirm",
        { gain: 0.72 },
      );
    };

    document.addEventListener("pointerdown", unlock, { capture: true });
    document.addEventListener("keydown", unlock, { capture: true });
    document.addEventListener("click", handleGlobalClick);
    return () => {
      unsubscribe();
      document.removeEventListener("pointerdown", unlock, { capture: true });
      document.removeEventListener("keydown", unlock, { capture: true });
      document.removeEventListener("click", handleGlobalClick);
    };
  }, [localAudioDockShowcase, localShowcaseBypass]);

  const applySettings = (patch: Partial<GameAudioSettings>) => {
    if (localAudioDockShowcase) {
      setSettings((current) => ({ ...current, ...patch }));
      return;
    }
    getGameAudio().setSettings(patch);
  };

  const updateVolume =
    (key: "musicVolume" | "sfxVolume") =>
    (event: ChangeEvent<HTMLInputElement>) => {
      applySettings({ [key]: Number(event.target.value) / 100 });
    };

  const musicActive = !settings.musicMuted && settings.musicVolume > 0;

  if (localShowcaseBypass && !localAudioDockShowcase) return <>{children}</>;

  return (
    <>
      {children}
      <aside
        className={`audio-dock${panelOpen ? " is-open" : ""}`}
        aria-label="사운드 설정"
        data-audio-showcase={localAudioDockShowcase ? "true" : undefined}
      >
        {panelOpen && (
          <section className="audio-dock__panel" aria-label="오디오 믹서">
            <header className="audio-dock__header">
              <span>LAST COMMA AUDIO</span>
              <strong>사운드 믹서</strong>
            </header>

            <div className="audio-dock__track">
              <div>
                <span>MAIN BGM</span>
                <strong>The Last Comma</strong>
              </div>
              <button
                type="button"
                className={settings.musicMuted ? "is-muted" : ""}
                aria-pressed={settings.musicMuted}
                aria-label={settings.musicMuted ? "배경음악 켜기" : "배경음악 끄기"}
                onClick={() =>
                  applySettings({ musicMuted: !settings.musicMuted })
                }
              >
                {settings.musicMuted ? "OFF" : "ON"}
              </button>
            </div>
            <label className="audio-dock__slider">
              <span>배경음악</span>
              <input
                type="range"
                min="0"
                max="100"
                step="1"
                value={percent(settings.musicVolume)}
                onChange={updateVolume("musicVolume")}
                aria-label="배경음악 볼륨"
              />
              <output>{percent(settings.musicVolume)}</output>
            </label>

            <div className="audio-dock__track audio-dock__track--effects">
              <div>
                <span>COMBAT · UI · LOOT</span>
                <strong>효과음</strong>
              </div>
              <button
                type="button"
                className={settings.sfxMuted ? "is-muted" : ""}
                aria-pressed={settings.sfxMuted}
                aria-label={settings.sfxMuted ? "효과음 켜기" : "효과음 끄기"}
                onClick={() =>
                  applySettings({ sfxMuted: !settings.sfxMuted })
                }
              >
                {settings.sfxMuted ? "OFF" : "ON"}
              </button>
            </div>
            <label className="audio-dock__slider">
              <span>효과음</span>
              <input
                type="range"
                min="0"
                max="100"
                step="1"
                value={percent(settings.sfxVolume)}
                onChange={updateVolume("sfxVolume")}
                aria-label="효과음 볼륨"
              />
              <output>{percent(settings.sfxVolume)}</output>
            </label>

            <p>설정은 이 브라우저에 자동 저장됩니다.</p>
          </section>
        )}

        <button
          type="button"
          className="audio-dock__trigger"
          aria-expanded={panelOpen}
          aria-label={panelOpen ? "사운드 설정 닫기" : "사운드 설정 열기"}
          title="사운드 설정"
          onClick={() => setPanelOpen((open) => !open)}
        >
          <span className={`audio-dock__meter${musicActive ? " is-playing" : ""}`} aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
          </span>
          <span>SOUND</span>
        </button>
      </aside>
    </>
  );
}
