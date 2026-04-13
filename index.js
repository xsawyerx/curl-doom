// cURL DOOM server, spawns one headless doom process per session,
// pipes commands in, reads framebuffers out, and serves ANSI frames.

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');

const app = express();

const PORT = process.env.PORT || 3000;
const DOOM_BIN = path.join(__dirname, 'doomgeneric', 'doomgeneric_server');
const WAD = path.join(__dirname, 'doom1.wad');

// doomgeneric renders at 640×400 RGBA (little-endian 0xAARRGGBB, so the
// byte layout on disk is B, G, R, A).
const DOOM_W = 640;
const DOOM_H = 400;
const FRAME_SIZE = DOOM_W * DOOM_H * 4;

// Idle sessions are reaped after this many ms of no /tick activity.
const IDLE_TIMEOUT_MS = 60 * 1000;
const REAP_INTERVAL_MS = 10 * 1000;

// Default ANSI viewport. Each terminal row is two stacked pixels (▀ trick),
// so the effective pixel grid is cols × rows*2.
const DEFAULT_COLS = 100;
const DEFAULT_ROWS = 40;

// Tics to run per user action. Doom reads input during game tics, so we
// hold the key for a few tics and then release it.
const TICS_KEYDOWN = 4;
const TICS_KEYUP = 1;
// Tics to run per "idle" poll request (no key pressed).
const TICS_IDLE = 2;

// doom key codes (from doomkeys.h)

const K = {
  LEFT: 0xac,
  UP: 0xad,
  RIGHT: 0xae,
  DOWN: 0xaf,
  STRAFE_L: 0xa0,
  STRAFE_R: 0xa1,
  USE: 0xa2,
  FIRE: 0xa3,
  ESCAPE: 27,
  ENTER: 13,
  TAB: 9,
  BACKSPACE: 0x7f,
  RSHIFT: 0x80 + 0x36,
  Y: 'y'.charCodeAt(0),
  N: 'n'.charCodeAt(0),
};

// Map client keystrokes (the bytes doom.sh sends) to a doom keycode.
// null means "tick without pushing a key".
const KEYMAP = {
  w: K.UP, W: K.UP,
  s: K.DOWN, S: K.DOWN,
  a: K.LEFT, A: K.LEFT,
  d: K.RIGHT, D: K.RIGHT,
  ',': K.STRAFE_L, '.': K.STRAFE_R,
  f: K.FIRE, F: K.FIRE,
  ' ': K.USE,
  e: K.USE, E: K.USE,
  enter: K.ENTER, '\n': K.ENTER, '\r': K.ENTER,
  escape: K.ESCAPE, esc: K.ESCAPE,
  tab: K.TAB, '\t': K.TAB,
  shift: K.RSHIFT,
  y: K.Y, Y: K.Y,
  n: K.N, N: K.N,
  '': null,
};

// play script (served by GET /)
//
// The bash wrapper lives in `play.sh` next to this file. We load it once at
// startup, with `__SERVER__` as a placeholder, then substitute the request's
// own host on each GET / so the script keeps talking back to wherever it was
// downloaded from.

const fs = require('fs');
const PLAY_SCRIPT_TEMPLATE = fs.readFileSync(
  path.join(__dirname, 'play.sh'),
  'utf8'
);

// sessions

/**
 * Session shape:
 *   id           string
 *   proc         ChildProcess
 *   frameStream  Readable (fd 3)
 *   frameBuf     Buffer (accumulates partial frame reads)
 *   pending      Array<{resolve, reject}> (awaiting the next full frame)
 *   busy         Promise | null (serialises /tick requests on this session)
 *   lastActive   number (ms since epoch)
 *   dead         boolean
 */
const sessions = new Map();

function spawnDoom() {
  // stdio: [0]=stdin pipe, [1]=inherit (unused, the child dup2s stderr
  // onto fd 1 anyway), [2]=stderr pipe, [3]=frame pipe.
  // -warp 1 1 -skill 3 jumps straight into E1M1 on "Hurt me plenty",
  // skipping the title screen and menu dance.
  const proc = spawn(DOOM_BIN, ['-iwad', WAD, '-warp', '1', '1', '-skill', '3'], {
    stdio: ['pipe', 'inherit', 'pipe', 'pipe'],
    cwd: __dirname,
  });
  // Drain stderr so the pipe doesn't fill and block doom.
  proc.stderr.on('data', () => {});
  return proc;
}

