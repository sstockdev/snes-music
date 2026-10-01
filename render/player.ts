/** Steps a .uge song tick by tick the way hUGEDriver does, producing what each channel should sound like. */
import { REST, type Cell, type Instrument, type Song } from "./uge.ts";

export const VBLANK_HZ = 59.7275;
const C3_HZ = 65.406;

/** One channel's state for the current tick. */
export interface Voice {
  kind: Instrument["kind"];
  /** Instrument name, used by the 16-bit renderer to pick a patch. */
  name: string;
  gate: boolean;
  /** A new note started on this tick. */
  trigger: boolean;
  /** Volume or envelope was set without a new note (effects C and A). */
  reload: boolean;
  /** Tone frequency in Hz; for noise, the LFSR clock. */
  freq: number;
  /** Frequency without the arpeggio offset. */
  baseFreq: number;
  /** Arpeggio semitones (0xy), or null. */
  chord: [number, number] | null;
  /** Final note number, including table offsets. */
  note: number;
  volume: number;
  envelopeDir: 1 | -1;
  envelopePace: number;
  /** Seconds until the length counter silences the note, or 0 for no limit. */
  length: number;
  duty: number;
  wave: number;
  waveLevel: number;
  shortNoise: boolean;
  sweepTime: number;
  sweepDown: boolean;
  sweepShift: number;
  left: boolean;
  right: boolean;
}

export interface Frame {
  voices: Voice[];
  /** NR50 master volume, 0..1 per side. */
  masterLeft: number;
  masterRight: number;
}

const KINDS: Instrument["kind"][] = ["duty", "duty", "wave", "noise"];

export function notePeriod(note: number): number {
  return Math.max(0, Math.min(2047, Math.round(2048 - 131072 / (C3_HZ * 2 ** (note / 12)))));
}

function periodFreq(period: number, kind: Instrument["kind"]): number {
  return (kind === "wave" ? 65536 : 131072) / (2048 - Math.min(2047, period));
}

/** Noise note to LFSR clock, after hUGEDriver's `63 - note` poly table. 64 and up wraps into 7-bit mode. */
export function noiseClock(note: number): { freq: number; short: boolean } {
  const n = Math.max(0, note);
  const v = (63 - (n & 63)) & 63;
  const shift = v >> 2;
  const div = v & 3 || 0.5;
  return { freq: 524288 / div / 2 ** (shift + 1), short: n > 63 };
}

class Channel {
  ins: Instrument | null = null;
  note = 0;
  period = 0;
  target: number | null = null;
  gate = false;
  trigger = false;
  reload = false;
  volume = 0;
  envelopeDir: 1 | -1 = -1;
  envelopePace = 0;
  duty = 2;
  subRow = 0;
  subOffset = 0;
  cell: Cell | null = null;
  delayed: Cell | null = null;
  delayAt = 0;
  cutAt: number | null = null;
  vibratoPhase = 0;
  arp: [number, number] | null = null;
  arpOffset = 0;
  readonly kind: Instrument["kind"];

  constructor(kind: Instrument["kind"]) {
    this.kind = kind;
  }
}

export class Player {
  readonly tickRate: number;
  private chans = KINDS.map((k) => new Channel(k));
  private order = 0;
  private row = 0;
  private tick = 0;
  private speed: number;
  private jump: number | null = null;
  private breakRow: number | null = null;
  private masterLeft = 1;
  private masterRight = 1;
  private pan = 0xff;
  private seen = new Set<number>();
  /** Set when the song reaches an order it has played before: [first visit tick, revisit tick]. */
  loop: [number, number] | null = null;
  private starts = new Map<number, number>();
  ticks = 0;
  private length: number;
  private song: Song;

  constructor(song: Song) {
    this.song = song;
    this.speed = song.ticksPerRow;
    this.tickRate = song.timerEnabled ? 4096 / Math.max(1, 256 - (song.timerDivider & 255)) : VBLANK_HZ;
    this.length = Math.max(1, ...song.orders.map((o) => o.length));
  }

