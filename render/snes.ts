/**
 * A 16-bit console voicing of a .uge song. The four tracker channels keep their notes, timing and volume envelopes,
 * but each plays through a smoother patch (flute, strings, wordless choir and so on), arpeggios on sustained patches
 * become held chords, and everything shares an SNES-style echo, rendered at the SNES's 32 kHz.
 */
import { Biquad, Envelope, Lfsr, OnePole, pulse, saw, type Synth } from "./dsp.ts";
import type { Voice } from "./player.ts";

export const SNES_RATE = 32000;

export const PATCHES = ["flute", "whistle", "strings", "choir", "organ", "harp", "piano", "marimba", "bell", "brass", "reed", "bass", "chip", "drums"] as const;
export type PatchName = (typeof PATCHES)[number];

interface Patch {
  attack: number;
  release: number;
  /** Rate in Hz, depth in cents, delay in seconds. */
  vibrato?: [number, number, number];
  /** Arpeggios play as held chords. */
  chords?: boolean;
  /** Detuned copies per note, in cents. */
  detune?: number[];
  pan: number;
  send: number;
  gain: number;
}

const PATCH: Record<PatchName, Patch> = {
  flute: { attack: 0.04, release: 0.15, vibrato: [5, 14, 0.25], pan: 0, send: 0.35, gain: 0.9 },
  whistle: { attack: 0.03, release: 0.2, vibrato: [5, 10, 0.2], pan: 0, send: 0.6, gain: 0.8 },
  strings: { attack: 0.09, release: 0.35, vibrato: [5.5, 8, 0.2], chords: true, detune: [-8, 0, 8], pan: 0.25, send: 0.5, gain: 0.7 },
  choir: { attack: 0.16, release: 0.5, vibrato: [4.8, 12, 0.3], chords: true, detune: [-10, 0, 9], pan: -0.15, send: 0.6, gain: 1.6 },
  organ: { attack: 0.01, release: 0.12, chords: true, pan: 0, send: 0.45, gain: 0.55 },
  harp: { attack: 0.003, release: 0.5, pan: -0.3, send: 0.5, gain: 0.9 },
  piano: { attack: 0.002, release: 0.25, chords: true, pan: -0.1, send: 0.4, gain: 0.8 },
  marimba: { attack: 0.001, release: 0.15, pan: 0.25, send: 0.4, gain: 1.1 },
  bell: { attack: 0.002, release: 0.6, pan: 0.3, send: 0.6, gain: 0.7 },
  brass: { attack: 0.03, release: 0.12, vibrato: [5, 8, 0.3], pan: 0, send: 0.3, gain: 0.6 },
  reed: { attack: 0.03, release: 0.1, vibrato: [5.5, 10, 0.2], pan: 0.1, send: 0.35, gain: 0.6 },
  bass: { attack: 0.005, release: 0.06, pan: 0, send: 0.08, gain: 1.1 },
  chip: { attack: 0.003, release: 0.05, pan: 0, send: 0.3, gain: 0.5 },
  drums: { attack: 0.001, release: 0.04, pan: -0.1, send: 0.15, gain: 1 },
};

const KEYWORDS: [RegExp, PatchName][] = [
  [/whistle|ocarina|bird|wind/, "whistle"],
  [/flute|recorder/, "flute"],
  [/string|violin|viola|cello|pad/, "strings"],
  [/choir|voice|vox|aah|ooh/, "choir"],
  [/organ/, "organ"],
  [/piano|rhodes|keys/, "piano"],
  [/marimba|kalimba|xylo|mallet|vibes/, "marimba"],
  [/harp|pluck|guitar|lute|lyre/, "harp"],
  [/bell|chime|glock|celesta/, "bell"],
  [/brass|horn|trumpet|fanfare/, "brass"],
  [/reed|oboe|clarinet|bassoon/, "reed"],
  [/bass/, "bass"],
  [/chip|square|pulse|8.?bit/, "chip"],
  [/drum|kick|snare|hat|perc|noise|cymbal/, "drums"],
];

const DEFAULTS: PatchName[] = ["flute", "strings", "bass", "drums"];
const DUTY = [0.125, 0.25, 0.5, 0.75];
const TAU = Math.PI * 2;

