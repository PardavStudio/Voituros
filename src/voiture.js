import RAPIER from '@dimforge/rapier2d-compat';
import * as PIXI from 'pixi.js';
import { routeYAt } from './route.js';
import { randomPaint, drawPaint, drawGlint, shade } from './peinture.js';

export const PALETTE = ['#f43f5e', '#f59e0b', '#22d3ee', '#a78bfa', '#a3e635', '#f472b6'];

export const G_ROUTE = 0x0001;
export const G_CHASSIS = 0x0002;
export const G_WHEEL = 0x0004;

export const interactionGroups = (membership, filter) => ((membership << 16) | filter) >>> 0;

export const DRIVE_TORQUE = 4.2e7;

export const BRAKE_TORQUE = 6.0e7;

export const SPEED_TARGET = 950;

export const CHASSIS_MAX_VX = 1050;

export const SUSP_SAG = 9;

export const SUSP_ZETA = 0.8;

export const AXLE_MAX_V = 1400;

export const WHEEL_ANGULAR_DAMPING = 0.45;

export function randomCarSpec(rng) {
  const L = 70 + rng() * 40;
  const H = 22 + rng() * 16;
  const wheelRadius = 14 + rng() * 10;
  const wheelBase = Math.min(55 + rng() * 40, L - 14);
  const paint = randomPaint(rng);
  const color = paint.base;

  const j = () => (rng() - 0.5) * 4;
  const bodyVerts = [
    { x: -L / 2, y: H * 0.5 },
    { x: L / 2, y: H * 0.5 },
    { x: L / 2, y: -H * 0.05 + j() },
    { x: L * 0.18 + j(), y: -H * 0.28 },
    { x: L * 0.02 + j(), y: -H * 0.5 },
    { x: -L * 0.28 + j(), y: -H * 0.5 },
    { x: -L / 2, y: -H * 0.1 + j() },
  ];
  return { bodyVerts, wheelRadius, wheelBase, color, bodyLen: L, bodyH: H, paint };
}

export const GRAVE_PAINT = { base: '#6b7280', secondary: '#4b5563', pattern: 'solid', metal: 0, pearl: 0, seed: 0 };

function drawWheel(g, r, paint) {
  g.clear();
  const metal = paint?.metal ?? 0.6;

  const tg = new PIXI.FillGradient({
    type: 'linear',
    start: { x: 0.5, y: 0 },
    end: { x: 0.5, y: 1 },
    textureSpace: 'local',
    colorStops: [
      { offset: 0, color: '#3a4353' },
      { offset: 0.55, color: '#161b22' },
      { offset: 1, color: '#07090d' },
    ],
  });
  g.circle(0, 0, r).fill({ fill: tg });

  g.circle(0, 0, r * 0.97).fill({ color: '#1d232c', alpha: 0.55 });

  const rimR = r * 0.62;
  g.circle(0, 0, rimR + 0.8).fill({ color: '#d5dae2', alpha: 0.9 });

  g.circle(0, 0, rimR - 0.8).fill({ color: '#0b0e13' });

  g.circle(0, 0, rimR * 0.8).fill({ color: '#5b636e' });
  for (let k = 0; k < 6; k++) {
    const a = (k * Math.PI * 2) / 6 + 0.5;
    g.circle(Math.cos(a) * rimR * 0.55, Math.sin(a) * rimR * 0.55, Math.max(1, r * 0.022));
    g.fill({ color: '#2c333d' });
  }

  const spoke = shade('#c2c8d1', -22 + 20 * metal);
  const spokeDark = shade('#7d848f', -20 + 16 * metal);
  const quads = [];
  for (let k = 0; k < 5; k++) {
    const a = (k * Math.PI * 2) / 5;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const px = -sa;
    const py = ca;
    quads.push([ca, sa, px, py]);
  }
  for (const [wd, col] of [[1.35, spokeDark], [1.0, spoke]]) {
    for (const [ca, sa, px, py] of quads) {
      const r0 = r * 0.16;
      const r1 = rimR * 0.92;
      const wdt = r * 0.075 * wd;
      g.moveTo(ca * r0 - px * wdt, sa * r0 - py * wdt);
      g.lineTo(ca * r1 - px * wdt * 1.25, sa * r1 - py * wdt * 1.25);
      g.lineTo(ca * r1 + px * wdt * 1.25, sa * r1 + py * wdt * 1.25);
      g.lineTo(ca * r0 + px * wdt, sa * r0 + py * wdt);
      g.closePath();
      g.fill({ color: col });
    }
  }

  g.circle(0, 0, r * 0.15).fill({ color: '#3a414c' });
  for (let k = 0; k < 5; k++) {
    const a = (k * Math.PI * 2) / 5 + 0.3;
    g.circle(Math.cos(a) * r * 0.1, Math.sin(a) * r * 0.1, Math.max(1, r * 0.025));
    g.fill({ color: '#c9ced6' });
  }
  g.circle(0, 0, r * 0.06).fill({ color: '#e8ebf0' });
}

