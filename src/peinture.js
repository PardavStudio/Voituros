import * as PIXI from 'pixi.js';

export const NEUTRALS = ['#f5f7fa', '#dfe3ea', '#aeb4bf', '#2a2f36', '#101216', '#c8a24a'];

export function hexToHsl(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const l = ((mx + mn) / 2) * 100;
  if (mx === mn) return { h: 0, s: 0, l };
  const d = mx - mn;
  const s = (d / (l > 50 ? 2 - mx - mn : mx + mn)) * 100;
  let h = 0;
  if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
  else if (mx === g) h = ((b - r) / d + 2) * 60;
  else h = ((r - g) / d + 4) * 60;
  return { h, s, l };
}

export function hslToHex(h, s, l) {
  h = ((h % 360) + 360) % 360;
  s = Math.min(100, Math.max(0, s)) / 100;
  l = Math.min(100, Math.max(0, l)) / 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const to = (x) => Math.round(x * 255).toString(16).padStart(2, '0');
  return `#${to(f(0))}${to(f(8))}${to(f(4))}`;
}

export function shade(hex, dl, dh = 0, ds = 0) {
  const { h, s, l } = hexToHsl(hex);
  return hslToHex(h + dh, s + ds, l + dl);
}

export function randomPaint(rng) {
  const roll = rng();
  const pattern = roll < 0.45 ? 'solid' : roll < 0.7 ? 'two-tone' : roll < 0.85 ? 'stripes' : 'skirt';
  let base;
  if (rng() < 0.2) {

    base = NEUTRALS[(rng() * 4) | 0];
  } else {

    base = hslToHex((rng() * 360) | 0, 48 + rng() * 40, 34 + rng() * 26);
  }
  const { h: bh, s: bs } = hexToHsl(base);
  let secondary;
  if (rng() < 0.45) {
    secondary = NEUTRALS[(rng() * NEUTRALS.length) | 0];
  } else if (rng() < 0.5) {
    secondary = hslToHex(bh + 25 + rng() * 35, bs, 45 + rng() * 25);
  } else {
    secondary = hslToHex(bh + 165 + rng() * 30, 40 + rng() * 35, 45 + rng() * 25);
  }

  if (pattern !== 'solid' && luminance(base) < 0.09 && luminance(secondary) < 0.09) {
    secondary = shade(secondary, 28);
  }
  const metal = 0.3 + rng() * 0.7;
  const pearl = rng() < 0.4 ? 0.2 + rng() * 0.6 : 0;
  const seed = (rng() * 1e9) | 0;
  return { base, secondary, pattern, metal, pearl, seed };
}

export function paintStops(paint) {
  const c = 0.7 + 0.6 * paint.metal;
  const ph = hexToHsl(paint.secondary).h - hexToHsl(paint.base).h;
  return [
    { offset: 0, color: shade(paint.base, 38 * c, ph * 0.25 * paint.pearl + 8, -12) },
    { offset: 0.3, color: shade(paint.base, 14 * c, ph * 0.12 * paint.pearl, -4) },
    { offset: 0.55, color: paint.base },
    { offset: 0.78, color: shade(paint.base, -16 * c, -6, 4) },
    { offset: 1, color: shade(paint.base, -30 * c, -10, 6) },
  ];
}

export function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const f = (c) => {
    const x = c / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(n >> 16) + 0.7152 * f((n >> 8) & 255) + 0.0722 * f(n & 255);
}

export function roofYAt(v, x) {
  const chain = [v[2], v[3], v[4], v[5], v[6]];
  const xs = chain.map((p) => p.x);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  if (x <= xMin) return chain[xs.indexOf(xMin)].y;
  if (x >= xMax) return chain[xs.indexOf(xMax)].y;
  for (let i = 0; i < chain.length - 1; i++) {
    const a = chain[i];
    const b = chain[i + 1];
    if ((x - a.x) * (x - b.x) <= 0 && a.x !== b.x) {
      const t = (x - a.x) / (b.x - a.x);
      return a.y + (b.y - a.y) * t;
    }
  }
  return Math.min(...chain.map((p) => p.y));
}

