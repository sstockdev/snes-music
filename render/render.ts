/** Renders a parsed .uge song to PCM with the Game Boy or 16-bit voicing. */
import type { Synth } from "./dsp.ts";
import { GameBoy } from "./gb.ts";
import { Player, type Frame } from "./player.ts";
import { Snes, SNES_RATE, type SnesOptions } from "./snes.ts";
import type { Song } from "./uge.ts";

export type Style = "gb" | "snes";

export interface RenderOptions extends SnesOptions {
  style: Style;
  /** Play the song once with its tail instead of cutting one seamless loop. */
  once?: boolean;
  /** Seconds of release and echo kept after a one-shot song. */
  tail?: number;
  /** Safety limit for songs that never repeat. */
  maxSeconds?: number;
  /** Peak level of the output in dBFS (default -1). Lower it for a quieter track. */
  peak?: number;
}

export interface Rendered {
  sampleRate: number;
  left: Float32Array;
  right: Float32Array;
  /** Seconds of the song before its loop starts; a seamless render leaves this part out. */
  intro: number;
}

export function render(song: Song, options: RenderOptions): Rendered {
  const sampleRate = options.style === "snes" ? SNES_RATE : 44100;
  const synth: Synth = options.style === "snes" ? new Snes(sampleRate, song.waves, options) : new GameBoy(sampleRate, song.waves);
  const player = new Player(song);
  const perTick = sampleRate / player.tickRate;
  const max = Math.ceil((options.maxSeconds ?? 600) * sampleRate);
  const left = new Float32Array(max);
  const right = new Float32Array(max);
  const tickStart = (tick: number) => Math.round(tick * perTick);

  let tick = 0;
  let stopAt = max;
  let loop: [number, number] | null = null;
  let last: Frame | null = null;
  while (tickStart(tick) < stopAt) {
    let frame: Frame;
    if (options.once && loop && tick >= loop[1] && last) {
      // Past the end of a one-shot: hold every channel released so tails ring out.
      frame = { ...last, voices: last.voices.map((v) => ({ ...v, gate: false, trigger: false, reload: false })) };
    } else {
      frame = player.step();
      if (!loop && player.loop) {
        loop = player.loop;
        const [start, end] = loop.map(tickStart);
        // A one-shot keeps its tail; a loop renders a second pass so echo and releases carry over the seam.
        stopAt = Math.min(max, options.once ? end + Math.round((options.tail ?? 3) * sampleRate) : 2 * end - start);
      }
    }
    last = frame;
    synth.set(frame.voices, frame.masterLeft, frame.masterRight);
    const at = tickStart(tick);
    synth.render(left, right, at, Math.min(stopAt, tickStart(tick + 1)) - at);
    tick++;
  }
  if (!loop) throw new Error(`The song did not loop within ${options.maxSeconds ?? 600} s`);
  const [start, end] = loop.map(tickStart);
  const from = options.once ? 0 : end;
  const to = options.once ? stopAt : 2 * end - start;
  const out = { sampleRate, left: left.slice(from, to), right: right.slice(from, to), intro: options.once ? 0 : start / sampleRate };
  normalize(out.left, out.right, options.peak ?? -1);
  return out;
}

/** Scales both channels in place so the louder peak sits at `peakDb` dBFS. */
function normalize(left: Float32Array, right: Float32Array, peakDb: number): void {
  let peak = 1e-9;
  for (let i = 0; i < left.length; i++) peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
  const g = 10 ** (peakDb / 20) / peak;
  for (let i = 0; i < left.length; i++) {
    left[i] *= g;
    right[i] *= g;
  }
}

/** 16-bit stereo WAV with TPDF dither. */
export function wav({ sampleRate, left, right }: Rendered): Uint8Array {
  const n = left.length;
  const buf = new ArrayBuffer(44 + n * 4);
  const d = new DataView(buf);
  const text = (at: number, s: string) => [...s].forEach((c, i) => d.setUint8(at + i, c.charCodeAt(0)));
  text(0, "RIFF");
  d.setUint32(4, 36 + n * 4, true);
  text(8, "WAVE");
  text(12, "fmt ");
  d.setUint32(16, 16, true);
  d.setUint16(20, 1, true);
  d.setUint16(22, 2, true);
  d.setUint32(24, sampleRate, true);
  d.setUint32(28, sampleRate * 4, true);
  d.setUint16(32, 4, true);
  d.setUint16(34, 16, true);
  text(36, "data");
  d.setUint32(40, n * 4, true);
  const q = (x: number) => Math.max(-32768, Math.min(32767, Math.round(x * 32767 + Math.random() - Math.random())));
  for (let i = 0; i < n; i++) {
    d.setInt16(44 + i * 4, q(left[i]), true);
    d.setInt16(46 + i * 4, q(right[i]), true);
  }
  return new Uint8Array(buf);
}