  private instrument(c: Channel, index: number): Instrument | null {
    const list = c.kind === "duty" ? this.song.duty : c.kind === "wave" ? this.song.wave : this.song.noise;
    return list[index - 1] ?? null;
  }

  private cellAt(ch: number): Cell | null {
    const order = this.song.orders[ch];
    if (!order.length) return null;
    return this.song.patterns.get(order[this.order % order.length])?.[this.row] ?? null;
  }

  private start(c: Channel, cell: Cell): void {
    if (cell.instrument > 0) c.ins = this.instrument(c, cell.instrument) ?? c.ins;
    if (cell.note !== REST && cell.note < 72) {
      if (cell.effect === 3 && c.gate) {
        c.target = notePeriod(cell.note);
      } else {
        c.note = cell.note;
        c.period = notePeriod(cell.note);
        c.target = null;
        c.gate = true;
        c.trigger = true;
        c.subRow = 0;
        c.subOffset = 0;
        c.vibratoPhase = 0;
        c.cutAt = null;
        const ins = c.ins;
        c.volume = ins ? (ins.kind === "wave" ? [0, 15, 8, 4][ins.waveLevel] : ins.volume) : 15;
        c.envelopeDir = ins?.envelopeDir ?? -1;
        c.envelopePace = ins?.kind === "wave" ? 0 : (ins?.envelopePace ?? 0);
        c.duty = ins?.duty ?? 2;
      }
    }
    c.cell = cell;
    c.arp = null;
    if (cell.effect === 0 && cell.param) c.arp = [cell.param >> 4, cell.param & 15];
    if (cell.effect === 12) {
      c.volume = cell.param >> 4;
      c.envelopeDir = cell.param & 8 ? 1 : -1;
      c.envelopePace = cell.param & 7;
      c.reload = !c.trigger;
    }
    if (cell.effect === 9) c.duty = (cell.param >> 6) & 3;
    if (cell.effect === 14) {
      c.cutAt = cell.param;
      if (cell.param === 0) c.gate = false;
    }
  }

  private globals(cell: Cell): void {
    switch (cell.effect) {
      case 5:
        this.masterLeft = (((cell.param >> 4) & 7) + 1) / 8;
        this.masterRight = ((cell.param & 7) + 1) / 8;
        break;
      case 8:
        this.pan = cell.param;
        break;
      case 11:
        this.jump = cell.param;
        break;
      case 13:
        this.breakRow = cell.param & 63;
        break;
      case 15:
        if (cell.param > 0) this.speed = cell.param;
        break;
    }
  }

  /** Effects that run on every tick, from the pattern cell or the instrument table. */
  private perTick(c: Channel, effect: number, param: number, first: boolean): void {
    switch (effect) {
      case 1:
        if (!first) c.period = Math.min(2047, c.period + param);
        break;
      case 2:
        if (!first) c.period = Math.max(0, c.period - param);
        break;
      case 3:
        if (c.target !== null && !first) {
          c.period += Math.sign(c.target - c.period) * Math.min(param, Math.abs(c.target - c.period));
          if (c.period === c.target) c.target = null;
        }
        break;
      case 10:
        if (!first) c.volume = Math.max(0, Math.min(15, c.volume + (param >> 4) - (param & 15)));
        if (!first) c.reload = true;
        break;
    }
  }

  private advanceRow(): void {
    this.tick = 0;
    if (this.jump !== null) {
      this.order = this.jump % this.length;
      this.row = 0;
    } else if (this.breakRow !== null) {
      this.order = (this.order + 1) % this.length;
      this.row = this.breakRow;
    } else if (++this.row >= 64) {
      this.row = 0;
      this.order = (this.order + 1) % this.length;
    }
    this.jump = null;
    this.breakRow = null;
  }

