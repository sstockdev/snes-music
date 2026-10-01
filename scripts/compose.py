"""
Write hUGETracker v6 (.uge) songs with note names instead of raw cells.

    from compose import Song

    song = Song("Title", speed=12)                 # ticks per row; 12 is about 75 BPM at 4 rows per beat
    flute = song.duty("Flute", volume=13)
    harp = song.duty("Harp", volume=11, duty=1)
    pad = song.wave("Strings", level=2)
    kick = song.noise("Kick", volume=9, pace=2, table=[90, 63, 57, 50, 43, 36, 36])

    a = song.pattern()
    a.line(0, flute, "A5:3 F#5:1 G#5:2 A5:2 | B5:4 - E5:2", unit=2)   # unit = rows per step
    a.chords(2, pad, "D3 E3 D3 E3", rows=16)                           # one held chord per 16 rows
    a.hits(3, kick, rows=[0, 32])
    song.order(a, a)
    song.save("title.uge")

Pitches are written as they should sound. The Game Boy wave channel plays an octave below the pulse channels for
the same tracker note, so wave instruments are shifted to match. Noise hits take a tracker note directly (32-63, or
24 with a pitch table, as in references/uge_format.md).

Instrument names matter to the 16-bit renderer (render/cli.ts): "Flute", "Strings", "Choir", "Organ", "Harp",
"Bell", "Brass", "Reed", "Bass", "Chip" and "Drums"/"Kick"/"Snare"/"Hat" each pick a patch.
"""
import re
import struct

REST = 90
NAMES = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
CHORDS = {"": 0x47, "m": 0x37, "sus": 0x57, "sus2": 0x27, "5": 0x7C, "dim": 0x36, "aug": 0x48}
# Effects (hUGEDriver numbering).
ARPEGGIO, PORTA_UP, PORTA_DOWN, TONE_PORTA, VIBRATO, SET_VOLUME, NOTE_CUT, SET_SPEED = 0, 1, 2, 3, 4, 12, 14, 15
TRIANGLE = [0, 2, 4, 6, 8, 10, 12, 14, 15, 15, 14, 12, 10, 8, 6, 4, 2, 0, 0, 0, 2, 4, 6, 8, 10, 12, 14, 15, 14, 12, 8, 4]


def midi(name):
    """'C4' is middle C (MIDI 60). Accepts sharps (#) and flats (b)."""
    m = re.fullmatch(r"([A-G])([#b]*)(-?\d)", name)
    if not m:
        raise ValueError(f"Bad note {name!r}")
    return 12 * (int(m.group(3)) + 1) + NAMES[m.group(1)] + m.group(2).count("#") - m.group(2).count("b")


class Instrument:
    def __init__(self, kind, index, name, **fields):
        self.kind, self.index, self.name, self.fields = kind, index, name, fields

    def note(self, name):
        """Tracker note for a sounding pitch. Pulse note 0 is MIDI 36; the wave channel sounds an octave lower."""
        n = midi(name) - (24 if self.kind == "wave" else 36)
        if not 0 <= n < 72:
            raise ValueError(f"{name} is out of range for a {self.kind} instrument")
        return n


class Pattern:
    def __init__(self):
        self.cells = [[[REST, 0, 0, 0] for _ in range(64)] for _ in range(4)]

    def set(self, channel, row, note=REST, instrument=None, effect=0, param=0):
        cell = self.cells[channel][row]
        cell[0] = note
        if instrument is not None:
            cell[1] = instrument.index
        if effect or param:
            cell[2], cell[3] = effect, param
        return self

    def line(self, channel, instrument, text, unit=1, start=0):
        """Notes as 'A5:3 F#5:1 - B5'. ':n' is length in units (default 1), '-' or 'r' rests, '.' is a note cut, '|' is ignored."""
        row = start
        for token in text.split():
            if token == "|":
                continue
            name, _, length = token.partition(":")
            steps = int(length or 1)
            if name in ("-", "r"):
                pass
            elif name == ".":
                self.set(channel, row, effect=NOTE_CUT, param=0)
            else:
                self.set(channel, row, instrument.note(name), instrument)
            row += steps * unit
        if row > 64:
            raise ValueError(f"Line runs past row 64 (to {row})")
        return self

    def chords(self, channel, instrument, text, rows=16, start=0):
        """Held chords as 'D3 Em3 Bm2', one per `rows`. The arpeggio is written on every row so it holds,
        which the 16-bit renderer plays as a real chord on sustained patches."""
        row = start
        for token in text.split():
            m = re.fullmatch(r"([A-G][#b]*)(m|sus2|sus|5|dim|aug)?(-?\d)", token)
            if not m:
                raise ValueError(f"Bad chord {token!r}")
            root = instrument.note(m.group(1) + m.group(3))
            param = CHORDS[m.group(2) or ""]
            for r in range(row, min(64, row + rows)):
                self.set(channel, r, root if r == row else REST, instrument if r == row else None, ARPEGGIO, param)
            row += rows
        return self

    def hits(self, channel, instrument, rows, note=24):
        for r in rows:
            self.set(channel, r, note, instrument)
        return self