/** Picks a patch from the instrument name, falling back to the channel's default. */
export function patchFor(name: string, channel: number): PatchName {
  const n = name.toLowerCase();
  return KEYWORDS.find(([re]) => re.test(n))?.[1] ?? DEFAULTS[channel];
}

/** Band-limited harmonics of a 32-step wave table, normalized to a peak of 1. */
function harmonics(table: number[]): [number, number][] {
  const h: [number, number][] = [];
  for (let k = 1; k < 16; k++) {
    let a = 0;
    let b = 0;
    table.forEach((s, i) => {
      a += s * Math.cos((TAU * k * i) / 32);
      b += s * Math.sin((TAU * k * i) / 32);
    });
    h.push([(2 * a) / 32, (2 * b) / 32]);
  }
  let peak = 1e-9;
  for (let i = 0; i < 256; i++) {
    const p = (TAU * i) / 256;
    peak = Math.max(peak, Math.abs(h.reduce((sum, [a, b], k) => sum + a * Math.cos((k + 1) * p) + b * Math.sin((k + 1) * p), 0)));
  }
  return h.map(([a, b]) => [a / peak, b / peak]);
}

class PatchVoice {
  patch: Patch;
  private env: Envelope;
  private v: Voice | null = null;
  private t = 0;
  private amp = 0;
  private held = 0;
  private gateAmp = 0;
  private phases = new Float64Array(9);
  private filter = new Biquad();
  private formants = [new Biquad(), new Biquad(), new Biquad()];
  private breath: OnePole;
  private lfsr = new Lfsr();
  private noiseTone: OnePole;
  private body = 0;
  private name: PatchName;
  private sr: number;
  private tables: [number, number][][];
  readonly pan: number;

  constructor(name: PatchName, sampleRate: number, tables: [number, number][][]) {
    this.name = name;
    this.patch = PATCH[name];
    this.pan = this.patch.pan;
    this.sr = sampleRate;
    this.tables = tables;
    this.env = new Envelope(sampleRate);
    this.breath = new OnePole(sampleRate, 2500);
    this.noiseTone = new OnePole(sampleRate, 8000);
    const cutoff = { strings: 3200, choir: 4000, brass: 2400, reed: 2200, bass: 1600, chip: 7000 }[name as string] ?? 9000;
    this.filter.set("low", sampleRate, cutoff, 0.7);
    // An open "aah".
    [800, 1150, 2900].forEach((f, i) => this.formants[i].set("band", sampleRate, f, [6, 8, 10][i]));
  }

  set(v: Voice): void {
    this.env.apply(v);
    if (v.trigger) this.t = 0;
    this.v = v;
  }

  private tone(freq: number, slot: number, dt: number): number {
    const p = this.phases;
    p[slot] = (p[slot] + dt) % 1;
    const x = p[slot];
    const v = this.v!;
    switch (this.name) {
      case "flute":
        return Math.sin(TAU * x) + 0.25 * Math.sin(2 * TAU * x) + 0.1 * Math.sin(3 * TAU * x) + 0.04 * Math.sin(4 * TAU * x);
      case "organ": {
        let y = 0;
        const bars = [1, 0.5, 0.35, 0.25, 0, 0.15, 0, 0.1];
        for (let h = 1; h <= 8; h++) if (bars[h - 1] && freq * h < this.sr / 2) y += bars[h - 1] * Math.sin(h * TAU * x);
        return y;
      }
      case "harp": {
        let y = 0;
        for (let h = 1; h <= 5 && freq * h < this.sr / 2; h++) y += Math.exp(-this.t * h * 1.6) * Math.sin(h * TAU * x) / h;
        return y * Math.exp(-this.t * 1.4);
      }
      case "whistle":
        return Math.sin(TAU * x) + 0.08 * Math.sin(2 * TAU * x);
      case "piano": {
        // An electric piano: a sine with a fading FM bite and a short tine ping on top.
        const bite = 0.25 + 1.3 * Math.exp(-this.t * 7);
        let y = Math.sin(TAU * x + bite * Math.sin(TAU * x));
        if (freq * 14 < this.sr / 2) y += 0.12 * Math.exp(-this.t * 40) * Math.sin(14 * TAU * x);
        return y * Math.exp(-this.t * 0.9);
      }
      case "marimba": {
        // A bar: the fundamental plus the bright fourth partial that dies away first.
        let y = Math.sin(TAU * x);
        if (freq * 4 < this.sr / 2) y += 0.4 * Math.exp(-this.t * 25) * Math.sin(4 * TAU * x);
        return y * Math.exp(-this.t * 4.5);
      }
      case "bell":
        return Math.sin(TAU * x + 2.2 * Math.exp(-this.t * 3) * Math.sin(3.5 * TAU * x)) * Math.exp(-this.t * 1.1);
      case "strings":
      case "choir":
      case "brass":
        return saw(x, dt);
      case "reed":
        return pulse(x, dt, 0.3);
      case "chip":
        return pulse(x, dt, DUTY[v.duty]) * 0.7;
      case "bass": {
        if (v.kind !== "wave") return pulse(x, dt, 0.5) * 0.8;
        let y = 0;
        const table = this.tables[v.wave];
        for (let k = 0; k < table.length && freq * (k + 1) < this.sr / 2; k++) {
          const ph = (k + 1) * TAU * x;
          y += table[k][0] * Math.cos(ph) + table[k][1] * Math.sin(ph);
        }
        return y;
      }
      default:
        return 0;
    }
  }

