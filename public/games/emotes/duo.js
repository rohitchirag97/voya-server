// Mochi & Tofu: our own couple, a chubby cream bear and a little white kitty, as 2D sticker-style emotes drawn on a
// canvas every frame (flat colours, dark outline, blush). Each emote is a short scene the two act out on a seat.
// Stage units: the floor is y = 0, up is negative; the two stand about 60 units apart; a character is ~100 tall.

export const DUO = new Set(['hug', 'smooch', 'love', 'party', 'comfort', 'sulk', 'gift']);
const DUR = { hug: 3200, smooch: 3300, love: 3200, party: 3400, comfort: 3500, sulk: 3600, gift: 3500 };

const OUT = '#4a3426', CREAM = '#fff1d8', MUZZLE = '#f3c896', EAR = '#ffb9a8', PINK = '#ff7fa4', WHITE = '#ffffff', ORANGE = '#ffa552', RED = '#ff3d6e';
const LW = 3.2;
const clamp01 = (x) => Math.min(1, Math.max(0, x));
const ease = (x) => 1 - Math.pow(1 - clamp01(x), 3);
const backOut = (x) => { x = clamp01(x); const c = 2.2; return 1 + (c + 1) * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2); };
const lerp = (a, b, t) => a + (b - a) * clamp01(t);
const rand = (a, b) => a + Math.random() * (b - a);