export function createCar(world, spec, spawn) {
  const r = spec.wheelRadius;

  const anchorY = spec.bodyH * 0.5 + r * 0.55;
  const anchors = [
    { x: -spec.wheelBase / 2, y: anchorY },
    { x: spec.wheelBase / 2, y: anchorY },
  ];

  const flat = new Float32Array(spec.bodyVerts.flatMap((p) => [p.x, p.y]));
  const hull = RAPIER.ColliderDesc.convexHull(flat);
  const chassisDesc = (hull || RAPIER.ColliderDesc.cuboid(spec.bodyLen / 2, spec.bodyH / 2))
    .setDensity(1.0)
    .setFriction(0.35)
    .setRestitution(0.05)
    .setCollisionGroups(interactionGroups(G_CHASSIS, G_ROUTE))
    .setTranslation(0, 4);
  const chassis = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic().setTranslation(spawn.x, spawn.y).setRotation(0).setCcdEnabled(true).setCanSleep(false),
  );
  const chassisCol = world.createCollider(chassisDesc, chassis);

  const wheels = anchors.map((a) => {
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(spawn.x + a.x, spawn.y + a.y)
        .setCcdEnabled(true)
        .setCanSleep(false)
        .setAngularDamping(WHEEL_ANGULAR_DAMPING),
    );
    const col = world.createCollider(
      RAPIER.ColliderDesc.ball(r)
        .setDensity(1.2)
        .setFriction(2.0)
        .setRestitution(0.1)
        .setCollisionGroups(interactionGroups(G_WHEEL, G_ROUTE))
        .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Average),
      body,
    );
    return { body, col };
  });

  const axles = anchors.map((a) => {
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(spawn.x + a.x, spawn.y + a.y)
        .setCcdEnabled(true)
        .setCanSleep(false),
    );
    const col = world.createCollider(
      RAPIER.ColliderDesc.cuboid(6, 6)
        .setDensity(1.0)
        .setCollisionGroups(interactionGroups(0, 0)),
      body,
    );
    return { body, col };
  });

  const joints = [];
  anchors.forEach((a, i) => {
    joints.push(
      world.createImpulseJoint(
        RAPIER.JointData.prismatic({ x: a.x, y: a.y }, { x: 0, y: 0 }, { x: 0, y: 1 }),
        chassis,
        axles[i].body,
        true,
      ),
      world.createImpulseJoint(RAPIER.JointData.revolute({ x: 0, y: 0 }, { x: 0, y: 0 }), axles[i].body, wheels[i].body, true),
    );
  });

  const grav = world.gravity && Number.isFinite(world.gravity.y) ? Math.abs(world.gravity.y) : 980;
  const mC = chassis.mass();
  const cornerKC = anchors.map((_, i) => {
    const mW = wheels[i].body.mass() + axles[i].body.mass();
    const supported = mC / 2 + mW;
    const staticF = supported * grav;
    const k = staticF / SUSP_SAG;
    const mEff = (mC / 2) * mW / (mC / 2 + mW);
    const c = 2 * SUSP_ZETA * Math.sqrt(k * mEff);
    return { k, c };
  });
  anchors.forEach((a, i) => {
    joints.push(
      world.createImpulseJoint(
        RAPIER.JointData.spring(0, cornerKC[i].k, cornerKC[i].c, { x: a.x, y: a.y }, { x: 0, y: 0 }),
        chassis,
        axles[i].body,
        true,
      ),
    );
  });

  const container = new PIXI.Container();
  const bodyMesh = new PIXI.Graphics();
  drawPaint(bodyMesh, spec, spec.paint);
  container.addChild(bodyMesh);

  const glintMesh = new PIXI.Graphics();
  glintMesh.blendMode = 'add';
  drawGlint(glintMesh, spec, spec.paint, 0);
  container.addChild(glintMesh);

  const noseX = spec.bodyLen / 2;
  const lightGroup = new PIXI.Container();
  lightGroup.position.set(noseX - 2, 0);
  const lampMesh = new PIXI.Graphics();
  lampMesh.blendMode = 'add';

  lampMesh.circle(0, 0, 8).fill({ color: '#ffe9b8', alpha: 0.4 });
  lampMesh.circle(0, 0, 3.6).fill({ color: '#fffef8', alpha: 0.95 });
  lightGroup.addChild(lampMesh);
  container.addChild(lightGroup);
  const fanMesh = new PIXI.Graphics();
  fanMesh.blendMode = 'add';

  let shadowSpr1 = null;
  let shadowSpr2 = null;
  try {
    shadowTex = shadowTex || makeBlobTexture('4,7,13');
    if (shadowTex) {
      shadowSpr1 = new PIXI.Sprite(shadowTex);
      shadowSpr1.anchor.set(0.5);
      shadowSpr2 = new PIXI.Sprite(shadowTex);
      shadowSpr2.anchor.set(0.5);
    }
  } catch {
    shadowSpr1 = shadowSpr2 = null;
  }
  const washMesh = new PIXI.Graphics();
  washMesh.blendMode = 'add';
  const dustMesh = new PIXI.Graphics();
  dustMesh.blendMode = 'add';

  const dust = [];
  for (let i = 0; i < DUST_N; i++) {
    dust.push({
      r: 15 + Math.random() * (FAN_RANGE - 45),
      a: (Math.random() * 2 - 1) * 0.9,
      vr: 6 + Math.random() * 10,
      sz: 1 + (i % 3) * 0.6,
      tw: 1.5 + Math.random() * 3,
      ph: Math.random() * Math.PI * 2,
      seed: Math.random(),
    });
  }

  const wheelMeshes = anchors.map((a, i) => {
    const mesh = new PIXI.Graphics();
    drawWheel(mesh, r, spec.paint);
    mesh.position.set(a.x, a.y);
    container.addChild(mesh);
    return { mesh, anchor: a, body: wheels[i].body, axle: axles[i].body, k: cornerKC[i].k, c: cornerKC[i].c };
  });

  const car = {
    chassis,
    wheelF: wheels[1].body,
    wheelR: wheels[0].body,
    axles: [axles[0].body, axles[1].body],
    joints,
    colliders: [chassisCol, wheels[0].col, wheels[1].col, axles[0].col, axles[1].col],
    spec,
    container,
    bodyMesh,
    glintMesh,
    shadowSpr1,
    shadowSpr2,
    wheelMeshes,
    suspTravel: [0, 0],
    dead: false,

    noseX,
    lightGroup,
    fanMesh,
    washMesh,
    dustMesh,
    dust,
    fanHits: new Float32Array(FAN_RAYS),
    dustT: Math.random() * 20,

    render: {
      cPrev: { x: 0, y: 0, a: 0 }, cCurr: { x: 0, y: 0, a: 0 },
      fPrev: { x: 0, y: 0, a: 0 }, fCurr: { x: 0, y: 0, a: 0 },
      rPrev: { x: 0, y: 0, a: 0 }, rCurr: { x: 0, y: 0, a: 0 },
      _t: null, _f: null, _r: null, _fA: 0, _rA: 0,
    },
  };
  snapRender(car);
  return car;
}

