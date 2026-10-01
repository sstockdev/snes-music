---
name: snes-music
description: |
  Write chiptune and retro game music as tracker songs, and render them to seamless looping mp3/wav as 16-bit
  (SNES-style) console music or as Game Boy hardware. Also writes Game Boy music (.uge, hUGETracker) and sound
  effects (.sav, FX Hammer) for GB Studio, and converts MP3/M4A/WAV recordings to .uge. Use whenever the user wants
  game music or sound effects: BGM, SFX, jingles, title/battle/village/dungeon themes, chiptune, 8-bit or 16-bit
  music, SNES music, Game Boy or GB Studio music, .uge or .sav files, or just "make me some game music".
license: MIT
compatibility: Python 3.8+ to write songs. Node 22.18+ and ffmpeg (for mp3) to render audio. librosa only for audio-to-UGE conversion.
metadata:
  author: Sam Stockstrom (sstockdev)
  co-author: Claude (Anthropic)
  based-on: kurum-inc/gb-music by Kuniiskywalker
---

# SNES Music

Write songs as notes, save them as hUGETracker `.uge` files, and render them as 16-bit or Game Boy audio. The same
`.uge` also loads straight into GB Studio 4.x. Paths below are relative to this skill's folder. README.md is the
full guide to `compose.py` and the renderer.

## Choose a workflow

| The user wants | Write | Then |
|---|---|---|
| Music to use as audio (any engine, a video, a demo) | a `.uge` with `scripts/compose.py` | render it with `render/cli.ts` |
| Music for a GB Studio project | a `.uge` with `scripts/compose.py` | give them the `.uge` (render an mp3 too, so they can preview it) |
| Sound effects for GB Studio | a `.sav` with `scripts/sav_template.py` | give them the `.sav` |
| An existing recording converted | a `.uge` with `scripts/audio_to_uge.py` | render or hand over as above |

## Writing a song

1. Settle the genre, mood, key, tempo and length. Ask only if the request gives nothing to go on.
2. Write a Python script that imports `Song` from `scripts/compose.py` (its docstring and `examples/title_theme.py`
   show the API). Write pitches as they should sound; `compose.py` handles the wave channel's octave offset.
3. Name instruments after the sound you want ("Flute", "Strings", "Choir", "Harp", "Piano", "Kick"...). The 16-bit
   renderer picks each channel's patch from the name; README.md lists the patches.
4. Run the script to get the `.uge`.

Drop to `scripts/uge_template.py` and `references/uge_format.md` only for things `compose.py` doesn't cover.

## Rendering

```bash
node render/cli.ts song.uge out.mp3                 # 16-bit, one seamless loop
node render/cli.ts song.uge out.mp3 --style gb      # Game Boy hardware
node render/cli.ts jingle.uge out.mp3 --once        # play once and ring out, for jingles and stingers
```

Other options: `--peak=-6` for a quieter file, `--echo 0-1`, `--patch 2=choir`, `--tail <seconds>` with `--once`.

## Check the result

You cannot hear the audio. Before handing it over, check it with numbers:

- `ffmpeg -i out.mp3 -af astats -f null -`: no NaNs, little DC offset, peak near the `--peak` level.
- Render each channel alone (save a copy of the song with only that channel written) to compare levels: lead a few
  dB above the harmony, drums under everything in a gentle piece.
- For a loop, compare the jump between the last and first samples with the average step. A click is many times larger.
- `npm test` runs the renderer's tests.

Then give the user the file and say it needs a listen.

## Channels

- **Ch1 (pulse):** lead melody
- **Ch2 (pulse):** harmony, arpeggios, counter melody, held chords
- **Ch3 (wave):** bass or a low pad
- **Ch4 (noise):** drums

Tempo is `speed` in ticks per row (about 60 ticks a second): 6 is 150 BPM at 4 rows a beat, 8 is 112, 10 is 90,
12 is 75, 15 is 60.

## Pitfalls

- **Noise drums must end up at note 32-63.** 0-31 is nearly silent on hardware and 64+ buzzes. Hit at 32-63 without
  a pitch table, or at 24 with one (`compose.py`), and let the table shape the sound.
- **Subpattern (pitch table) notes are relative offsets: 36 means no change.** Raising the pattern note instead makes
  drums buzz. See `references/uge_format.md`.
- **Wave output level is the NR32 code: 1 = 100%, 2 = 50%, 3 = 25%.** 3 is the quietest, not the loudest.
- In raw cells, instrument numbers are 1-based (0 = none) and note 90 is a rest.
- GB Studio BGM always loops. For one-shot sounds in GB Studio, use a `.sav` or stop the music with an event.

## Sound effects (.sav)

FX Hammer banks hold up to 60 effects, played with GB Studio's "Play Sound Effect" event. They use only Ch2 (pulse)
and Ch4 (noise), leaving Ch1 and Ch3 to the music. Read `references/sav_format.md`, then adapt
`scripts/sav_template.py`.

| Sound | Approach |
|---|---|
| Hit/Impact | High volume, fast decay, both channels |
| Jump | Rising pitch sweep (Ch2 only) |
| Coin/Collect | Two quick high notes |
| Explosion/Crash | Full-volume noise, slow decay |
| Rolling | Falling pitch plus continuous noise |
| Chime/Correct | Two tones, low then high, sustained |
| Cursor/UI | One short blip |

## Converting a recording

`scripts/audio_to_uge.py` needs librosa (`pip install librosa`, in a virtual environment if the system Python is
managed). It detects tempo, key and chords, extracts a melody (HPSS then pyin), maps MIDI to tracker notes
(`uge_note = midi_note - 48`), snaps to the key and writes melody on Ch1, chords on Ch2, bass on Ch3 and drums on Ch4.

Melody extraction from a full mix is often noisy. When pyin returns mostly nothing or a flat line, write a melody by
hand over the detected chords and key instead.
