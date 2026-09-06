import * as PIXI from 'pixi.js';
import { mulberry32 } from './utils.js';

export const SKY_TW = 2048;

export const SKY_TH = 1024;

const BAND_SLOPE = 0.5;

const L0 = 75;

const SCALE = SKY_TW / 140;

const DRIFT_X = 3;
const DRIFT_Y = 0.8;

const PAR_X = 0.03;
const PAR_Y = 0.02;

const D2R = Math.PI / 180;
const A_NGP = 192.859508 * D2R;
const D_NGP = 27.128336 * D2R;
const L_NCP = 122.932;

export function equatorialToGalactic(ra, dec) {
  const a = ra * D2R;
  const d = dec * D2R;
  const sb = Math.sin(D_NGP) * Math.sin(d) + Math.cos(D_NGP) * Math.cos(d) * Math.cos(a - A_NGP);
  const y = Math.cos(d) * Math.sin(a - A_NGP);
  const x = Math.cos(D_NGP) * Math.sin(d) - Math.sin(D_NGP) * Math.cos(d) * Math.cos(a - A_NGP);
  let l = (L_NCP - Math.atan2(y, x) / D2R) % 360;
  if (l < 0) l += 360;
  return [l, Math.asin(Math.max(-1, Math.min(1, sb))) / D2R];
}

export const NAMED_STARS = [
  ['Vega', 279.234, 38.784, 0.03, '#cfe0ff'],
  ['Deneb', 310.358, 45.28, 1.25, '#dbe6ff'],
  ['Altair', 297.696, 8.868, 0.77, '#fff3e0'],
  ['Sadr', 305.559, 40.253, 2.23, '#fff0d0'],
  ['Albireo', 292.68, 27.96, 3.03, '#ffe2b8'],
  ['Gienah Cyg', 311.553, 33.97, 2.46, '#e8ecff'],
  ['Delta Cyg', 296.18, 45.131, 2.87, '#dfe6ff'],
  ['Polaris', 37.95, 89.264, 1.98, '#fff6e0'],
  ['Antares', 247.352, -26.432, 0.92, '#ffb08a'],
  ['Sirius', 101.287, -16.716, -1.42, '#e4ecff'],
];

const RIFT = [
  { off: 1.5, w: 2.4, kill: 0.8 },
  { off: -3.0, w: 1.8, kill: 0.65 },
];

function bandY(x) {
  return 512 + BAND_SLOPE * (x - 1024);
}

function gauss(rng) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

let glowTex = null;

function getGlowTexture() {
  if (glowTex) return glowTex;
  if (typeof document === 'undefined') return null;
  const cv = document.createElement('canvas');
  cv.width = SKY_TW;
  cv.height = SKY_TH;
  const ctx = cv.getContext('2d');
  const rng = mulberry32(0xBEEF);

  const nx = -0.4472;
  const ny = 0.8944;
  const blob = (x, y, r, rgb, alpha, composite) => {
    ctx.globalCompositeOperation = composite;
    for (const ox of [-SKY_TW, 0, SKY_TW]) {
      for (const oy of [-SKY_TH, 0, SKY_TH]) {
        const g = ctx.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
        g.addColorStop(0, `rgba(${rgb},${alpha})`);
        g.addColorStop(1, `rgba(${rgb},0)`);
        ctx.fillStyle = g;
        ctx.fillRect(x + ox - r, y + oy - r, r * 2, r * 2);
      }
    }
  };

  for (let i = 0; i < 64; i++) {
    const t = -300 + rng() * (SKY_TW + 600);
    const off = gauss(rng) * 70;
    const warm = rng() < 0.3;
    blob(
      t,
      bandY(t) + off * ny,
      60 + rng() * 95,
      warm ? '255,226,192' : '168,182,232',
      0.05 + rng() * 0.05,
      'lighter',
    );
  }

  for (let i = 0; i < 30; i++) {
    const t = -200 + rng() * (SKY_TW + 400);
    const off = gauss(rng) * 26;
    blob(t, bandY(t) + off * ny, 26 + rng() * 42, '255,233,201', 0.07 + rng() * 0.06, 'lighter');
  }

  for (const lane of RIFT) {
    for (let i = 0; i < 26; i++) {
      const t = -200 + rng() * (SKY_TW + 400);
      const off = lane.off * SCALE + gauss(rng) * lane.w * SCALE * 0.4;
      blob(t, bandY(t) + off * ny, lane.w * SCALE * (0.5 + rng() * 0.5), '0,0,0', 0.3, 'destination-out');
    }
  }
  ctx.globalCompositeOperation = 'source-over';
  glowTex = PIXI.Texture.from(cv);
  return glowTex;
}

