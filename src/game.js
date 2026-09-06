/**
 * Game : machine à états ready|driving|flipped|dead, distance/best/tombes/respawn.
 * @module game
 */
import * as PIXI from 'pixi.js';
import RAPIER from '@dimforge/rapier2d-compat';
import {
  generateRoute,
  buildRouteColliders,
  clearRouteColliders,
  clearRouteDecor,
  drawRoute,
  routeYAt,
  normalizeDifficulty,
  PX_PER_M,
} from './route.js';
import {
  randomCarSpec,
  createCar,
  destroyCar,
  applyDrive,
  applyBrake,
  applySuspension,
  syncCarVisual,
  snapshotPrev,
  snapshotCurr,
  snapRender,
  updateCarLight,
  ghostifyCar,
} from './voiture.js';
import { normalizeSeed } from './utils.js';

/** cos(angle) < FLIP_COS ⇒ retourné (≈ ±100°, toit vers le bas). */
export const FLIP_COS = -0.17;
/** Durée de retournement avant la mort (s). */
export const FLIP_TIME = 3.0;
/** Délai avant respawn après la mort (s). */
export const RESPAWN_DELAY = 1.2;
/** Abscisse de spawn. */
export const SPAWN_X = 0;

/**
 * Partie : monde physique, route, voiture active, tombes, scores.
 */
export class Game {
  /**
   * @param {{ world: import('@dimforge/rapier2d-compat').World, worldLayer: PIXI.Container, camera?: object, best?: number, ui?: { toast?: (msg:string)=>void, flip?: (visible:boolean, remaining:number, frac:number)=>void, hint?: ()=>void } }} opts
   */
  constructor({ world, worldLayer, camera = null, best = 0, ui = {} }) {
    this.world = world;
    this.layer = worldLayer;
    this.camera = camera;
    this.ui = { toast: () => {}, flip: () => {}, hint: () => {}, ...ui };

    this.routeGfx = new PIXI.Graphics();
    this.carLayer = new PIXI.Container();
    this.layer.addChild(this.routeGfx);
    this.layer.addChild(this.carLayer);

    this.state = 'ready';
    this.distance = 0;
    this.best = Number.isFinite(best) && best > 0 ? best : 0;
    this.deaths = 0;
    /** Tombes : enregistrements purs {x, y, distance} (sérialisables). */
    this.graves = [];
    this.graveVisuals = [];
    this.car = null;
    this.route = null;
    this.routeHandle = null;
    this.seed = 1;
    this.difficulty = 'medium';
    this.flipTimer = 0;
    this.deadTimer = 0;
    this.stuckTimer = 0;
    this.lastDeath = 0;
    this.dir = 0;
    this.brake = false;
  }

  /**
   * (Re)construit la route + respawn. Tombes effacées, best conservé.
   * @param {unknown} seed Graine.
   * @param {unknown} difficulty Difficulté.
   * @returns {{ seed: number, difficulty: string }}
   */
  newRoute(seed, difficulty) {
    this.seed = normalizeSeed(seed);
    this.difficulty = normalizeDifficulty(difficulty);
    // Nettoyage complet : voiture active, visuels de tombes, décors, colliders.
    if (this.car) {
      destroyCar(this.world, this.car);
      this.car = null;
    }
    for (const v of this.graveVisuals) v.destroy({ children: true });
    this.graveVisuals = [];
    this.graves = [];
    clearRouteDecor(this.routeGfx.parent);
    if (this.routeHandle) {
      clearRouteColliders(this.world, this.routeHandle);
      this.routeHandle = null;
    }
    this.route = generateRoute(this.seed, this.difficulty);
    this.routeHandle = buildRouteColliders(this.world, this.route.points);
    this.routeGfx.clear();
    drawRoute(this.routeGfx, this.route.points, this.difficulty);
    this.spawnNewCar(null);
    return { seed: this.seed, difficulty: this.difficulty };
  }

