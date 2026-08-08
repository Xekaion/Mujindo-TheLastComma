"""Generate the original Mujindo sound-effect library.

The generator intentionally uses only Python's standard library.  Every WAV is
deterministic, stereo, 44.1 kHz, 16-bit PCM, and authored for this project; no
third-party samples are embedded.
"""

from __future__ import annotations

import argparse
import math
import random
import struct
import wave
from pathlib import Path


RATE = 44_100
TAU = math.tau


def track(seconds: float) -> tuple[list[float], list[float]]:
    samples = max(1, round(seconds * RATE))
    return [0.0] * samples, [0.0] * samples


def pan_gains(pan: float) -> tuple[float, float]:
    position = max(-1.0, min(1.0, pan))
    angle = (position + 1.0) * math.pi / 4
    return math.cos(angle), math.sin(angle)


def envelope(
    elapsed: float,
    duration: float,
    attack: float,
    release: float,
    decay: float,
) -> float:
    attack_gain = min(1.0, elapsed / max(0.0001, attack))
    release_gain = min(1.0, (duration - elapsed) / max(0.0001, release))
    body = math.exp(-decay * elapsed / max(duration, 0.0001))
    return max(0.0, attack_gain * release_gain * body)


def waveform(kind: str, phase: float) -> float:
    sine = math.sin(phase)
    if kind == "sine":
        return sine
    if kind == "triangle":
        return 2 / math.pi * math.asin(sine)
    if kind == "saw":
        return 2 * ((phase / TAU) % 1) - 1
    if kind == "soft-square":
        return math.tanh(2.3 * sine)
    raise ValueError(f"Unknown waveform: {kind}")


def add_tone(
    output: tuple[list[float], list[float]],
    *,
    start: float,
    duration: float,
    frequency: float,
    end_frequency: float | None = None,
    gain: float = 0.35,
    pan: float = 0.0,
    kind: str = "sine",
    attack: float = 0.006,
    release: float = 0.08,
    decay: float = 1.2,
    vibrato_hz: float = 0.0,
    vibrato_depth: float = 0.0,
) -> None:
    left, right = output
    begin = max(0, round(start * RATE))
    count = min(round(duration * RATE), len(left) - begin)
    if count <= 0:
        return
    left_gain, right_gain = pan_gains(pan)
    phase = 0.0
    target = end_frequency if end_frequency is not None else frequency
    for index in range(count):
        elapsed = index / RATE
        progress = index / max(1, count - 1)
        base_frequency = frequency * ((target / frequency) ** progress)
        current_frequency = base_frequency * (
            1 + math.sin(TAU * vibrato_hz * elapsed) * vibrato_depth
        )
        phase += TAU * current_frequency / RATE
        value = (
            waveform(kind, phase)
            * envelope(elapsed, duration, attack, release, decay)
            * gain
        )
        left[begin + index] += value * left_gain
        right[begin + index] += value * right_gain


def add_noise(
    output: tuple[list[float], list[float]],
    *,
    seed: int,
    start: float,
    duration: float,
    gain: float = 0.2,
    pan: float = 0.0,
    attack: float = 0.002,
    release: float = 0.08,
    decay: float = 2.0,
    smoothing: float = 0.18,
    highpass: float = 0.0,
) -> None:
    left, right = output
    begin = max(0, round(start * RATE))
    count = min(round(duration * RATE), len(left) - begin)
    if count <= 0:
        return
    rng = random.Random(seed)
    left_gain, right_gain = pan_gains(pan)
    low = 0.0
    previous_low = 0.0
    for index in range(count):
        elapsed = index / RATE
        white = rng.uniform(-1, 1)
        low += (white - low) * max(0.001, min(1.0, smoothing))
        high = low - previous_low
        previous_low = low
        filtered = low * (1 - highpass) + high * min(18.0, highpass * 18.0)
        value = (
            filtered
            * envelope(elapsed, duration, attack, release, decay)
            * gain
        )
        left[begin + index] += value * left_gain
        right[begin + index] += value * right_gain


