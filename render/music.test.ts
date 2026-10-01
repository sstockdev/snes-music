import { describe, expect, it } from "vitest";
import { Player, VBLANK_HZ, notePeriod } from "./player.ts";
import { render, wav } from "./render.ts";
import { patchFor, SNES_RATE } from "./snes.ts";
import { REST, parseUge } from "./uge.ts";

type Row = [note: number, instrument?: number, effect?: number, param?: number];

interface Spec {
  speed?: number;
  /** Rows per channel for pattern 0; missing rows rest. */
  rows: Record<number, Record<number, Row>>;
  orders?: number;
  names?: [string, string, string, string];
  subpattern?: number[];
}

/** Writes a small hUGETracker v6 file, following the snes-music skill's template. */
function uge({ speed = 6, rows, orders = 1, names = ["Lead", "Harmony", "Bass", "Hat"], subpattern }: Spec): Uint8Array {
  const out: number[] = [];
  const u32 = (v: number) => out.push(v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255);
  const u8 = (v: number) => out.push(v & 255);
  const str = (s: string) => {
    u8(s.length);
    for (let i = 0; i < 255; i++) u8(i < s.length ? s.charCodeAt(i) : 0);
  };
  const instrument = (kind: number, name: string, sub?: number[]) => {
    u32(kind);
    str(name);
    u32(0);
    u8(0);
    u8(15);
    u32(1);
    u8(0);
    u32(0);
    u32(0);
    u32(0);
    u8(2);
    u32(1);
    u32(0);
    u32(0);
    u8(sub ? 1 : 0);
    for (let i = 0; i < 64; i++) {
      u32(sub?.[i] ?? 90);
      u32(0);
      u32(0);
      u32(0);
      u8(0);
    }
  };
  u32(6);
  str("Test");
  str("");
  str("");
  const empty = (kind: number, n: number) => {
    for (let i = 0; i < n; i++) instrument(kind, "");
  };
  instrument(0, names[0]);
  instrument(0, names[1]);
  empty(0, 13);
  instrument(1, names[2]);
  empty(1, 14);
  instrument(2, names[3], subpattern);
  empty(2, 14);
  for (let w = 0; w < 16; w++) for (let i = 0; i < 32; i++) u8(i < 16 ? 15 : 0);
  u32(speed);
  u8(0);
  u32(0);
  u32(4);
  for (let t = 0; t < 4; t++) {
    u32(t);
    for (let r = 0; r < 64; r++) {
      const [note, ins = 0, effect = 0, param = 0] = rows[t]?.[r] ?? [REST];
      u32(note);
      u32(ins);
      u32(0);
      u32(effect);
      u8(param);
    }
  }
  for (let t = 0; t < 4; t++) {
    u32(orders + 1);
    for (let o = 0; o < orders; o++) u32(t);
    u32(0);
  }
  for (let i = 0; i < 16; i++) u32(0);
  return new Uint8Array(out);
}

const steps = (player: Player, n: number) => Array.from({ length: n }, () => player.step());

describe("parseUge", () => {
  it("reads instruments, patterns and orders", () => {
    const song = parseUge(uge({ speed: 5, rows: { 0: { 0: [24, 1] } }, orders: 2 }));
    expect(song.ticksPerRow).toBe(5);
    expect(song.duty[0].name).toBe("Lead");
    expect(song.wave[0].name).toBe("Bass");
    expect(song.noise[0].kind).toBe("noise");
    expect(song.patterns.get(0)?.[0]).toEqual({ note: 24, instrument: 1, effect: 0, param: 0 });
    expect(song.orders).toEqual([[0, 0], [1, 1], [2, 2], [3, 3]]);
  });

  it("rejects other versions and short files", () => {
    const bytes = uge({ rows: {} });
    expect(() => parseUge(bytes.slice(0, 1000))).toThrow(/ends early/);
    bytes[0] = 5;
    expect(() => parseUge(bytes)).toThrow(/v6/);
  });
});

