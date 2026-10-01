/** Small DSP pieces shared by the Game Boy and 16-bit renderers. */
import type { Voice } from "./player.ts";

export interface Synth {
  /** Takes the channel states for the next tick. */
  set(voices: Voice[], masterLeft: number, masterRight: number): void;
  /** Adds `n` samples into the buffers starting at `at`. */
  render(left: Float32Array, right: Float32Array, at: number, n: number): void;
}

/** The Game Boy's 4-bit volume envelope (stepped at 64 Hz) and length counter. */
export class Envelope {
  level = 0;
  on = false;
  private dir: 1 | -1 = -1;
  private pace = 0;
  private clock = 0;
  private left = 0;
  private sr: number;

  constructor(sampleRate: number) {
    this.sr = sampleRate;
  }

  apply(v: Voice): void {
    if (v.trigger || v.reload) {
      this.level = v.volume;
      this.dir = v.envelopeDir;
      this.pace = v.envelopePace;
      this.clock = 0;
    }
    if (v.trigger) {
      this.on = true;
      this.left = v.length;
    }
    if (!v.gate) this.on = false;
  }

  /** Advances one sample and returns the volume, 0..15. */
  next(): number {
    if (!this.on) return 0;
    if (this.left > 0) {
      this.left -= 1 / this.sr;
      if (this.left <= 0) this.on = false;
    }
    if (this.pace) {
      this.clock += 64 / this.sr;
      if (this.clock >= this.pace) {
        this.clock -= this.pace;
        this.level = Math.max(0, Math.min(15, this.level + this.dir));
      }
    }
    return this.level;
  }
}

/** PolyBLEP correction for a discontinuity at phase 0, for anti-aliased saw and pulse waves. */
export function blep(t: number, dt: number): number {
  if (t < dt) {
    const x = t / dt;
    return x + x - x * x - 1;
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt;
    return x * x + x + x + 1;
  }
  return 0;
}

export function pulse(phase: number, dt: number, width: number): number {
  let y = phase < width ? 1 : -1;
  y += blep(phase, dt);
  y -= blep((phase - width + 1) % 1, dt);
  return y;
}

export function saw(phase: number, dt: number): number {
  return 2 * phase - 1 - blep(phase, dt);
}

export class OnePole {
  private a = 0;
  private y = 0;
  constructor(sampleRate: number, cutoff: number) {
    this.setCutoff(sampleRate, cutoff);
  }
  setCutoff(sampleRate: number, cutoff: number): void {
    this.a = 1 - Math.exp((-2 * Math.PI * Math.min(cutoff, sampleRate * 0.45)) / sampleRate);
  }
  low(x: number): number {
    return (this.y += this.a * (x - this.y));
  }
  high(x: number): number {
    return x - this.low(x);
  }
}

/** RBJ biquad, low-pass or band-pass. */
export class Biquad {
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;

  set(type: "low" | "band", sampleRate: number, freq: number, q: number): this {
    const w = (2 * Math.PI * Math.min(freq, sampleRate * 0.45)) / sampleRate;
    const alpha = Math.sin(w) / (2 * q);
    const cos = Math.cos(w);
    const a0 = 1 + alpha;
    if (type === "low") {
      this.b0 = (1 - cos) / 2 / a0;
      this.b1 = (1 - cos) / a0;
      this.b2 = this.b0;
    } else {
      this.b0 = alpha / a0;
      this.b1 = 0;
      this.b2 = -alpha / a0;
    }
    this.a1 = (-2 * cos) / a0;
    this.a2 = (1 - alpha) / a0;
    return this;
  }

  run(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

/** Steps the Game Boy noise LFSR at `freq` and box-filters it down to one output sample. */
export class Lfsr {
  private reg = 0x7fff;
  private acc = 0;
  private out = 1;

  sample(freq: number, sampleRate: number, short: boolean): number {
    this.acc += freq / sampleRate;
    const steps = Math.floor(this.acc);
    this.acc -= steps;
    if (steps === 0) return this.out;
    let sum = 0;
    const n = Math.min(steps, 64);
    for (let i = 0; i < n; i++) {
      const bit = (this.reg ^ (this.reg >> 1)) & 1;
      this.reg = (this.reg >> 1) | (bit << 14);
      if (short) this.reg = (this.reg & ~0x40) | (bit << 6);
      sum += this.reg & 1 ? -1 : 1;
    }
    this.out = sum / n;
    return this.out;
  }
}