export function destroyCar(world, car, opts = {}) {
  for (const j of car.joints || []) {
    try {
      world.removeImpulseJoint(j, true);
    } catch {

    }
  }
  for (const b of [car.chassis, car.wheelF, car.wheelR, ...(car.axles || [])]) {
    if (b) {
      try {
        world.removeRigidBody(b);
      } catch {

      }
    }
  }
  if (!opts.keepVisual) car.container.destroy({ children: true });

  for (const m of [car.fanMesh, car.washMesh, car.dustMesh]) {
    try {
      m?.removeFromParent();
      m?.destroy();
    } catch {

    }
  }
  for (const s of [car.shadowSpr1, car.shadowSpr2]) {
    try {
      s?.removeFromParent();
      s?.destroy();
    } catch {

    }
  }
}

export function applyDrive(car, dir, dt) {
  if (!dir || car.dead) return;
  const a = car.chassis.rotation();
  const cv = car.chassis.linvel();
  const vlong = (cv.x * Math.cos(a) + cv.y * Math.sin(a)) * dir;
  const approach = Math.max(0, Math.min(1, (SPEED_TARGET - vlong) / 200));
  const r = car.spec.wheelRadius;
  for (const w of [car.wheelF, car.wheelR]) {
    const slip = w.angvel() * r * dir - vlong;
    const grip = slip <= 60 ? 1 : Math.max(0.15, 1 - (slip - 60) / 190);
    w.applyTorqueImpulse(dir * DRIVE_TORQUE * approach * grip * dt, true);
  }
}