export function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x;
    const yi = poly[i].y;
    const xj = poly[j].x;
    const yj = poly[j].y;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function drawPaint(g, spec, paint) {
  g.clear();
  const v = spec.bodyVerts;
  const L = spec.bodyLen;
  const H = spec.bodyH;

  const grad = new PIXI.FillGradient({
    type: 'linear',
    start: { x: 0.5, y: 0 },
    end: { x: 0.5, y: 1 },
    textureSpace: 'local',
    colorStops: paintStops(paint),
  });
  g.moveTo(v[0].x, v[0].y);
  for (let i = 1; i < v.length; i++) g.lineTo(v[i].x, v[i].y);
  g.closePath();
  g.fill({ fill: grad });

  if (paint.pattern === 'two-tone' && v.length >= 6) {

    const tri = [v[3], v[4], v[5]];
    const cx = (tri[0].x + tri[1].x + tri[2].x) / 3;
    const cy = (tri[0].y + tri[1].y + tri[2].y) / 3;
    g.moveTo(cx + (tri[0].x - cx) * 0.88, cy + (tri[0].y - cy) * 0.88);
    g.lineTo(cx + (tri[1].x - cx) * 0.88, cy + (tri[1].y - cy) * 0.88);
    g.lineTo(cx + (tri[2].x - cx) * 0.88, cy + (tri[2].y - cy) * 0.88);
    g.closePath();
    g.fill({ color: paint.secondary });
  } else if (paint.pattern === 'stripes') {

    const xA = -L * 0.26;
    const xB = L * 0.12;
    const margin = H * 0.055;
    const bandH = H * 0.07;
    const gap = H * 0.045;
    const yA = roofYAt(v, xA);
    const yB = roofYAt(v, xB);
    for (let k = 0; k < 2; k++) {
      const off = margin + k * (bandH + gap);
      g.moveTo(xA, yA + off);
      g.lineTo(xB, yB + off);
      g.lineTo(xB, yB + off + bandH);
      g.lineTo(xA, yA + off + bandH);
      g.closePath();
      g.fill({ color: paint.secondary, alpha: 0.95 });
    }
  } else if (paint.pattern === 'skirt') {

    g.rect(-L / 2, H * 0.16, L, H * 0.34);
    g.fill({ color: shade(paint.secondary, -12) });
  }

  {
    const hx = L * 0.16;
    const hy = roofYAt(v, hx) + H * 0.12;
    const rx = L * 0.07;
    const ry = H * 0.07;
    g.moveTo(hx - rx, hy);
    g.lineTo(hx, hy - ry);
    g.lineTo(hx + rx, hy);
    g.lineTo(hx, hy + ry);
    g.closePath();
    g.fill({ color: '#fffdf4', alpha: 0.28 + 0.12 * paint.metal });
    g.moveTo(hx - rx * 0.45, hy);
    g.lineTo(hx, hy - ry * 0.45);
    g.lineTo(hx + rx * 0.45, hy);
    g.lineTo(hx, hy + ry * 0.45);
    g.closePath();
    g.fill({ color: '#ffffff', alpha: 0.35 });
  }

  g.moveTo(-L / 2, H * 0.08);
  g.lineTo(L / 2, H * 0.08);
  g.lineTo(L / 2, H * 0.14);
  g.lineTo(-L / 2, H * 0.14);
  g.closePath();
  g.fill({ color: shade(paint.base, -22), alpha: 0.55 });
  g.moveTo(-L / 2, H * 0.02);
  g.lineTo(L / 2, H * 0.02);
  g.lineTo(L / 2, H * 0.07);
  g.lineTo(-L / 2, H * 0.07);
  g.closePath();
  g.fill({ color: '#ffffff', alpha: 0.1 });
}

export function drawGlint(g, spec, paint, angle) {
  g.clear();
  const L = spec.bodyLen;
  const H = spec.bodyH;
  const gx = Math.max(-L * 0.32, Math.min(L * 0.32, -Math.sin(angle) * L * 0.6));
  const gw = L * 0.16;
  const gy = -H * 0.18;
  const gh = H * 0.1;
  g.moveTo(gx - gw, gy + gh);
  g.lineTo(gx + gw, gy - gh * 0.4);
  g.lineTo(gx + gw * 0.7, gy - gh);
  g.lineTo(gx - gw * 1.3, gy + gh * 0.4);
  g.closePath();
  g.fill({ color: '#ffffff', alpha: 0.08 + 0.06 * (paint?.metal ?? 0.5) });
}