def add_echo(
    output: tuple[list[float], list[float]],
    delay_seconds: float,
    gain: float,
    crossfeed: float = 0.45,
) -> None:
    left, right = output
    delay = max(1, round(delay_seconds * RATE))
    for index in range(delay, len(left)):
        source_left = left[index - delay]
        source_right = right[index - delay]
        left[index] += (source_left * (1 - crossfeed) + source_right * crossfeed) * gain
        right[index] += (source_right * (1 - crossfeed) + source_left * crossfeed) * gain


def finish(output: tuple[list[float], list[float]], target_peak: float = 0.91) -> None:
    left, right = output
    # Remove the tiny DC offset that asymmetrical synthetic waves can create.
    left_mean = sum(left) / len(left)
    right_mean = sum(right) / len(right)
    for index in range(len(left)):
        left[index] -= left_mean
        right[index] -= right_mean
    peak = max(max(abs(value) for value in left), max(abs(value) for value in right), 1e-9)
    scale = min(1.0, target_peak / peak)
    # A gentle soft limiter preserves transients without writing clipped samples.
    for channel in output:
        for index, value in enumerate(channel):
            channel[index] = math.tanh(value * scale * 1.18) / math.tanh(1.18)


def write_wav(path: Path, output: tuple[list[float], list[float]]) -> None:
    finish(output)
    path.parent.mkdir(parents=True, exist_ok=True)
    left, right = output
    frames = bytearray()
    for left_sample, right_sample in zip(left, right):
        frames.extend(
            struct.pack(
                "<hh",
                round(max(-1, min(1, left_sample)) * 32_000),
                round(max(-1, min(1, right_sample)) * 32_000),
            )
        )
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(2)
        wav.setsampwidth(2)
        wav.setframerate(RATE)
        wav.writeframes(frames)


def ui_confirm() -> tuple[list[float], list[float]]:
    sound = track(0.24)
    add_tone(sound, start=0, duration=0.18, frequency=660, end_frequency=760, gain=0.42, pan=-0.18, kind="triangle", decay=2.4)
    add_tone(sound, start=0.045, duration=0.18, frequency=990, end_frequency=1180, gain=0.32, pan=0.22, decay=2.8)
    add_echo(sound, 0.055, 0.15)
    return sound


def ui_back() -> tuple[list[float], list[float]]:
    sound = track(0.22)
    add_tone(sound, start=0, duration=0.19, frequency=620, end_frequency=300, gain=0.42, kind="triangle", decay=1.3)
    add_noise(sound, seed=101, start=0, duration=0.07, gain=0.10, highpass=0.5, smoothing=0.45)
    return sound


def player_shot() -> tuple[list[float], list[float]]:
    sound = track(0.19)
    add_tone(sound, start=0, duration=0.16, frequency=1050, end_frequency=230, gain=0.48, kind="saw", decay=2.6)
    add_tone(sound, start=0, duration=0.13, frequency=1450, end_frequency=520, gain=0.25, pan=0.25, kind="sine", decay=2.5)
    add_noise(sound, seed=201, start=0, duration=0.07, gain=0.33, highpass=0.8, smoothing=0.6, decay=4.4)
    return sound


def player_crit() -> tuple[list[float], list[float]]:
    sound = track(0.39)
    for index, frequency in enumerate((880, 1320, 1760)):
        add_tone(sound, start=index * 0.028, duration=0.29, frequency=frequency, end_frequency=frequency * 1.08, gain=0.28, pan=-0.5 + index * 0.5, kind="triangle", decay=3.0)
    add_noise(sound, seed=202, start=0, duration=0.1, gain=0.21, highpass=0.9, smoothing=0.75, decay=5)
    add_echo(sound, 0.075, 0.23, 0.7)
    return sound


def player_hit() -> tuple[list[float], list[float]]:
    sound = track(0.36)
    add_tone(sound, start=0, duration=0.32, frequency=130, end_frequency=52, gain=0.65, kind="sine", decay=2.8)
    add_noise(sound, seed=203, start=0, duration=0.22, gain=0.52, smoothing=0.055, decay=3.8)
    add_noise(sound, seed=204, start=0.01, duration=0.09, gain=0.28, highpass=0.75, smoothing=0.65, decay=4.5)
    return sound