class Song:
    def __init__(self, name, speed=6, artist="", comment=""):
        self.name, self.speed, self.artist, self.comment = name, speed, artist, comment
        self.instruments = {"duty": [], "wave": [], "noise": []}
        self.waves = [TRIANGLE] + [[i // 2 for i in range(32)] for _ in range(15)]
        self.patterns = []
        self.sequence = []

    def _add(self, kind, name, **fields):
        group = self.instruments[kind]
        if len(group) >= 15:
            raise ValueError(f"Only 15 {kind} instruments fit")
        inst = Instrument(kind, len(group) + 1, name, **fields)
        group.append(inst)
        return inst

    def duty(self, name, volume=12, pace=0, up=False, duty=2, table=None):
        """Pulse instrument. pace 0 holds the volume; 1-7 fades it one step every pace/64 s."""
        return self._add("duty", name, volume=volume, pace=pace, up=up, duty=duty, table=table)

    def wave(self, name, level=1, wave=0, table=None):
        """Wave instrument. level: 1 full, 2 half, 3 quarter."""
        return self._add("wave", name, level=level, wave=wave, table=table)

    def noise(self, name, volume=10, pace=2, up=False, short=False, table=None):
        """Noise instrument. up: the envelope rises instead of fading. table: per-tick tracker notes, offsets from the
        hit (36 = no change, 90 = keep)."""
        return self._add("noise", name, volume=volume, pace=pace, up=up, short=short, table=table)

    def pattern(self):
        p = Pattern()
        self.patterns.append(p)
        return p

    def order(self, *patterns):
        self.sequence.extend(patterns)

    def save(self, path):
        out = bytearray()
        u32 = lambda v: out.extend(struct.pack("<I", v & 0xFFFFFFFF))
        u8 = lambda v: out.extend(struct.pack("B", v & 0xFF))

        def text(s):
            e = s.encode()[:255]
            u8(len(e))
            out.extend(e + b"\0" * (255 - len(e)))

        def instrument(kind, inst):
            f = inst.fields if inst else {}
            u32(["duty", "wave", "noise"].index(kind))
            text(inst.name if inst else "")
            u32(0)
            u8(0)
            u8(f.get("volume", 0) if kind != "wave" else 0)
            u32(0 if f.get("up") else 1)
            u8(f.get("pace", 0))
            u32(0)
            u32(0)
            u32(0)
            u8(f.get("duty", 2))
            u32(f.get("level", 0) if kind == "wave" else 0)
            u32(f.get("wave", 0))
            u32(1 if f.get("short") else 0)
            table = f.get("table")
            u8(1 if table else 0)
            for i in range(64):
                u32(table[i] if table and i < len(table) else REST)
                u32(0)
                u32(0)
                u32(0)
                u8(0)

        u32(6)
        text(self.name)
        text(self.artist)
        text(self.comment)
        for kind in ("duty", "wave", "noise"):
            group = self.instruments[kind]
            for i in range(15):
                instrument(kind, group[i] if i < len(group) else None)
        for w in self.waves:
            for s in w:
                u8(s)
        u32(self.speed)
        u8(0)
        u32(0)
        u32(len(self.patterns) * 4)
        for pi, p in enumerate(self.patterns):
            for ch in range(4):
                u32(pi * 4 + ch)
                for note, inst, effect, param in p.cells[ch]:
                    u32(note)
                    u32(inst)
                    u32(0)
                    u32(effect)
                    u8(param)
        sequence = self.sequence or self.patterns
        for ch in range(4):
            u32(len(sequence) + 1)
            for p in sequence:
                u32(self.patterns.index(p) * 4 + ch)
            u32(0)
        for _ in range(16):
            u32(0)
        with open(path, "wb") as f:
            f.write(out)
        return len(out)