  /**
   * Fait apparaître une voiture neuve au départ (couleur forcée différente).
   * @param {{ color?: string } | null} prevSpec Spec précédente (anti-doublon couleur).
   * @returns {void}
   */
  spawnNewCar(prevSpec) {
    if (this.car) {
      // Les corps (même fantômes, fixes + désactivés) sont retirés du monde ;
      // le visuel d'une tombe est conservé sur place.
      destroyCar(this.world, this.car, { keepVisual: this.car.dead });
      if (this.car.dead) this.graveVisuals.push(this.car.container);
      this.car = null;
    }
    let spec = randomCarSpec(Math.random);
    if (prevSpec) {
      let tries = 0;
      while (spec.color === prevSpec.color && tries < 10) {
        spec = randomCarSpec(Math.random);
        tries++;
      }
    }
    const spawn = { x: SPAWN_X, y: routeYAt(this.route.points, SPAWN_X) - 80 };
    this.car = createCar(this.world, spec, spawn);
    // Éclairage monde sous la voiture (wash, fan, poussières).
    this.carLayer.addChildAt(this.car.washMesh, 0);
    this.carLayer.addChildAt(this.car.fanMesh, 1);
    this.carLayer.addChildAt(this.car.dustMesh, 2);
    this.carLayer.addChild(this.car.container);
    syncCarVisual(this.car);
    this.state = 'ready';
    this.distance = 0;
    this.flipTimer = 0;
    this.deadTimer = 0;
    this.stuckTimer = 0;
    if (this.camera) this.camera.snapTo(spawn.x, spawn.y - 80);
  }

  /**
   * Mémorise l'input courant (appliqué à chaque fixedStep).
   * @param {-1|0|1} dir Direction.
   * @param {boolean} brake Frein.
   * @returns {void}
   */
  setInput(dir, brake) {
    this.dir = dir;
    this.brake = brake;
  }

  /**
   * Un pas physique à 120 Hz : suspensions, propulsion, step, états.
   * @param {number} dt Pas de temps (s).
   * @returns {void}
   */
  fixedStep(dt) {
    const car = this.car;
    if (!car || !this.route) return;
    snapshotPrev(car);
    if (this.state !== 'dead') {
      applySuspension(car, dt);
      if (this.dir !== 0) applyDrive(car, this.dir, dt);
      if (this.brake) applyBrake(car, dt);
    }
    this.world.step();
    snapshotCurr(car);
    const t = car.chassis.translation();

    if (this.state === 'dead') {
      this.deadTimer += dt;
      if (this.deadTimer >= RESPAWN_DELAY) {
        const prev = this.lastDeath;
        this.spawnNewCar(car.spec);
        this.ui.toast(`🚗 Nouvelle voiture ! — précédent : ${prev.toFixed(1)} m`);
      }
      return;
    }

    this.distance = Math.max(0, (t.x - SPAWN_X) / PX_PER_M);
    if (this.distance > this.best) {
      this.best = this.distance;
      try {
        localStorage.setItem('voituros.best', String(this.best));
      } catch {
        /* stockage indisponible */
      }
    }

    const angle = car.chassis.rotation();
    if (Math.cos(angle) < FLIP_COS) {
      this.state = 'flipped';
      this.flipTimer += dt;
      this.ui.flip(true, Math.max(0, FLIP_TIME - this.flipTimer), Math.min(1, this.flipTimer / FLIP_TIME));
      if (this.flipTimer >= FLIP_TIME) this.die('flip', t);
      return;
    }
    this.flipTimer = 0;
    this.ui.flip(false, 0, 0);
    if (this.state !== 'driving') {
      const lv = car.chassis.linvel();
      if (this.dir !== 0 || Math.hypot(lv.x, lv.y) > 30) this.state = 'driving';
      else this.state = 'ready';
    }

    // Chute sous la route ⇒ mort immédiate (tombe à la projection x).
    if (t.y > 2000 || t.y - routeYAt(this.route.points, t.x) > 500) {
      this.die('fall', t);
      return;
    }

    // Bloquage sans flip : hint, pas de mort auto.
    const lv = car.chassis.linvel();
    if (Math.hypot(lv.x, lv.y) < 20 && this.distance < 5) {
      this.stuckTimer += dt;
      if (this.stuckTimer > 15) {
        this.ui.hint();
        this.stuckTimer = 0;
      }
    } else {
      this.stuckTimer = 0;
    }
  }

