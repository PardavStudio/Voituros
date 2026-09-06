/**
 * Petits utilitaires déterministes (RNG seedé, maths).
 * @module utils
 */

/**
 * RNG seedé mulberry32. Même seed ⇒ même séquence.
 * @param {number} seed Graine entière (sera coercée en uint32).
 * @returns {() => number} Fonction retournant un flottant dans [0, 1).
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Hash FNV-1a d'une chaîne vers un uint32 (pour dériver une seed).
 * @param {string} str Chaîne à hasher.
 * @returns {number} Hash uint32.
 */
export function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Normalise une seed quelconque en uint32. Seed invalide ⇒ fallback temporel.
 * @param {unknown} seed Seed brute (nombre, chaîne numérique, …).
 * @returns {number} Seed uint32 valide.
 */
export function normalizeSeed(seed) {
  if (typeof seed === 'number' && Number.isFinite(seed)) return Math.abs(Math.floor(seed)) % 100000 || 1;
  if (typeof seed === 'string' && seed.trim() !== '') {
    if (/^-?\d+$/.test(seed.trim())) return Math.abs(parseInt(seed.trim(), 10)) % 100000 || 1;
    return hashSeed(seed) % 100000;
  }
  return Date.now() % 100000;
}

/**
 * Borne une valeur dans [min, max].
 * @param {number} v Valeur.
 * @param {number} min Borne basse.
 * @param {number} max Borne haute.
 * @returns {number} Valeur bornée.
 */
export function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

/**
 * Interpolation linéaire.
 * @param {number} a Départ.
 * @param {number} b Arrivée.
 * @param {number} t Facteur [0, 1].
 * @returns {number} Valeur interpolée.
 */
export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * Transition douce 0→1 entre deux seuils (dérivée nulle aux bords).
 * @param {number} e0 Seuil bas (résultat 0 en-dessous).
 * @param {number} e1 Seuil haut (résultat 1 au-dessus).
 * @param {number} x Entrée.
 * @returns {number} Valeur dans [0, 1].
 */
export function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}