  private drum(v: Voice): number {
    // Noise colored by the noise channel's clock, plus a pitched body that follows the note down for kicks.
    const noise = this.lfsr.sample(v.freq, this.sr, v.shortNoise);
    const bright = Math.max(0, Math.min(1, (v.note - 30) / 33));
    this.noiseTone.setCutoff(this.sr, 600 + 11000 * bright * bright);
    const hiss = this.noiseTone.low(noise) * (0.35 + 0.65 * bright);
    const weight = Math.max(0, Math.min(1, (56 - v.note) / 16));
    const bodyFreq = Math.max(45, 55 * 2 ** ((v.note - 40) / 10));
    this.body = (this.body + bodyFreq / this.sr) % 1;
    return hiss * (1 - 0.5 * weight) + Math.sin(TAU * this.body) * weight * 1.4 * Math.exp(-this.t * 10);
  }

  next(): number {
    const v = this.v;
    if (!v) return 0;
    const level = this.env.next() / 15;
    const sounding = this.env.on;
    if (sounding) this.held = level;
    const p = this.patch;
    // Attack toward the gate, then release from the last held level once the note stops.
    const target = sounding ? 1 : 0;
    const time = sounding ? p.attack : p.release / 4;
    this.gateAmp += (target - this.gateAmp) * Math.min(1, 1 / (time * this.sr));
    this.amp += ((sounding ? level : this.held) - this.amp) * Math.min(1, 1 / (0.004 * this.sr));
    const gain = this.amp * this.gateAmp;
    this.t += 1 / this.sr;
    if (gain < 1e-4) return 0;

    if (this.name === "drums") return this.drum(v) * gain * p.gain;

    let ratio = 1;
    if (p.vibrato) {
      const [rate, cents, delay] = p.vibrato;
      const depth = cents * Math.max(0, Math.min(1, (this.t - delay) / 0.3));
      ratio = 2 ** ((depth * Math.sin(TAU * rate * this.t)) / 1200);
    }
    const notes = p.chords && v.chord ? [0, v.chord[0], v.chord[1]] : [null];
    const detune = p.detune ?? [0];
    let y = 0;
    notes.forEach((offset, n) => {
      const base = (offset === null ? v.freq : v.baseFreq * 2 ** (offset / 12)) * ratio;
      detune.forEach((c, d) => {
        const f = base * 2 ** (c / 1200);
        y += this.tone(f, n * 3 + d, f / this.sr);
      });
    });
    y /= Math.sqrt(notes.length * detune.length);

    if (this.name === "brass") this.filter.set("low", this.sr, 350 + 2600 * (1 - Math.exp(-this.t / 0.06)), 0.9);
    if (this.name === "choir") {
      const s = this.filter.run(y);
      y = this.formants[0].run(s) + 0.5 * this.formants[1].run(s) + 0.25 * this.formants[2].run(s);
    } else if (["strings", "brass", "reed", "bass", "chip"].includes(this.name)) {
      y = this.filter.run(y);
    }
    if (this.name === "flute") y += this.breath.low(Math.random() * 2 - 1) * 0.12;
    return y * gain * p.gain;
  }
}

