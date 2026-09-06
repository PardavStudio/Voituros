import { mulberry32 } from './utils.js';
import { routeYAt } from './route.js';

export const ICE_DEPTH = 150;

export const ICE_TINTS = {
  easy: { top: '#d8eff7', mid: '#7fb8d9', deep: '#1d5a85' },
  medium: { top: '#cfe8f5', mid: '#6fa9cf', deep: '#174e78' },
  hard: { top: '#c2ddf0', mid: '#6399c2', deep: '#123f66' },
};

function mixHex(a, b, t) {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const c = (x, y) => Math.round(x + (y - x) * t);
  const r = c((pa >> 16) & 255, (pb >> 16) & 255);
  const g = c((pa >> 8) & 255, (pb >> 8) & 255);
  const bl = c(pa & 255, pb & 255);
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${bl.toString(16).padStart(2, '0')}`;
}

function depthColor(tint, f) {
  if (f < 0.18) return mixHex(tint.top, tint.mid, f / 0.18);
  if (f < 0.55) return mixHex(tint.mid, tint.deep, (f - 0.18) / 0.37);
  return mixHex(tint.deep, '#0a2036', (f - 0.55) / 0.45);
}

export function drawIce(graphics, points, difficulty, seed) {
  const key = String(difficulty || '').toLowerCase();
  const tint = ICE_TINTS[key] || ICE_TINTS.medium;
  const n = points.length;
  const rng = mulberry32(typeof seed === 'number' ? seed : 1);

  graphics.moveTo(points[0].x, points[0].y + ICE_DEPTH);
  for (let i = 0; i < n; i++) graphics.lineTo(points[i].x, points[i].y + ICE_DEPTH);
  graphics.lineTo(points[n - 1].x, points[n - 1].y + 2000);
  graphics.lineTo(points[0].x, points[0].y + 2000);
  graphics.closePath();
  graphics.fill({ color: '#070c16' });

  const BANDS = 14;
  for (let b = 0; b < BANDS; b++) {
    const f0 = b / BANDS;
    const f1 = (b + 1) / BANDS;
    graphics.moveTo(points[0].x, points[0].y + f0 * ICE_DEPTH);
    for (let i = 1; i < n; i++) graphics.lineTo(points[i].x, points[i].y + f0 * ICE_DEPTH);
    for (let i = n - 1; i >= 0; i--) graphics.lineTo(points[i].x, points[i].y + f1 * ICE_DEPTH);
    graphics.closePath();
    graphics.fill({ color: depthColor(tint, (f0 + f1) / 2) });
  }

  const x0 = points[0].x;
  const x1 = points[n - 1].x;
  const clampCrack = (x, y) => {
    const cx = x < x0 + 10 ? x0 + 10 : x > x1 - 10 ? x1 - 10 : x;
    const sy = routeYAt(points, cx);
    const cy = y < sy + 2 ? sy + 2 : y > sy + ICE_DEPTH - 10 ? sy + ICE_DEPTH - 10 : y;
    return [cx, cy];
  };

  const cl = (p) => clampCrack(p[0], p[1]);
  const cracks = Math.floor((x1 - x0) / 90);
  for (let c = 0; c < cracks; c++) {
    let x = x0 + rng() * (x1 - x0);
    let y = routeYAt(points, x) + 3 + rng() * 8;
    let ang = (rng() - 0.5) * 0.45;
    const segs = 5 + ((rng() * 5) | 0);
    const w = rng() < 0.6 ? 1 : 2;
    const a = 0.16 + rng() * 0.29;
    let p = cl([x, y]);
    x = p[0];
    y = p[1];
    graphics.moveTo(x, y);
    for (let s = 0; s < segs; s++) {
      const len = 8 + rng() * 10;
      p = cl([x + Math.cos(ang) * len, y + Math.sin(ang) * len + 0.8]);
      x = p[0];
      y = p[1];
      graphics.lineTo(x, y);
      if (rng() < 0.3 && s > 0) {

        let bx = x;
        let by = y;
        let ba = ang + (rng() < 0.5 ? -1 : 1) * (0.6 + rng() * 0.5);
        graphics.moveTo(bx, by);
        const bs = 2 + ((rng() * 3) | 0);
        for (let k = 0; k < bs; k++) {
          const bp = cl([bx + Math.cos(ba) * (6 + rng() * 8), by + Math.sin(ba) * (6 + rng() * 8)]);
          bx = bp[0];
          by = bp[1];
          graphics.lineTo(bx, by);
        }
        graphics.moveTo(x, y);
      }
      ang += (rng() - 0.5) * 0.35;
    }
    graphics.stroke({ width: w, color: '#eaf6ff', alpha: a });
  }

  for (let r = 0; r < 3; r++) {
    let x = x0 + rng() * (x1 - x0 - 600);
    graphics.moveTo(x, routeYAt(points, x) + 4);
    const len = 300 + rng() * 300;
    for (let s = x; s < x + len; s += 24) {
      graphics.lineTo(s, routeYAt(points, s) + 4 + Math.sin(s * 0.02 + r * 2) * 3);
    }
    graphics.stroke({ width: 2.5, color: '#f2faff', alpha: 0.3 });
  }

  for (let i = 0; i < 600; i++) {
    const x = x0 + rng() * (x1 - x0);
    const y = routeYAt(points, x) + 6 + rng() * rng() * 60;
    const s = 0.8 + rng() * 1.8;
    graphics.circle(x, y, s);
    graphics.fill({ color: '#e8f4fc', alpha: 0.05 + rng() * 0.1 });
  }

  for (let i = 0; i < 500; i++) {
    const x = x0 + rng() * (x1 - x0);
    const y = routeYAt(points, x) + rng() * rng() * 14;
    const s = rng() < 0.8 ? 1 : 2;
    graphics.rect(x, y, s, s);
    graphics.fill({ color: rng() < 0.7 ? '#ffffff' : '#bfe6ff', alpha: 0.1 + rng() * 0.3 });
  }

  const nc = Math.floor((x1 - x0) / 350);
  for (let i = 0; i < nc; i++) {
    const x = x0 + rng() * (x1 - x0);
    drawCrystal(
      graphics,
      x,
      routeYAt(points, x) + 4 + rng() * 10,
      6 + rng() * 7,
      rng() * Math.PI,
      '#e8f4fc',
      0.16 + rng() * 0.16,
    );
  }

  for (let i = 0; i < 130; i++) {
    const x = x0 + rng() * (x1 - x0);
    const y = routeYAt(points, x) + 1;
    const w = 6 + rng() * 22;
    graphics.moveTo(x, y);
    graphics.lineTo(x + w, y - 0.5);
    graphics.stroke({ width: 1, color: '#f4fbff', alpha: 0.07 + rng() * 0.14 });
  }
}

export function drawCrystal(g, x, y, r, rot, color, alpha) {

  g.moveTo(x + r * 0.12, y);
  for (let k = 1; k <= 6; k++) {
    const a = (k * Math.PI) / 3;
    g.lineTo(x + Math.cos(a) * r * 0.12, y + Math.sin(a) * r * 0.12);
  }
  g.closePath();
  g.fill({ color, alpha });
  for (let b = 0; b < 6; b++) {
    const a = rot + (b * Math.PI) / 3;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const len = r * (0.94 + Math.random() * 0.12);
    g.moveTo(x, y);
    g.lineTo(x + c * len, y + s * len);
    for (const f of [0.45, 0.7]) {
      const bx = x + c * len * f;
      const by = y + s * len * f;
      const bl = len * (f < 0.5 ? 0.3 : 0.22) * (0.9 + Math.random() * 0.2);
      const ja = (Math.random() - 0.5) * 0.16;
      g.moveTo(bx, by);
      g.lineTo(bx + Math.cos(a + 1.05 + ja) * bl, by + Math.sin(a + 1.05 + ja) * bl);
      g.moveTo(bx, by);
      g.lineTo(bx + Math.cos(a - 1.05 - ja) * bl, by + Math.sin(a - 1.05 - ja) * bl);
    }
  }
  g.stroke({ width: 1.4, color, alpha });
}

export function createTwinkles(count = 36, seed = 1, x0 = -600, x1 = 11400) {
  const rng = mulberry32(typeof seed === 'number' ? seed : 1);
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push({
      x: x0 + rng() * (x1 - x0),
      tw: 0.8 + rng() * 2.4,
      ph: rng() * Math.PI * 2,
      sz: 2.5 + rng() * 4,
      rot: rng() * Math.PI,
    });
  }
  return out;
}

export function drawTwinkles(g, twinkles, t, camX, viewW, points) {
  g.clear();
  const half = viewW / 2 + 200;
  for (const p of twinkles) {
    const a = 0.5 + 0.5 * Math.sin(t * p.tw + p.ph);
    if (p.x < camX - half || p.x > camX + half) {
      if (a > 0.05) continue;
      p.x = camX + (Math.random() * 2 - 1) * half;
      p.rot = Math.random() * Math.PI;
    }
    if (a < 0.04) continue;
    const y = routeYAt(points, p.x) + 1 + (p.sz % 3);
    const r = p.sz * (0.4 + 0.6 * a);
    g.moveTo(p.x - r, y);
    g.lineTo(p.x + r, y);
    g.moveTo(p.x, y - r);
    g.lineTo(p.x, y + r);
    g.stroke({ width: 1, color: '#eaf7ff', alpha: 0.75 * a });
  }
}