function createSession() {
  const id = crypto.randomBytes(8).toString('hex');
  const proc = spawnDoom();

  const session = {
    id,
    proc,
    frameStream: proc.stdio[3],
    frameBuf: Buffer.alloc(0),
    pending: [],
    busy: null,
    lastActive: Date.now(),
    dead: false,
  };

  session.frameStream.on('data', chunk => {
    session.frameBuf = Buffer.concat([session.frameBuf, chunk]);
    while (session.frameBuf.length >= FRAME_SIZE && session.pending.length) {
      const frame = session.frameBuf.subarray(0, FRAME_SIZE);
      session.frameBuf = session.frameBuf.subarray(FRAME_SIZE);
      const waiter = session.pending.shift();
      // Copy so subsequent reads into the shared buffer can't race.
      waiter.resolve(Buffer.from(frame));
    }
  });

  const markDead = (reason) => {
    if (session.dead) return;
    session.dead = true;
    for (const w of session.pending) w.reject(new Error(reason));
    session.pending.length = 0;
    sessions.delete(id);
  };

  proc.on('exit', code => markDead(`doom exited (code ${code})`));
  proc.on('error', err => markDead(`doom spawn error: ${err.message}`));
  session.frameStream.on('error', err => markDead(`frame stream: ${err.message}`));

  sessions.set(id, session);
  return session;
}

function destroySession(session, reason = 'reaped') {
  if (session.dead) return;
  session.dead = true;
  try { session.proc.stdin.write('Q\n'); } catch {}
  try { session.proc.kill('SIGTERM'); } catch {}
  // Fallback hard-kill if the process ignores SIGTERM.
  setTimeout(() => {
    try { session.proc.kill('SIGKILL'); } catch {}
  }, 1000).unref();
  for (const w of session.pending) w.reject(new Error(reason));
  session.pending.length = 0;
  sessions.delete(session.id);
}

// Reap idle sessions.
setInterval(() => {
  const cutoff = Date.now() - IDLE_TIMEOUT_MS;
  for (const s of sessions.values()) {
    if (s.lastActive < cutoff) destroySession(s, 'idle timeout');
  }
}, REAP_INTERVAL_MS).unref();

// Kill all doom children if the Node server itself dies.
function killAll() {
  for (const s of [...sessions.values()]) destroySession(s, 'server shutdown');
}
process.on('exit', killAll);
process.on('SIGINT', () => { killAll(); process.exit(0); });
process.on('SIGTERM', () => { killAll(); process.exit(0); });

// per-session command pipeline

function writeCmd(session, line) {
  if (session.dead) throw new Error('session dead');
  session.proc.stdin.write(line + '\n');
}

function requestFrame(session) {
  return new Promise((resolve, reject) => {
    if (session.dead) return reject(new Error('session dead'));
    session.pending.push({ resolve, reject });
    writeCmd(session, 'F');
  });
}

// Run one "key press" cycle end-to-end and return the resulting frame.
// Serialised per-session via `busy` so concurrent /tick requests queue up
// instead of interleaving commands on the same pipe.
async function step(session, doomKey) {
  // Wait for the previous step on this session to finish. We grab the
  // current busy promise before awaiting so we only wait one cycle.
  // Otherwise a settled promise would leave us spinning forever.
  while (session.busy) {
    const prev = session.busy;
    try { await prev; } catch {}
    if (session.busy === prev) session.busy = null;
  }

  const work = (async () => {
    session.lastActive = Date.now();
    if (doomKey != null) {
      writeCmd(session, `K 1 ${doomKey}`);
      writeCmd(session, `T ${TICS_KEYDOWN}`);
      writeCmd(session, `K 0 ${doomKey}`);
      writeCmd(session, `T ${TICS_KEYUP}`);
    } else {
      writeCmd(session, `T ${TICS_IDLE}`);
    }
    return requestFrame(session);
  })();
  session.busy = work;
  try {
    return await work;
  } finally {
    if (session.busy === work) session.busy = null;
  }
}

// framebuffer to ANSI

const RESET = '\x1b[0m';
const CLEAR = '\x1b[2J\x1b[H';
const HOME = '\x1b[H';
const HIDE_CURSOR = '\x1b[?25l';

function clamp(n) { return n < 0 ? 0 : n > 255 ? 255 : n | 0; }

// Sample one pixel from the doom framebuffer at (sx, sy). The buffer is
// little-endian uint32 0xAARRGGBB, so on disk the bytes are B, G, R, A.
function samplePixel(fb, sx, sy) {
  const i = (sy * DOOM_W + sx) * 4;
  return [fb[i + 2], fb[i + 1], fb[i]]; // R, G, B
}

