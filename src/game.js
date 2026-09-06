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
import { createTwinkles, drawTwinkles } from './glace.js';
import { normalizeSeed } from './utils.js';

export const FLIP_COS = -0.17;

export const FLIP_TIME = 3.0;

export const RESPAWN_DELAY = 1.2;

export const SPAWN_X = 0;

export class Game {

  constructor({ world, worldLayer, camera = null, best = 0, audio = null, ui = {} }) {
    this.world = world;
    this.layer = worldLayer;
    this.camera = camera;
    this.audio = audio;
    this.ui = { toast: () => {}, flip: () => {}, hint: () => {}, ...ui };

    this.routeGfx = new PIXI.Graphics();
    this.twinkleGfx = new PIXI.Graphics();
    this.carLayer = new PIXI.Container();
    this.layer.addChild(this.routeGfx);
    this.layer.addChild(this.twinkleGfx);
    this.layer.addChild(this.carLayer);
    this.twinkles = createTwinkles(36, 7, -600, 11400);
    this.twinkleT = Math.random() * 20;

    this.state = 'ready';
    this.distance = 0;
    this.best = Number.isFinite(best) && best > 0 ? best : 0;
    this.deaths = 0;

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

  newRoute(seed, difficulty) {
    this.seed = normalizeSeed(seed);
    this.difficulty = normalizeDifficulty(difficulty);

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
    const pts = this.route.points;

    this.twinkles = createTwinkles(36, this.seed, pts[0].x, pts[pts.length - 1].x);
    this.routeGfx.clear();
    drawRoute(this.routeGfx, this.route.points, this.difficulty, this.seed);
    this.twinkleGfx.clear();
    this.spawnNewCar(null);
    return { seed: this.seed, difficulty: this.difficulty };
  }

  spawnNewCar(prevSpec) {
    if (this.car) {

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

    this.carLayer.addChildAt(this.car.washMesh, 0);
    this.carLayer.addChildAt(this.car.fanMesh, 1);
    this.carLayer.addChildAt(this.car.dustMesh, 2);

    for (const s of [this.car.shadowSpr1, this.car.shadowSpr2]) {
      if (s) this.carLayer.addChildAt(s, 0);
    }
    this.carLayer.addChild(this.car.container);
    syncCarVisual(this.car);
    this.state = 'ready';
    this.distance = 0;
    this.flipTimer = 0;
    this.deadTimer = 0;
    this.stuckTimer = 0;
    if (this.camera) this.camera.snapTo(spawn.x, spawn.y - 80);
    if (this.audio && typeof this.audio.onSpawn === 'function') {
      try {
        this.audio.onSpawn();
      } catch {

      }
    }
  }

  setInput(dir, brake) {
    this.dir = dir;
    this.brake = brake;
  }

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

    if (t.y > 2000 || t.y - routeYAt(this.route.points, t.x) > 500) {
      this.die('fall', t);
      return;
    }

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

  frame(alpha = 1, dt = 0) {
    if (!this.car) return;
    syncCarVisual(this.car, alpha);
    updateCarLight(this.car, dt, this.route ? this.route.points : null);
  }

  updateIce(dt, camX, viewW) {
    if (!this.route) return;
    const step = Math.min(0.1, Math.max(0, dt || 0));
    if (step > 0) this.twinkleT += step;
    const cx = Number.isFinite(camX) ? camX : this.carX;
    const vw = Number.isFinite(viewW) && viewW > 0 ? viewW : 2600;
    drawTwinkles(this.twinkleGfx, this.twinkles, this.twinkleT, cx, vw, this.route.points);
  }

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
    if (this.audio && typeof this.audio.onDeath === 'function') {
      try {
        this.audio.onDeath();
      } catch {

      }
    }
    try {
      localStorage.setItem('voituros.best', String(this.best));
    } catch {

    }
    this.ui.toast(
      kind === 'flip' ? `💀 Retourné ! ${d.toFixed(1)} m — nouvelle voiture…` : `💀 Chute ! ${d.toFixed(1)} m — nouvelle voiture…`,
    );
  }

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

  get carX() {
    return this.car ? this.car.chassis.translation().x : 0;
  }

  get carY() {
    return this.car ? this.car.chassis.translation().y : 0;
  }

  get carAngle() {
    return this.car ? this.car.chassis.rotation() : 0;
  }

  get carLongSpeed() {
    if (!this.car) return 0;
    const v = this.car.chassis.linvel();
    const a = this.car.chassis.rotation();
    return v.x * Math.cos(a) + v.y * Math.sin(a);
  }

  get carVel() {
    if (!this.car) return { x: 0, y: 0 };
    const v = this.car.chassis.linvel();
    return { x: v.x, y: v.y };
  }

  get carSpec() {
    return this.car ? this.car.spec : null;
  }

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

      }
    }
    snapRender(car);
  }

  teleport(x) {
    const car = this.car;
    if (!car || !this.route) return;
    const xx = Number.isFinite(x) ? x : SPAWN_X;
    const yy = routeYAt(this.route.points, xx) - 80;

    if (this.state !== 'dead') {
      for (const b of [car.chassis, car.wheelF, car.wheelR, ...(car.axles || [])]) {
        try {
          if (b.bodyType() === RAPIER.RigidBodyType.Fixed) b.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
        } catch {

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

  reset() {
    if (!this.route) return;
    this.spawnNewCar(this.car ? this.car.spec : null);
  }
}

