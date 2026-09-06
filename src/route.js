/**
 * Route procédurale : génération déterministe (sinus seedés + vnoise 1D),
 * colliders Rapier par segment, rendu Pixi néon.
 * @module route
 */
import RAPIER from '@dimforge/rapier2d-compat';
import * as PIXI from 'pixi.js';
import { mulberry32, normalizeSeed, clamp, smoothstep } from './utils.js';
import { drawIce } from './glace.js';

/** Longueur totale de la piste en px. */
export const TRACK_LENGTH = 12000;
/** Pixels par mètre (affichage uniquement, la physique reste en px). */
export const PX_PER_M = 10;
/** Pas d'échantillonnage de la route en px. */
export const DX = 20;
/** Début de piste (tablier plat à l'ouest pour les sorties en marche arrière). */
export const START_X = -600;
/** Fin de piste dérivée. */
export const END_X = START_X + TRACK_LENGTH;

/**
 * Paramètres par difficulté (amplitudes, périodes, rugosité, pente max, couleur).
 */
export const DIFFICULTIES = {
  easy: { A1: 45, L1: 1100, A2: 12, L2: 320, A3: 0, stepNoise: 140, slopeMaxDeg: 20, color: '#34d399' },
  medium: { A1: 90, L1: 900, A2: 35, L2: 260, A3: 18, stepNoise: 140, slopeMaxDeg: 35, color: '#60a5fa' },
  hard: { A1: 140, L1: 750, A2: 70, L2: 200, A3: 45, stepNoise: 90, slopeMaxDeg: 50, color: '#f472b6' },
};

const TAU = Math.PI * 2;

/**
 * Normalise un nom de difficulté (inconnu ⇒ 'medium').
 * @param {unknown} d Difficulté brute.
 * @returns {'easy'|'medium'|'hard'} Difficulté valide.
 */
export function normalizeDifficulty(d) {
  const s = String(d || '').toLowerCase();
  return s === 'easy' || s === 'hard' ? s : 'medium';
}

/**
 * Construit un bruit de valeur 1D (interpolation cosinus entre valeurs hashées).
 * @param {() => number} rng RNG seedé pour le treillis.
 * @param {number} step Pas du treillis en px.
 * @param {number} x0 Début de couverture.
 * @param {number} x1 Fin de couverture.
 * @returns {(x: number) => number} Fonction de bruit dans [-1, 1].
 */
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

/**
 * Génère la route de façon déterministe : même seed + même difficulté ⇒ mêmes points.
 * Somme de sinusoïdes seedées + fBm léger (2 octaves), enveloppe smoothstep au
 * départ (plat garanti sur x ∈ [-200, 200]), puis écrêtage de la pente.
 * @param {unknown} seed Graine (normalisée en interne).
 * @param {unknown} difficulty 'easy' | 'medium' | 'hard'.
 * @returns {{ points: Array<{x:number,y:number}>, seed: number, difficulty: string }}
 */