function drawTile(g, ox, oy) {
  const rng = mulberry32(20260613);
  const dot = (x, y, r, color, alpha) => {
    g.circle(ox + (((x % SKY_TW) + SKY_TW) % SKY_TW), oy + (((y % SKY_TH) + SKY_TH) % SKY_TH), r).fill({ color, alpha });
  };
  const star = (x, y, mag, tint) => {
    dot(x, y, Math.max(0.7, 2.6 - 0.45 * mag), tint, Math.max(0.3, Math.min(1, 1.1 - 0.12 * mag)));
  };

  for (let i = 0; i < 550; i++) {
    const x = rng() * SKY_TW;
    const bDeg = gauss(rng) * 5;
    let p = rng();
    for (const lane of RIFT) {
      const d = Math.abs(bDeg - lane.off) / lane.w;
      if (d < 1 && p < lane.kill * (1 - d)) {
        p = 2;
        break;
      }
    }
    if (p > 1) continue;
    const mag = 2 + 4 * rng() * rng();
    const tints = ['#cdd8ff', '#ffffff', '#ffe6c4'];
    star(x, bandY(x) + bDeg * SCALE, mag, tints[(rng() * 3) | 0]);
  }

  for (let i = 0; i < 150; i++) {
    const x = rng() * SKY_TW;
    const mag = 4 + 2.5 * rng();
    star(x, bandY(x) + gauss(rng) * 12 * SCALE, mag, rng() < 0.6 ? '#b9c4e8' : '#e8ecff');
  }

  for (let i = 0; i < 120; i++) {
    const mag = 3 + 3 * rng();
    star(rng() * SKY_TW, rng() * SKY_TH, mag, '#9fb0d8');
  }

  for (const [name, ra, dec, mag, tint] of NAMED_STARS) {
    void name;
    const [l, b] = equatorialToGalactic(ra, dec);
    const dl = ((l - L0 + 540) % 360) - 180;
    if (Math.abs(dl) > 70) continue;
    const x = 1024 + dl * SCALE;
    const y = bandY(x) + b * SCALE;
    const r = Math.max(0.8, Math.min(3.4, 2.8 - 0.5 * mag));
    dot(x, y, r + 1.6, tint, 0.25);
    dot(x, y, r, tint, Math.max(0.35, Math.min(1, 1.15 - 0.13 * mag)));
  }
}

export function createSky() {
  const container = new PIXI.Container();
  const tex = getGlowTexture();
  for (let ix = 0; ix < 3; ix++) {
    for (let iy = 0; iy < 3; iy++) {
      if (tex) {
        const s = new PIXI.Sprite(tex);
        s.position.set(ix * SKY_TW, iy * SKY_TH);
        s.blendMode = 'add';
        container.addChild(s);
      }
      const g = new PIXI.Graphics();
      drawTile(g, ix * SKY_TW, iy * SKY_TH);
      container.addChild(g);
    }
  }
  let t = 0;
  return {
    container,
    update(dt, camX, camY) {
      if (!Number.isFinite(dt) || dt < 0) return;
      t += dt;
      const ox = t * DRIFT_X + (Number.isFinite(camX) ? camX : 0) * PAR_X;
      const oy = t * DRIFT_Y + (Number.isFinite(camY) ? camY : 0) * PAR_Y;
      container.position.set(-(((ox % SKY_TW) + SKY_TW) % SKY_TW), -(((oy % SKY_TH) + SKY_TH) % SKY_TH));
    },
  };
}

