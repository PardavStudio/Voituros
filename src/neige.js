/**
 * Neige réaliste en COORDONNÉES MONDE (verrouillée au monde comme la
 * glace : montée/descente/vitesse/zoom de la caméra justes par
 * construction — aucun hack de vent apparent). 3 couches de profondeur,
 * sway sinusoïdal par flocon, rafales globales, éclairée par le faisceau
 * et clipsée au sol. Zéro alloc par frame.
 * @module neige
 */

/** Nombre de flocons (fixe, tient 60 fps partout). */
export const SNOW_N = 220;

/**
 * Crée la chute (positions monde, état persistant).
 * @param {unknown} [seed] Graine.
 * @returns {{ flakes: Array<{ x: number, y: number, z: 0|1|2, size: number, vy: number, ph: number, fr: number, sw: number }>, t: number, wind: number }}
 */
export function createSnow(seed = 7) {
  let s = (typeof seed === 'number' ? seed : 7) >>> 0 || 1;
  const rnd = () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const flakes = [];
  for (let i = 0; i < SNOW_N; i++) {
    const r = rnd();
    const z = r < 0.4 ? 0 : r < 0.75 ? 1 : 2;
    flakes.push({
      x: (rnd() - 0.5) * 3000,
      y: (rnd() - 0.5) * 1600,
      z,
      size: z === 0 ? 0.7 + rnd() * 0.6 : z === 1 ? 1.2 + rnd() * 0.8 : 2 + rnd() * 0.9,
      vy: z === 0 ? 25 + rnd() * 20 : z === 1 ? 50 + rnd() * 30 : 95 + rnd() * 45,
      ph: rnd() * Math.PI * 2,
      fr: 0.5 + rnd() * 1.1,
      sw: z === 0 ? 8 : z === 1 ? 16 : 26,
    });
  }
  return { flakes, t: rnd() * 20, wind: 10 };
}

/**
 * Met à jour + dessine la neige (projection caméra identique au monde :
 * sx = (wx − camX)·zoom + w/2, sy = (wy − camY)·zoom + h·0.55).
 * @param {PIXI.Graphics} g Cible (layer écran).
 * @param {{ flakes: Array, t: number, wind: number }} snow État.
 * @param {number} dt Delta temps (s).
 * @param {{ w: number, h: number, camX: number, camY: number, zoom: number }} view Vue.
 * @param {{ beam: (wx:number,wy:number)=>number, groundY: (wx:number)=>number } | null} [env] Faisceau + sol (optionnel).
 * @returns {void}
 */
export function drawSnow(g, snow, dt, view, env = null) {
  const step = Math.min(0.1, Math.max(0, dt || 0));
  snow.t += step;
  const t = snow.t;
  snow.wind = 10 + 18 * Math.sin(t * 0.11) + 8 * Math.sin(t * 0.043 + 2);
  g.clear();
  const w = view.w;
  const h = view.h;
  const zoom = view.zoom > 0 ? view.zoom : 1;
  if (w <= 0 || h <= 0 || !Number.isFinite(step) || step <= 0) return;
  const hw = w / zoom / 2 + 120;
  const hh = h / zoom / 2 + 120;
  const cx = view.camX;
  const cy = view.camY;
  const useEnv = env !== null && env !== undefined && typeof env.beam === 'function' && typeof env.groundY === 'function';
  for (const f of snow.flakes) {
    const depthK = f.z === 0 ? 0.4 : f.z === 1 ? 0.7 : 1;
    f.y += (f.vy / 1) * step;
    f.x += snow.wind * depthK * step;
    if (f.x < cx - hw) {
      f.x += hw * 2;
      f.y = cy + (Math.random() * 2 - 1) * hh;
    } else if (f.x > cx + hw) {
      f.x -= hw * 2;
      f.y = cy + (Math.random() * 2 - 1) * hh;
    }
    if (f.y < cy - hh) {
      f.y += hh * 2;
      f.x = cx + (Math.random() * 2 - 1) * hw;
    } else if (f.y > cy + hh) {
      f.y -= hh * 2;
      f.x = cx + (Math.random() * 2 - 1) * hw;
    }
    const swayX = Math.sin(t * f.fr + f.ph) * f.sw;
    const wx = f.x + swayX * 0.35;
    const wy = f.y;
    const px = (wx - cx) * zoom + w / 2;
    const py = (wy - cy) * zoom + (h * 0.55);
    let alpha = f.z === 0 ? 0.28 : f.z === 1 ? 0.5 : 0.75;
    let tint = '#f2f7fc';
    if (useEnv) {
      if (wy > env.groundY(wx) + 2) {
        alpha *= 0.06;
      } else {
        const b = env.beam(wx, wy);
        if (b > 0.01) {
          alpha = Math.min(0.95, alpha * (0.55 + 1.5 * b));
          if (b > 0.45) tint = '#fff3d8';
        }
      }
    }
    const s = f.size * zoom;
    if (f.z === 2) {
      g.moveTo(px - s, py);
      g.lineTo(px, py - s * 1.25);
      g.lineTo(px + s, py);
      g.lineTo(px, py + s * 1.25);
      g.closePath();
      g.fill({ color: tint, alpha });
    } else {
      g.circle(px, py, s);
      g.fill({ color: tint, alpha });
    }
  }
}
