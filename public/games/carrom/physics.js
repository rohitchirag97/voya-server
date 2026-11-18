// Carrom physics, shared: the server (services/carrom.ts) runs it to decide every shot, the board page runs the same
// code to animate the shot it was sent, then snaps to the server's result.
// Only + - * / and Math.sqrt (no trig at run time), so Bun and the phone's WebView compute the same numbers.
//
// Units: metres and seconds. Playing surface: x, y = 0 .. S (inside the cushions), y grows towards side 0 (the
// bottom). Discs slide on a powdered board: friction takes off a fixed amount of speed per second, and they bounce off
// each other and the cushions. Sizes follow the international (ICF) board.

export const S = 0.74; // playing surface, square
export const R = 0.0159; // carrom men (coins), 3.18 cm
export const RS = 0.0206; // the striker, 4.13 cm
export const POCKET_R = 0.0222; // pockets, 4.45 cm, in the corners
export const P_IN = POCKET_R + 0.001; // pocket centre, from each edge
export const POCKETS = [
  { x: P_IN, y: P_IN },
  { x: S - P_IN, y: P_IN },
  { x: P_IN, y: S - P_IN },
  { x: S - P_IN, y: S - P_IN },
];
// Each side's baseline (where its player places the striker): the centre line runs this far in from the edge, and is
// BASE_LEN long, centred.
export const BASE_IN = 0.1015 + 0.0159;
export const BASE_LEN = 0.47;
export const MAX_SPEED = 5.5; // m/s at full power
const MIN_SPEED = 0.25;
const MASS_STRIKER = 2.7; // relative to a coin
const DECEL = 1.6; // m/s² of friction on the powdered board
const E_DISC = 0.9; // disc-disc restitution
const E_RAIL = 0.72; // cushion restitution
export const DT = 0.001;
const MAX_T = 25;

// 9 white (n 0-8), 9 black (n 9-17), the queen (18), racked in the centre: the queen, six around her, twelve around
// those, colours alternating. cos/sin of the needed angles are written out so no trig runs.
export const WHITE = (n) => n < 9;
export const QUEEN = 18;
const H = 0.8660254037844386; // √3 / 2
const RING1 = [[1, 0], [0.5, H], [-0.5, H], [-1, 0], [-0.5, -H], [0.5, -H]];
const RING2 = [[2, 0], [1.5, H], [1, 2 * H], [0, 2 * H], [-1, 2 * H], [-1.5, H], [-2, 0], [-1.5, -H], [-1, -2 * H], [0, -2 * H], [1, -2 * H], [1.5, -H]];
export function rack() {
  const c = S / 2, g = 2 * R + 0.0004;
  const coins = [{ n: QUEEN, x: c, y: c }];
  let w = 0, b = 9;
  RING1.forEach(([u, v], i) => coins.push({ n: i % 2 === 0 ? w++ : b++, x: c + u * g, y: c + v * g }));
  RING2.forEach(([u, v], i) => coins.push({ n: i % 2 === 0 ? b++ : w++, x: c + u * g, y: c + v * g }));
  return coins;
}

// Side k's baseline: the striker's centre at position t (0..1 along the line, left to right as that player sees
// it), and the direction pointing into the board from that side.
export function baseline(side, t) {
  const a = (S - BASE_LEN) / 2 + t * BASE_LEN;
  if (side === 0) return { x: a, y: S - BASE_IN, inX: 0, inY: -1 };
  if (side === 1) return { x: BASE_IN, y: a, inX: 1, inY: 0 }; // left side
  if (side === 2) return { x: S - a, y: BASE_IN, inX: 0, inY: 1 };
  return { x: S - BASE_IN, y: S - a, inX: -1, inY: 0 }; // right side
}

/** @param {{ n: number, x: number, y: number }[]} coins @param {{ x: number, y: number }} striker */
export function createSim(coins, striker) {
  return {
    discs: [{ n: -1, x: striker.x, y: striker.y, vx: 0, vy: 0, r: RS, m: MASS_STRIKER, on: true }, ...coins.map((c) => ({ n: c.n, x: c.x, y: c.y, vx: 0, vy: 0, r: R, m: 1, on: true }))],
    t: 0,
    potted: /** @type {number[]} */ ([]), // coins, in the order they dropped
    strikerPotted: false,
    done: false,
  };
}