def player_dash() -> tuple[list[float], list[float]]:
    sound = track(0.31)
    add_noise(sound, seed=205, start=0, duration=0.27, gain=0.46, pan=-0.25, highpass=0.45, smoothing=0.22, decay=1.1)
    add_tone(sound, start=0, duration=0.25, frequency=270, end_frequency=1120, gain=0.28, pan=0.35, kind="sine", decay=1.5)
    add_echo(sound, 0.032, 0.12, 0.8)
    return sound


def player_impact() -> tuple[list[float], list[float]]:
    sound = track(0.22)
    add_tone(sound, start=0, duration=0.19, frequency=210, end_frequency=68, gain=0.55, kind="triangle", decay=3.5)
    add_noise(sound, seed=206, start=0, duration=0.12, gain=0.4, highpass=0.55, smoothing=0.3, decay=4.2)
    return sound


def enemy_shot() -> tuple[list[float], list[float]]:
    sound = track(0.27)
    add_tone(sound, start=0, duration=0.24, frequency=190, end_frequency=610, gain=0.46, pan=-0.1, kind="soft-square", decay=1.8, vibrato_hz=28, vibrato_depth=0.018)
    add_noise(sound, seed=301, start=0.015, duration=0.15, gain=0.2, pan=0.35, highpass=0.55, smoothing=0.28, decay=3)
    return sound


def enemy_death() -> tuple[list[float], list[float]]:
    sound = track(0.46)
    add_tone(sound, start=0, duration=0.41, frequency=260, end_frequency=48, gain=0.56, kind="saw", decay=2.2)
    add_noise(sound, seed=302, start=0, duration=0.38, gain=0.43, smoothing=0.075, decay=2.3)
    add_noise(sound, seed=303, start=0, duration=0.12, gain=0.22, highpass=0.9, smoothing=0.72, decay=5.5)
    return sound


def enemy_death_heavy() -> tuple[list[float], list[float]]:
    sound = track(0.78)
    add_tone(sound, start=0, duration=0.7, frequency=118, end_frequency=29, gain=0.72, kind="soft-square", decay=2.0)
    add_tone(sound, start=0.06, duration=0.55, frequency=190, end_frequency=43, gain=0.34, pan=0.3, kind="saw", decay=2.6)
    add_noise(sound, seed=304, start=0, duration=0.58, gain=0.57, smoothing=0.045, decay=2.2)
    add_echo(sound, 0.09, 0.2, 0.8)
    return sound


def enemy_summon() -> tuple[list[float], list[float]]:
    sound = track(0.88)
    add_tone(sound, start=0, duration=0.78, frequency=95, end_frequency=360, gain=0.4, pan=-0.25, kind="triangle", decay=0.8, vibrato_hz=7, vibrato_depth=0.025)
    add_tone(sound, start=0.08, duration=0.69, frequency=142, end_frequency=720, gain=0.3, pan=0.3, kind="sine", decay=1.0)
    add_noise(sound, seed=305, start=0, duration=0.75, gain=0.28, highpass=0.35, smoothing=0.14, decay=1.2)
    add_echo(sound, 0.105, 0.28, 0.75)
    return sound


def enemy_teleport() -> tuple[list[float], list[float]]:
    sound = track(0.63)
    add_tone(sound, start=0, duration=0.29, frequency=220, end_frequency=1780, gain=0.42, pan=-0.5, kind="sine", decay=1.0)
    add_tone(sound, start=0.22, duration=0.35, frequency=1650, end_frequency=170, gain=0.38, pan=0.5, kind="triangle", decay=1.6)
    add_noise(sound, seed=306, start=0.02, duration=0.48, gain=0.3, highpass=0.78, smoothing=0.48, decay=1.8)
    add_echo(sound, 0.052, 0.22, 0.9)
    return sound


