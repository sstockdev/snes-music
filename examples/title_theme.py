"""Title theme: D Lydian, about 75 BPM. A flute melody that states itself and answers, over harp and strings.

python3 examples/title_theme.py title.uge && node render/cli.ts title.uge title.mp3 --peak=-6
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "../scripts"))
from compose import Song, midi  # noqa: E402

song = Song("Title Theme", speed=12)
flute = song.duty("Flute", volume=9)
harp = song.duty("Harp", volume=10, duty=1)
strings = song.wave("Strings", level=2)
kick = song.noise("Kick", volume=12, pace=3, table=[90, 63, 57, 50, 43, 36, 36])
snare = song.noise("Snare", volume=9, pace=2)
hat = song.noise("Hat", volume=6, pace=1)

# Broken chords in eighths: root, fifth, octave, tenth, twelfth, tenth, octave, fifth.
SHAPE = {"": [0, 7, 12, 16, 19, 16, 12, 7], "m": [0, 7, 12, 15, 19, 15, 12, 7]}
NOTE = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def name(m):
    return f"{NOTE[m % 12]}{m // 12 - 1}"


def arpeggio(p, chords):
    text = []
    for chord in chords.split():
        minor = chord[-2] == "m"
        base = midi(chord.replace("m", ""))
        text += [f"{name(base + i)}:1" for i in SHAPE["m" if minor else ""]]
    p.line(1, harp, " ".join(text), unit=2)


def section(melody, chords, drums):
    p = song.pattern()
    if melody:
        p.line(0, flute, melody, unit=2)
    else:
        # Let the last melody note ring one bar into the interlude, then rest.
        p.set(0, 16, effect=14)
    arpeggio(p, chords)
    p.chords(2, strings, chords, rows=16)
    # drums: 1 kick only, 2 adds offbeat hats, 3 adds a backbeat snare and pickup kicks.
    if drums:
        p.hits(3, kick, rows=[0, 32] if drums < 3 else [0, 24, 32, 56])
    if drums > 1:
        p.hits(3, hat, rows=[r for r in range(64) if r % 4 == 2], note=58)
    if drums > 2:
        p.hits(3, snare, rows=[16, 48], note=50)
    return p


# Melodies in eighths (unit = 2 rows), four bars each.
A = "A5:3 F#5:1 G#5:2 A5:2 | B5:4 G#5:2 E5:2 | A5:3 F#5:1 G#5:2 A5:2 | G#5:2 B5:2 E5:4"
A2 = "A5:3 F#5:1 G#5:2 A5:2 | D6:4 C#6:2 B5:2 | B5:3 A5:1 F#5:2 D5:2 | E5:8"
B = "F#5:2 B5:2 A5:2 F#5:2 | E5:3 C#5:1 E5:2 A5:2 | G#5:4 B5:2 E6:2 | D6:2 C#6:2 B5:2 G#5:2"
A3 = "A5:3 F#5:1 G#5:2 A5:2 | B5:4 G#5:2 E5:2 | F#5:3 G#5:1 A5:2 C#6:2 | D6:8"

intro = section(None, "D3 E3 D3 E3", 1)
a = section(A, "D3 E3 D3 E3", 2)
a2 = section(A2, "D3 E3 Bm2 A2", 2)
b = section(B, "Bm2 A2 E3 E3", 3)
a3 = section(A3, "D3 E3 F#m3 D3", 3)
# The second time round the flute sits out the bridge and the band carries it.
groove = section(None, "Bm2 A2 E3 E3", 3)
song.order(intro, a, a2, b, a3, intro, groove, a3)

out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "title.uge")
song.save(out)
print(out)
