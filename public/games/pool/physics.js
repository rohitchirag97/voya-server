// 8 Ball Pool physics, shared: the server (services/pool.ts) runs it to decide every shot, the table page runs the
// same code to animate the shot it was sent, then snaps to the server's result.
// Only + - * / and Math.sqrt (no hypot/sin/cos), so Bun and the phone's WebView compute the same numbers.
//
// Units: metres and seconds. Playing surface (inside the cushion noses): x = 0 (head rail) .. L (foot rail), y = 0 .. W.
// Each ball: position, velocity, and spin (wx, wy about the table axes, wz about the vertical). The cloth grips the
// ball where it touches: a ball slides (strong friction, spin and velocity converge) until it rolls naturally, then
// only rolling resistance slows it. That gives real stun, follow and draw: after hitting a ball the cue ball keeps
// its spin, and the cloth turns that spin into forward or backward motion.

export const L = 2.24; // 8 ft table
export const W = 1.12;
export const R = 0.028575; // 2 1/4" ball
export const HEAD_X = L / 4; // head string; the kitchen is x <= HEAD_X
export const HEAD = { x: HEAD_X, y: W / 2 };
export const FOOT = { x: (3 * L) / 4, y: W / 2 };
export const MAX_SPEED = 7; // m/s at full power (a hard break)
export const DT = 0.001; // one step = 1 ms
const MAX_T = 40; // a shot never runs longer than this
const G = 9.81;
const MU_SLIDE = 0.2; // ball-cloth sliding friction
const MU_ROLL = 0.015; // rolling resistance
const SPIN_DECAY = 10; // rad/s² of side spin the cloth takes away
const E_BALL = 0.95; // ball-ball restitution
const E_RAIL = 0.78; // cushion restitution
const RAIL_ENGLISH = 0.2; // how much side spin bends a cushion rebound

// Pocket mouths: how far from the corner (along each rail) and from the middle of a long rail the cushions stop.
export const CORNER = 0.07;
export const SIDE = 0.062;
export const JAW = 0.045; // how far the pocket jaws run back into the rail

// A ball whose centre comes within r of a pocket centre drops.
export const POCKETS = [
  { x: -0.022, y: -0.022, r: 0.062 },
  { x: L / 2, y: -0.034, r: 0.058 },
  { x: L + 0.022, y: -0.022, r: 0.062 },
  { x: -0.022, y: W + 0.022, r: 0.062 },
  { x: L / 2, y: W + 0.034, r: 0.058 },
  { x: L + 0.022, y: W + 0.022, r: 0.062 },
];

// Cushion noses and pocket jaws, as segments [x1, y1, x2, y2]. A ball bounces off the nearest point of a segment, so
// the rounded ends of the cushions (the jaw points) rattle balls like a real pocket.
export const CUSHIONS = [
  [CORNER, 0, L / 2 - SIDE, 0], [L / 2 + SIDE, 0, L - CORNER, 0],
  [CORNER, W, L / 2 - SIDE, W], [L / 2 + SIDE, W, L - CORNER, W],
  [0, CORNER, 0, W - CORNER], [L, CORNER, L, W - CORNER],
  // corner jaws, at 45 degrees
  [CORNER, 0, CORNER - JAW, -JAW], [0, CORNER, -JAW, CORNER - JAW],
  [L - CORNER, 0, L - CORNER + JAW, -JAW], [L, CORNER, L + JAW, CORNER - JAW],
  [CORNER, W, CORNER - JAW, W + JAW], [0, W - CORNER, -JAW, W - CORNER + JAW],
  [L - CORNER, W, L - CORNER + JAW, W + JAW], [L, W - CORNER, L + JAW, W - CORNER + JAW],
  // side jaws, slightly narrowing
  [L / 2 - SIDE, 0, L / 2 - SIDE + 0.01, -JAW], [L / 2 + SIDE, 0, L / 2 + SIDE - 0.01, -JAW],
  [L / 2 - SIDE, W, L / 2 - SIDE + 0.01, W + JAW], [L / 2 + SIDE, W, L / 2 + SIDE - 0.01, W + JAW],
];

