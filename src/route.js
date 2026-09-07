import RAPIER from '@dimforge/rapier2d-compat';
import * as PIXI from 'pixi.js';
import { mulberry32, normalizeSeed, clamp, smoothstep } from './utils.js';
import { drawIce } from './glace.js';

export const TRACK_LENGTH = 12000;

export const PX_PER_M = 10;

export const DX = 20;

export const START_X = -600;

export const END_X = START_X + TRACK_LENGTH;

export const DIFFICULTIES = {
  easy: { A1: 45, L1: 1100, A2: 12, L2: 320, A3: 0, stepNoise: 140, slopeMaxDeg: 20, color: '#34d399' },
  medium: { A1: 90, L1: 900, A2: 35, L2: 260, A3: 18, stepNoise: 140, slopeMaxDeg: 35, color: '#60a5fa' },
  hard: { A1: 140, L1: 750, A2: 70, L2: 200, A3: 45, stepNoise: 90, slopeMaxDeg: 50, color: '#f472b6' },
};

const TAU = Math.PI * 2;

export function normalizeDifficulty(d) {
  const s = String(d || '').toLowerCase();
  return s === 'easy' || s === 'hard' ? s : 'medium';
}

function makeNoise1D(rng, step, x0, x1) {
  const n = Math.ceil((x1 - x0) / step) + 4;
  const lattice = new Array(n);
  for (let i = 0; i < n; i++) lattice[i] = rng() * 2 - 1;
  return (x) => {
    const t = (x - x0) / step;
    const i = Math.floor(t);
    const f = t - i;
    const a = lattice[clamp(i, 0, n - 2)];
    const b = lattice[clamp(i + 1, 0, n - 1)];
    const u = (1 - Math.cos(f * Math.PI)) / 2;
    return a + (b - a) * u;
  };
}

export function generateRoute(seed, difficulty) {
  const s = normalizeSeed(seed);
  const diff = normalizeDifficulty(difficulty);
  const P = DIFFICULTIES[diff];
  const rng = mulberry32(s);

  const phi1 = rng() * TAU;
  const phi2 = rng() * TAU;

  const n1 = makeNoise1D(rng, P.stepNoise || 140, START_X, END_X);
  const n2 = makeNoise1D(rng, (P.stepNoise || 140) / 2.7, START_X, END_X);
  const wob = makeNoise1D(rng, 430, START_X, END_X);
  const warpAmp = P.L1 * 0.18;

  const rawY = (x) => {
    const env = smoothstep(200, 800, x);
    const xw = x + warpAmp * wob(x);
    const fbm = 0.65 * n1(xw) + 0.35 * n2(xw + 13.7);
    return env * (P.A1 * Math.sin((TAU * xw) / P.L1 + phi1) + P.A2 * Math.sin((TAU * xw) / P.L2 + phi2) + P.A3 * fbm);
  };

  const maxDy = Math.tan((P.slopeMaxDeg * Math.PI) / 180) * DX;

  const maxDCurv = DX * Math.tan((10 * Math.PI) / 180);
  const points = [];
  let prevY = 0;
  let prevDy = 0;
  for (let x = START_X; x <= END_X + 0.5; x += DX) {
    const target = x <= 200 ? 0 : rawY(x);
    const dy = clamp(clamp(target - prevY, prevDy - maxDCurv, prevDy + maxDCurv), -maxDy, maxDy);
    prevDy = dy;
    prevY += dy;
    points.push({ x, y: prevY });
  }

  for (let pass = 0; pass < 2; pass++) {
    const src = points.map((p) => p.y);
    for (let i = 0; i < points.length; i++) {
      if (points[i].x <= 200) continue;
      const ym = src[Math.max(0, i - 1)];
      const yp = src[Math.min(src.length - 1, i + 1)];
      points[i].y = ym * 0.25 + src[i] * 0.5 + yp * 0.25;
    }
  }
  return { points, seed: s, difficulty: diff };
}

export function buildRouteColliders(world, points) {
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const colliders = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const segLen = Math.hypot(b.x - a.x, b.y - a.y);
    const halfLen = segLen / 2 + 0.5;

    const nx = (b.y - a.y) / (segLen || 1);
    const ny = -(b.x - a.x) / (segLen || 1);
    const desc = RAPIER.ColliderDesc.cuboid(halfLen, 10)
      .setTranslation(mx - nx * 10, my - ny * 10)
      .setRotation(Math.atan2(b.y - a.y, b.x - a.x))
      .setFriction(1.5)
      .setRestitution(0)
      .setCollisionGroups(((0x0001 << 16) | 0xffff) >>> 0);
    colliders.push(world.createCollider(desc, body));
  }
  return { body, colliders };
}

export function clearRouteColliders(world, handle) {
  if (handle && handle.body) world.removeRigidBody(handle.body);
}

export function drawRoute(graphics, points, difficulty, seed = 1) {
  drawIce(graphics, points, difficulty, seed);

  const y0 = routeYAt(points, 0);
  graphics.moveTo(0, y0).lineTo(0, y0 - 46);
  graphics.stroke({ width: 3, color: '#e5e7eb' });
  graphics.moveTo(0, y0 - 46).lineTo(26, y0 - 38).lineTo(0, y0 - 30);
  graphics.closePath();
  graphics.fill({ color: '#e5e7eb' });

  const parent = graphics.parent;
  for (let d = 100; d * PX_PER_M <= END_X; d += 100) {
    const x = d * PX_PER_M;
    const y = routeYAt(points, x);
    graphics.moveTo(x, y - 2).lineTo(x, y - 12);
    graphics.stroke({ width: 2, color: '#3a4356' });
    if (parent) {
      const label = new PIXI.Text({
        text: `${d}m`,
        style: { fontFamily: 'ui-monospace, monospace', fontSize: 12, fill: '#8b93a7' },
      });
      label.anchor.set(0.5, 1);
      label.position.set(x, y - 14);
      label.label = 'route-decor';
      parent.addChild(label);
    }
  }
}

export function clearRouteDecor(parent) {
  if (!parent) return;
  for (const c of [...parent.children]) {
    if (c.label === 'route-decor') parent.removeChild(c).destroy();
  }
}

export function routeYAt(points, x) {
  if (x <= points[0].x) return points[0].y;
  const last = points[points.length - 1];
  if (x >= last.x) return last.y;
  let lo = 0;
  let hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].x <= x) lo = mid;
    else hi = mid;
  }
  const a = points[lo];
  const b = points[hi];
  const t = (x - a.x) / (b.x - a.x);
  return a.y + (b.y - a.y) * t;
}

