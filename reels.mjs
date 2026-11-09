// One Poster Studio video, recorded by many GitHub Actions machines at once.
// The video is a timeline of designs; it is cut into equal slices of frames, one per machine, and each machine
// cuts its slice in two and records both halves side by side. A piece that starts partway into a design runs the
// page clock there first (see record.mjs), so the pieces join with `-c copy` into a seamless MP4.
//
//   node reels.mjs plan  <spec.json>              prints the pieces (for checking)
//   node reels.mjs work  <spec.json> <k> <out>    machine k records its pieces into <out>/part-NNNN.mp4
//   node reels.mjs join  <parts dir> <out.mp4>    joins every part-*.mp4 in order
//
// spec: { items: [{ scene: 1..12 | 'outro', secs }], size: 'post' | 'reel', qr, motion, origin }
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { recordReel, SIZES } from './record.mjs';

export const MACHINES = 20; // the free plan runs 20 jobs at once
const SPLIT = 2; // pieces recorded side by side on one machine
const FPS = 30;
const MIN_SLICE = 4 * FPS; // a machine's share is never under 4 s; short videos use fewer machines

export function plan(spec) {
  const size = SIZES[spec.size === 'post' ? 'post' : 'reel'];
  const origin = (spec.origin || 'https://parliament-widget.vercel.app').replace(/\/$/, '');
  const extra = (spec.qr ? '&qr=1' : '') + (spec.motion === false ? '&motion=0' : '');
  let at = 0;
  const designs = spec.items.map((it) => {
    const frames = Math.round(it.secs * FPS);
    const d = { start: at, frames, bgOffsetMs: (at / FPS) * 1000, url: `${origin}/tv?scene=${it.scene}&format=${size.w}x${size.h}&reel=1${extra}&dur=${Math.max(8, Math.round(it.secs))}` };
    at += frames;
    return d;
  });
  const total = at;
  const machines = Math.max(1, Math.min(MACHINES, Math.floor(total / MIN_SLICE)));
  const slices = machines * SPLIT;
  const pieces = [];
  for (let s = 0; s < slices; s += 1) {
    const a = Math.round((s * total) / slices), b = Math.round(((s + 1) * total) / slices);
    designs.forEach((d) => {
      const from = Math.max(a, d.start), to = Math.min(b, d.start + d.frames);
      if (to > from) pieces.push({ machine: Math.floor(s / SPLIT), url: d.url, from: (from - d.start) / FPS, secs: (to - from) / FPS, bgOffsetMs: d.bgOffsetMs });
    });
  }
  pieces.forEach((p, i) => { p.index = i; });
  return { size, machines, totalSecs: total / FPS, pieces };
}

async function work(spec, k, out) {
  const { size, pieces } = plan(spec);
  const mine = pieces.filter((p) => p.machine === k);
  await mkdir(out, { recursive: true });
  const t = Date.now();
  // Side by side, at most SPLIT at a time.
  const queue = mine.slice();
  await Promise.all(Array.from({ length: SPLIT }, async () => {
    for (let p = queue.shift(); p; p = queue.shift()) {
      for (let attempt = 1; ; attempt += 1) {
        try {
          const mp4 = await recordReel({ url: p.url, secs: p.secs, from: p.from, fps: FPS, size, bgOffsetMs: p.bgOffsetMs });
          await writeFile(join(out, `part-${String(p.index).padStart(4, '0')}.mp4`), mp4);
          console.log(`piece ${p.index}: ${p.secs.toFixed(2)} s from ${p.from.toFixed(2)} s in ${((Date.now() - t) / 1000).toFixed(1)} s`);
          break;
        } catch (e) {
          console.error(`piece ${p.index} attempt ${attempt}: ${e.message}`);
          if (attempt >= 3) throw e;
        }
      }
    }
  }));
  console.log(`machine ${k}: ${mine.length} pieces in ${((Date.now() - t) / 1000).toFixed(1)} s`);
}

async function joinParts(dir, out) {
  const parts = (await readdir(dir, { recursive: true })).filter((f) => /part-\d+\.mp4$/.test(f))
    .sort((a, b) => Number(a.match(/part-(\d+)/)[1]) - Number(b.match(/part-(\d+)/)[1]));
  if (!parts.length) throw new Error('no parts');
  const list = join(dir, 'list.txt');
  await writeFile(list, parts.map((f) => `file '${join(dir, f).replaceAll('\\', '/')}'`).join('\n'));
  await new Promise((ok, fail) => {
    const p = spawn(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', '-y', out], { stdio: 'inherit' });
    p.on('close', (code) => (code === 0 ? ok() : fail(new Error('ffmpeg concat failed'))));
  });
  console.log(`joined ${parts.length} parts into ${out}`);
}

if (process.argv[1] && process.argv[1].endsWith('reels.mjs')) {
  const [cmd, a, b, c] = process.argv.slice(2);
  const spec = () => readFile(a, 'utf8').then(JSON.parse);
  if (cmd === 'plan') console.log(JSON.stringify(plan(await spec()), null, 1));
  else if (cmd === 'work') await work(await spec(), Number(b), c);
  else if (cmd === 'join') await joinParts(a, b);
  else { console.error('usage: plan|work|join'); process.exit(1); }
}