// The standard rack: apex on the foot spot, the 8 in the middle, a solid and a stripe in the back corners.
const RACK = [[1], [9, 2], [10, 8, 3], [11, 4, 12, 5], [6, 13, 14, 7, 15]];
export function rack() {
  const gap = 2 * R + 0.0002;
  const balls = [{ n: 0, x: HEAD.x, y: HEAD.y }];
  RACK.forEach((row, i) => row.forEach((n, j) => balls.push({ n, x: FOOT.x + i * gap * 0.8660254037844386, y: FOOT.y + (j - (row.length - 1) / 2) * gap })));
  return balls;
}

// A table ready to shoot: balls = [{ n, x, y }] (n 0 = cue ball).
/** @param {{ n: number, x: number, y: number }[]} balls */
export function createSim(balls) {
  return {
    balls: balls.map((b) => ({ n: b.n, x: b.x, y: b.y, vx: 0, vy: 0, wx: 0, wy: 0, wz: 0, on: true })),
    t: 0,
    firstHit: /** @type {number | null} */ (null), // the first ball the cue ball touched
    rail: false, // any ball reached a cushion after that first contact
    potted: /** @type {number[]} */ ([]), // in the order they dropped
    done: false,
  };
}

// The cue hits the cue ball. shot: dx, dy = unit direction; power 0..1; sx, sy = where the tip hits, in the unit disc
// (sx > 0: right of centre, sy > 0: above centre), up to half a radius from centre.
export function strike(sim, shot) {
  const b = sim.balls.find((x) => x.n === 0);
  const v = 0.25 + shot.power * (MAX_SPEED - 0.25);
  b.vx = shot.dx * v;
  b.vy = shot.dy * v;
  const top = (2.5 * v * 0.5 * shot.sy) / R; // spin about the horizontal axis across the shot (5 v b / 2R², b = sy R/2)
  b.wx = -shot.dy * top;
  b.wy = shot.dx * top;
  b.wz = (2.5 * v * 0.5 * shot.sx) / R; // right of centre = counter-clockwise seen from above
}