export function applyBrake(car, dt) {
  if (car.dead) return;
  for (const w of [car.wheelF, car.wheelR]) {
    const av = w.angvel();
    if (Math.abs(av) > 2) w.applyTorqueImpulse(-Math.sign(av) * BRAKE_TORQUE * dt, true);
  }
}

export function applySuspension(car, dt) {
  if (car.dead) return;
  const ct = car.chassis.translation();
  const a = car.chassis.rotation();
  const sin = Math.sin(a);
  const cos = Math.cos(a);
  car.wheelMeshes.forEach((entry, i) => {
    const { axle, anchor } = entry;
    const wt = axle.translation();
    const dx = wt.x - ct.x;
    const dy = wt.y - ct.y;

    car.suspTravel[i] = -sin * dx + cos * dy - anchor.y;
    softCap(axle, AXLE_MAX_V, AXLE_MAX_V, dt);
  });
  softCap(car.chassis, CHASSIS_MAX_VX, 1100, dt);
}

function softCap(body, maxX, maxY, dt) {
  const v = body.linvel();
  const ex = Math.abs(v.x) > maxX ? v.x - Math.sign(v.x) * maxX : 0;
  const ey = Math.abs(v.y) > maxY ? v.y - Math.sign(v.y) * maxY : 0;
  if (ex !== 0 || ey !== 0) {

    const m = body.mass();
    const k = Math.min(1, dt * 12);
    body.applyImpulse({ x: -ex * m * k, y: -ey * m * k }, true);
  }
}

export function snapshotPrev(car) {
  if (!car || !car.render) return;
  const R = car.render;
  readBody(car.chassis, R.cPrev);
  readBody(car.wheelF, R.fPrev);
  readBody(car.wheelR, R.rPrev);
}

export function snapshotCurr(car) {
  if (!car || !car.render) return;
  const R = car.render;
  readBody(car.chassis, R.cCurr);
  readBody(car.wheelF, R.fCurr);
  readBody(car.wheelR, R.rCurr);
}

export function snapRender(car) {
  if (!car || !car.render) return;
  snapshotCurr(car);
  const R = car.render;
  R.cPrev.x = R.cCurr.x; R.cPrev.y = R.cCurr.y; R.cPrev.a = R.cCurr.a;
  R.fPrev.x = R.fCurr.x; R.fPrev.y = R.fCurr.y; R.fPrev.a = R.fCurr.a;
  R.rPrev.x = R.rCurr.x; R.rPrev.y = R.rCurr.y; R.rPrev.a = R.rCurr.a;
}

function readBody(body, out) {
  const t = body.translation();
  out.x = t.x; out.y = t.y; out.a = body.rotation();
}