function frameToAnsi(fb, cols, rows) {
  // Two stacked pixels per character row using '▀' (upper half block):
  // foreground = top pixel, background = bottom pixel, doubling vertical
  // resolution for free.
  //
  // We start each frame with cursor-home (`\x1b[H`), NOT clear-screen
  // (`\x1b[2J`). On slow terminals the difference is night and day: with
  // 2J, if the terminal hasn't finished rendering frame N before frame
  // N+1's clear arrives, the user sees a blank/half-blank screen. With
  // home-only, the new frame overwrites in place, so the worst-case
  // glitch is a frame that's "torn" (top from N+1, bottom from N), far
  // more readable than blanking. Callers that need to actually clear the
  // screen (e.g. the very first frame of a session) prepend CLEAR
  // themselves.
  const pxH = rows * 2;
  const xScale = DOOM_W / cols;
  const yScale = DOOM_H / pxH;

  let out = HOME + HIDE_CURSOR;
  let prevTop = null, prevBot = null;

  for (let row = 0; row < rows; row++) {
    const syTop = Math.min(DOOM_H - 1, ((row * 2) * yScale) | 0);
    const syBot = Math.min(DOOM_H - 1, ((row * 2 + 1) * yScale) | 0);
    for (let col = 0; col < cols; col++) {
      const sx = Math.min(DOOM_W - 1, (col * xScale) | 0);
      const [tr, tg, tb] = samplePixel(fb, sx, syTop);
      const [br, bg, bb] = samplePixel(fb, sx, syBot);

      // Emit SGR only when color changes, shrinks the response ~5×.
      if (prevTop === null || tr !== prevTop[0] || tg !== prevTop[1] || tb !== prevTop[2]) {
        out += `\x1b[38;2;${clamp(tr)};${clamp(tg)};${clamp(tb)}m`;
        prevTop = [tr, tg, tb];
      }
      if (prevBot === null || br !== prevBot[0] || bg !== prevBot[1] || bb !== prevBot[2]) {
        out += `\x1b[48;2;${clamp(br)};${clamp(bg)};${clamp(bb)}m`;
        prevBot = [br, bg, bb];
      }
      out += '\u2580'; // ▀
    }
    out += RESET + '\n';
    prevTop = prevBot = null;
  }
  return out;
}

// HTTP

// Upper bounds match doom's native resolution under the half-block glyph
// (cols × rows*2 pixels). Beyond 320×200 we'd just be upscaling, which
// adds bytes without adding detail.
const MAX_COLS = 320;
const MAX_ROWS = 100;

function parseDims(req) {
  const cols = Math.max(20, Math.min(MAX_COLS, parseInt(req.query.cols, 10) || DEFAULT_COLS));
  const rows = Math.max(10, Math.min(MAX_ROWS, parseInt(req.query.rows, 10) || DEFAULT_ROWS));
  return { cols, rows };
}

// POST /new to create session, return session id + first frame.
app.post('/new', async (req, res) => {
  let session;
  try {
    session = createSession();
    const { cols, rows } = parseDims(req);
    // The C side runs 35 warm-up tics inside main() before accepting
    // commands, so the first framebuffer already contains a real frame.
    const fb = await requestFrame(session);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('X-Session', session.id);
    // First frame clears the screen; subsequent /tick frames just home.
    res.send(CLEAR + frameToAnsi(fb, cols, rows));
  } catch (err) {
    if (session) destroySession(session, 'new failed');
    res.status(500).send(`Failed to start doom: ${err.message}\n`);
  }
});

// POST /tick?s=SESSION&key=KEY to advance game, return ANSI frame.
app.post('/tick', async (req, res) => {
  const id = req.query.s;
  const session = id && sessions.get(id);
  if (!session) {
    res.status(400).send('Unknown session. POST /new to start.\n');
    return;
  }
  const rawKey = req.query.key || '';
  if (!(rawKey in KEYMAP)) {
    res.status(400).send(`Unknown key: ${JSON.stringify(rawKey)}\n`);
    return;
  }
  try {
    const { cols, rows } = parseDims(req);
    const fb = await step(session, KEYMAP[rawKey]);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(frameToAnsi(fb, cols, rows));
  } catch (err) {
    res.status(500).send(`Tick failed: ${err.message}\n`);
  }
});

// POST /quit?s=SESSION to explicit cleanup (doom.sh sends this on exit).
app.post('/quit', (req, res) => {
  const id = req.query.s;
  const session = id && sessions.get(id);
  if (session) destroySession(session, 'quit');
  res.send('bye\n');
});

app.get('/health', (req, res) => {
  res.json({ sessions: sessions.size });
});

