// Records one TV design as an upright MP4 (a 1080x1920 reel or a 1080x1350 feed post), frame by frame.
// Headless Chrome plays the page on virtual time: the clock only moves when we say so, so every frame is
// exactly 1/fps apart however long a screenshot takes, and the animation comes out smooth. ffmpeg encodes.
// Copied from parliament-widget/lib/reel.mjs, plus `from` (start a piece partway into a design) for the GitHub Actions fan-out.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((p) => p && existsSync(p));
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

// GitHub's machines have no GPU, and there the background's three blurred light pools (#ocean, blur(90px)) cost about
// three quarters of every frame. While recording, each pool is blurred once into an image with the same Gaussian blur
// and then drifts as that image, so it looks the same but is cheap to draw. The TV page itself is unchanged.
const CHEAP_BLUR = `(function () {
  function swap(o) {
    if (o.__cheap) return; o.__cheap = 1;
    var css = '';
    Array.prototype.forEach.call(o.children, function (el, i) {
      var cs = getComputedStyle(el), w = parseFloat(cs.width), h = parseFloat(cs.height), R = 90, P = R * 3;
      var c = document.createElement('canvas'); c.width = Math.ceil(w + 2 * P); c.height = Math.ceil(h + 2 * P);
      var g = c.getContext('2d'); g.filter = 'blur(' + R + 'px)'; g.fillStyle = cs.backgroundColor;
      g.beginPath(); g.ellipse(P + w / 2, P + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2); g.fill();
      css += '#ocean i:nth-child(' + (i + 1) + '){filter:none!important;border-radius:0!important;box-sizing:content-box!important;padding:' + P + 'px!important;margin:-' + P + 'px!important;background:url(' + c.toDataURL() + ') center/100% 100% no-repeat!important}';
    });
    var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
  }
  new MutationObserver(function () { var o = document.getElementById('ocean'); if (o && o.children.length) swap(o); })
    .observe(document, { childList: true, subtree: true });
})();`;

export const SIZES = { reel: { w: 1080, h: 1920 }, post: { w: 1080, h: 1350 } };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A minimal DevTools protocol client over the browser's WebSocket (Node's built-in WebSocket).
function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const waiting = new Map();
  const listeners = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && waiting.has(msg.id)) {
      const { ok, fail } = waiting.get(msg.id);
      waiting.delete(msg.id);
      if (msg.error) fail(new Error(msg.error.message)); else ok(msg.result);
    } else if (msg.method) {
      listeners.slice().forEach((l) => l(msg));
    }
  };
  const open = new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = () => fail(new Error('DevTools connection failed')); });
  return {
    open,
    send(method, params = {}, sessionId) {
      const n = ++id;
      ws.send(JSON.stringify({ id: n, method, params, sessionId }));
      // Nothing may wait forever: a call Chrome never answers fails, and the piece is recorded again.
      return new Promise((ok, fail) => {
        const t = setTimeout(() => { waiting.delete(n); fail(new Error(method + ' timed out')); }, 90000);
        waiting.set(n, { ok: (v) => { clearTimeout(t); ok(v); }, fail: (e) => { clearTimeout(t); fail(e); } });
      });
    },
    once(method, sessionId, timeoutMs = 30000) {
      return new Promise((ok, fail) => {
        const off = () => { const i = listeners.indexOf(l); if (i >= 0) listeners.splice(i, 1); };
        const t = setTimeout(() => { off(); fail(new Error(method + ' timed out')); }, timeoutMs);
        const l = (msg) => { if (msg.method === method && msg.sessionId === sessionId) { clearTimeout(t); off(); ok(msg.params); } };
        listeners.push(l);
      });
    },
    close() { try { ws.close(); } catch {} },
  };
}

async function devtoolsUrl(profile, chrome) {
  const file = join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 150; i += 1) {
    if (chrome.exitCode !== null) throw new Error('Chrome exited early');
    try {
      const [port, path] = (await readFile(file, 'utf8')).trim().split('\n');
      if (port && path) return `ws://127.0.0.1:${port}${path}`;
    } catch {}
    await sleep(100);
  }
  throw new Error('Chrome did not start');
}

function encoder(fps, file) {
  const proc = spawn(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '22', '-tune', 'animation', '-pix_fmt', 'yuv420p', '-r', String(fps),
    '-movflags', '+faststart', '-y', file,
  ], { stdio: ['pipe', 'ignore', 'pipe'] });
  let err = '';
  proc.stdin.on('error', () => {}); // a failed encoder is reported by `done`
  proc.stderr.on('data', (c) => { err += c; });
  const done = new Promise((ok, fail) => {
    proc.on('error', () => fail(new Error('ffmpeg not found (install it or set FFMPEG_PATH)')));
    proc.on('close', (code) => (code === 0 ? ok(readFile(file)) : fail(new Error('ffmpeg failed: ' + err.trim().slice(-300)))));
  });
  done.catch(() => {}); // awaited through finish(); a recording that fails first reports its own error
  return {
    proc,
    write: (buf) => new Promise((ok) => (proc.stdin.write(buf) ? ok() : proc.stdin.once('drain', ok))),
    finish: () => { proc.stdin.end(); return done; },
  };
}