function lerpAngle(a, b, t) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  else if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

export function syncCarVisual(car, alpha = 1) {
  const R = car.render;
  const a = alpha >= 1 || !R ? null : alpha <= 0 ? 0 : alpha;
  let t, angle, fW, rW;
  if (a === null) {
    t = car.chassis.translation();
    angle = car.chassis.rotation();
    fW = car.wheelF.translation(); rW = car.wheelR.translation();
  } else {
    const cx = R.cPrev.x + (R.cCurr.x - R.cPrev.x) * a;
    const cy = R.cPrev.y + (R.cCurr.y - R.cPrev.y) * a;
    angle = lerpAngle(R.cPrev.a, R.cCurr.a, a);
    t = R._t || (R._t = { x: 0, y: 0 });
    t.x = cx; t.y = cy;
    fW = R._f || (R._f = { x: 0, y: 0 });
    fW.x = R.fPrev.x + (R.fCurr.x - R.fPrev.x) * a;
    fW.y = R.fPrev.y + (R.fCurr.y - R.fPrev.y) * a;
    rW = R._r || (R._r = { x: 0, y: 0 });
    rW.x = R.rPrev.x + (R.rCurr.x - R.rPrev.x) * a;
    rW.y = R.rPrev.y + (R.rCurr.y - R.rPrev.y) * a;
    R._fA = lerpAngle(R.fPrev.a, R.fCurr.a, a);
    R._rA = lerpAngle(R.rPrev.a, R.rCurr.a, a);
  }
  car.container.position.set(t.x, t.y);
  car.container.rotation = angle;

  if (car.glintMesh && !car.dead) drawGlint(car.glintMesh, car.spec, car.spec.paint, angle);
  const cos = Math.cos(-angle);
  const sin = Math.sin(-angle);
  car.wheelMeshes.forEach(({ mesh, body }) => {
    const wt = a === null ? body.translation() : body === car.wheelF ? R._f : R._r;
    const dx = wt.x - t.x;
    const dy = wt.y - t.y;
    mesh.position.set(cos * dx - sin * dy, sin * dx + cos * dy);
    mesh.rotation = (a === null ? body.rotation() : body === car.wheelF ? R._fA : R._rA) - angle;
  });
}

export const FAN_RAYS = 56;

export const FAN_HALF = 0.26;

export const FAN_RANGE = 380;

export const LIGHT_PITCH = 0.14;

export const DUST_N = 44;

export function edgesFor(points) {
  if (points === edgeCachePts && edgeCache) return edgeCache;
  const n = points.length - 1;
  const out = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    out[i * 4] = points[i].x;
    out[i * 4 + 1] = points[i].y;
    out[i * 4 + 2] = points[i + 1].x;
    out[i * 4 + 3] = points[i + 1].y;
  }
  edgeCachePts = points;
  edgeCache = out;
  return out;
}

let edgeCachePts = null;

let edgeCache = null;

export function castRay(ox, oy, dx, dy, x1, y1, x2, y2) {
  const sdx = x2 - x1;
  const sdy = y2 - y1;
  const denom = dx * sdy - dy * sdx;
  if (denom > -1e-9 && denom < 1e-9) return Infinity;
  const t2 = (dy * (x1 - ox) - dx * (y1 - oy)) / denom;
  if (t2 < 0 || t2 > 1) return Infinity;
  const t = Math.abs(dx) > Math.abs(dy) ? (x1 + sdx * t2 - ox) / dx : (y1 + sdy * t2 - oy) / dy;
  return t >= 0 ? t : Infinity;
}

export function castFan(lx, ly, aim, half, count, range, edges, out) {
  const xMin = lx - 40;
  const xMax = lx + range + 40;
  for (let i = 0; i < count; i++) {
    const a = count === 1 ? aim : aim - half + (2 * half * i) / (count - 1);
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    let best = range;
    for (let e = 0; e < edges.length; e += 4) {
      const x1 = edges[e];
      const x2 = edges[e + 2];
      if ((x1 < xMin && x2 < xMin) || (x1 > xMax && x2 > xMax)) continue;
      const t = castRay(lx, ly, dx, dy, x1, edges[e + 1], x2, edges[e + 3]);
      if (t < best) best = t;
    }
    out[i] = best;
  }
  return out;
}