// One 1 ms step. onEvent(kind, n, strength) is called for sounds: "ball", "rail", "pocket".
export function step(sim, onEvent) {
  const bs = sim.balls;
  let moving = false;
  for (const b of bs) {
    if (!b.on) continue;
    if (b.vx === 0 && b.vy === 0 && b.wx === 0 && b.wy === 0) {
      b.wz = 0;
      continue;
    }
    moving = true;
    const ux = b.vx - R * b.wy; // where the ball touches the cloth: how fast it slips
    const uy = b.vy + R * b.wx;
    const u = Math.sqrt(ux * ux + uy * uy);
    if (u > 3.5 * MU_SLIDE * G * DT) {
      const k = (MU_SLIDE * G * DT) / u;
      b.vx -= k * ux;
      b.vy -= k * uy;
      const kw = (2.5 * k) / R;
      b.wx -= kw * uy;
      b.wy += kw * ux;
    } else {
      b.vx -= (2 / 7) * ux; // the last bit of slip: now rolling
      b.vy -= (2 / 7) * uy;
      const sp = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
      const dec = MU_ROLL * G * DT;
      if (sp <= dec) {
        b.vx = 0;
        b.vy = 0;
      } else {
        b.vx -= (b.vx / sp) * dec;
        b.vy -= (b.vy / sp) * dec;
      }
      b.wx = -b.vy / R;
      b.wy = b.vx / R;
    }
    const dz = SPIN_DECAY * DT;
    b.wz = b.wz > dz ? b.wz - dz : b.wz < -dz ? b.wz + dz : 0;
    b.x += b.vx * DT;
    b.y += b.vy * DT;
  }

  // ball against ball: equal masses, the push along the line of centres; spins are kept
  for (let i = 0; i < bs.length; i++) {
    const a = bs[i];
    if (!a.on) continue;
    for (let j = i + 1; j < bs.length; j++) {
      const c = bs[j];
      if (!c.on) continue;
      const dx = c.x - a.x;
      const dy = c.y - a.y;
      const d2 = dx * dx + dy * dy;
      if (d2 >= 4 * R * R) continue;
      const d = Math.sqrt(d2) || 1e-9;
      const nx = dx / d;
      const ny = dy / d;
      const push = (2 * R - d) / 2;
      a.x -= nx * push;
      a.y -= ny * push;
      c.x += nx * push;
      c.y += ny * push;
      const rel = (a.vx - c.vx) * nx + (a.vy - c.vy) * ny;
      if (rel <= 0) continue;
      const J = ((1 + E_BALL) / 2) * rel;
      a.vx -= J * nx;
      a.vy -= J * ny;
      c.vx += J * nx;
      c.vy += J * ny;
      if (sim.firstHit === null && (a.n === 0 || c.n === 0)) sim.firstHit = a.n === 0 ? c.n : a.n;
      onEvent?.("ball", a.n, rel);
    }
  }

  // cushions (only balls near the edge can touch one)
  for (const b of bs) {
    if (!b.on || (b.x > R + 0.01 && b.x < L - R - 0.01 && b.y > R + 0.01 && b.y < W - R - 0.01)) continue;
    for (const s of CUSHIONS) {
      const ex = s[2] - s[0];
      const ey = s[3] - s[1];
      let t = ((b.x - s[0]) * ex + (b.y - s[1]) * ey) / (ex * ex + ey * ey);
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = b.x - (s[0] + t * ex);
      const dy = b.y - (s[1] + t * ey);
      const d2 = dx * dx + dy * dy;
      if (d2 >= R * R) continue;
      const d = Math.sqrt(d2) || 1e-9;
      const nx = dx / d;
      const ny = dy / d;
      b.x += nx * (R - d);
      b.y += ny * (R - d);
      const vn = b.vx * nx + b.vy * ny;
      if (vn >= 0) continue;
      b.vx -= (1 + E_RAIL) * vn * nx;
      b.vy -= (1 + E_RAIL) * vn * ny;
      // side spin grips the cushion and bends the rebound (running / reverse english)
      let kick = RAIL_ENGLISH * R * b.wz;
      const cap = -vn * 0.6;
      kick = kick > cap ? cap : kick < -cap ? -cap : kick;
      b.vx -= kick * ny;
      b.vy += kick * nx;
      b.wz *= 0.6;
      if (sim.firstHit !== null) sim.rail = true;
      onEvent?.("rail", b.n, -vn);
    }
  }

  // pockets; anything that somehow left the table counts as pocketed too
  for (const b of bs) {
    if (!b.on) continue;
    let drop = b.x < -R - JAW || b.x > L + R + JAW || b.y < -R - JAW || b.y > W + R + JAW;
    for (const p of POCKETS) {
      const dx = b.x - p.x;
      const dy = b.y - p.y;
      if (dx * dx + dy * dy < p.r * p.r) drop = true;
    }
    if (!drop) continue;
    b.on = false;
    sim.potted.push(b.n);
    onEvent?.("pocket", b.n, Math.sqrt(b.vx * b.vx + b.vy * b.vy));
    b.vx = b.vy = b.wx = b.wy = b.wz = 0;
  }

  sim.t += DT;
  if (!moving || sim.t >= MAX_T) {
    for (const b of bs) b.vx = b.vy = b.wx = b.wy = b.wz = 0;
    sim.done = true;
  }
}

// What a shot does, start to finish.
/** @param {{ n: number, x: number, y: number }[]} balls @param {{ dx: number, dy: number, power: number, sx: number, sy: number }} shot */
export function simulate(balls, shot) {
  const sim = createSim(balls);
  strike(sim, shot);
  while (!sim.done) step(sim);
  return {
    to: sim.balls.filter((b) => b.on).map((b) => ({ n: b.n, x: b.x, y: b.y })),
    potted: sim.potted,
    firstHit: sim.firstHit,
    rail: sim.rail,
    ms: Math.round(sim.t * 1000),
  };
}
