/** Reads hUGETracker v6 (.uge) songs, the format the snes-music skill writes. Layout: .claude/skills/snes-music/references/uge_format.md */

export const REST = 90;
const SUBPATTERN_NO_CHANGE = 90;
const SUBPATTERN_ZERO = 36;

export interface Cell {
  note: number;
  /** 1-based; 0 keeps the channel's current instrument. */
  instrument: number;
  effect: number;
  param: number;
}

export interface SubCell {
  /** Offset from the pattern note in semitones, or null for no change. */
  offset: number | null;
  /** Row to jump to after this one, or null. */
  jump: number | null;
  effect: number;
  param: number;
}

export interface Instrument {
  kind: "duty" | "wave" | "noise";
  name: string;
  length: number;
  lengthEnabled: boolean;
  volume: number;
  /** +1 louder, -1 quieter. */
  envelopeDir: 1 | -1;
  /** Envelope pace in 1/64 s steps; 0 holds the volume. */
  envelopePace: number;
  sweepTime: number;
  sweepDown: boolean;
  sweepShift: number;
  duty: number;
  /** NR32 code: 0 mute, 1 full, 2 half, 3 quarter. */
  waveLevel: number;
  wave: number;
  /** 7-bit "metallic" noise. */
  shortNoise: boolean;
  subpattern: SubCell[] | null;
}

export interface Song {
  name: string;
  artist: string;
  comment: string;
  duty: Instrument[];
  wave: Instrument[];
  noise: Instrument[];
  /** 16 tables of 32 four-bit samples. */
  waves: number[][];
  ticksPerRow: number;
  timerEnabled: boolean;
  timerDivider: number;
  patterns: Map<number, Cell[]>;
  /** Pattern keys per channel, in play order. */
  orders: number[][];
}

class Reader {
  pos = 0;
  private buf: Uint8Array;
  private view: DataView;
  constructor(buf: Uint8Array) {
    this.buf = buf;
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  need(n: number): void {
    if (this.pos + n > this.buf.length) throw new Error(`UGE file ends early at byte ${this.pos}`);
  }
  u8(): number {
    this.need(1);
    return this.buf[this.pos++];
  }
  i8(): number {
    this.need(1);
    return this.view.getInt8(this.pos++);
  }
  u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }
  str(): string {
    const len = this.u8();
    this.need(255);
    const s = new TextDecoder().decode(this.buf.subarray(this.pos, this.pos + Math.min(len, 255)));
    this.pos += 255;
    return s;
  }
}

function readSubpattern(r: Reader): SubCell[] | null {
  const enabled = r.i8() !== 0;
  const rows: SubCell[] = [];
  for (let i = 0; i < 64; i++) {
    const note = r.u32();
    r.u32();
    const jump = r.u32();
    const effect = r.u32();
    const param = r.u8();
    rows.push({
      offset: note === SUBPATTERN_NO_CHANGE ? null : note - SUBPATTERN_ZERO,
      jump: jump === 0 ? null : jump - 1,
      effect,
      param,
    });
  }
  // GB Studio exports 32 rows and jumps back to row 0 after row 31.
  return enabled ? rows.slice(0, 32) : null;
}

function readInstrument(r: Reader): Instrument {
  const kind = (["duty", "wave", "noise"] as const)[r.u32()] ?? "duty";
  const name = r.str();
  const length = r.u32();
  const lengthEnabled = r.u8() !== 0;
  const volume = r.u8();
  const envelopeDir = r.u32() === 0 ? 1 : -1;
  const envelopePace = r.u8() & 7;
  const sweepTime = r.u32() & 7;
  const sweepDown = r.u32() !== 0;
  const sweepShift = r.u32() & 7;
  const duty = r.u8() & 3;
  const waveLevel = r.u32() & 3;
  const wave = r.u32() & 15;
  const shortNoise = r.u32() !== 0;
  const subpattern = readSubpattern(r);
  return {
    kind, name, length, lengthEnabled, volume: Math.min(15, volume), envelopeDir, envelopePace,
    sweepTime, sweepDown, sweepShift, duty, waveLevel, wave, shortNoise, subpattern,
  };
}

export function parseUge(bytes: Uint8Array): Song {
  const r = new Reader(bytes);
  const version = r.u32();
  if (version !== 6) throw new Error(`Only hUGETracker v6 files are supported (got v${version})`);
  const name = r.str();
  const artist = r.str();
  const comment = r.str();
  const block = () => Array.from({ length: 15 }, () => readInstrument(r));
  const duty = block();
  const wave = block();
  const noise = block();
  const waves = Array.from({ length: 16 }, () => Array.from({ length: 32 }, () => r.u8() & 15));
  const ticksPerRow = Math.max(1, r.u32());
  const timerEnabled = r.i8() !== 0;
  const timerDivider = r.u32();
  const patternCount = r.u32();
  const patterns = new Map<number, Cell[]>();
  for (let p = 0; p < patternCount; p++) {
    const key = r.u32();
    const cells: Cell[] = [];
    for (let i = 0; i < 64; i++) {
      const note = r.u32();
      const instrument = r.u32();
      r.u32();
      cells.push({ note, instrument, effect: r.u32(), param: r.u8() });
    }
    patterns.set(key, cells);
  }
  const orders: number[][] = [];
  for (let c = 0; c < 4; c++) {
    const count = Math.max(0, r.u32() - 1);
    orders.push(Array.from({ length: count }, () => r.u32()));
    r.u32();
  }
  return { name, artist, comment, duty, wave, noise, waves, ticksPerRow, timerEnabled, timerDivider, patterns, orders };
}