let shadowTex = null;

function makeBlobTexture(rgb) {
  try {
    const S = 128;
    const cv = document.createElement('canvas');
    cv.width = S;
    cv.height = S;
    const ctx2d = cv.getContext('2d');
    if (!ctx2d) return null;
    const grd = ctx2d.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    grd.addColorStop(0, `rgba(${rgb},1)`);
    grd.addColorStop(0.4, `rgba(${rgb},0.45)`);
    grd.addColorStop(1, `rgba(${rgb},0)`);
    ctx2d.fillStyle = grd;
    ctx2d.fillRect(0, 0, S, S);
    return PIXI.Texture.from(cv);
  } catch {
    return null;
  }
}
export function beamLight(car, wx, wy) {
  try {
    if (!car || car.dead || !car.fanHits) return 0;
    const pos = car.container.position;
    const angle = car.container.rotation;
    const cb = Math.cos(angle);
    const sb = Math.sin(angle);
    const lx = pos.x + cb * (car.noseX - 2);
    const ly = pos.y + sb * (car.noseX - 2);
    const dx = wx - lx;
    const dy = wy - ly;
    const dist = Math.hypot(dx, dy);
    if (dist < 1 || dist > FAN_RANGE) return 0;
    const aim = angle + LIGHT_PITCH;
    const rel = (Math.atan2(dy, dx) - aim) / (2 * FAN_HALF) + 0.5;
    if (rel < 0 || rel > 1) return 0;
    const fi = rel * (FAN_RAYS - 1);
    const i0 = fi <= 0 ? 0 : fi >= FAN_RAYS - 1 ? FAN_RAYS - 2 : Math.floor(fi);
    const fr = fi - i0;
    const maxR = car.fanHits[i0] * (1 - fr) + car.fanHits[i0 + 1] * fr;
    if (maxR <= 0 || dist > maxR) return 0;
    const prof = Math.cos((rel - 0.5) * Math.PI);
    return Math.max(0, prof * prof) * falloff(dist / FAN_RANGE);
  } catch {
    return 0;
  }
}

function falloff(f) {
  const d = f < 0 ? 0 : f > 1 ? 1 : f;
  return 1 / (1 + 0.6 * d + 2.4 * d * d);
}

function drawFanPoly(g, lx, ly, coss, sins, hits, i0, i1, scale, color, alpha) {
  g.moveTo(lx, ly);
  for (let i = i0; i <= i1; i++) g.lineTo(lx + coss[i] * hits[i] * scale, ly + sins[i] * hits[i] * scale);
  g.closePath();
  g.fill({ color, alpha });
}