// The flick: dx, dy = unit direction; power 0..1.
export function strike(sim, shot) {
  const v = MIN_SPEED + shot.power * (MAX_SPEED - MIN_SPEED);
  sim.discs[0].vx = shot.dx * v;
  sim.discs[0].vy = shot.dy * v;
}

// One 1 ms step. onEvent(kind, n, strength) for sounds: "disc", "rail", "pocket".
export function step(sim, onEvent) {
  const ds = sim.discs;
  let moving = false;
  for (const d of ds) {
    if (!d.on || (d.vx === 0 && d.vy === 0)) continue;
    moving = true;
    const sp = Math.sqrt(d.vx * d.vx + d.vy * d.vy);
    const dec = DECEL * DT;
    if (sp <= dec) { d.vx = 0; d.vy = 0; continue; }
    d.vx -= (d.vx / sp) * dec;
    d.vy -= (d.vy / sp) * dec;
    d.x += d.vx * DT;
    d.y += d.vy * DT;
  }

  // disc against disc: momentum kept, restitution E_DISC along the line of centres
  for (let i = 0; i < ds.length; i++) {
    const a = ds[i];
    if (!a.on) continue;
    for (let j = i + 1; j < ds.length; j++) {
      const c = ds[j];
      if (!c.on) continue;
      const dx = c.x - a.x, dy = c.y - a.y, rr = a.r + c.r;
      const d2 = dx * dx + dy * dy;
      if (d2 >= rr * rr) continue;
      const d = Math.sqrt(d2) || 1e-9;
      const nx = dx / d, ny = dy / d;
      const over = rr - d, ma = a.m, mc = c.m, mt = ma + mc;
      a.x -= nx * over * (mc / mt);
      a.y -= ny * over * (mc / mt);
      c.x += nx * over * (ma / mt);
      c.y += ny * over * (ma / mt);
      const rel = (a.vx - c.vx) * nx + (a.vy - c.vy) * ny;
      if (rel <= 0) continue;
      const J = ((1 + E_DISC) * rel) / (1 / ma + 1 / mc);
      a.vx -= (J / ma) * nx;
      a.vy -= (J / ma) * ny;
      c.vx += (J / mc) * nx;
      c.vy += (J / mc) * ny;
      onEvent?.("disc", c.n, rel);
    }
  }

  // pockets first (a disc over a pocket mouth drops instead of bouncing), then the four cushions
  for (const d of ds) {
    if (!d.on) continue;
    let drop = false;
    for (const p of POCKETS) {
      const dx = d.x - p.x, dy = d.y - p.y;
      if (dx * dx + dy * dy < POCKET_R * POCKET_R) drop = true;
    }
    if (drop) {
      d.on = false;
      d.vx = d.vy = 0;
      if (d.n < 0) sim.strikerPotted = true;
      else sim.potted.push(d.n);
      onEvent?.("pocket", d.n, 1);
      continue;
    }
    if (d.x < d.r) { d.x = d.r; if (d.vx < 0) { onEvent?.("rail", d.n, -d.vx); d.vx = -d.vx * E_RAIL; } }
    if (d.x > S - d.r) { d.x = S - d.r; if (d.vx > 0) { onEvent?.("rail", d.n, d.vx); d.vx = -d.vx * E_RAIL; } }
    if (d.y < d.r) { d.y = d.r; if (d.vy < 0) { onEvent?.("rail", d.n, -d.vy); d.vy = -d.vy * E_RAIL; } }
    if (d.y > S - d.r) { d.y = S - d.r; if (d.vy > 0) { onEvent?.("rail", d.n, d.vy); d.vy = -d.vy * E_RAIL; } }
  }

  sim.t += DT;
  if (!moving || sim.t >= MAX_T) {
    for (const d of ds) d.vx = d.vy = 0;
    sim.done = true;
  }
}

// What a shot does, start to finish: where the coins end up (the striker always comes back), what dropped.
export function simulate(coins, striker, shot) {
  const sim = createSim(coins, striker);
  strike(sim, shot);
  while (!sim.done) step(sim);
  return {
    to: sim.discs.filter((d) => d.on && d.n >= 0).map((d) => ({ n: d.n, x: d.x, y: d.y })),
    potted: sim.potted,
    strikerPotted: sim.strikerPotted,
    ms: Math.round(sim.t * 1000),
  };
}
