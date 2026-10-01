/** Game Boy APU: two pulse channels, a 4-bit wave channel and LFSR noise, as the hardware plays a .uge. */
import { Envelope, Lfsr, OnePole, pulse, type Synth } from "./dsp.ts";
import type { Voice } from "./player.ts";

const DUTY = [0.125, 0.25, 0.5, 0.75];
const WAVE_SHIFT = [4, 0, 1, 2];

export class GameBoy implements Synth {
  private env: Envelope[];
  private voices: Voice[] = [];
  private phase = [0, 0, 0, 0];
  private sweepClock = 0;
  private sweepFreq = 0;
  private lfsr = new Lfsr();
  private masterLeft = 1;
  private masterRight = 1;
  private dcLeft: OnePole;
  private dcRight: OnePole;
  private sr: number;
  private waves: number[][];

  constructor(sampleRate: number, waves: number[][]) {
    this.sr = sampleRate;
    this.waves = waves;
    this.env = [0, 1, 2, 3].map(() => new Envelope(sampleRate));
    // The output capacitor's high-pass.
    this.dcLeft = new OnePole(sampleRate, 30);
    this.dcRight = new OnePole(sampleRate, 30);
  }

  set(voices: Voice[], masterLeft: number, masterRight: number): void {
    voices.forEach((v, i) => {
      this.env[i].apply(v);
      if (v.trigger && v.kind === "wave") this.phase[i] = 0;
    });
    if (voices[0].trigger || !this.voices.length || voices[0].freq !== this.voices[0].freq) {
      this.sweepFreq = voices[0].freq;
      this.sweepClock = 0;
    }
    this.voices = voices;
    this.masterLeft = masterLeft;
    this.masterRight = masterRight;
  }

  private sweep(v: Voice): number {
    if (!v.sweepTime || !v.sweepShift) return v.freq;
    this.sweepClock += 128 / this.sr;
    if (this.sweepClock >= v.sweepTime) {
      this.sweepClock -= v.sweepTime;
      const period = 2048 - 131072 / this.sweepFreq;
      const next = period + (v.sweepDown ? -1 : 1) * (period / 2 ** v.sweepShift);
      if (next >= 2047) this.env[0].on = false;
      else this.sweepFreq = 131072 / (2048 - Math.max(0, next));
    }
    return this.sweepFreq;
  }

  render(left: Float32Array, right: Float32Array, at: number, n: number): void {
    const vs = this.voices;
    if (!vs.length) return;
    for (let s = at; s < at + n; s++) {
      let l = 0;
      let r = 0;
      for (let i = 0; i < 4; i++) {
        const v = vs[i];
        const vol = this.env[i].next();
        let y = 0;
        const freq = i === 0 ? this.sweep(v) : v.freq;
        const dt = freq / this.sr;
        if (v.kind === "noise") {
          y = this.lfsr.sample(freq, this.sr, v.shortNoise) * (vol / 15);
        } else if (v.kind === "wave") {
          this.phase[i] = (this.phase[i] + dt) % 1;
          const table = this.waves[v.wave];
          const sample = table[Math.floor(this.phase[i] * 32)] >> WAVE_SHIFT[v.waveLevel];
          y = this.env[i].on && v.waveLevel ? (sample - 7.5) / 7.5 : 0;
        } else {
          this.phase[i] = (this.phase[i] + dt) % 1;
          y = pulse(this.phase[i], Math.min(dt, 0.5), DUTY[v.duty]) * (vol / 15);
        }
        if (v.left) l += y;
        if (v.right) r += y;
      }
      left[s] += this.dcLeft.high(l * 0.25 * this.masterLeft);
      right[s] += this.dcRight.high(r * 0.25 * this.masterRight);
    }
  }
}