// GET / to have content-negotiated landing page.
//
//   curl: returns play.sh, with __SERVER__ rewritten to whichever host
//      it's fetched it from. Pipe straight to bash:
//      curl -sL doom.example.com | bash
//   browser: tiny HTML page that shows the same one-liner.
app.get('/', (req, res) => {
  const ua = (req.headers['user-agent'] || '').toLowerCase();
  const isCli = /^(curl|wget|fetch|httpie|powershell|libfetch)/.test(ua);

  // Reconstruct the URL the client used to reach us so the served script
  // talks back to the right host (works behind proxies via X-Forwarded-*).
  const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim()
    || (req.socket.encrypted ? 'https' : 'http');
  const host = (req.headers['x-forwarded-host'] || '').split(',')[0].trim()
    || req.headers.host
    || `localhost:${PORT}`;
  const serverUrl = `${proto}://${host}`;

  if (isCli) {
    const script = PLAY_SCRIPT_TEMPLATE.replace(/__SERVER__/g, serverUrl);
    res.setHeader('Content-Type', 'text/x-shellscript; charset=utf-8');
    res.send(script);
    return;
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html>
<html><head><meta charset="utf-8"><title>cURL DOOM</title>
<style>
  body { background:#0a0a0a; color:#e0e0e0; font-family: ui-monospace, Menlo, monospace;
         max-width: 50em; margin: 4em auto; padding: 0 1em; line-height: 1.5; }
  h1 { color: #ff4040; letter-spacing: 0.05em; }
  pre { background:#1a1a1a; color:#e0e0e0; padding:1em; border-radius:6px;
        overflow-x:auto; border-left: 3px solid #ff4040; }
  code { background:#1a1a1a; padding:.1em .35em; border-radius:3px; }
  a { color:#9ed; }
  small { color:#888; }
</style></head><body>
<h1>cURL DOOM</h1>
<p>DOOM, played over <code>curl</code>.</p>
<pre>curl -sL ${serverUrl} | bash</pre>
<p>That's it. Pipe straight to bash, get a working keyboard, and shoot some imps.</p>
<p>Or, if you want to do it the hard way (no shell wrapper, just a single
streaming HTTP request):</p>
<pre>
stty -echo -icanon min 1 time 0 &amp;&amp; curl -sN -X POST -T - localhost:3000/play
</pre>
<p><small>Source: <a href="https://github.com/xsawyerx/curl-doom">github/xsawyerx/curl-doom</a> &middot; this server: <code>${serverUrl}</code></small></p>
</body></html>`);
});

// POST /play for bidirectional streaming. Read keystrokes from the request
// body, stream ANSI frames out as the response body. The pure-curl path:
//
//   curl -sN -X POST -T - "$SERVER/play?cols=200&rows=60" < /dev/tty
//
// Doom runs at ~35Hz on its own (no client poll loop). Keys are released
// 150ms after the last byte for that key, so holding W moves you smoothly.
app.post('/play', async (req, res) => {
  const { cols, rows } = parseDims(req);
  let session;
  try {
    session = createSession();
  } catch (err) {
    res.status(500).send(`Failed to start doom: ${err.message}\n`);
    return;
  }

  // Disable Nagle so each frame leaves the kernel as one packet instead of
  // getting batched with the next, terminal emulators read the pty in
  // chunks, and batching makes the partial-frame problem visibly worse.
  try { req.socket.setNoDelay(true); } catch {}

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
  res.flushHeaders();

  // One-time clear so the first frame lands on a blank screen. Subsequent
  // frames overwrite in place via cursor-home (see frameToAnsi).
  res.write(CLEAR);

  // Frame pacing. Doom-native is ~35 Hz, but a single ANSI frame at
  // 200x60 is roughly 300 KB; at 35 Hz that's ~10 MB/s of escape
  // sequences, which most terminal emulators can't render in real time.
  // 15 Hz is the smoothest default that "just works" across terminals
  // (Apple Terminal, iTerm, Ghostty, kitty); pass ?fps=N (5..35) to
  // override. Combined with the cursor-home trick, even when frames tear
  // the result is a partially-updated frame instead of a blank one.
  const fpsRaw = parseInt(req.query.fps, 10);
  const fps = Number.isFinite(fpsRaw) ? Math.max(5, Math.min(35, fpsRaw)) : 15;
  const FRAME_MS = Math.round(1000 / fps);

  let closed = false;
  const heldTimers = new Map(); // doomKey -> timeoutId

  // Detect client disconnect via the underlying TCP socket. We can NOT use
  // req.on('close') here: in modern Node it fires when the request body's
  // Readable stream ends, which for `curl -T -` with no stdin data is
  // basically instantaneous and would tear the session down before we
  // ever wrote a frame. The TCP socket's 'close' event only fires on real
  // connection termination.
  const onClientGone = () => close('client disconnect');
  req.socket.once('close', onClientGone);

  const close = (reason) => {
    if (closed) return;
    closed = true;
    req.socket.removeListener('close', onClientGone);
    for (const t of heldTimers.values()) clearTimeout(t);
    heldTimers.clear();
    destroySession(session, reason || 'play closed');
    try { res.end(); } catch {}
  };
  req.on('error', () => close('req error'));
  res.on('error', () => close('res error'));

  // held-key state
  // Each pressed key gets a 150ms release timer; new bytes for the same
  // key reset the timer. Doom sees one K 1 ... K 0 cycle per "press".
  const RELEASE_MS = 150;
  function pressKey(doomKey) {
    if (closed || session.dead) return;
    const existing = heldTimers.get(doomKey);
    if (existing) {
      clearTimeout(existing);
    } else {
      try { writeCmd(session, `K 1 ${doomKey}`); } catch { return; }
    }
    const t = setTimeout(() => {
      heldTimers.delete(doomKey);
      try { writeCmd(session, `K 0 ${doomKey}`); } catch {}
    }, RELEASE_MS);
    heldTimers.set(doomKey, t);
  }

  // byte parser
  // Two-byte ESC[A/B/C/D for arrows, bare ESC = menu. Across-chunk safe
  // because escState/escTimer are closed over by req's data handler.
  let escState = 0; // 0=normal, 1=after ESC, 2=after ESC[
  let escTimer = null;

  function clearEscTimer() {
    if (escTimer) { clearTimeout(escTimer); escTimer = null; }
  }
  function flushBareEsc() {
    clearEscTimer();
    if (escState === 1) pressKey(K.ESCAPE);
    escState = 0;
  }

  function feedByte(b) {
    if (escState === 1) {
      clearEscTimer();
      if (b === 0x5b /* '[' */) {
        escState = 2;
        escTimer = setTimeout(() => { escState = 0; escTimer = null; }, 100);
        return;
      }
      // Bare ESC followed by something else: emit ESC, then process the byte.
      pressKey(K.ESCAPE);
      escState = 0;
      // fall through and process this byte normally
    } else if (escState === 2) {
      clearEscTimer();
      escState = 0;
      switch (b) {
        case 0x41: return pressKey(K.UP);    // A
        case 0x42: return pressKey(K.DOWN);  // B
        case 0x43: return pressKey(K.RIGHT); // C
        case 0x44: return pressKey(K.LEFT);  // D
        default: return;
      }
    }

    if (b === 0x1b /* ESC */) {
      escState = 1;
      escTimer = setTimeout(flushBareEsc, 80);
      return;
    }
    // Quit bytes: 'q', 'Q', Ctrl-C, Ctrl-D.
    if (b === 0x71 || b === 0x51 || b === 0x03 || b === 0x04) {
      close('quit byte');
      return;
    }
    if (b === 0x0a || b === 0x0d) return pressKey(K.ENTER);
    if (b === 0x09) return pressKey(K.TAB);

    const ch = String.fromCharCode(b);
    if (ch in KEYMAP) {
      const dk = KEYMAP[ch];
      if (dk != null) pressKey(dk);
    }
  }

  req.on('data', chunk => {
    for (const b of chunk) feedByte(b);
  });

  // tic loop
  // Drives doom forward one tic at a time, streaming each frame to the
  // client. The C side has already done 140 warmup tics by the time it
  // hits its read-loop, so the very first frame we ask for here is a
  // real in-game scene.
  try {
    while (!closed && !session.dead) {
      try {
        writeCmd(session, 'T 1');
      } catch { break; }
      let fb;
      try {
        fb = await requestFrame(session);
      } catch { break; }
      if (closed) break;

      session.lastActive = Date.now();
      const ansi = frameToAnsi(fb, cols, rows);
      const ok = res.write(ansi);
      if (!ok) {
        // Backpressure: wait for the socket to drain before queueing more.
        await new Promise(resolve => {
          const onDrain = () => { res.off('close', onClose); resolve(); };
          const onClose = () => { res.off('drain', onDrain); resolve(); };
          res.once('drain', onDrain);
          res.once('close', onClose);
        });
      }
      await sleep(FRAME_MS);
    }
  } finally {
    close('play loop exit');
  }
});

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

app.listen(PORT, () => {
  console.log(`cURL DOOM running on http://localhost:${PORT}`);
  console.log(`doom binary: ${DOOM_BIN}`);
  console.log(`WAD:         ${WAD}`);
  console.log(`Play with:   curl -sL http://localhost:${PORT} | bash`);
  console.log(`         or: ./doom.sh`);
});
