// Mochi & Tofu: our bear and kitty couple as 2D sticker emotes. The art is illustrated (duo/*.png, cut from
// emote-art/ sheets: body parts, 8 expressions each, props); this file rigs it like a cut-out puppet and animates it
// with springs, so heads lag and bob, arms overshoot and settle, bodies squash on landing and tails swing.
// Stage units are the art's own pixels (a head is 300 wide); the floor is y = 0, up is negative.

export const DUO = new Set(['hug', 'smooch', 'love', 'party', 'comfort', 'sulk', 'gift']);
const DUR = { hug: 3300, smooch: 3400, love: 3300, party: 3400, comfort: 3600, sulk: 3700, gift: 3600 };
const FACES = ['happy', 'love', 'kiss', 'cry', 'sulk', 'worried', 'excited', 'shy'];
const PROPS = ['bigheart', 'heart', 'flower', 'box', 'lid', 'tear', 'note', 'sparkle', 'anger', 'puff'];

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const ease = (x) => 1 - Math.pow(1 - clamp01(x), 3);
const backOut = (x) => { x = clamp01(x); const c = 2.2; return 1 + (c + 1) * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2); };
const lerp = (a, b, t) => a + (b - a) * clamp01(t);
const rand = (a, b) => a + Math.random() * (b - a);

// ---------- art ----------
const base = new URL('./duo/', import.meta.url).href;
const img = {};
const load = (name) => { const i = new Image(); i.decoding = 'async'; i.src = base + name + '.webp'; img[name] = i; return i; };
for (const who of ['mochi', 'tofu']) {
  for (const p of ['head', 'torso', 'armL', 'armR']) load(`${who}_${p}`);
  for (const f of FACES) load(`${who}_face_${f}`);
}
load('tofu_tail');
for (const p of PROPS) load(`prop_${p}`);
let meta = null;
fetch(base + 'manifest.json').then((r) => r.json()).then((m) => (meta = m)).catch(() => {});
const ready = () => !!meta && Object.values(img).every((i) => i.complete && i.naturalWidth);

// Where the parts join, per character (art pixels; the torso stands on y = 0, centred).
const RIG = {
  mochi: { scale: 1, neckDrop: 44, shoulder: [104, 34], armPivot: [0.5, 0.09], tail: null },
  tofu: { scale: 0.84, neckDrop: 40, shoulder: [82, 30], armPivot: [0.5, 0.1], tail: { at: [62, -34], pivot: [0.12, 0.92] } },
};

// ---------- springs ----------
// A value that chases its target: stiff k, damping c (low damping = bouncier, it overshoots and settles).
const spring = (v = 0) => ({ v, vel: 0, to: v });
function springStep(s, k, c, dt) { s.vel += (k * (s.to - s.v) - c * s.vel) * dt; s.v += s.vel * dt; }
const K = { x: [90, 15], y: [260, 16], rot: [150, 11], sq: [320, 13], headY: [200, 9], headRot: [130, 8], arm: [170, 11], tail: [55, 4] };

function character(who, x) {
  return { who, face: null, front: { L: false, R: false }, hold: null, s: { x: spring(x), y: spring(0), rot: spring(0), sq: spring(0), headY: spring(0), headRot: spring(0), armL: spring(0.12), armR: spring(-0.12), tail: spring(0) } };
}
function simulate(c, dt, t) {
  const s = c.s;
  const prevYVel = s.y.vel;
  springStep(s.x, ...K.x, dt);
  springStep(s.y, ...K.y, dt);
  springStep(s.rot, ...K.rot, dt);
  // the head lags the body: when the body moves up, the head sinks a little, then catches up and overshoots
  s.headY.vel -= (s.y.vel - prevYVel) * 0.18;
  springStep(s.headY, ...K.headY, dt);
  springStep(s.headRot, ...K.headRot, dt);
  // stretch while moving fast, a squash kick when coming down onto the floor, and breathing at rest
  s.sq.to = -Math.min(0.1, Math.abs(s.y.vel) / 2600) + 0.012 * Math.sin(t * 3.2 + (c.who === 'tofu' ? 1 : 0));
  if (prevYVel > 260 && s.y.v > -6) s.sq.vel += 5.5;
  springStep(s.sq, ...K.sq, dt);
  springStep(s.armL, ...K.arm, dt);
  springStep(s.armR, ...K.arm, dt);
  s.tail.to = 0.25 * Math.sin(t * 2.4) - s.x.vel * 0.0012 - s.rot.v * 0.8; // swings on its own, and against the body's motion
  springStep(s.tail, ...K.tail, dt);
}

