# snes-music

An [Agent Skill](https://agentskills.io) for writing tracker music and turning it into audio. It started as [kurum-inc/gb-music](https://github.com/kurum-inc/gb-music), which writes Game Boy songs (`.uge`) and sound effects (`.sav`) for GB Studio. This copy adds:

- **`scripts/compose.py`**: write songs with note names and chord symbols instead of raw tracker cells.
- **`render/`**: render a `.uge` to a seamless mp3 or wav loop, as Game Boy hardware or as 16-bit console music with SNES-style instruments and echo.

So you can write a song as notes, hear it as a 16-bit score, and drop the mp3 into any game.

## Install

With the [skills CLI](https://skills.sh):

```bash
npx skills add sstockdev/snes-music        # this project
npx skills add sstockdev/snes-music -g     # all projects
```

Or clone it into a project's `.claude/skills/` folder:

```bash
git clone https://github.com/sstockdev/snes-music.git .claude/skills/snes-music
```

A nested clone with its own `.git` won't commit cleanly inside another repo, so take the files without `.git` or add it as a submodule.

You need:

- Python 3.8 or newer for writing songs (standard library only).
- Node 22.18 or newer for rendering (it runs the TypeScript directly, no build step).
- ffmpeg for mp3 output. Without it, render to `.wav`.
- librosa, only for `scripts/audio_to_uge.py`.

## Quick start

```bash
python3 examples/title_theme.py /tmp/title.uge
node render/cli.ts /tmp/title.uge /tmp/title.mp3 --peak=-6
```

That writes the example title theme (D Lydian, a soft flute over harp, strings and a light backbeat) and renders a 103 second seamless loop.

In Claude Code you can just ask: "write a calm village theme in F major with a flute lead and render it as 16-bit." The skill tells Claude to use `compose.py` and the renderer.

## Writing a song

A song is four channels playing patterns of 64 rows. Each row lasts `speed` ticks at about 60 ticks a second.

| Channel | Hardware | Usual role |
|---|---|---|
| 1 | Pulse | Lead melody |
| 2 | Pulse | Harmony, arpeggios, counter melody |
| 3 | Wave | Bass, or a low pad |
| 4 | Noise | Drums |

```python
import sys
sys.path.insert(0, ".claude/skills/snes-music/scripts")
from compose import Song

song = Song("Village", speed=10)                    # 10 ticks a row is about 90 BPM at 4 rows a beat
flute = song.duty("Flute", volume=13)
harp = song.duty("Harp", volume=10, duty=1)
strings = song.wave("Strings", level=2)
kick = song.noise("Kick", volume=8, pace=3, table=[90, 63, 57, 50, 43, 36, 36])
hat = song.noise("Hat", volume=3, pace=1)

verse = song.pattern()
verse.line(0, flute, "F5:3 G5:1 A5:2 C6:2 | Bb5:4 A5:2 G5:2 | F5:8 | -:8", unit=2)
verse.line(1, harp, "F3 C4 F4 A4 C5 A4 F4 C4 " * 4, unit=2)
verse.chords(2, strings, "F3 Bb2 F3 C3", rows=16)
verse.hits(3, kick, rows=[0, 32])
verse.hits(3, hat, rows=range(2, 64, 4), note=58)

song.order(verse, verse)
song.save("village.uge")
```

### Pitches

Write notes as they should sound: `C4` is middle C, with `#` for sharps and `b` for flats. The wave channel plays an octave below the pulse channels for the same tracker note, and `compose.py` corrects for that, so `D3` sounds as D3 on every channel.

### `line(channel, instrument, text, unit=1, start=0)`

A run of notes, one token each:

- `A5:3` plays A5 for 3 units. `unit` is rows per unit, so `unit=2` makes each unit an eighth note at 4 rows a beat.
- `-` or `r` rests, `-:4` rests for 4 units. A rest doesn't stop the note before it: tracker notes ring until the next note, a cut or the end of their envelope.
- `.` cuts the note that's playing.
- `|` is ignored, so bar lines can make lines readable.

A line that runs past row 64 raises an error, which catches miscounted bars.

### `chords(channel, instrument, text, rows=16, start=0)`

Held chords such as `D3 Em3 Bm2 F#m3`, one every `rows` rows. Qualities: none (major), `m`, `sus`, `sus2`, `5`, `dim`, `aug`, `7`, `maj7`, `m7`, `6`, `m6`, `add9`, `m9`. On the Game Boy a chord is a fast arpeggio. The 16-bit renderer plays it as a real held chord on strings, choir and organ.

### `hits(channel, instrument, rows, note=24)`

Drum hits. Noise notes work differently from pitched ones:

- **With a pitch table** (`table=` on the instrument), hit at 24 and let the table shape the sound, as in the kick above.
- **Without one**, hit at 32 to 63: about 40 to 46 for a kick, 48 to 54 for a snare, 56 to 63 for a hat.

Notes below 32 are almost silent and notes above 63 buzz. `references/uge_format.md` explains why.

### Instruments

| Method | Options |
|---|---|
| `duty(name, volume=12, pace=0, up=False, duty=2, table=None)` | `volume` 0 to 15. `pace` 0 holds the note; 1 to 7 fades it one step every pace/64 s. `duty` 0 to 3 is 12.5, 25, 50 or 75% pulse width. |
| `wave(name, level=1, wave=0, table=None)` | `level` 1 is full, 2 half, 3 quarter. `wave` picks one of 16 wave tables in `song.waves` (0 is a triangle). |
| `noise(name, volume=10, pace=2, up=False, short=False, table=None)` | `up` makes the envelope rise for swells. `short` is the metallic 7-bit noise. `table` holds per-tick notes as offsets: 36 means no change, 90 keeps the last one. |

Pick each instrument's name with care, because the 16-bit renderer chooses its sound from the name.

### Order and tempo

`song.order(a, b, a, c)` sets the play order; the song loops back to the start after the last pattern. `speed` is ticks per row:

| speed | BPM at 4 rows a beat |
|---|---|
| 6 | 150 |
| 8 | 112 |
| 10 | 90 |
| 12 | 75 |
| 15 | 60 |

Lower-level effects (portamento, vibrato, volume) go through `pattern.set(channel, row, note, instrument, effect, param)` with the codes in `references/uge_format.md`.

## Rendering

```bash
node render/cli.ts song.uge out.mp3 [--style snes|gb] [--once] [--echo 0-1] [--peak=<dB>] [--patch <channel>=<patch>]
```

With npm: `npm run render -- song.uge out.mp3`.

### `--style snes` (default)

The song keeps its notes, timing and volume envelopes, but each channel plays a sampled-sounding patch at the SNES's 32 kHz, with a shared echo. The output is resampled to 44.1 kHz, 128 kbps mp3.

| Patch | Picked by names containing | Sound |
|---|---|---|
| whistle | whistle, ocarina, bird, wind | A clean whistled sine with vibrato and a long echo. No breath, so it works for wind and birds. |
| flute | flute, recorder | Breathy lead with delayed vibrato. Default for channel 1. |
| strings | string, violin, viola, cello, pad | Three detuned saws, soft attack, held chords. Default for channel 2. |
| choir | choir, voice, vox, aah, ooh | Wordless "aah", formant filtered, held chords. |
| organ | organ | Drawbar organ, held chords. |
| piano | piano, rhodes, keys | Electric piano: FM bite and a tine ping, held chords for comping (try 7th chords). |
| marimba | marimba, kalimba, xylo, mallet, vibes | Wooden bar, short and warm. |
| harp | harp, pluck, guitar, lute, lyre | Plucked, decays on its own. |
| bell | bell, chime, glock, celesta | FM bell. |
| brass | brass, horn, trumpet, fanfare | Saw with an opening filter. |
| reed | reed, oboe, clarinet, bassoon | Narrow pulse, filtered. |
| bass | bass | The song's wave table, band limited. Default for channel 3. |
| chip | chip, square, pulse, 8bit | A clean pulse wave, for a deliberate chip lead. |
| drums | drum, kick, snare, hat, perc, noise, cymbal | Noise colored by pitch plus a body that follows the note down. Default for channel 4. |

`--patch 2=choir` forces a patch on a channel whatever the instrument is named. `--echo 0.5` halves the echo; `--echo 0` removes it.

### `--style gb`

Game Boy hardware: band-limited pulse waves, the 4-bit wave channel, the LFSR noise channel, the volume envelopes and length counters, sweep on channel 1, and the output's high-pass.

### Loops, intros and one-shots

By default the output is exactly one loop. The renderer plays the song twice and keeps the second pass, so the echo and releases from the end are already sounding at the start and the loop has no seam.

The loop is the stretch between the song's first repeated pattern and its return. If the order jumps back somewhere other than the start, the patterns before the loop point are an intro, and the loop render leaves them out (the renderer warns you).

`--once` plays the song through once and lets it ring for 3 seconds (`--tail 0.5` to change that), for jingles, stingers and sound effects. A pattern break (`pattern.set(ch, row, effect=13)`) ends a sound shorter than one pattern.

Every render is normalized so its peak sits at -1 dBFS. `--peak=-6` (or lower) makes a quieter file, which is handy for background music that sits under dialogue. Negative values need the `=` form.

### Checking a render without listening

Claude can't hear audio, so check a render with numbers before handing it over:

- `ffmpeg -i out.mp3 -af astats -f null -` should show no NaNs, little DC offset, and a peak near the `--peak` level.
- Render with one channel at a time to compare levels. The lead should sit a few dB above the harmony, the bed under that, and drums under everything in a gentle piece.
- For a loop, compare the jump between the last and first samples with the average step between samples. A click shows up as a jump many times larger.

Then give the file to a person to listen to.

## GB Studio

The upstream workflow still works: `scripts/uge_template.py` and `scripts/sav_template.py` write files GB Studio 4.x loads directly, and `scripts/audio_to_uge.py` converts recordings into a `.uge`. See SKILL.md and `references/`.

## Tests

```bash
npm install
npm test
```

## Credits

- **Author:** Sam Stockstrom ([sstockdev](https://github.com/sstockdev))
- **Co-author:** Claude (Anthropic)
- **Based on:** [kurum-inc/gb-music](https://github.com/kurum-inc/gb-music) by Kuniiskywalker, which wrote the GB Studio `.uge`/`.sav` generators and format references

## License

MIT. See LICENSE.