// ---------- drawing kit ----------
function blob(g, x, y, rx, ry, fill, line = LW) {
  g.beginPath(); g.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
  g.fillStyle = fill; g.fill();
  if (line) { g.lineWidth = line; g.strokeStyle = OUT; g.stroke(); }
}
function shade(g, x, y, rx, ry) { // a soft shadow low on a round shape
  g.save(); g.beginPath(); g.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); g.clip();
  const r = g.createLinearGradient(0, y - ry, 0, y + ry); r.addColorStop(0.55, 'rgba(120,80,40,0)'); r.addColorStop(1, 'rgba(120,80,40,.16)');
  g.fillStyle = r; g.fillRect(x - rx, y - ry, rx * 2, ry * 2); g.restore();
}
// an arm or leg from (x, y): angle 0 points down, positive swings it out to the left (canvas rotation)
function limb(g, x, y, ang, len, w, fill) {
  g.save(); g.translate(x, y); g.rotate(ang);
  g.beginPath(); g.roundRect(-w / 2, -w / 2, w, len + w / 2, w / 2);
  g.fillStyle = fill; g.fill(); g.lineWidth = LW; g.strokeStyle = OUT; g.stroke();
  g.restore();
}
export function heart(g, x, y, s, color = RED, line = true) {
  g.save(); g.translate(x, y); g.scale(s / 10, s / 10);
  g.beginPath(); g.moveTo(0, 4);
  g.bezierCurveTo(-1, 3, -10, -2, -10, -6); g.bezierCurveTo(-10, -11, -3, -12, 0, -7);
  g.bezierCurveTo(3, -12, 10, -11, 10, -6); g.bezierCurveTo(10, -2, 1, 3, 0, 4); g.closePath();
  g.fillStyle = color; g.fill();
  if (line) { g.lineWidth = LW * 10 / s * 0.8; g.strokeStyle = OUT; g.stroke(); }
  g.fillStyle = 'rgba(255,255,255,.55)'; g.beginPath(); g.ellipse(-5, -7, 2.4, 1.5, -0.6, 0, Math.PI * 2); g.fill();
  g.restore();
}
function sparkle(g, x, y, s, color = '#ffe27a') {
  g.save(); g.translate(x, y); g.fillStyle = color; g.beginPath();
  g.moveTo(0, -s); g.quadraticCurveTo(0, 0, s, 0); g.quadraticCurveTo(0, 0, 0, s); g.quadraticCurveTo(0, 0, -s, 0); g.quadraticCurveTo(0, 0, 0, -s);
  g.fill(); g.restore();
}
function tear(g, x, y, s) {
  g.save(); g.translate(x, y); g.beginPath(); g.moveTo(0, -s); g.quadraticCurveTo(s * 0.9, s * 0.2, 0, s * 0.8); g.quadraticCurveTo(-s * 0.9, s * 0.2, 0, -s);
  g.fillStyle = '#7fd3ff'; g.fill(); g.lineWidth = 1.6; g.strokeStyle = '#3b9ad6'; g.stroke(); g.restore();
}
function note(g, x, y, s, color) {
  g.save(); g.translate(x, y); g.fillStyle = color; g.strokeStyle = color; g.lineWidth = s * 0.18;
  g.beginPath(); g.ellipse(0, 0, s * 0.42, s * 0.32, -0.4, 0, Math.PI * 2); g.fill();
  g.beginPath(); g.moveTo(s * 0.36, -0.1 * s); g.lineTo(s * 0.36, -s * 1.3); g.quadraticCurveTo(s * 0.9, -s * 1.1, s * 0.8, -s * 0.6); g.stroke();
  g.restore();
}
function angerMark(g, x, y, s) {
  g.save(); g.translate(x, y); g.strokeStyle = '#ff3b3b'; g.lineWidth = s * 0.28; g.lineCap = 'round';
  for (const [cx, cy, a] of [[1, 1, Math.PI], [-1, 1, -Math.PI / 2], [-1, -1, 0], [1, -1, Math.PI / 2]]) { g.beginPath(); g.arc(cx * s * 0.55, cy * s * 0.55, s * 0.45, a, a + Math.PI / 2); g.stroke(); }
  g.restore();
}
function flower(g, x, y, s) {
  g.save(); g.translate(x, y);
  g.strokeStyle = '#4caf50'; g.lineWidth = 2.6; g.beginPath(); g.moveTo(0, 0); g.quadraticCurveTo(3, -10, 0, -20); g.stroke();
  g.fillStyle = '#7bd36b'; g.beginPath(); g.ellipse(4, -8, 4, 2, -0.5, 0, Math.PI * 2); g.fill();
  for (let i = 0; i < 5; i++) { const a = (i / 5) * Math.PI * 2; blob(g, Math.cos(a) * 5.2, -24 + Math.sin(a) * 5.2, 4.4, 4.4, '#ff8fb8', 1.6); }
  blob(g, 0, -24, 3.4, 3.4, '#ffd54a', 1.4);
  g.restore();
}
function giftBox(g, x, y, s, lid = 0, lidRot = 0) {
  g.save(); g.translate(x, y); g.scale(s, s);
  g.beginPath(); g.roundRect(-14, -24, 28, 24, 3); g.fillStyle = '#ff5c7c'; g.fill(); g.lineWidth = LW / s; g.strokeStyle = OUT; g.stroke();
  g.fillStyle = '#ffd54a'; g.fillRect(-3, -24, 6, 24);
  g.save(); g.translate(0, -24 - lid); g.rotate(lidRot);
  g.beginPath(); g.roundRect(-16, -7, 32, 8, 2.5); g.fillStyle = '#ff5c7c'; g.fill(); g.stroke();
  g.fillStyle = '#ffd54a'; g.fillRect(-3, -7, 6, 8);
  for (const sx of [-1, 1]) { g.beginPath(); g.ellipse(sx * 5, -10, 5, 3.4, sx * 0.5, 0, Math.PI * 2); g.fillStyle = '#ffd54a'; g.fill(); g.lineWidth = 1.8; g.stroke(); }
  g.restore();
  g.restore();
}