// ---------- drawing ----------
function drawImg(g, name, x, y) { const i = img[name]; if (i?.complete && i.naturalWidth) g.drawImage(i, x, y); }
function prop(g, name, x, y, size, rot = 0, alpha = 1) {
  const i = img['prop_' + name]; if (!i?.naturalWidth || size <= 0) return;
  const k = size / Math.max(i.naturalWidth, i.naturalHeight);
  g.save(); g.translate(x, y); g.rotate(rot); g.globalAlpha *= alpha; g.drawImage(i, (-i.naturalWidth * k) / 2, (-i.naturalHeight * k) / 2, i.naturalWidth * k, i.naturalHeight * k); g.restore();
}
function arm(g, c, side) {
  const r = RIG[c.who], i = img[`${c.who}_arm${side}`]; if (!i?.naturalWidth) return;
  const sx = (side === 'L' ? -1 : 1) * r.shoulder[0], torso = img[`${c.who}_torso`];
  g.save(); g.translate(sx, -torso.naturalHeight + r.shoulder[1]); g.rotate(c.s['arm' + side].v);
  g.drawImage(i, -i.naturalWidth * r.armPivot[0], -i.naturalHeight * r.armPivot[1]);
  if (c.hold && c.holdSide === side) c.hold(g, i.naturalHeight * (1 - r.armPivot[1]) - 10); // something in this paw
  g.restore();
}
// layer 'back': everything except arms drawn in front of the partner; 'front': just those arms
function drawCharacter(g, c, layer) {
  const r = RIG[c.who], s = c.s, torso = img[`${c.who}_torso`]; if (!torso?.naturalWidth || !meta) return;
  g.save();
  g.translate(s.x.v, s.y.v); g.scale(r.scale, r.scale); g.rotate(s.rot.v);
  g.scale(1 + s.sq.v * 0.6, 1 - s.sq.v); // squash and stretch from the feet
  if (layer === 'front') { for (const side of ['L', 'R']) if (c.front[side]) arm(g, c, side); g.restore(); return; }
  if (r.tail) {
    const t = img.tofu_tail;
    g.save(); g.translate(r.tail.at[0], r.tail.at[1]); g.rotate(s.tail.v); g.drawImage(t, -t.naturalWidth * r.tail.pivot[0], -t.naturalHeight * r.tail.pivot[1]); g.restore();
  }
  drawImg(g, `${c.who}_torso`, -torso.naturalWidth / 2, -torso.naturalHeight);
  for (const side of ['L', 'R']) if (!c.front[side]) arm(g, c, side);
  // head: pivots on the neck, lags with its own springs; an expression replaces the plain head
  g.save();
  g.translate(0, -torso.naturalHeight + r.neckDrop + s.headY.v); g.rotate(s.headRot.v);
  if (c.face) {
    const off = meta[c.who].faceOff[c.face], size = meta[c.who].faceSize;
    drawImg(g, `${c.who}_face_${c.face}`, -size[0] / 2 - off[0], -size[1] - off[1]);
  } else {
    const h = img[`${c.who}_head`]; drawImg(g, `${c.who}_head`, -h.naturalWidth / 2, -h.naturalHeight);
  }
  g.restore();
  g.restore();
}
function shadow(g, c) {
  const lift = Math.min(1, Math.max(0, -c.s.y.v / 120)), w = 150 * RIG[c.who].scale * (1 - 0.35 * lift);
  g.fillStyle = `rgba(0,0,0,${0.18 * (1 - 0.5 * lift)})`; g.beginPath(); g.ellipse(c.s.x.v, 4, w, 16 * (1 - 0.3 * lift), 0, 0, Math.PI * 2); g.fill();
}