def enemy_charge() -> tuple[list[float], list[float]]:
    sound = track(0.75)
    add_tone(sound, start=0, duration=0.7, frequency=72, end_frequency=820, gain=0.52, kind="saw", decay=0.45, vibrato_hz=12, vibrato_depth=0.025)
    add_tone(sound, start=0.12, duration=0.56, frequency=108, end_frequency=1230, gain=0.26, pan=0.35, kind="sine", decay=0.25)
    add_noise(sound, seed=307, start=0.42, duration=0.25, gain=0.34, highpass=0.65, smoothing=0.34, decay=1.0)
    return sound


def time_rift() -> tuple[list[float], list[float]]:
    sound = track(1.02)
    add_tone(sound, start=0, duration=0.94, frequency=58, end_frequency=42, gain=0.52, kind="soft-square", decay=0.8, vibrato_hz=5.5, vibrato_depth=0.035)
    for index, frequency in enumerate((510, 760, 1140, 1710)):
        add_tone(sound, start=0.12 + index * 0.13, duration=0.39, frequency=frequency, end_frequency=frequency * 0.72, gain=0.19, pan=(-1) ** index * 0.55, kind="triangle", decay=2.4)
    add_noise(sound, seed=308, start=0.05, duration=0.83, gain=0.2, highpass=0.55, smoothing=0.2, decay=1.1)
    add_echo(sound, 0.12, 0.3, 0.85)
    return sound


def memory_pickup() -> tuple[list[float], list[float]]:
    sound = track(0.31)
    add_tone(sound, start=0, duration=0.24, frequency=740, end_frequency=940, gain=0.36, pan=-0.25, kind="triangle", decay=3.4)
    add_tone(sound, start=0.052, duration=0.22, frequency=1110, end_frequency=1420, gain=0.31, pan=0.28, kind="sine", decay=3.6)
    add_echo(sound, 0.06, 0.19, 0.8)
    return sound


def loot_drop() -> tuple[list[float], list[float]]:
    sound = track(0.43)
    add_tone(sound, start=0, duration=0.34, frequency=205, end_frequency=92, gain=0.48, kind="triangle", decay=3.1)
    add_tone(sound, start=0.055, duration=0.31, frequency=780, end_frequency=620, gain=0.24, pan=0.3, kind="sine", decay=3.0)
    add_noise(sound, seed=401, start=0, duration=0.1, gain=0.25, highpass=0.7, smoothing=0.5, decay=5)
    return sound


def loot_rare() -> tuple[list[float], list[float]]:
    sound = track(0.82)
    for index, frequency in enumerate((440, 660, 880, 1320)):
        add_tone(sound, start=0.04 + index * 0.08, duration=0.46, frequency=frequency, end_frequency=frequency * 1.035, gain=0.25, pan=-0.55 + index * 0.36, kind="triangle", decay=2.5)
    add_noise(sound, seed=402, start=0.02, duration=0.38, gain=0.18, highpass=0.88, smoothing=0.62, decay=2.8)
    add_echo(sound, 0.11, 0.27, 0.8)
    return sound


def loot_legendary() -> tuple[list[float], list[float]]:
    sound = track(1.42)
    add_tone(sound, start=0, duration=1.18, frequency=72, end_frequency=54, gain=0.39, kind="soft-square", decay=1.3)
    notes = (330, 440, 660, 880, 1320)
    for index, frequency in enumerate(notes):
        add_tone(sound, start=0.08 + index * 0.105, duration=0.75, frequency=frequency, end_frequency=frequency * 1.08, gain=0.25, pan=-0.65 + index * 0.32, kind="triangle", decay=2.1, vibrato_hz=5.2, vibrato_depth=0.008)
    add_noise(sound, seed=403, start=0.08, duration=0.82, gain=0.2, highpass=0.9, smoothing=0.68, decay=2.2)
    add_echo(sound, 0.14, 0.31, 0.75)
    add_echo(sound, 0.27, 0.16, 0.6)
    return sound