describe("Player", () => {
  it("plays notes at hUGEDriver pitches, the wave channel an octave down", () => {
    const player = new Player(parseUge(uge({ rows: { 0: { 0: [12, 1] }, 2: { 0: [12, 1] } } })));
    const [frame] = steps(player, 1);
    expect(frame.voices[0].trigger).toBe(true);
    expect(frame.voices[0].freq).toBeCloseTo(130.8, 0);
    expect(frame.voices[2].freq).toBeCloseTo(65.4, 0);
    expect(notePeriod(0)).toBe(44);
  });

  it("finds the loop after every order has played", () => {
    const player = new Player(parseUge(uge({ speed: 3, rows: {}, orders: 2 })));
    steps(player, 2 * 64 * 3 + 1);
    expect(player.loop).toEqual([0, 2 * 64 * 3]);
    expect(player.tickRate).toBeCloseTo(VBLANK_HZ);
  });

  it("cycles arpeggios, cuts notes and changes speed", () => {
    const player = new Player(parseUge(uge({ speed: 4, rows: { 0: { 0: [24, 1, 0, 0x47], 1: [REST, 0, 14, 2], 2: [REST, 0, 15, 2] } } })));
    const row0 = steps(player, 4).map((f) => f.voices[0]);
    expect(row0.map((v) => v.note)).toEqual([24, 28, 31, 24]);
    expect(row0[0].chord).toEqual([4, 7]);
    const row1 = steps(player, 4).map((f) => f.voices[0].gate);
    expect(row1).toEqual([true, true, false, false]);
    steps(player, 2);
    // Row 3 starts after two ticks at the new speed.
    expect(steps(player, 1)[0].voices[0].note).toBe(24);
  });

  it("adds instrument table offsets to the pattern note", () => {
    const player = new Player(parseUge(uge({ rows: { 3: { 0: [24, 1] } }, subpattern: [90, 63, 51] })));
    const notes = steps(player, 3).map((f) => f.voices[3].note);
    expect(notes).toEqual([24, 51, 39]);
  });
});

describe("render", () => {
  const song = () => parseUge(uge({ speed: 2, rows: { 0: { 0: [24, 1], 32: [31, 1] }, 1: { 0: [12, 2, 0, 0x37] }, 2: { 0: [0, 1] }, 3: { 0: [50, 1], 16: [58, 1] } } }));
  const loopSeconds = (64 * 2) / VBLANK_HZ;

  it("cuts exactly one loop in each style", () => {
    for (const style of ["gb", "snes"] as const) {
      const out = render(song(), { style });
      expect(out.sampleRate).toBe(style === "snes" ? SNES_RATE : 44100);
      expect(out.left.length / out.sampleRate).toBeCloseTo(loopSeconds, 2);
      const peak = [...out.left, ...out.right].reduce((p, x) => Math.max(p, Math.abs(x)), 0);
      expect(peak).toBeCloseTo(0.891, 2);
      expect(out.left.every(Number.isFinite)).toBe(true);
    }
  });

  it("keeps a tail after a one-shot", () => {
    const out = render(song(), { style: "snes", once: true, tail: 1 });
    expect(out.left.length / out.sampleRate).toBeCloseTo(loopSeconds + 1, 2);
  });

  it("normalizes to the requested peak", () => {
    const out = render(song(), { style: "gb", peak: -6 });
    const peak = [...out.left, ...out.right].reduce((p, x) => Math.max(p, Math.abs(x)), 0);
    expect(peak).toBeCloseTo(0.501, 2);
  });

  it("writes 16-bit stereo WAV", () => {
    const out = render(song(), { style: "gb" });
    const bytes = wav(out);
    const view = new DataView(bytes.buffer);
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("RIFF");
    expect(view.getUint16(22, true)).toBe(2);
    expect(view.getUint32(24, true)).toBe(44100);
    expect(bytes.length).toBe(44 + out.left.length * 4);
  });
});

describe("patchFor", () => {
  it("picks patches from instrument names and falls back per channel", () => {
    expect(patchFor("Choir Aah", 1)).toBe("choir");
    expect(patchFor("Harp", 0)).toBe("harp");
    expect(patchFor("Bass", 2)).toBe("bass");
    expect(patchFor("Lead", 0)).toBe("flute");
    expect(patchFor("", 1)).toBe("strings");
    expect(patchFor("", 3)).toBe("drums");
  });
});