// ---------- scenes ----------
// Each runs every simulation step: it sets where things should be (spring targets), faces, and adds particles.
// M = Mochi (left), T = Tofu (right).
const walk = (c, t, from, to, start, len) => {
  const p = (t - start) / len;
  if (p < 0 || p > 1) return false;
  c.s.x.to = lerp(from, to, ease(p));
  c.s.y.to = -26 * Math.abs(Math.sin(t / 95));
  c.s.rot.to = 0.07 * Math.sin(t / 95);
  c.s.armL.to = 0.12 + 0.45 * Math.sin(t / 95); c.s.armR.to = -0.12 + 0.45 * Math.sin(t / 95);
  return true;
};
const settle = (c) => { c.s.y.to = 0; c.s.rot.to = 0; };
const place = (c, x) => { c.s.x.v = c.s.x.to = x; };
const SCENES = {
  hug(e, t, M, T) {
    if (t < 20) { place(M, -340); place(T, 330); }
    walk(M, t, -340, -115, 0, 700); walk(T, t, 330, 110, 60, 700);
    if (t < 760) { M.face = null; T.face = 'excited'; return; }
    settle(M); settle(T);
    if (!e.flags.hug) { e.flags.hug = true; M.s.sq.vel += 4; T.s.sq.vel += 4; } // a squeeze as they meet
    M.front.R = true; T.front.L = true;
    M.s.armR.to = -1.05; M.s.armL.to = 0.5; T.s.armL.to = 1.3; T.s.armR.to = -0.5; // his arm round her shoulders (she is shorter), hers round his middle
    const sway = 0.07 * Math.sin(t / 260);
    M.s.rot.to = 0.12 + sway; T.s.rot.to = -0.12 + sway;
    M.s.headRot.to = 0.1; T.s.headRot.to = -0.12;
    M.face = t > 1500 ? 'love' : 'happy'; T.face = t > 1300 ? 'shy' : 'happy';
    if (t > e.next && t < e.dur - 500) { e.next = t + 240; e.add('heart', rand(-60, 60), -560, rand(-40, 40), -110, 1100, rand(40, 60)); }
  },
  smooch(e, t, M, T) {
    if (t < 20) { place(M, -170); place(T, 175); }
    M.face = t < 1200 ? 'shy' : 'love'; T.face = t < 650 ? 'excited' : t < 1350 ? 'kiss' : 'happy';
    if (t < 650) { T.s.y.to = -14 * Math.abs(Math.sin(t / 110)); return; }
    if (t < 1250) { T.s.x.to = 70; T.s.y.to = -26; T.s.rot.to = -0.16; T.s.headRot.to = -0.14; T.s.armL.to = 1.3; M.s.rot.to = 0.05; M.s.headRot.to = 0.12; return; }
    if (!e.flags.pop) { e.flags.pop = true; e.add('bigheart', -40, -470, 0, -60, 1400, 150); for (let i = 0; i < 10; i++) { const a = (i / 10) * Math.PI * 2; e.add('sparkle', -40 + Math.cos(a) * 40, -470 + Math.sin(a) * 40, Math.cos(a) * 260, Math.sin(a) * 260, 650, 34); } }
    T.s.x.to = 140; T.s.y.to = -20 * Math.abs(Math.sin(t / 120)); T.s.rot.to = 0; T.s.headRot.to = 0; T.s.armL.to = 0.12;
    M.s.rot.to = 0.1 * Math.sin(t / 240); M.s.headRot.to = 0.14 * Math.sin(t / 200); // dizzy with love
    if (t > e.next && t < e.dur - 500) { e.next = t + 280; e.add('heart', rand(-260, -100), -500, rand(-30, 30), -120, 1000, rand(36, 50)); }
  },
  love(e, t, M, T) {
    if (t < 20) { place(M, -170); place(T, 175); }
    const up = t > 250;
    M.face = t < 900 ? 'happy' : 'love'; T.face = 'love';
    M.s.armL.to = up ? 2.75 : 0.12; M.s.armR.to = up ? -2.75 : -0.12; M.front.L = M.front.R = true;
    M.s.y.to = -14 * Math.abs(Math.sin(t / 260));
    e.prop = (g) => { if (up) { const beat = 1 + 0.12 * Math.pow(Math.max(0, Math.sin(t / 140)), 6), a = backOut((t - 250) / 400); prop(g, 'bigheart', M.s.x.v, M.s.y.v - 640, 210 * a * beat); } };
    T.s.armL.to = 0.85; T.s.armR.to = -0.85; T.front.L = T.front.R = true; // paws clasped
    T.s.rot.to = 0.07 * Math.sin(t / 300); T.s.headRot.to = 0.1 * Math.sin(t / 300);
    if (up && t > e.next && t < e.dur - 500) { e.next = t + 220; e.add('heart', M.s.x.v + rand(-60, 60), -620, rand(-60, 150), -140, 1100, rand(30, 46)); }
  },
  party(e, t, M, T) {
    if (t < 20) { place(M, -175); place(T, 175); }
    const beat = t / 250, up = Math.floor(beat) % 2 === 0;
    M.face = 'happy'; T.face = 'excited';
    M.s.y.to = -50 * Math.abs(Math.sin(beat * Math.PI)); T.s.y.to = -50 * Math.abs(Math.cos(beat * Math.PI));
    M.s.rot.to = up ? 0.14 : -0.14; T.s.rot.to = up ? -0.14 : 0.14;
    M.s.armL.to = up ? 2.6 : 0.3; M.s.armR.to = up ? -0.3 : -2.6; T.s.armL.to = up ? 0.3 : 2.6; T.s.armR.to = up ? -2.6 : -0.3;
    M.s.headRot.to = up ? -0.1 : 0.1; T.s.headRot.to = up ? 0.1 : -0.1;
    if (t > e.next && t < e.dur - 500) {
      e.next = t + 120;
      if (Math.random() < 0.35) e.add('note', rand(-300, 300), -520, rand(-40, 40), -130, 1100, rand(38, 52));
      else e.add('confetti', rand(-320, 320), -620, rand(-60, 60), rand(120, 220), 1200, 14, `hsl(${rand(0, 360)},90%,62%)`);
    }
  },
  comfort(e, t, M, T) {
    if (t < 20) { place(M, -360); place(T, 150); }
    const ok = t > 2400;
    T.face = ok ? (t > 2900 ? 'happy' : 'shy') : 'cry';
    if (!ok) { T.s.x.to = 150 + 5 * Math.sin(t / 25); T.s.y.to = -6 * Math.abs(Math.sin(t / 90)); T.s.headRot.to = 0.06 * Math.sin(t / 70); T.s.armL.to = 0.5; T.s.armR.to = -0.5; } // sobbing, shaking
    else { T.s.x.to = 150; T.s.y.to = -18 * Math.abs(Math.sin(t / 130)); T.s.headRot.to = 0; T.s.armL.to = 0.2; T.s.armR.to = -0.2; }
    M.face = ok ? 'happy' : 'worried';
    if (!walk(M, t, -360, -40, 200, 800) && t > 1000) {
      settle(M); M.front.R = true; M.s.rot.to = 0.1;
      M.s.armR.to = ok ? -0.3 : -1.2 + (Math.floor(t / 260) % 2 ? 0.16 : 0); // an arm round its shoulders, patting
    }
    if (!ok && t > 150 && t > e.next) { e.next = t + 120; const sx = Math.random() < 0.5 ? -1 : 1; e.add('tear', 150 + sx * 70, -300, sx * rand(80, 160), -160, 650, rand(26, 34), null, 900); }
    if (!e.flags.fine && ok) { e.flags.fine = true; e.add('bigheart', 150, -520, 0, -70, 1100, 100); for (let i = 0; i < 7; i++) e.add('sparkle', 150 + rand(-120, 120), -420 + rand(-60, 60), rand(-60, 60), -60, 600, 28); }
  },
  sulk(e, t, M, T) {
    if (t < 20) { place(M, -360); place(T, 175); }
    const forgive = t > 2400;
    T.face = forgive ? (t > 2850 ? 'happy' : 'shy') : 'sulk';
    if (!forgive) { T.front.L = T.front.R = true; T.s.armL.to = -1.0; T.s.armR.to = 1.0; T.s.rot.to = -0.08; T.s.headRot.to = -0.16; } // arms crossed, nose up
    else { T.s.armL.to = 0.12; T.s.armR.to = -1.4; T.s.rot.to = 0; T.s.headRot.to = 0.08; T.s.y.to = -18 * Math.abs(Math.sin(t / 130)); }
    M.face = forgive ? 'happy' : 'worried';
    if (!walk(M, t, -360, -150, 150, 800) && t > 950) { settle(M); M.s.rot.to = forgive ? 0 : 0.16; M.s.headRot.to = forgive ? 0 : 0.12; } // bowing
    M.front.R = !forgive; M.s.armR.to = forgive ? -0.2 : -1.25;
    M.holdSide = 'R'; T.holdSide = 'R';
    M.hold = forgive ? null : (g, len) => prop(g, 'flower', 0, len + 30, 120, 1.2);
    T.hold = forgive ? (g, len) => prop(g, 'flower', 0, len + 30, 110, 1.4) : null;
    e.prop = (g) => { if (!forgive && t > 200) prop(g, 'anger', T.s.x.v + 120, -520, 80 * backOut((t - 200) / 300) * (1 + 0.15 * Math.sin(t / 70))); };
    if (!e.flags.yay && forgive) { e.flags.yay = true; e.add('bigheart', 175, -540, 0, -70, 1100, 100); e.add('puff', 175, -300, 0, -40, 500, 90); }
  },
  gift(e, t, M, T) {
    if (t < 20) { place(M, -380); place(T, 185); }
    const opened = t > 1500;
    M.face = 'happy'; T.face = opened ? 'love' : t > 900 ? 'excited' : null;
    if (!walk(M, t, -380, -170, 0, 800)) settle(M);
    M.front.L = M.front.R = t < 1000; M.s.armL.to = t < 1000 ? -0.85 : 0.12; M.s.armR.to = t < 1000 ? 0.85 : -0.12;
    const bx = t < 1000 ? M.s.x.v + 10 : lerp(M.s.x.v + 10, 0, (t - 1000) / 350), by = t < 1000 ? -90 + M.s.y.v : lerp(-90, -10, (t - 1000) / 350);
    const lid = opened ? ease((t - 1500) / 350) : 0;
    e.prop = (g) => {
      prop(g, 'box', bx, by - 40, 150);
      prop(g, 'lid', bx + lid * 60, by - 120 - lid * 230, 170, lid * 2.4, 1 - clamp01((t - 2100) / 400));
    };
    if (opened) { T.s.y.to = -60 * Math.abs(Math.sin(t / 150)); T.s.armL.to = 2.6; T.s.armR.to = -2.6; T.s.rot.to = 0.06 * Math.sin(t / 150); }
    else if (t > 900) { T.s.armL.to = 0.6; T.s.armR.to = -0.6; T.front.L = T.front.R = true; }
    if (!e.flags.open && opened) { e.flags.open = true; e.add('bigheart', 0, -180, 0, -190, 1500, 110); for (let i = 0; i < 12; i++) { const a = -Math.PI / 2 + rand(-1.3, 1.3); e.add('sparkle', 0, -170, Math.cos(a) * 320, Math.sin(a) * 320, 700, 32); } }
  },
};