def profession_ascend() -> tuple[list[float], list[float]]:
    """Three-act class awakening: seal charge, rupture, and coronation chord."""
    sound = track(2.36)
    add_tone(sound, start=0, duration=1.78, frequency=46, end_frequency=86, gain=0.42, kind="soft-square", decay=0.42, vibrato_hz=4.2, vibrato_depth=0.018)
    add_tone(sound, start=0.02, duration=1.44, frequency=93, end_frequency=372, gain=0.26, pan=-0.32, kind="saw", decay=0.55, vibrato_hz=7.0, vibrato_depth=0.012)
    add_tone(sound, start=0.06, duration=1.38, frequency=139.5, end_frequency=558, gain=0.22, pan=0.34, kind="triangle", decay=0.5)
    for index, frequency in enumerate((261.63, 329.63, 392.0, 523.25, 659.25, 783.99)):
        add_tone(sound, start=0.32 + index * 0.135, duration=0.72, frequency=frequency, end_frequency=frequency * 1.11, gain=0.16, pan=-0.72 + index * 0.29, kind="triangle", decay=1.35)
    add_noise(sound, seed=410, start=0.02, duration=1.25, gain=0.17, highpass=0.62, smoothing=0.25, decay=0.9)
    add_tone(sound, start=1.42, duration=0.82, frequency=118, end_frequency=31, gain=0.72, kind="soft-square", decay=2.5)
    add_noise(sound, seed=411, start=1.42, duration=0.48, gain=0.58, smoothing=0.045, decay=3.6)
    add_noise(sound, seed=412, start=1.43, duration=0.72, gain=0.24, highpass=0.92, smoothing=0.72, decay=2.7)
    for index, frequency in enumerate((392.0, 523.25, 659.25, 783.99, 1046.5)):
        add_tone(sound, start=1.46 + index * 0.052, duration=0.66, frequency=frequency, end_frequency=frequency * 1.025, gain=0.21, pan=-0.6 + index * 0.3, kind="sine", decay=1.45, vibrato_hz=5.1, vibrato_depth=0.006)
    add_echo(sound, 0.105, 0.24, 0.82)
    add_echo(sound, 0.21, 0.13, 0.62)
    return sound


def room_clear() -> tuple[list[float], list[float]]:
    sound = track(1.05)
    for index, frequency in enumerate((392, 523.25, 783.99)):
        add_tone(sound, start=index * 0.15, duration=0.69, frequency=frequency, end_frequency=frequency * 1.02, gain=0.32, pan=-0.35 + index * 0.35, kind="triangle", decay=2.2)
    add_tone(sound, start=0.34, duration=0.62, frequency=1046.5, gain=0.19, pan=0.15, kind="sine", decay=2.5)
    add_echo(sound, 0.13, 0.28, 0.72)
    return sound


def boss_appear() -> tuple[list[float], list[float]]:
    sound = track(1.67)
    add_tone(sound, start=0, duration=1.5, frequency=54, end_frequency=38, gain=0.76, kind="soft-square", decay=1.25)
    add_tone(sound, start=0.12, duration=1.15, frequency=92, end_frequency=148, gain=0.43, pan=-0.3, kind="saw", decay=1.2, vibrato_hz=5.5, vibrato_depth=0.02)
    add_tone(sound, start=0.68, duration=0.72, frequency=480, end_frequency=1380, gain=0.3, pan=0.42, kind="triangle", decay=1.6)
    add_noise(sound, seed=404, start=0, duration=0.78, gain=0.63, smoothing=0.038, decay=2.6)
    add_echo(sound, 0.17, 0.26, 0.86)
    return sound


def enhance_success() -> tuple[list[float], list[float]]:
    sound = track(0.94)
    for index, frequency in enumerate((523.25, 659.25, 783.99, 1046.5)):
        add_tone(sound, start=index * 0.085, duration=0.55, frequency=frequency, end_frequency=frequency * 1.04, gain=0.28, pan=-0.5 + index / 3, kind="triangle", decay=2.7)
    add_noise(sound, seed=405, start=0.2, duration=0.3, gain=0.17, highpass=0.92, smoothing=0.72, decay=3)
    add_echo(sound, 0.1, 0.25, 0.75)
    return sound