/** Mono-to-stereo echo in the style of the SNES DSP: one delay line per side, a low-pass in the feedback loop. */
class Echo {
  private l: Float32Array;
  private r: Float32Array;
  private pos = 0;
  private lowL: OnePole;
  private lowR: OnePole;
  private feedback: number;

  constructor(sampleRate: number, seconds: number, feedback: number) {
    const n = Math.max(1, Math.round(sampleRate * seconds));
    this.l = new Float32Array(n);
    this.r = new Float32Array(n);
    this.lowL = new OnePole(sampleRate, 3800);
    this.lowR = new OnePole(sampleRate, 3800);
    this.feedback = feedback;
  }

  run(inL: number, inR: number): [number, number] {
    const outL = this.l[this.pos];
    const outR = this.r[this.pos];
    // Cross the feedback so repeats spread across the field.
    this.l[this.pos] = inL + this.lowL.low(outR) * this.feedback;
    this.r[this.pos] = inR + this.lowR.low(outL) * this.feedback;
    this.pos = (this.pos + 1) % this.l.length;
    return [outL, outR];
  }
}

export interface SnesOptions {
  /** Patch per channel; null keeps the automatic choice. */
  patches?: (PatchName | null)[];
  /** Echo amount, 0 to 1. */
  echo?: number;
}

export class Snes implements Synth {
  private voices: (PatchVoice | null)[] = [null, null, null, null];
  private names: (PatchName | null)[] = [null, null, null, null];
  private state: Voice[] = [];
  private echo: Echo;
  private echoAmount: number;
  private outL = new Biquad();
  private outR = new Biquad();
  private masterLeft = 1;
  private masterRight = 1;
  private tables: [number, number][][];
  private sr: number;
  private forced: (PatchName | null)[];

  constructor(sampleRate: number, waves: number[][], options: SnesOptions = {}) {
    this.sr = sampleRate;
    this.tables = waves.map(harmonics);
    this.forced = options.patches ?? [];
    this.echoAmount = options.echo ?? 1;
    this.echo = new Echo(sampleRate, 0.176, 0.42);
    // Gaussian interpolation leaves the SNES a little soft on top.
    this.outL.set("low", sampleRate, 11000, 0.6);
    this.outR.set("low", sampleRate, 11000, 0.6);
  }

  set(voices: Voice[], masterLeft: number, masterRight: number): void {
    voices.forEach((v, i) => {
      // A new instrument on a trigger can switch the channel's patch.
      if (v.trigger || !this.voices[i]) {
        const name = this.forced[i] ?? patchFor(v.name, i);
        if (name !== this.names[i]) {
          this.voices[i] = new PatchVoice(name, this.sr, this.tables);
          this.names[i] = name;
        }
      }
      this.voices[i]!.set(v);
    });
    this.state = voices;
    this.masterLeft = masterLeft;
    this.masterRight = masterRight;
  }

  render(left: Float32Array, right: Float32Array, at: number, n: number): void {
    for (let s = at; s < at + n; s++) {
      let l = 0;
      let r = 0;
      let sendL = 0;
      let sendR = 0;
      this.voices.forEach((pv, i) => {
        if (!pv) return;
        const y = pv.next() * 0.3;
        const v = this.state[i];
        // A channel the song pans hard to one side stays there; otherwise the patch places it.
        const pan = v && v.left !== v.right ? (v.left ? -0.7 : 0.7) : pv.pan;
        const gl = Math.cos(((pan + 1) * Math.PI) / 4);
        const gr = Math.sin(((pan + 1) * Math.PI) / 4);
        l += y * gl;
        r += y * gr;
        sendL += y * gl * pv.patch.send;
        sendR += y * gr * pv.patch.send;
      });
      const [el, er] = this.echo.run(sendL, sendR);
      const wet = 0.55 * this.echoAmount;
      left[s] += this.outL.run((l + el * wet) * this.masterLeft);
      right[s] += this.outR.run((r + er * wet) * this.masterRight);
    }
  }
}