// eyes at (+-dx, y) in head space
function eyes(g, type, dx, y) {
  g.lineCap = 'round'; g.lineJoin = 'round';
  for (const s of [-1, 1]) {
    const x = s * dx;
    const t = type === 'wink' ? (s < 0 ? 'happy' : 'dot') : type;
    g.strokeStyle = OUT; g.fillStyle = OUT; g.lineWidth = 2.6;
    if (t === 'dot' || t === 'angry' || t === 'worried') {
      g.beginPath(); g.ellipse(x, y, 3.4, 4.4, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#fff'; g.beginPath(); g.arc(x - 1.1, y - 1.6, 1.3, 0, Math.PI * 2); g.fill();
      if (t === 'angry') { g.beginPath(); g.moveTo(x - s * 6, y - 6); g.lineTo(x + s * 3, y - 9); g.stroke(); } // inner end low: cross
      if (t === 'worried') { g.beginPath(); g.moveTo(x - s * 5, y - 10); g.lineTo(x + s * 3, y - 7); g.stroke(); } // inner end high: worried
    } else if (t === 'sparkle') {
      g.beginPath(); g.ellipse(x, y, 5, 6, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#fff'; g.beginPath(); g.arc(x - 1.6, y - 2.2, 2, 0, Math.PI * 2); g.fill(); g.beginPath(); g.arc(x + 1.8, y + 2, 1, 0, Math.PI * 2); g.fill();
    } else if (t === 'happy') {
      g.beginPath(); g.moveTo(x - 4, y + 1.5); g.quadraticCurveTo(x, y - 5, x + 4, y + 1.5); g.stroke();
    } else if (t === 'closed' || t === 'cry' || t === 'huff') {
      g.beginPath(); g.moveTo(x - 4, y - 1); g.quadraticCurveTo(x, y + 3.5, x + 4, y - 1); g.stroke();
      if (t === 'huff') { g.beginPath(); g.moveTo(x - s * 6, y - 4); g.lineTo(x + s * 3, y - 8); g.stroke(); }
      if (t === 'cry') { g.fillStyle = 'rgba(127,211,255,.9)'; g.beginPath(); g.roundRect(x - 2.6, y + 2, 5.2, 20, 2.6); g.fill(); }
    } else if (t === 'heart') {
      heart(g, x, y + 1, 6.5, RED, false);
    }
  }
}
function mouth(g, type, y) {
  g.strokeStyle = OUT; g.lineWidth = 2.2; g.lineCap = 'round';
  if (type === 'smile') { g.beginPath(); g.moveTo(-4.5, y); g.quadraticCurveTo(-2.2, y + 2.8, 0, y); g.quadraticCurveTo(2.2, y + 2.8, 4.5, y); g.stroke(); }
  else if (type === 'open' || type === 'wail') {
    const w = type === 'wail' ? 6.5 : 5, h = type === 'wail' ? 8 : 5.5;
    g.beginPath(); g.moveTo(-w, y); g.quadraticCurveTo(0, y - 1, w, y); g.quadraticCurveTo(w * 0.8, y + h, 0, y + h); g.quadraticCurveTo(-w * 0.8, y + h, -w, y); g.closePath();
    g.fillStyle = '#9b3a2a'; g.fill(); g.stroke();
    g.fillStyle = '#ff8fa0'; g.beginPath(); g.ellipse(0, y + h - 1.6, w * 0.5, 1.8, 0, 0, Math.PI * 2); g.fill();
  } else if (type === 'kiss') {
    g.fillStyle = '#ff6f8f'; g.beginPath(); g.ellipse(1, y + 1, 2.8, 2, 0, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.moveTo(-1, y - 2); g.quadraticCurveTo(3, y - 1, -0.5, y + 1); g.quadraticCurveTo(3, y + 2, -1, y + 4); g.stroke();
  } else if (type === 'frown') { g.beginPath(); g.moveTo(-4, y + 2); g.quadraticCurveTo(0, y - 2, 4, y + 2); g.stroke(); }
  else if (type === 'pout') { g.beginPath(); g.moveTo(-4, y + 1); g.quadraticCurveTo(-2, y - 1.5, 0, y + 1); g.quadraticCurveTo(2, y + 3, 4, y); g.stroke(); }
}
function blush(g, a, dx, y) {
  if (a <= 0) return;
  g.fillStyle = `rgba(255,120,150,${0.55 * a})`;
  for (const s of [-1, 1]) { g.beginPath(); g.ellipse(s * dx, y, 6, 3.6, 0, 0, Math.PI * 2); g.fill(); }
}
const armAngle = (p, side) => (p[side === 'L' ? 'angL' : 'angR'] ?? (side === 'L' ? 1 : -1) * (0.25 + 2.3 * (p[side === 'L' ? 'armL' : 'armR'] ?? 0)));

// Mochi the bear. pose: x, y, rot, squash, tilt, armL/armR (0 down .. 1 up) or angL/angR, frontL/frontR (drawn over the partner),
// eyes, mouth, blush, hold(g) for something in its paws.
function mochi(g, p, layer) {
  g.save(); g.translate(p.x, p.y); g.rotate(p.rot ?? 0);
  const sq = p.squash ?? 0; g.scale(1 + sq * 0.6, 1 - sq);
  if (layer === 'front') {
    if (p.frontL) limb(g, -24, -40, armAngle(p, 'L'), p.lenL ?? 22, 13, CREAM);
    if (p.frontR) limb(g, 24, -40, armAngle(p, 'R'), p.lenR ?? 22, 13, CREAM);
    p.hold?.(g);
    g.restore(); return;
  }
  blob(g, -14, -4, 11, 7, CREAM); blob(g, 14, -4, 11, 7, CREAM);
  blob(g, 0, -30, 32, 28, CREAM); shade(g, 0, -30, 32, 28);
  heart(g, 0, -24, 8, PINK);
  if (!p.frontL) limb(g, -24, -40, armAngle(p, 'L'), p.lenL ?? 22, 13, CREAM);
  if (!p.frontR) limb(g, 24, -40, armAngle(p, 'R'), p.lenR ?? 22, 13, CREAM);
  g.save(); g.translate(0, -66); g.rotate(p.tilt ?? 0);
  for (const s of [-1, 1]) { blob(g, s * 24, -23, 11, 11, CREAM); blob(g, s * 24, -23, 6, 6, EAR, 0); }
  blob(g, 0, 0, 35, 30, CREAM); shade(g, 0, 0, 35, 30);
  blob(g, 0, 8, 13, 9.5, MUZZLE, 2.2);
  blob(g, 0, 4, 4.4, 3.2, OUT, 0);
  mouth(g, p.mouth ?? 'smile', 9.5);
  eyes(g, p.eyes ?? 'dot', 13, -4);
  blush(g, p.blush ?? 0.6, 23, 7);
  g.restore();
  g.restore();
}

// Tofu the kitty (a little smaller).
function tofu(g, p, layer) {
  g.save(); g.translate(p.x, p.y); g.rotate(p.rot ?? 0); g.scale(0.88, 0.88);
  const sq = p.squash ?? 0; g.scale(1 + sq * 0.6, 1 - sq);
  if (layer === 'front') {
    if (p.frontL) limb(g, -19, -32, armAngle(p, 'L'), 19, 11.5, WHITE);
    if (p.frontR) limb(g, 19, -32, armAngle(p, 'R'), 19, 11.5, WHITE);
    p.hold?.(g);
    g.restore(); return;
  }
  // tail: an outlined curl with orange stripes
  const wag = Math.sin((p.t ?? 0) * 6) * 6;
  const tail = () => { g.beginPath(); g.moveTo(18, -12); g.quadraticCurveTo(44, -10, 38 + wag * 0.3, -40); g.quadraticCurveTo(36, -52, 44 + wag, -54); };
  g.lineCap = 'round'; g.strokeStyle = OUT; g.lineWidth = 11; tail(); g.stroke(); g.strokeStyle = WHITE; g.lineWidth = 6; tail(); g.stroke();
  g.strokeStyle = ORANGE; g.lineWidth = 3; for (const [a, b] of [[34, -18], [40, -34]]) { g.beginPath(); g.moveTo(a - 3, b - 3); g.lineTo(a + 3, b + 3); g.stroke(); }
  blob(g, -11, -4, 9.5, 6.5, WHITE); blob(g, 11, -4, 9.5, 6.5, WHITE);
  blob(g, 0, -25, 25, 23, WHITE); shade(g, 0, -25, 25, 23);
  if (!p.frontL) limb(g, -19, -32, armAngle(p, 'L'), 19, 11.5, WHITE);
  if (!p.frontR) limb(g, 19, -32, armAngle(p, 'R'), 19, 11.5, WHITE);
  g.save(); g.translate(0, -57); g.rotate(p.tilt ?? 0);
  for (const s of [-1, 1]) { // ears
    g.beginPath(); g.moveTo(s * 8, -22); g.lineTo(s * 22, -38); g.lineTo(s * 28, -12); g.closePath();
    g.fillStyle = WHITE; g.fill(); g.lineWidth = LW; g.strokeStyle = OUT; g.lineJoin = 'round'; g.stroke();
    g.beginPath(); g.moveTo(s * 13, -21); g.lineTo(s * 21, -31); g.lineTo(s * 24, -16); g.closePath(); g.fillStyle = EAR; g.fill();
  }
  blob(g, 0, 0, 31, 25, WHITE); shade(g, 0, 0, 31, 25);
  g.fillStyle = ORANGE; for (const [x, w] of [[-6, 4], [0, 5], [6, 4]]) { g.beginPath(); g.ellipse(x, -21, w / 2 + 0.5, 4.5, 0, 0, Math.PI * 2); g.fill(); } // the orange tuft
  g.strokeStyle = 'rgba(74,52,38,.55)'; g.lineWidth = 1.4;
  for (const s of [-1, 1]) for (const k of [-1, 0, 1]) { g.beginPath(); g.moveTo(s * 18, 5 + k * 3); g.lineTo(s * 30, 3 + k * 5); g.stroke(); }
  g.fillStyle = '#ff8fa0'; g.beginPath(); g.moveTo(-2.4, 2); g.lineTo(2.4, 2); g.lineTo(0, 4.4); g.closePath(); g.fill();
  mouth(g, p.mouth ?? 'smile', 6.5);
  eyes(g, p.eyes ?? 'dot', 11, -3);
  blush(g, p.blush ?? 0.7, 19, 6);
  g.restore();
  g.restore();
}

// where the tip of an arm is (shoulder at sx, sy; canvas rotation maps (0, len) to (-len sin a, len cos a))
const paw = (sx, sy, a, len) => [sx - len * Math.sin(a), sy + len * Math.cos(a)];

// ---------- scenes: each returns the two poses for time t (ms), and adds particles ----------
function walkHop(t, speed = 14) { return -5 * Math.abs(Math.sin((t / 1000) * speed)); }
const SCENES = {
  hug(e, t) {
    const s = t / 1000, meet = ease(t / 650), hugging = t > 600;
    const sway = hugging ? 0.09 * Math.sin(s * 5) : 0;
    const b = { x: lerp(-52, -23, meet), y: t < 650 ? walkHop(t) : 0, eyes: hugging ? 'happy' : 'dot', mouth: hugging ? 'smile' : 'open', blush: hugging ? 1 : 0.5, rot: hugging ? 0.1 + sway : 0, armL: 0.25, armR: 0.5 };
    const c = { x: lerp(54, 24, meet), y: t < 650 ? walkHop(t + 120) : 0, eyes: hugging ? 'happy' : 'sparkle', mouth: 'smile', blush: 1, rot: hugging ? -0.1 + sway : 0, armL: 0.5, armR: 0.25, t: s };
    if (hugging) { Object.assign(b, { frontR: true, angR: -1.7 }); Object.assign(c, { frontL: true, angL: 1.75 }); b.squash = c.squash = 0.03 * Math.sin(s * 10); }
    if (hugging && t > e.next && t < e.dur - 500) { e.next = t + 260; e.add('heart', rand(-15, 15), -100, rand(-12, 12), -40, 1100, rand(7, 11)); }
    return [b, c];
  },
  smooch(e, t) {
    const s = t / 1000, lean = ease((t - 700) / 450), after = t > 1250;
    const b = { x: -30, rot: lean * 0.05 + (after ? 0.12 * Math.sin(s * 3) : 0), eyes: after ? 'heart' : 'dot', mouth: lean > 0.5 && !after ? 'kiss' : after ? 'open' : 'smile', blush: 0.6 + 0.4 * lean, tilt: after ? 0.15 * Math.sin(s * 4) : 0, armL: 0.15, armR: after ? 0.8 : 0.2 };
    const c = { x: lerp(36, 25, lean), y: -6 * lean, rot: -0.12 * lean, eyes: lean > 0.4 ? 'closed' : 'sparkle', mouth: lean > 0.3 ? 'kiss' : 'smile', blush: 1, armL: 0.6 * lean, armR: 0.1, t: s };
    if (after) { c.y = -4 * Math.abs(Math.sin(s * 8)); c.eyes = 'happy'; c.rot = -0.1; }
    if (!e.flags.pop && t > 1200) { e.flags.pop = true; e.add('bigheart', -6, -100, 0, -10, 1300, 22); for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; e.add('sparkle', -6 + Math.cos(a) * 10, -100 + Math.sin(a) * 10, Math.cos(a) * 60, Math.sin(a) * 60, 600, 5); } }
    if (after && t > e.next && t < e.dur - 500) { e.next = t + 300; e.add('heart', rand(-30, -10), -95, rand(-10, 10), -35, 1000, rand(6, 9)); }
    return [b, c];
  },
  love(e, t) {
    const s = t / 1000, up = backOut((t - 150) / 400), beat = 1 + 0.16 * Math.pow(Math.max(0, Math.sin(s * 7)), 6);
    const hx = -30, hy = -122 + 4 * Math.sin(s * 3);
    const b = { x: -30, y: -3 * Math.abs(Math.sin(s * 3.5)), armL: 0.95 * up, armR: 0.95 * up, eyes: 'happy', mouth: 'open', blush: 0.9 };
    b.hold = (g) => { if (up > 0.05) heart(g, 0, -118 + 4 * Math.sin(s * 3), 26 * up * beat, RED); };
    const c = { x: 32, rot: 0.08 * Math.sin(s * 2.5), eyes: 'heart', mouth: 'smile', blush: 1, angL: 0.9, angR: -0.9, frontL: true, frontR: true, t: s, y: -3 * Math.abs(Math.sin(s * 2.5 + 1)) };
    b.frontL = b.frontR = true;
    if (t > 400 && t > e.next && t < e.dur - 500) { e.next = t + 230; e.add('heart', hx + rand(-10, 10), hy + 10, rand(-25, 35), -45, 1100, rand(5, 8)); }
    return [b, c];
  },
  party(e, t) {
    const s = t / 1000, bb = Math.abs(Math.sin(s * Math.PI * 2)), cb = Math.abs(Math.sin(s * Math.PI * 2 + Math.PI / 2)), alt = Math.sin(s * Math.PI * 2);
    const b = { x: -31 + 4 * Math.sin(s * Math.PI), y: -9 * bb, squash: 0.06 * (1 - bb), rot: 0.14 * alt, armL: alt > 0 ? 1 : 0.3, armR: alt > 0 ? 0.3 : 1, eyes: 'happy', mouth: 'open', blush: 0.8 };
    const c = { x: 33 - 4 * Math.sin(s * Math.PI), y: -9 * cb, squash: 0.06 * (1 - cb), rot: -0.14 * alt, armL: alt > 0 ? 0.3 : 1, armR: alt > 0 ? 1 : 0.3, eyes: 'happy', mouth: 'open', blush: 0.9, t: s * 2 };
    if (t > e.next && t < e.dur - 500) {
      e.next = t + 140;
      if (Math.random() < 0.4) e.add('note', rand(-60, 60), -100, rand(-15, 15), -40, 1100, rand(7, 10), `hsl(${rand(0, 360)},90%,65%)`);
      else e.add('confetti', rand(-60, 60), -130, rand(-20, 20), rand(40, 70), 1100, 4, `hsl(${rand(0, 360)},90%,60%)`);
    }
    return [b, c];
  },
  comfort(e, t) {
    const s = t / 1000, ok = t > 2300, come = ease((t - 300) / 600), pat = t > 900 && !ok ? Math.abs(Math.sin(s * 9)) : 0;
    const c = { x: 28 + (ok ? 0 : 1.2 * Math.sin(s * 40)), y: ok ? -4 * Math.abs(Math.sin(s * 7)) : 0, eyes: ok ? 'happy' : 'cry', mouth: ok ? 'smile' : 'wail', blush: ok ? 1 : 0.5, armL: ok ? 0.5 : 0.15, armR: ok ? 0.5 : 0.15, tilt: ok ? 0 : 0.1, t: s };
    const b = { x: lerp(-50, -20, come), y: t < 900 && t > 300 ? walkHop(t) : 0, eyes: ok ? 'happy' : 'worried', mouth: ok ? 'smile' : 'frown', blush: 0.6, armL: 0.15, rot: 0.08, frontR: t > 800, angR: t > 800 ? -2.55 + 0.15 * pat : -0.4, lenR: t > 800 ? 38 : 22 };
    if (!ok && t > 200 && t > e.next) { e.next = t + 160; const sx = Math.random() < 0.5 ? -1 : 1; e.add('tear', 28 + sx * 9, -50, sx * rand(20, 40), -30, 600, 3.6, null, 140); }
    if (!e.flags.fine && ok) { e.flags.fine = true; e.add('bigheart', 28, -110, 0, -15, 1000, 12); for (let i = 0; i < 6; i++) e.add('sparkle', 28 + rand(-25, 25), -90 + rand(-15, 15), rand(-20, 20), -20, 600, 4); }
    return [b, c];
  },
  sulk(e, t) {
    const s = t / 1000, forgive = t > 2300, come = ease((t - 200) / 700);
    const c = { x: 32, eyes: forgive ? 'happy' : 'huff', mouth: forgive ? 'smile' : 'pout', blush: forgive ? 1 : 0.4, tilt: forgive ? 0 : -0.18, frontL: !forgive, frontR: !forgive, angL: forgive ? 0.6 : -0.9, angR: forgive ? -0.6 : 0.9, t: s, y: forgive ? -5 * Math.abs(Math.sin(s * 7)) : 0 };
    const b = { x: lerp(-52, -30, come), y: t > 200 && t < 900 ? walkHop(t) : 0, rot: forgive ? 0 : 0.16, eyes: forgive ? 'happy' : 'worried', mouth: forgive ? 'open' : 'frown', blush: 0.7, armL: 0.2, frontR: true, angR: forgive ? -0.5 : -0.95,
      hold: (g) => { if (!forgive) flower(g, ...paw(24, -40, -0.95, 28), 1); } };
    if (forgive) c.hold = (g) => flower(g, ...paw(19, -32, -0.6, 24), 1);
    e.anger = forgive ? 0 : backOut((t - 150) / 300) * (1 + 0.15 * Math.sin(s * 12));
    if (!e.flags.yay && forgive) { e.flags.yay = true; e.add('bigheart', 32, -112, 0, -15, 1000, 12); }
    return [b, c];
  },
  gift(e, t) {
    const s = t / 1000, come = ease(t / 800), opened = t > 1400, give = ease((t - 800) / 400);
    const b = { x: lerp(-58, -32, come), y: t < 800 ? walkHop(t) : 0, eyes: opened ? 'happy' : 'dot', mouth: 'open', blush: 0.7, frontL: true, frontR: true, angL: -0.9 + 0.5 * give, angR: -1.3, rot: 0.06 };
    const bx = lerp(lerp(-58, -32, come) + 28, 2, give), lid = opened ? ease((t - 1400) / 300) * 26 : 0;
    e.prop = (g) => giftBox(g, bx, -14, 0.9, lid, opened ? ease((t - 1400) / 300) * 1.2 : 0);
    const c = { x: 35, y: opened ? -10 * Math.abs(Math.sin(s * 7)) : 0, eyes: opened ? 'happy' : 'sparkle', mouth: opened ? 'open' : 'smile', blush: 1, armL: opened ? 1 : 0.3, armR: opened ? 1 : 0.3, t: s };
    if (!e.flags.open && opened) { e.flags.open = true; e.add('bigheart', 2, -40, 0, -45, 1300, 14); for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + rand(-1.2, 1.2); e.add('sparkle', 2, -38, Math.cos(a) * 70, Math.sin(a) * 70, 700, 5); } }
    return [b, c];
  },
};

// ---------- the layer ----------
export function createDuo(canvas, { clean = false } = {}) { // clean: no glow or shadow (picker artwork)
  const g = canvas.getContext('2d');
  let W = 1, H = 1, dpr = 1;
  const list = [];
  function resize(w, h, d) { W = w; H = h; dpr = d; canvas.width = Math.round(w * d); canvas.height = Math.round(h * d); canvas.style.width = w + 'px'; canvas.style.height = h + 'px'; }
  function play({ emote, x, y, size }) {
    const e = { k: emote, x, y, size, t: 0, dur: DUR[emote] ?? 3300, parts: [], flags: {}, next: 0 };
    e.add = (type, px, py, vx, vy, life, s, color = null, gy = 0) => e.parts.push({ type, x: px, y: py, vx, vy, life, s, color, gy, born: e.t, rot: rand(-0.5, 0.5) });
    list.push(e);
  }
  function step(dtMs) {
    for (let i = list.length - 1; i >= 0; i--) { const e = list[i]; e.t += dtMs; if (e.t >= e.dur) list.splice(i, 1); }
    return list.length > 0;
  }
  function draw(e) {
    const t = e.t, k = e.k;
    const inn = backOut(t / 380), out = 1 - ease((t - (e.dur - 320)) / 320);
    // the stage: as wide as the seat (1.65 x the picture), feet just under the picture
    const scale = ((e.size * 1.65) / 165) * Math.max(0.001, inn * out);
    g.save();
    g.translate(e.x, e.y + e.size * 0.5);
    g.scale(scale, scale);
    g.globalAlpha = clamp01(out * 1.4);
    const glow = g.createRadialGradient(0, -50, 4, 0, -50, 80); glow.addColorStop(0, 'rgba(255,170,200,.42)'); glow.addColorStop(1, 'rgba(255,170,200,0)');
    if (!clean) { g.fillStyle = glow; g.fillRect(-80, -130, 160, 160); g.fillStyle = 'rgba(0,0,0,.16)'; g.beginPath(); g.ellipse(0, 1, 62, 6, 0, 0, Math.PI * 2); g.fill(); }
    e.prop = null; e.anger = 0;
    const [b, c] = SCENES[k](e, t);
    mochi(g, b); tofu(g, c);
    e.prop?.(g);
    mochi(g, b, 'front'); tofu(g, c, 'front');
    if (e.anger > 0) angerMark(g, c.x + 20, -96, 7 * e.anger);
    for (let i = e.parts.length - 1; i >= 0; i--) {
      const q = e.parts[i], a = (t - q.born) / q.life;
      if (a >= 1) { e.parts.splice(i, 1); continue; }
      const sec = (t - q.born) / 1000;
      const px = q.x + q.vx * sec, py = q.y + q.vy * sec + 0.5 * q.gy * sec * sec;
      g.save(); g.globalAlpha = clamp01(out * 1.4) * (a > 0.7 ? (1 - a) / 0.3 : 1);
      const grow = backOut(a / 0.2);
      if (q.type === 'heart') heart(g, px + 4 * Math.sin(sec * 6), py, q.s * grow, a % 0.5 < 0.25 ? RED : PINK);
      else if (q.type === 'bigheart') heart(g, px, py, q.s * grow * (1 + 0.1 * Math.sin(sec * 14)), RED);
      else if (q.type === 'sparkle') sparkle(g, px, py, q.s * (1 - a * 0.5));
      else if (q.type === 'tear') tear(g, px, py, q.s);
      else if (q.type === 'note') note(g, px + 5 * Math.sin(sec * 5), py, q.s * grow, q.color);
      else if (q.type === 'confetti') { g.translate(px, py); g.rotate(q.rot + sec * 6); g.fillStyle = q.color; g.fillRect(-q.s / 2, -q.s, q.s, q.s * 2); }
      g.restore();
    }
    g.restore();
  }
  function render() {
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    for (const e of list) draw(e);
  }
  return { play, step, render, resize, active: () => list.length > 0, list };
}
