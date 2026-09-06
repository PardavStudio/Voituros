export const SNOW_N = 220;

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
      x: rnd(),
      y: rnd(),
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

export function drawSnow(g, snow, dt, w, h, camVX = 0, env = null) {
  const step = Math.min(0.1, Math.max(0, dt || 0));
  snow.t += step;
  const t = snow.t;

  snow.wind = 10 + 18 * Math.sin(t * 0.11) + 8 * Math.sin(t * 0.043 + 2);
  g.clear();
  if (w <= 0 || h <= 0 || !Number.isFinite(step) || step <= 0) return;
  const vx = Math.max(-1500, Math.min(1500, Number.isFinite(camVX) ? camVX : 0));
  const useEnv =
    env !== null &&
    env !== undefined &&
    env.zoom > 0 &&
    typeof env.beam === 'function' &&
    typeof env.groundY === 'function';
  const ez = useEnv ? env.zoom : 1;
  const ecx = useEnv ? env.camX : 0;
  const ecy = useEnv ? env.camY : 0;
  for (const f of snow.flakes) {
    const depthK = f.z === 0 ? 0.4 : f.z === 1 ? 0.7 : 1;
    f.y += (f.vy / h) * step;

    const swayX = Math.sin(t * f.fr + f.ph) * f.sw;
    f.x += ((snow.wind * depthK - vx * depthK * 0.9 + swayX * f.fr) / w) * step;
    if (f.y > 1.02) {
      f.y = -0.02;
      f.x = Math.random();
    } else if (f.y < -0.03) {
      f.y = 1.01;
    }
    if (f.x > 1.03) f.x -= 1.06;
    else if (f.x < -0.03) f.x += 1.06;
    const px = f.x * w + swayX * 0.35;
    const py = f.y * h;
    let alpha = f.z === 0 ? 0.28 : f.z === 1 ? 0.5 : 0.75;
    let tint = '#f2f7fc';
    if (useEnv) {

      const wx = (px - w / 2) / ez + ecx;
      const wy = (py - h * 0.55) / ez + ecy;
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
    if (f.z === 2) {

      const s = f.size;
      g.moveTo(px - s, py);
      g.lineTo(px, py - s * 1.25);
      g.lineTo(px + s, py);
      g.lineTo(px, py + s * 1.25);
      g.closePath();
      g.fill({ color: tint, alpha });
    } else {
      g.circle(px, py, f.size);
      g.fill({ color: tint, alpha });
    }
  }
}