def enhance_fail() -> tuple[list[float], list[float]]:
    sound = track(0.61)
    add_tone(sound, start=0, duration=0.52, frequency=410, end_frequency=118, gain=0.48, kind="triangle", decay=1.5)
    add_tone(sound, start=0.08, duration=0.43, frequency=205, end_frequency=64, gain=0.32, pan=0.25, kind="sine", decay=2)
    add_noise(sound, seed=406, start=0.03, duration=0.22, gain=0.18, smoothing=0.12, decay=2.5)
    return sound


def enhance_destroy() -> tuple[list[float], list[float]]:
    sound = track(1.28)
    add_tone(sound, start=0, duration=1.04, frequency=105, end_frequency=27, gain=0.75, kind="soft-square", decay=2.0)
    add_noise(sound, seed=407, start=0, duration=0.65, gain=0.68, smoothing=0.045, decay=2.2)
    for index in range(9):
        add_tone(sound, start=0.04 + index * 0.033, duration=0.28, frequency=920 + index * 173, end_frequency=260 + index * 31, gain=0.11, pan=-0.8 + (index % 5) * 0.4, kind="triangle", decay=4.2)
    add_echo(sound, 0.12, 0.2, 0.8)
    return sound


def shelter_rest() -> tuple[list[float], list[float]]:
    sound = track(1.16)
    for pan, frequency in ((-0.45, 261.63), (0, 329.63), (0.45, 392.0), (-0.15, 523.25)):
        add_tone(sound, start=0.04, duration=1.0, frequency=frequency, end_frequency=frequency * 0.995, gain=0.22, pan=pan, kind="sine", decay=1.5, vibrato_hz=4.7, vibrato_depth=0.006)
    add_noise(sound, seed=408, start=0.02, duration=0.83, gain=0.1, highpass=0.75, smoothing=0.32, decay=2.4)
    add_echo(sound, 0.16, 0.26, 0.72)
    return sound


def salvage() -> tuple[list[float], list[float]]:
    sound = track(0.69)
    for index in range(7):
        frequency = 1480 - index * 145
        add_tone(sound, start=index * 0.045, duration=0.35, frequency=frequency, end_frequency=frequency * 0.53, gain=0.13, pan=-0.65 + (index % 4) * 0.43, kind="triangle", decay=3.5)
    add_noise(sound, seed=409, start=0, duration=0.34, gain=0.22, highpass=0.82, smoothing=0.62, decay=3.5)
    add_echo(sound, 0.075, 0.18, 0.85)
    return sound


SOUNDS = {
    "ui-confirm.wav": ui_confirm,
    "ui-back.wav": ui_back,
    "player-shot.wav": player_shot,
    "player-crit.wav": player_crit,
    "player-hit.wav": player_hit,
    "player-dash.wav": player_dash,
    "player-impact.wav": player_impact,
    "enemy-shot.wav": enemy_shot,
    "enemy-death.wav": enemy_death,
    "enemy-death-heavy.wav": enemy_death_heavy,
    "enemy-summon.wav": enemy_summon,
    "enemy-teleport.wav": enemy_teleport,
    "enemy-charge.wav": enemy_charge,
    "time-rift.wav": time_rift,
    "memory-pickup.wav": memory_pickup,
    "loot-drop.wav": loot_drop,
    "loot-rare.wav": loot_rare,
    "loot-legendary.wav": loot_legendary,
    "profession-ascend.wav": profession_ascend,
    "room-clear.wav": room_clear,
    "boss-appear.wav": boss_appear,
    "enhance-success.wav": enhance_success,
    "enhance-fail.wav": enhance_fail,
    "enhance-destroy.wav": enhance_destroy,
    "shelter-rest.wav": shelter_rest,
    "salvage.wav": salvage,
}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "public" / "assets" / "audio" / "sfx",
    )
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    for filename, synthesizer in SOUNDS.items():
        output = args.output / filename
        write_wav(output, synthesizer())
        print(f"generated {output.name}")


if __name__ == "__main__":
    main()