/**
 * Renders `url` (a /tv page) at `size` (1080x1920 or 1080x1350) for `secs` seconds from the moment its design comes on, at `fps`,
 * and resolves with the MP4 as a Buffer. onProgress(0..1) follows the captured frames.
 */
export async function recordReel({ url, secs = 15, from = 0, fps = 30, size = SIZES.reel, bgOffsetMs = 0, onProgress = () => {} }) {
  const REEL = size;
  if (!CHROME) throw new Error('Google Chrome not found (set CHROME_PATH)');
  const T0 = Date.now(), lap = {}; const mark = (k) => { lap[k] = ((Date.now() - T0) / 1000).toFixed(1); };
  const profile = await mkdtemp(join(tmpdir(), 'reel-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    `--window-size=${REEL.w},${REEL.h}`, '--hide-scrollbars', '--mute-audio', '--force-device-scale-factor=1',
    '--no-first-run', '--no-default-browser-check', ...(process.env.CI ? ['--no-sandbox', '--disable-dev-shm-usage'] : []), ...(process.env.REEL_NO_GPU ? ['--disable-gpu'] : []), 'about:blank',
  ], { stdio: 'ignore' });
  let client = null;
  let enc = null;
  try {
    client = cdp(await devtoolsUrl(profile, chrome));
    await client.open;
    const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
    const send = (m, p) => client.send(m, p, sessionId);
    await send('Page.enable');
    if (process.env.REEL_GPU_BLUR !== '1') await send('Page.addScriptToEvaluateOnNewDocument', { source: CHEAP_BLUR });
    await send('Emulation.setDeviceMetricsOverride', { width: REEL.w, height: REEL.h, deviceScaleFactor: 1, mobile: false });
    // Moves the page's clock on by `ms`; a pending fetch (data, photos, fonts) holds the clock until it lands.
    const advance = async (ms) => {
      const expired = client.once('Emulation.virtualTimeBudgetExpired', sessionId, 120000);
      await send('Emulation.setVirtualTimePolicy', { policy: 'pauseIfNetworkFetchesPending', budget: ms });
      await expired;
    };
    await send('Emulation.setVirtualTimePolicy', { policy: 'pause' });
    const nav = await send('Page.navigate', { url });
    if (nav.errorText) throw new Error('Could not open ' + url + ' (' + nav.errorText + ')');
    const on = async () => (await send('Runtime.evaluate', {
      expression: "!!document.querySelector('.scene.on:not(.wait):not(.s-slate)')", returnByValue: true,
    })).result.value;
    // Until the design comes on (data loaded, photos kept), the clock runs in small steps and nothing is recorded.
    for (let waited = 0; !(await on()); waited += 50) {
      if (waited > 40000) throw new Error('The design did not come on (no data for it right now?)');
      await advance(50);
    }
    mark('on');
    enc = encoder(fps, join(profile, 'reel.mp4'));
    const frames = Math.round(secs * fps);
    const step = 1000 / fps;
    // CSS animations and transitions run on Chrome's own clock, not the virtual one, so just before each frame every
    // animation is set to where the virtual clock says it should be and slowed to 1/1000 speed. (At full speed, a slow
    // machine lets them run ahead between frames, and anything chained to their end starts early.) Everything on the page at the first frame
    // starts from its beginning there, so the reel opens with the design's full entrance; an animation that
    // appears later is taken to have started at the previous frame. The moving background (#ocean, #iso) starts
    // bgOffsetMs in instead, so when several designs are joined it carries on across the cut without a jump.
    const sync = () => send('Runtime.evaluate', { expression: `(function () {
      var now = performance.now();
      document.getAnimations().forEach(function (a) {
        if (a.__v0 === undefined) { var t = a.effect && a.effect.target; a.__v0 = now - (t && t.closest && t.closest('#ocean, #iso') ? ${bgOffsetMs} : 0); }
        // Barely running (1/1000 speed): still running, so Chrome keeps drawing frames, but a slow machine can no
        // longer let it run ahead between frames.
        try { if (a.playbackRate !== 0.001) a.playbackRate = 0.001; a.currentTime = now - a.__v0; } catch (e) {}
      });
    })()` });
    // A piece that starts `from` seconds into the design first runs the clock there frame by frame, exactly as a
    // recording would, but without screenshots (about a tenth of the cost), so pieces join without a seam.
    for (let i = 0, skip = Math.round(from * fps); i < skip; i += 1) {
      await sync();
      await advance(step);
    }
    mark('ff');
    for (let i = 0; i < frames; i += 1) {
      await sync();
      const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 94, optimizeForSpeed: true });
      await enc.write(Buffer.from(shot.data, 'base64'));
      onProgress((i + 1) / frames);
      await advance(step);
    }
    mark('shot');
    const out = await enc.finish();
    mark('enc');
    if (process.env.REEL_TIMING) console.error('timing (s since start):', JSON.stringify(lap), 'from', from, 'secs', secs);
    return out;
  } catch (e) {
    if (enc) { try { enc.proc.kill(); } catch {} }
    throw e;
  } finally {
    if (client) client.close();
    try { chrome.kill(); } catch {}
    await sleep(300);
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}