// ---------- the layer ----------
export function createDuo(canvas, { clean = false } = {}) { // clean: no glow or shadows (picker artwork)
  const g = canvas.getContext('2d');
  let W = 1, H = 1, dpr = 1;
  const list = [];
  function resize(w, h, d) { W = w; H = h; dpr = d; canvas.width = Math.round(w * d); canvas.height = Math.round(h * d); canvas.style.width = w + 'px'; canvas.style.height = h + 'px'; }
  function play({ emote, x, y, size }) {
    const e = { k: emote, x, y, size, t: 0, dur: DUR[emote] ?? 3400, parts: [], flags: {}, next: 0, M: character('mochi', -175), T: character('tofu', 175) };
    e.add = (type, px, py, vx, vy, life, s, color = null, gy = 0) => e.parts.push({ type, x: px, y: py, vx, vy, life, s, color, gy, born: e.t, rot: rand(-0.4, 0.4) });
    list.push(e);
  }
  const STEP = 1000 / 120; // springs run at a fixed 120 steps a second, whatever the frame rate
  function step(dtMs) {
    if (!ready()) return list.length > 0; // art still loading: wait, then start
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];
      let left = Math.min(dtMs, 100);
      while (left > 0) {
        const dt = Math.min(STEP, left); left -= dt; e.t += dt;
        e.M.front = { L: false, R: false }; e.T.front = { L: false, R: false }; e.prop = null;
        SCENES[e.k](e, e.t, e.M, e.T);
        simulate(e.M, dt / 1000, e.t / 1000); simulate(e.T, dt / 1000, e.t / 1000);
      }
      if (e.t >= e.dur) list.splice(i, 1);
    }
    return list.length > 0;
  }
  function draw(e) {
    const t = e.t;
    const inn = backOut(t / 360), out = 1 - ease((t - (e.dur - 320)) / 320);
    const scale = ((e.size * 1.65) / 700) * Math.max(0.001, inn * out); // the stage is as wide as the seat
    g.save();
    g.translate(e.x, e.y + e.size * 0.52);
    g.scale(scale, scale);
    g.globalAlpha = clamp01(out * 1.4);
    if (!clean) {
      const glow = g.createRadialGradient(0, -230, 20, 0, -230, 380); glow.addColorStop(0, 'rgba(255,170,200,.4)'); glow.addColorStop(1, 'rgba(255,170,200,0)');
      g.fillStyle = glow; g.fillRect(-400, -620, 800, 760);
      shadow(g, e.M); shadow(g, e.T);
    }
    drawCharacter(g, e.M, 'back'); drawCharacter(g, e.T, 'back');
    e.prop?.(g);
    drawCharacter(g, e.M, 'front'); drawCharacter(g, e.T, 'front');
    for (let i = e.parts.length - 1; i >= 0; i--) {
      const q = e.parts[i], a = (t - q.born) / q.life;
      if (a >= 1) { e.parts.splice(i, 1); continue; }
      const sec = (t - q.born) / 1000;
      const px = q.x + q.vx * sec, py = q.y + q.vy * sec + 0.5 * q.gy * sec * sec;
      const alpha = a > 0.7 ? (1 - a) / 0.3 : 1, grow = backOut(a / 0.18);
      if (q.type === 'confetti') { g.save(); g.globalAlpha *= alpha; g.translate(px, py); g.rotate(q.rot + sec * 7); g.fillStyle = q.color; g.fillRect(-q.s / 2, -q.s, q.s, q.s * 2); g.restore(); }
      else prop(g, q.type, px + (q.type === 'heart' || q.type === 'note' ? 18 * Math.sin(sec * 6) : 0), py, q.s * grow * (q.type === 'bigheart' ? 1 + 0.08 * Math.sin(sec * 14) : 1), q.type === 'sparkle' ? sec * 3 : q.rot * 0.5, alpha);
    }
    g.restore();
  }
  function render() {
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    for (const e of list) draw(e);
  }
  return { play, step, render, resize, active: () => list.length > 0, list, ready };
}
