/**
 * Caméra intelligente : suivi lerp + lookahead vitesse + zoom auto.
 * @module camera
 */
import { clamp, lerp } from './utils.js';

/**
 * Crée la caméra (opère sur le container monde via pivot/position/scale).
 * @param {PIXI.Application} app Application Pixi (viewport via app.screen).
 * @param {PIXI.Container} [world] Container monde (défaut : app.stage).
 * @returns {{ update: (dt:number, target:{x:number,y:number}, vel:{x:number,y:number}) => void, snapTo: (x:number,y:number) => void, camX: number, camY: number, zoom: number }}
 */
export function createCamera(app, world = null) {
  const view = world || app.stage;
  const cam = {
    camX: 0,
    camY: -80,
    zoom: 1,
    /**
     * Téléporte la caméra (spawn / respawn).
     * @param {number} x Abscisse monde.
     * @param {number} y Ordonnée monde.
     */
    snapTo(x, y) {
      cam.camX = Number.isFinite(x) ? x : 0;
      cam.camY = Number.isFinite(y) ? y : 0;
      cam.apply();
    },
    /** Applique la transform monde→écran. */
    apply() {
      const w = app.screen.width || window.innerWidth;
      const h = app.screen.height || window.innerHeight;
      if (!Number.isFinite(cam.camX) || !Number.isFinite(cam.camY)) {
        cam.camX = 0;
        cam.camY = 0;
      }
      view.pivot.set(cam.camX, cam.camY);
      view.position.set(w / 2, h * 0.55);
      view.scale.set(cam.zoom);
    },
    /**
     * Suit la cible avec lookahead et zoom auto (lissé, anti-NaN).
     * @param {number} dt Delta temps (s).
     * @param {{x:number,y:number}} target Position monde à suivre.
     * @param {{x:number,y:number}} vel Vélocité monde (lookahead + zoom).
     */
    update(dt, target, vel) {
      const vx = Number.isFinite(vel.x) ? vel.x : 0;
      const vy = Number.isFinite(vel.y) ? vel.y : 0;
      const tx = (Number.isFinite(target.x) ? target.x : 0) + clamp(vx * 0.35, -180, 180);
      const ty = clamp((Number.isFinite(target.y) ? target.y : 0) - 80, -1200, 1200);
      cam.camX = lerp(cam.camX, tx, 1 - Math.exp(-5 * dt));
      cam.camY = lerp(cam.camY, ty, 1 - Math.exp(-4 * dt));
      const speed = Math.hypot(vx, vy);
      const zt = clamp(1.15 - speed * 0.0006, 0.75, 1.15);
      cam.zoom = lerp(cam.zoom, zt, 1 - Math.exp(-3 * dt));
      cam.apply();
    },
  };
  return cam;
}