export function updateCarLight(car, dt, routePoints) {
  if (!car || !routePoints || !Number.isFinite(dt)) return;
  const show = !car.dead;
  car.fanMesh.visible = show;
  car.washMesh.visible = show;
  car.dustMesh.visible = show;
  car.lightGroup.visible = show;
  if (!show) return;
  const step = Math.max(0, dt);
  car.dustT += step;
  const t = car.dustT;
  const pos = car.container.position;
  const angle = car.container.rotation;
  const cb = Math.cos(angle);
  const sb = Math.sin(angle);
  const lx = pos.x + cb * (car.noseX - 2);
  const ly = pos.y + sb * (car.noseX - 2);
  const aim = angle + LIGHT_PITCH;

  const aimEff = aim + 0.008 * Math.sin(t * 1.7) + 0.005 * Math.sin(t * 4.3 + 0.9);
  const edges = edgesFor(routePoints);
  const hits = castFan(lx, ly, aimEff, FAN_HALF, FAN_RAYS, FAN_RANGE, edges, car.fanHits);

  for (let i = 0; i < FAN_RAYS; i++) {
    const a = aimEff - FAN_HALF + (2 * FAN_HALF * i) / (FAN_RAYS - 1);
    fanCos[i] = Math.cos(a);
    fanSin[i] = Math.sin(a);
  }
  const flick = 1 + 0.022 * Math.sin(t * 12.9) + 0.014 * Math.sin(t * 5.7 + 1.7);
  car.lightGroup.alpha = 0.92 + 0.08 * flick;

  const fan = car.fanMesh;
  fan.clear();
  const last = FAN_RAYS - 1;
  drawFanPoly(fan, lx, ly, fanCos, fanSin, hits, 0, last, 1, '#ffdf6e', 0.1 * flick);

  const wash = car.washMesh;
  wash.clear();

  const sx = pos.x;
  const sy = routeYAt(routePoints, sx) + 7;
  const slope = Math.atan2(
    routeYAt(routePoints, sx + 40) - routeYAt(routePoints, sx - 40),
    80,
  );
  if (car.shadowSpr1) {
    car.shadowSpr1.visible = show;
    car.shadowSpr1.position.set(sx, sy);
    car.shadowSpr1.rotation = slope;
    car.shadowSpr1.scale.set(95 / 64, 15 / 64);
    car.shadowSpr1.alpha = 0.5;
  }
  if (car.shadowSpr2) {
    car.shadowSpr2.visible = show;
    car.shadowSpr2.position.set(sx, sy - 1);
    car.shadowSpr2.rotation = slope;
    car.shadowSpr2.scale.set(58 / 64, 9 / 64);
    car.shadowSpr2.alpha = 0.65;
  }

  const cv = car.chassis.linvel();
  const wind = Math.max(-130, Math.min(40, -(cv.x * Math.cos(aim) + cv.y * Math.sin(aim)) * 0.35));
  const g = car.dustMesh;
  g.clear();
  for (const p of car.dust) {
    p.r += (p.vr + wind) * step;
    p.a += Math.sin(t * 0.8 + p.ph) * 0.15 * step;
    if (p.a > 1) p.a = 1;
    else if (p.a < -1) p.a = -1;
    const pa = aim + p.a * FAN_HALF;

    const rel = p.a * 0.5 + 0.5;
    const fi = rel * (FAN_RAYS - 1);
    const i0 = fi <= 0 ? 0 : fi >= FAN_RAYS - 1 ? FAN_RAYS - 2 : Math.floor(fi);
    const fr = fi - i0;
    const maxR = hits[i0] * (1 - fr) + hits[i0 + 1] * fr;
    if (p.r > maxR - 6 || p.r < 12) {

      p.a = Math.random() * 2 - 1;
      p.seed = Math.random();
      p.ph = Math.random() * Math.PI * 2;
      p.r = 15 + p.seed * Math.max(20, maxR - 30);
    }
    const px = lx + Math.cos(pa) * p.r;
    const py = ly + Math.sin(pa) * p.r;
    const bright = falloff(p.r / FAN_RANGE) * (1 - p.a * p.a) * (0.5 + 0.5 * Math.sin(t * p.tw + p.ph)) * flick;
    if (bright > 0.03) g.circle(px, py, p.sz).fill({ color: '#fff6d8', alpha: 0.6 * bright });
  }
}

const fanCos = new Float32Array(FAN_RAYS);

const fanSin = new Float32Array(FAN_RAYS);

export function ghostifyCar(world, car) {
  for (const c of car.colliders) {
    try {
      c.setEnabled(false);
    } catch {

    }
  }
  for (const b of [car.chassis, car.wheelF, car.wheelR, ...(car.axles || [])]) {
    try {
      b.setBodyType(RAPIER.RigidBodyType.Fixed, true);
    } catch {

    }
  }
  drawPaint(car.bodyMesh, car.spec, GRAVE_PAINT);
  if (car.glintMesh) car.glintMesh.visible = false;
  for (const { mesh } of car.wheelMeshes) drawWheel(mesh, car.spec.wheelRadius, { metal: 0 });
  car.container.alpha = 0.55;
  if (car.lightGroup) car.lightGroup.visible = false;
  for (const m of [car.fanMesh, car.washMesh, car.dustMesh, car.shadowSpr1, car.shadowSpr2]) {
    if (m) m.visible = false;
  }
  car.dead = true;
  void world;
}