  /** Recopie physique→visuels, interpolée + éclairage (appel par frame).
   * @param {number} [alpha] Reste accumulateur/STEP.
   * @param {number} [dt] Delta temps rendu (s, éclairage/poussières).
   * @returns {void} */
  frame(alpha = 1, dt = 0) {
    if (!this.car) return;
    syncCarVisual(this.car, alpha);
    updateCarLight(this.car, dt, this.route ? this.route.points : null);
  }

  /**
   * Tue la voiture : fantôme sur place + tombe + toast, respawn dans 1.2 s.
   * @param {'flip'|'fall'} kind Cause.
   * @param {{ x: number, y: number }} t Position de la mort.
   * @returns {void}
   */
  die(kind, t) {
    const car = this.car;
    if (!car || this.state === 'dead') return;
    const d = Math.max(0, (t.x - SPAWN_X) / PX_PER_M);
    this.lastDeath = d;
    this.state = 'dead';
    this.deaths += 1;
    this.deadTimer = 0;
    this.flipTimer = 0;
    this.ui.flip(false, 0, 0);
    ghostifyCar(this.world, car);
    const grave = { x: t.x, y: t.y, distance: d };
    this.graves.push(grave);
    this.addGraveLabel(grave);
    try {
      localStorage.setItem('voituros.best', String(this.best));
    } catch {
      /* ignore */
    }
    this.ui.toast(
      kind === 'flip' ? `💀 Retourné ! ${d.toFixed(1)} m — nouvelle voiture…` : `💀 Chute ! ${d.toFixed(1)} m — nouvelle voiture…`,
    );
  }

  /**
   * Ajoute le label de tombe `💀 XX.X m` sous la voiture morte.
   * @param {{ x: number, y: number, distance: number }} grave Tombe.
   * @returns {void}
   */
  addGraveLabel(grave) {
    const c = new PIXI.Container();
    c.position.set(grave.x, grave.y + 44);
    const bg = new PIXI.Graphics();
    bg.roundRect(-58, -13, 116, 26, 6).fill({ color: '#111827', alpha: 0.8 });
    const txt = new PIXI.Text({
      text: `💀 ${grave.distance.toFixed(1)} m`,
      style: { fontFamily: 'ui-monospace, monospace', fontSize: 14, fill: '#f9fafb' },
    });
    txt.anchor.set(0.5);
    c.addChild(bg, txt);
    this.carLayer.addChild(c);
    this.graveVisuals.push(c);
  }

  /** Abscisse voiture (0 si absente). @returns {number} */
  get carX() {
    return this.car ? this.car.chassis.translation().x : 0;
  }

  /** Ordonnée voiture. @returns {number} */
  get carY() {
    return this.car ? this.car.chassis.translation().y : 0;
  }

  /** Vélocité châssis. @returns {{x:number,y:number}} */
  get carVel() {
    if (!this.car) return { x: 0, y: 0 };
    const v = this.car.chassis.linvel();
    return { x: v.x, y: v.y };
  }

  /** Spec de la voiture active (données pures). @returns {object|null} */
  get carSpec() {
    return this.car ? this.car.spec : null;
  }

  /**
   * Hook debug : télémétrie interne (vitesses roues/châssis, angle, état).
   * @returns {{ x:number, y:number, angle:number, vx:number, vy:number, wheels:number[], state:string, flipTimer:number, distance:number, deaths:number }}
   */
  debugState() {
    const car = this.car;
    if (!car) return { x: 0, y: 0, angle: 0, vx: 0, vy: 0, wheels: [], state: this.state, flipTimer: 0, distance: 0, deaths: this.deaths };
    const t = car.chassis.translation();
    const v = car.chassis.linvel();
    return {
      x: t.x,
      y: t.y,
      angle: car.chassis.rotation(),
      vx: v.x,
      vy: v.y,
      wheels: [car.wheelF.angvel(), car.wheelR.angvel()],
      masses: [car.chassis.mass(), car.wheelF.mass(), car.wheelR.mass()],
      susp: [...(car.suspTravel || [])],
      state: this.state,
      flipTimer: this.flipTimer,
      distance: this.distance,
      deaths: this.deaths,
    };
  }

