import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { extname } from "node:path";
import { parseArgs } from "node:util";
import { render, wav, type Style } from "./render.ts";
import { PATCHES, type PatchName } from "./snes.ts";
import { parseUge } from "./uge.ts";

const HELP = `Usage: node render/cli.ts <song.uge> <out.mp3|out.wav> [options]   (npm run render -- ..., or npm run music -- ... in Verse & Void)

Renders a hUGETracker song (the snes-music skill's .uge files) to a looping mp3 or wav. mp3 needs ffmpeg.

Options:
  --style snes|gb     snes (default): 16-bit voicing with patches and echo. gb: Game Boy hardware sound.
  --once              Play through once with a tail, for jingles. By default the output is one seamless loop.
  --echo <0-1>        Echo amount for --style snes (default 1).
  --peak=<dB>         Peak level in dBFS (default -1), e.g. --peak=-6 for a quieter track.
  --patch <ch>=<name> Force a patch on channel 1-4, e.g. --patch 2=choir. Repeatable.
                      Patches: ${PATCHES.join(", ")}.
                      Without it, the instrument name picks one ("Choir", "Harp", "Strings"...).`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    style: { type: "string", default: "snes" },
    once: { type: "boolean", default: false },
    echo: { type: "string" },
    peak: { type: "string" },
    patch: { type: "string", multiple: true },
    help: { type: "boolean", short: "h" },
  },
});

const [input, output] = positionals;
if (values.help || !input || !output) {
  console.log(HELP);
  process.exit(values.help ? 0 : 1);
}
if (values.style !== "snes" && values.style !== "gb") throw new Error(`Unknown style "${values.style}"`);

const patches: (PatchName | null)[] = [null, null, null, null];
for (const p of values.patch ?? []) {
  const [ch, name] = p.split("=");
  const i = Number(ch) - 1;
  if (!(i >= 0 && i < 4) || !PATCHES.includes(name as PatchName)) throw new Error(`Bad --patch "${p}"`);
  patches[i] = name as PatchName;
}

const song = parseUge(readFileSync(input));
const started = Date.now();
const out = render(song, {
  style: values.style as Style,
  once: values.once,
  echo: values.echo === undefined ? undefined : Number(values.echo),
  peak: values.peak === undefined ? undefined : Number(values.peak),
  patches,
});
const data = wav(out);
if (extname(output).toLowerCase() === ".wav") {
  writeFileSync(output, data);
} else {
  const ff = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", "pipe:0", "-ar", "44100", "-c:a", "libmp3lame", "-b:a", "128k", output], {
    input: data,
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (ff.error || ff.status !== 0) throw new Error(`ffmpeg failed${ff.error ? `: ${ff.error.message}` : ""}`);
}
const seconds = out.left.length / out.sampleRate;
console.log(`${output}: ${seconds.toFixed(1)} s ${values.once ? "one-shot" : "loop"} (${values.style}), rendered in ${((Date.now() - started) / 1000).toFixed(1)} s`);
if (out.intro > 0) console.warn(`Note: the song's loop starts ${out.intro.toFixed(1)} s in; the intro before it is left out of the loop.`);