export function generateRoute(seed, difficulty) {
  const s = normalizeSeed(seed);
  const diff = normalizeDifficulty(difficulty);
  const P = DIFFICULTIES[diff];
  const rng = mulberry32(s);

  const phi1 = rng() * TAU;
  const phi2 = rng() * TAU;
  // fBm léger : 2 octaves max pour rester carrossable.
  const n1 = makeNoise1D(rng, P.stepNoise || 140, START_X, END_X);
  const n2 = makeNoise1D(rng, (P.stepNoise || 140) / 2.7, START_X, END_X);

  const rawY = (x) => {
    const env = smoothstep(200, 800, x); // 0 sur le plat de départ
    const fbm = 0.65 * n1(x) + 0.35 * n2(x + 13.7);
    return env * (P.A1 * Math.sin((TAU * x) / P.L1 + phi1) + P.A2 * Math.sin((TAU * x) / P.L2 + phi2) + P.A3 * fbm);
  };

  const maxDy = Math.tan((P.slopeMaxDeg * Math.PI) / 180) * DX;
  // Limite de courbure : variation max de dy par pas ⇒ cassure ≤ ~10° par
  // joint, y compris aux transitions d'écrêtage (un clamp sec créait de longs
  // plans inclinés terminés par des coins à 30-50°).
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
  // Lissage anti-cassures : 2 passes binomiales [0.25, 0.5, 0.25] sur y
  // (zone plate x ≤ 200 gelée : spawn intact). Les joints tous les 20 px
  // formaient des angles durs (visibles + arêtes physiques) ; le lissage
  // arrondit les courbes sans changer l'échantillonnage ni le déterminisme,
  // et ne peut qu'adoucir les pentes (penteMax toujours garantie).
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

/**
 * Crée les colliders route : un cuboid par segment sur un unique corps fixe.
 * @param {import('@dimforge/rapier2d-compat').World} world Monde Rapier.
 * @param {Array<{x:number,y:number}>} points Points échantillonnés.
 * @returns {{ body: import('@dimforge/rapier2d-compat').RigidBody, colliders: Array }} Handle (pour nettoyage).
 */
export function buildRouteColliders(world, points) {
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const colliders = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const segLen = Math.hypot(b.x - a.x, b.y - a.y);
    const halfLen = segLen / 2 + 0.5; // léger recouvrement anti-trous
    // Normale écran-haut du segment : la face haute du cuboid (épaisseur 20)
    // doit coïncider EXACTEMENT avec la ligne visuelle (sinon la voiture
    // flotte ~10 px au-dessus de la route). Centre décalé de 10 px sous la
    // surface le long de la normale (exact à toute pente).
    const nx = (b.y - a.y) / (segLen || 1);
    const ny = -(b.x - a.x) / (segLen || 1);
    const desc = RAPIER.ColliderDesc.cuboid(halfLen, 10) // thickness = 20px
      .setTranslation(mx - nx * 10, my - ny * 10)
      .setRotation(Math.atan2(b.y - a.y, b.x - a.x))
      .setFriction(1.5)
      .setRestitution(0)
      .setCollisionGroups(((0x0001 << 16) | 0xffff) >>> 0); // groupe route 0x0001, collisionne tout
    colliders.push(world.createCollider(desc, body));
  }
  return { body, colliders };
}

/**
 * Supprime les colliders d'une route précédemment construite.
 * @param {import('@dimforge/rapier2d-compat').World} world Monde Rapier.
 * @param {{ body: import('@dimforge/rapier2d-compat').RigidBody }} handle Handle rendu par buildRouteColliders.
 * @returns {void}
 */
export function clearRouteColliders(world, handle) {
  if (handle && handle.body) world.removeRigidBody(handle.body);
}

/**
 * Dessine la route : dalle de glace (cf. glace.js — fini le trait néon),
 * drapeau de départ, ticks + labels tous les 100 m (labels ajoutés au
 * parent, taggés 'route-decor').
 * @param {PIXI.Graphics} graphics Graphics à dessiner (déjà enfant d'un Container monde).
 * @param {Array<{x:number,y:number}>} points Points échantillonnés.
 * @param {unknown} difficulty Difficulté (teinte de la glace).
 * @param {unknown} [seed] Graine (fissures/bulles déterministes).
 * @returns {void}
 */
export function drawRoute(graphics, points, difficulty, seed = 1) {
  drawIce(graphics, points, difficulty, seed);

  // Drapeau / marquage de départ à x=0.
  const y0 = routeYAt(points, 0);
  graphics.moveTo(0, y0).lineTo(0, y0 - 46);
  graphics.stroke({ width: 3, color: '#e5e7eb' });
  graphics.moveTo(0, y0 - 46).lineTo(26, y0 - 38).lineTo(0, y0 - 30);
  graphics.closePath();
  graphics.fill({ color: '#e5e7eb' });

  // Marqueurs tous les 100 m (= 1000 px), labels via Text.
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

/**
 * Supprime les décorations Text créées par drawRoute.
 * @param {PIXI.Container} parent Parent du Graphics de route.
 * @returns {void}
 */
export function clearRouteDecor(parent) {
  if (!parent) return;
  for (const c of [...parent.children]) {
    if (c.label === 'route-decor') parent.removeChild(c).destroy();
  }
}

/**
 * Hauteur de route interpolée linéairement (bornée aux extrémités).
 * @param {Array<{x:number,y:number}>} points Points échantillonnés.
 * @param {number} x Abscisse monde.
 * @returns {number} Ordonnée interpolée.
 */
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