  /**
   * Hook test : retourne la voiture sur le toit et fige les corps pour que le
   * compteur de retournement (3 s) soit déterministe (pas de restabilisation).
   * @returns {void}
   */
  debugFlip() {
    const car = this.car;
    if (!car || this.state === 'dead') return;
    const t = car.chassis.translation();
    const cx = t.x;
    const cy = t.y - 40;
    car.chassis.setTranslation({ x: cx, y: cy }, true);
    car.chassis.setRotation(Math.PI, true);
    car.chassis.setLinvel({ x: 0, y: 0 }, true);
    car.chassis.setAngvel(0, true);
    // Retourner aussi les roues et essieux (rotation PI autour du châssis)
    // pour que la voiture entière soit sur le toit et reste figée de façon déterministe.
    for (const { body, axle, anchor } of car.wheelMeshes) {
      body.setTranslation({ x: cx - anchor.x, y: cy - anchor.y }, true);
      body.setRotation(Math.PI, true);
      body.setLinvel({ x: 0, y: 0 }, true);
      body.setAngvel(0, true);
      if (axle) {
        axle.setTranslation({ x: cx - anchor.x, y: cy - anchor.y }, true);
        axle.setRotation(Math.PI, true);
        axle.setLinvel({ x: 0, y: 0 }, true);
        axle.setAngvel(0, true);
      }
    }
    for (const b of [car.chassis, car.wheelF, car.wheelR, ...(car.axles || [])]) {
      try {
        b.setBodyType(RAPIER.RigidBodyType.Fixed, true);
      } catch {
        /* ignore */
      }
    }
    snapRender(car);
  }

  /**
   * Hook test : téléporte la voiture au-dessus de la route à x.
   * @param {number} x Abscisse monde.
   * @returns {void}
   */
  teleport(x) {
    const car = this.car;
    if (!car || !this.route) return;
    const xx = Number.isFinite(x) ? x : SPAWN_X;
    const yy = routeYAt(this.route.points, xx) - 80;
    // Si un debugFlip précédent a figé les corps (état flipped, pas mort),
    // restaurer la dynamique pour que la voiture puisse rouler après le saut.
    if (this.state !== 'dead') {
      for (const b of [car.chassis, car.wheelF, car.wheelR, ...(car.axles || [])]) {
        try {
          if (b.bodyType() === RAPIER.RigidBodyType.Fixed) b.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
        } catch {
          /* ignore */
        }
      }
      this.flipTimer = 0;
      if (this.state === 'flipped') {
        this.state = 'driving';
        this.ui.flip(false, 0, 0);
      }
    }
    car.chassis.setTranslation({ x: xx, y: yy }, true);
    car.chassis.setRotation(0, true);
    car.chassis.setLinvel({ x: 0, y: 0 }, true);
    car.chassis.setAngvel(0, true);
    // Déplacer aussi les roues et essieux aux ancrages (rotation 0 ⇒ offset direct),
    // sinon les joints tirent le châssis vers l'ancienne position.
    for (const { body, axle, anchor } of car.wheelMeshes) {
      body.setTranslation({ x: xx + anchor.x, y: yy + anchor.y }, true);
      body.setRotation(0, true);
      body.setLinvel({ x: 0, y: 0 }, true);
      body.setAngvel(0, true);
      if (axle) {
        axle.setTranslation({ x: xx + anchor.x, y: yy + anchor.y }, true);
        axle.setRotation(0, true);
        axle.setLinvel({ x: 0, y: 0 }, true);
        axle.setAngvel(0, true);
      }
    }
    snapRender(car);
  }

  /**
   * Recommence la manche : voiture neuve au départ, distance à 0
   * (deaths, tombes et best conservés).
   * @returns {void}
   */
  reset() {
    if (!this.route) return;
    this.spawnNewCar(this.car ? this.car.spec : null);
  }
}