  /** Runs one tick and returns the channel states that hold until the next one. */
  step(): Frame {
    if (this.tick === 0) {
      if (this.row === 0) {
        if (this.seen.has(this.order) && !this.loop) this.loop = [this.starts.get(this.order) ?? 0, this.ticks];
        if (!this.seen.has(this.order)) this.starts.set(this.order, this.ticks);
        this.seen.add(this.order);
      }
      this.chans.forEach((c, i) => {
        const cell = this.cellAt(i);
        c.delayed = null;
        if (!cell) return;
        if (cell.effect === 7 && cell.param > 0) {
          c.delayed = cell;
          c.delayAt = cell.param;
        } else this.start(c, cell);
        this.globals(cell);
      });
    }
    for (const c of this.chans) {
      if (c.delayed && this.tick === c.delayAt) {
        this.start(c, c.delayed);
        c.delayed = null;
      }
      const first = this.tick === 0;
      if (c.cell && !c.delayed) this.perTick(c, c.cell.effect, c.cell.param, first);
      if (c.cutAt !== null && this.tick === c.cutAt) c.gate = false;
      const sub = c.ins?.subpattern;
      let subArp = 0;
      if (sub && c.gate) {
        const s = sub[c.subRow] ?? sub[0];
        if (s.offset !== null) c.subOffset = s.offset;
        if (s.effect === 0 && s.param) subArp = [0, s.param >> 4, s.param & 15][this.ticks % 3];
        else this.perTick(c, s.effect, s.param, false);
        c.subRow = s.jump ?? (c.subRow + 1) % sub.length;
      }
      c.arpOffset = c.arp ? [0, c.arp[0], c.arp[1]][this.tick % 3] : subArp;
    }
    const voices = this.chans.map((c, i) => this.voice(c, i));
    this.ticks++;
    if (++this.tick >= this.speed) this.advanceRow();
    return { voices, masterLeft: this.masterLeft, masterRight: this.masterRight };
  }

  private voice(c: Channel, i: number): Voice {
    const ins = c.ins;
    const cell = c.cell;
    let vibrato = 0;
    if (cell?.effect === 4 && cell.param) {
      c.vibratoPhase += (cell.param >> 4) / 16;
      vibrato = Math.sin(c.vibratoPhase * Math.PI * 2) * (cell.param & 15);
    }
    const offset = c.subOffset + c.arpOffset;
    const note = c.note + offset;
    let freq: number;
    let baseFreq: number;
    let shortNoise = ins?.shortNoise ?? false;
    if (c.kind === "noise") {
      const n = noiseClock(note);
      freq = baseFreq = n.freq;
      shortNoise ||= n.short;
    } else {
      baseFreq = periodFreq(c.period + vibrato, c.kind) * 2 ** (c.subOffset / 12);
      freq = baseFreq * 2 ** (c.arpOffset / 12);
    }
    const v: Voice = {
      kind: c.kind,
      name: ins?.name ?? "",
      gate: c.gate,
      trigger: c.trigger,
      reload: c.reload,
      freq,
      baseFreq,
      chord: c.arp,
      note,
      volume: c.volume,
      envelopeDir: c.envelopeDir,
      envelopePace: c.envelopePace,
      length: ins?.lengthEnabled ? (c.kind === "wave" ? 256 - ins.length : 64 - (ins.length & 63)) / 256 : 0,
      duty: c.duty,
      wave: ins?.wave ?? 0,
      waveLevel: ins?.waveLevel ?? 1,
      shortNoise,
      sweepTime: i === 0 ? (ins?.sweepTime ?? 0) : 0,
      sweepDown: ins?.sweepDown ?? false,
      sweepShift: ins?.sweepShift ?? 0,
      left: !!(this.pan & (1 << (i + 4))),
      right: !!(this.pan & (1 << i)),
    };
    c.trigger = false;
    c.reload = false;
    return v;
  }
}
