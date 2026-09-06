/**
 * Voiture low-poly : spec aléatoire, création physique Rapier
 * (châssis convexHull + 2 roues ball + joints revolute + ressort manuel),
 * propulsion par couple, rendu Pixi (carrosserie + phare + faisceau + roues).
 * @module voiture
 */
import RAPIER from '@dimforge/rapier2d-compat';
import * as PIXI from 'pixi.js';
import { routeYAt } from './route.js';

/** Palette néon sombre des carrosseries. */
export const PALETTE = ['#f43f5e', '#f59e0b', '#22d3ee', '#a78bfa', '#a3e635', '#f472b6'];
/**
 * Groupes de collision (membership << 16 | filter) : les roues ne doivent
 * JAMAIS entrer en contact avec le châssis (sinon frottement permanent qui
 * mange le couple moteur — les roues sont partiellement encastrées).
 */
export const G_ROUTE = 0x0001;
export const G_CHASSIS = 0x0002;
export const G_WHEEL = 0x0004;
/** @param {number} membership @param {number} filter */
export const interactionGroups = (membership, filter) => ((membership << 16) | filter) >>> 0;
/** Couple moteur par roue (unités Rapier en px, calibré pour gravir ~50°). */
export const DRIVE_TORQUE = 4.2e7;
/** Couple de frein (opposé à la rotation). */
export const BRAKE_TORQUE = 6.0e7;
/** Vitesse cible du châssis (≈ 950 px/s : plein gaz = décollages,
 * il faut doser les gaz sur les bosses sous peine de se retourner). */
export const SPEED_TARGET = 950;
/** Vitesse max du châssis (≈ caméra garantie, cf. camera.js). */
export const CHASSIS_MAX_VX = 1050;
/**
 * Enfoncement statique visé de la suspension sous le poids (px).
 * Compromis confort/garde au sol : assez souple pour absorber les bosses
 * (conduite agréable, caisse qui vit), assez ferme pour que le ventre ne
 * racle pas (garde nominale ~30 px). La raideur est dimensionnée par
 * essieu : k = poids_soutenu / SUSP_SAG.
 */
export const SUSP_SAG = 9;
/** Ratio d'amortissement (0.8 = légèrement sous-amorti : la caisse respire
 * sur les bosses sans rebondir ni pomper). */
export const SUSP_ZETA = 0.8;
/** Vitesse max d'un essieu (garde-fou anti-slingshot). */
export const AXLE_MAX_V = 1400;
/** Amortissement angulaire des roues = résistance au roulement (arrêt en ~5 s en roue libre). */
export const WHEEL_ANGULAR_DAMPING = 0.45;

/**
 * Génère une spec de voiture aléatoire (déterministe si rng seedé).
 * @param {() => number} rng RNG dans [0, 1).
 * @returns {{ bodyVerts: Array<{x:number,y:number}>, wheelRadius: number, wheelBase: number, color: string, bodyLen: number, bodyH: number }}
 */
export function randomCarSpec(rng) {
  const L = 70 + rng() * 40; // longueur 70–110 px
  const H = 22 + rng() * 16; // hauteur 22–38 px
  const wheelRadius = 14 + rng() * 10; // rayon 14–24 px
  const wheelBase = Math.min(55 + rng() * 40, L - 14); // empattement, borné à la caisse
  const color = PALETTE[Math.floor(rng() * PALETTE.length)];
  // Silhouette anguleuse 7 sommets (repère local : +X avant, +Y bas).
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
  return { bodyVerts, wheelRadius, wheelBase, color, bodyLen: L, bodyH: H };
}

/**
 * Dessine la carrosserie dans un Graphics (repère local voiture).
 * @param {PIXI.Graphics} g Graphics cible.
 * @param {{ bodyVerts: Array<{x:number,y:number}> }} spec Spec voiture.
 * @param {string} color Couleur de remplissage.
 * @returns {void}
 */
function drawBody(g, spec, color) {
  g.clear();
  const v = spec.bodyVerts;
  g.moveTo(v[0].x, v[0].y);
  for (let i = 1; i < v.length; i++) g.lineTo(v[i].x, v[i].y);
  g.closePath();
  g.fill({ color });
  g.stroke({ width: 2, color: '#e5e7eb' });
}

/**
 * Dessine une roue (pneu + jante unie, sans marqueur : rotation non visible).
 * @param {PIXI.Graphics} g Graphics cible.
 * @param {number} r Rayon.
 * @param {string} tire Couleur du pneu.
 * @returns {void}
 */
function drawWheel(g, r, tire) {
  g.clear();
  g.circle(0, 0, r).fill({ color: tire });
  g.circle(0, 0, r * 0.55).fill({ color: '#9ca3af' });
  g.circle(0, 0, r * 0.22).fill({ color: '#4b5563' });
}

/**
 * Crée la voiture : corps Rapier + visuels Pixi (container à ajouter à la scène).
 *
 * Suspension réelle : chaque roue est portée par un essieu (corps dynamique
 * sans collision) relié au châssis par un joint PRISMATIQUE d'axe Y local
 * (débattement vertical libre) et à la roue par un joint REVOLUTE (rotation
 * libre pour la propulsion). Le ressort/amortisseur manuel agit le long de
 * l'axe compliant ⇒ aucun conflit avec le solveur (stable).
 * @param {import('@dimforge/rapier2d-compat').World} world Monde Rapier.
 * @param {{ bodyVerts: Array<{x:number,y:number}>, wheelRadius: number, wheelBase: number, color: string, bodyLen: number, bodyH: number }} spec Spec voiture.
 * @param {{ x: number, y: number }} spawn Position de spawn.
 * @returns {{ chassis: import('@dimforge/rapier2d-compat').RigidBody, wheelF: import('@dimforge/rapier2d-compat').RigidBody, wheelR: import('@dimforge/rapier2d-compat').RigidBody, axles: Array, joints: Array, colliders: Array, spec: object, container: PIXI.Container, bodyMesh: PIXI.Graphics, wheelMeshes: Array<{mesh:PIXI.Graphics,anchor:{x:number,y:number},body:object,axle:object,k:number,c:number}>, suspTravel: Array<number>, dead: boolean }}
 */
export function createCar(world, spec, spawn) {
  const r = spec.wheelRadius;
  // Ancrage bas : la garde au sol nominale vaut anchorY + r − bodyH/2 ≈ 30 px.
  // Avec l'écrasement statique (~SUSP_SAG) + transfert de charge au démarrage,
  // un ancrage trop haut faisait racler le ventre (travel < −21 px) : d'où
  // les saccades dès qu'on accélérait. Ici la marge avant contact ≈ 23 px.
  const anchorY = spec.bodyH * 0.5 + r * 0.55; // ancrage sous le châssis, roues dégagées
  const anchors = [
    { x: -spec.wheelBase / 2, y: anchorY }, // arrière
    { x: spec.wheelBase / 2, y: anchorY }, // avant
  ];

  // Châssis : convexHull (fallback cuboid), densité 1.0, CCD.
  const flat = new Float32Array(spec.bodyVerts.flatMap((p) => [p.x, p.y]));
  const hull = RAPIER.ColliderDesc.convexHull(flat);
  const chassisDesc = (hull || RAPIER.ColliderDesc.cuboid(spec.bodyLen / 2, spec.bodyH / 2))
    .setDensity(1.0)
    .setFriction(0.35) // basse : si le ventre touche sur un gros impact, il glisse au lieu de planter (à-coup)
    .setRestitution(0.05)
    .setCollisionGroups(interactionGroups(G_CHASSIS, G_ROUTE)) // route uniquement, jamais les roues
    .setTranslation(0, 4); // centre de masse légèrement bas ⇒ stabilité
  const chassis = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic().setTranslation(spawn.x, spawn.y).setRotation(0).setCcdEnabled(true).setCanSleep(false),
  );
  const chassisCol = world.createCollider(chassisDesc, chassis);

  // Roues : ball, densité 1.2, friction forte, combine Average (antipatinage),
  // amortissement angulaire = résistance au roulement (la voiture s'arrête en roue libre).
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
        .setCollisionGroups(interactionGroups(G_WHEEL, G_ROUTE)) // route uniquement
        .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Average),
      body,
    );
    return { body, col };
  });

  // Essieux : cadres dynamiques sans interaction (membership 0 ⇒ aucune
  // collision) reliant châssis (prismatique, débattement Y) et roue (revolute, spin).
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
        .setCollisionGroups(interactionGroups(0, 0)), // aucune interaction, masse seulement
      body,
    );
    return { body, col };
  });

  // Liaisons : prismatique châssis↔essieu (suspension, axe Y local) +
  // revolute essieu↔roue (rotation libre pour la propulsion) +
  // SPRING natif châssis↔essieu (ressort résolu implicitement par le solveur :
  // stable par construction, aucune impulsion manuelle).
  // Les deux ancres coïncident au repos ⇒ rest_length 0 : le spring ramène
  // l'essieu vers son point d'ancre (le prismatique ne laisse que l'axe Y libre).
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

  // Raideur/amortissement par essieu dimensionnés sur les masses réelles :
  // enfoncement statique = SUSP_SAG, ratio d'amortissement = SUSP_ZETA.
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

  // Visuels : tout est enfant du container châssis (les joints étant rigides,
  // les roues restent à offset local fixe ; seule leur rotation est resync).
  const container = new PIXI.Container();
  const bodyMesh = new PIXI.Graphics();
  drawBody(bodyMesh, spec, spec.color);
  container.addChild(bodyMesh);

  // Éclairage : la lampe (halo chaud) vit dans le container châssis ; le
  // cône de visibilité (fan raycasté), la nappe route et les poussières sont
  // en coordonnées monde (ajoutés au carLayer par Game, sous la voiture) :
  // le terrain bloque la lumière rayon par rayon ⇒ vraies ombres.
  const noseX = spec.bodyLen / 2;
  const lightGroup = new PIXI.Container();
  lightGroup.position.set(noseX - 2, 0);
  const lampMesh = new PIXI.Graphics();
  lampMesh.circle(0, 0, 11).fill({ color: '#ffedb0', alpha: 0.5 });
  lampMesh.blendMode = 'add';
  lampMesh.circle(0, 0, 4).fill({ color: '#fff7d6' });
  lightGroup.addChild(lampMesh);
  container.addChild(lightGroup);
  const fanMesh = new PIXI.Graphics();
  fanMesh.blendMode = 'add';
  const washMesh = new PIXI.Graphics();
  washMesh.blendMode = 'add';
  const dustMesh = new PIXI.Graphics();
  dustMesh.blendMode = 'add';
  // Poussières : état persistant (zéro alloc par frame ; init aléatoire pour
  // éviter tout motif visible au spawn).
  const dust = [];
  for (let i = 0; i < DUST_N; i++) {
    dust.push({
      r: 15 + Math.random() * (FAN_RANGE - 45), // distance lampe (px)
      a: (Math.random() * 2 - 1) * 0.9, // écart angulaire (±0.9 × demi-angle)
      vr: 6 + Math.random() * 10, // dérive radiale propre (px/s)
      sz: 1 + (i % 3) * 0.6, // taille
      tw: 1.5 + Math.random() * 3, // fréquence de scintillement
      ph: Math.random() * Math.PI * 2, // phase
      seed: Math.random(),
    });
  }

  const wheelMeshes = anchors.map((a, i) => {
    const mesh = new PIXI.Graphics();
    drawWheel(mesh, r, '#1f2937');
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
    wheelMeshes,
    suspTravel: [0, 0],
    dead: false,
    // Éclairage (mis à jour par frame via updateCarLight ; fan/wash/dust
    // vivent dans le carLayer, ajoutés par Game).
    noseX,
    lightGroup,
    fanMesh,
    washMesh,
    dustMesh,
    dust,
    fanHits: new Float32Array(FAN_RAYS),
    dustT: Math.random() * 20,
    // Tampons d'interpolation de rendu (zéro alloc, remplis par snapRender).
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

/**
 * Détruit la voiture (joints + corps + visuels).
 * @param {import('@dimforge/rapier2d-compat').World} world Monde Rapier.
 * @param {object} car Voiture rendue par createCar.
 * @param {{ keepVisual?: boolean }} [opts] Si vrai, conserve le container (tombe).
 * @returns {void}
 */
export function destroyCar(world, car, opts = {}) {
  for (const j of car.joints || []) {
    try {
      world.removeImpulseJoint(j, true);
    } catch {
      /* déjà supprimé avec le corps */
    }
  }
  for (const b of [car.chassis, car.wheelF, car.wheelR, ...(car.axles || [])]) {
    if (b) {
      try {
        world.removeRigidBody(b);
      } catch {
        /* déjà supprimé */
      }
    }
  }
  if (!opts.keepVisual) car.container.destroy({ children: true });
  // Éclairage monde (fan/wash/dust vivent dans le carLayer) : toujours
  // retiré, même pour les tombes (phare éteint sur les épaves).
  for (const m of [car.fanMesh, car.washMesh, car.dustMesh]) {
    try {
      m?.removeFromParent();
      m?.destroy();
    } catch {
      /* déjà nettoyé */
    }
  }
}

/**
 * Propulsion à glissement limité : le couple reste plein tant que la roue
 * accroche (glissement ≤ 60 px/s) puis décroît en douceur (jamais de frein
 * actif, jamais de coupure franche : monotone, aucune oscillation). Sans ça,
 * le couple part en patinage chronique (slip ~400 : la moitié de la puissance
 * chauffe les pneus au lieu de pousser) et la vitesse plafonne à ~400 px/s
 * quel que soit le couple. Le fade se fait sur la vitesse du CHÂSSIS vers
 * SPEED_TARGET. Uniquement des couples (cf. PRD).
 * @param {object} car Voiture.
 * @param {-1|0|1} dir Direction (+1 avant, −1 arrière).
 * @param {number} dt Pas de temps (s).
 * @returns {void}
 */
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

/**
 * Frein fort (Espace) : couple opposé à la rotation, avec zone morte.
 * @param {object} car Voiture.
 * @param {number} dt Pas de temps (s).
 * @returns {void}
 */
export function applyBrake(car, dt) {
  if (car.dead) return;
  for (const w of [car.wheelF, car.wheelR]) {
    const av = w.angvel();
    if (Math.abs(av) > 2) w.applyTorqueImpulse(-Math.sign(av) * BRAKE_TORQUE * dt, true);
  }
}

/**
 * Mesure du débattement de suspension (le ressort est un joint natif résolu
 * implicitement : aucune force manuelle ici) + plafonnement DOUX des vitesses
 * par traînée (impulsions opposées à l'excès, rappel exponentiel).
 *
 * L'ancien code imposait les vélocités directement (setLinvel brutal) : chaque
 * dépassement en descente/bosse produisait une discontinuité visible (saccade),
 * en violation du PRD (« uniquement forces/couples/moteurs »). La traînée
 * dissipe sans discontinuité.
 * @param {object} car Voiture.
 * @param {number} dt Pas de temps (s).
 * @returns {void}
 */
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
    // Débattement le long de l'axe Y local (−sin·dx + cos·dy), moins l'ancre.
    // (Ancien bug : +sin·dx faussait la mesure dès que la voiture penchait.)
    car.suspTravel[i] = -sin * dx + cos * dy - anchor.y;
    softCap(axle, AXLE_MAX_V, AXLE_MAX_V, dt);
  });
  softCap(car.chassis, CHASSIS_MAX_VX, 1100, dt);
}

/**
 * Plafonne en douceur la vélocité d'un corps : au-delà du seuil, applique
 * une impulsion opposée à une fraction de l'excès (traînée quadratique
 * approchée, sans discontinuité — contrairement à setLinvel).
 * @param {import('@dimforge/rapier2d-compat').RigidBody} body Corps.
 * @param {number} maxX Seuil horizontal (px/s).
 * @param {number} maxY Seuil vertical (px/s).
 * @param {number} dt Pas de temps (s, pour proportionner l'impulsion).
 * @returns {void}
 */
function softCap(body, maxX, maxY, dt) {
  const v = body.linvel();
  const ex = Math.abs(v.x) > maxX ? v.x - Math.sign(v.x) * maxX : 0;
  const ey = Math.abs(v.y) > maxY ? v.y - Math.sign(v.y) * maxY : 0;
  if (ex !== 0 || ey !== 0) {
    // Rappel en ~5 steps (doux) : fraction de l'excès de quantité de mouvement.
    const m = body.mass();
    const k = Math.min(1, dt * 12);
    body.applyImpulse({ x: -ex * m * k, y: -ey * m * k }, true);
  }
}

/**
 * État de rendu interpolé (zéro alloc : tableaux pré-alloués).
 * `prev` = état physique avant le dernier pas, `curr` = après.
 * Le rendu affiche lerp(prev, curr, alpha) avec alpha = resteAccumulateur/STEP :
 * sur écran 120 Hz+ (0 step une frame sur deux) ou quand l'accumulateur
 * saute/double un step, le défilement reste continu au lieu d'avancer par
 * paliers (saccades visibles uniquement en roulant).
 * @param {object} car Voiture.
 * @returns {void}
 */
export function snapshotPrev(car) {
  if (!car || !car.render) return;
  const R = car.render;
  readBody(car.chassis, R.cPrev);
  readBody(car.wheelF, R.fPrev);
  readBody(car.wheelR, R.rPrev);
}

/**
 * Mémorise l'état d'après-step pour l'interpolation de rendu.
 * @param {object} car Voiture.
 * @returns {void}
 */
export function snapshotCurr(car) {
  if (!car || !car.render) return;
  const R = car.render;
  readBody(car.chassis, R.cCurr);
  readBody(car.wheelF, R.fCurr);
  readBody(car.wheelR, R.rCurr);
}

/**
 * Aligne prev = curr = état actuel (après téléportation/respawn : évite une
 * traînée d'interpolation d'une frame depuis l'ancienne position).
 * @param {object} car Voiture.
 * @returns {void}
 */
export function snapRender(car) {
  if (!car || !car.render) return;
  snapshotCurr(car);
  const R = car.render;
  R.cPrev.x = R.cCurr.x; R.cPrev.y = R.cCurr.y; R.cPrev.a = R.cCurr.a;
  R.fPrev.x = R.fCurr.x; R.fPrev.y = R.fCurr.y; R.fPrev.a = R.fCurr.a;
  R.rPrev.x = R.rCurr.x; R.rPrev.y = R.rCurr.y; R.rPrev.a = R.rCurr.a;
}

/**
 * Lit position + angle d'un corps dans un slot pré-alloué (zéro alloc).
 * @param {object} body Corps Rapier.
 * @param {{ x: number, y: number, a: number }} out Slot cible.
 * @returns {void}
 */
function readBody(body, out) {
  const t = body.translation();
  out.x = t.x; out.y = t.y; out.a = body.rotation();
}

/**
 * Interpolation angulaire par le plus court chemin (gère le wrap ±π).
 * @param {number} a Angle de départ.
 * @param {number} b Angle d'arrivée.
 * @param {number} t Facteur [0, 1].
 * @returns {number} Angle interpolé.
 */
function lerpAngle(a, b, t) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  else if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

/**
 * Recopie l'état physique vers les visuels, interpolé (zéro alloc).
 * @param {object} car Voiture.
 * @param {number} [alpha] Facteur d'interpolation [0, 1] (1 = état courant,
 * 0 = état précédent ; défaut 1 = comportement non interpolé).
 * @returns {void}
 */
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

/** Nombre de rayons du cône de visibilité du phare. */
export const FAN_RAYS = 56;
/** Demi-angle du cône du phare (rad, ~15°). */
export const FAN_HALF = 0.26;
/** Portée max du faisceau (px, nuit noire au-delà). */
export const FAN_RANGE = 380;
/** Inclinaison du phare vers le sol (rad, repère y-bas : positif = vers le bas). */
export const LIGHT_PITCH = 0.14;
/** Poussières en suspension dans le faisceau. */
export const DUST_N = 44;

/**
 * Construit la liste d'arêtes (segments route) pour le raycast, en
 * Float32Array [x1,y1,x2,y2]×N. Mise en cache par référence de points
 * (la route est statique : zéro alloc par frame).
 * @param {Array<{x:number,y:number}>} points Points de la route.
 * @returns {Float32Array} Arêtes.
 */
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
/** @type {Array<{x:number,y:number}>|null} */
let edgeCachePts = null;
/** @type {Float32Array|null} */
let edgeCache = null;

/**
 * Intersection rayon (origine + direction normalisée) / segment, forme
 * paramétrique (cf. ncase.me/sight-and-light, Red Blob Games visibility).
 * @param {number} ox Origine X. @param {number} oy Origine Y.
 * @param {number} dx Direction X (normalisée). @param {number} dy Direction Y.
 * @param {number} x1 @param {number} y1 @param {number} x2 @param {number} y2 Segment.
 * @returns {number} Distance le long du rayon, ou Infinity.
 */
export function castRay(ox, oy, dx, dy, x1, y1, x2, y2) {
  const sdx = x2 - x1;
  const sdy = y2 - y1;
  const denom = dx * sdy - dy * sdx;
  if (denom > -1e-9 && denom < 1e-9) return Infinity; // parallèle
  const t2 = (dy * (x1 - ox) - dx * (y1 - oy)) / denom;
  if (t2 < 0 || t2 > 1) return Infinity;
  const t = Math.abs(dx) > Math.abs(dy) ? (x1 + sdx * t2 - ox) / dx : (y1 + sdy * t2 - oy) / dy;
  return t >= 0 ? t : Infinity;
}

/**
 * Cône de visibilité : N rayons uniformes sur [aim−half, aim+half], plus
 * proche impact route par rayon (borne range). Les rayons qui ne touchent
 * rien vont à range ⇒ l'ombre derrière les crêtes est exacte par
 * construction (c'est le polygone de visibilité du phare).
 * @param {number} lx Lampe X (monde). @param {number} ly Lampe Y.
 * @param {number} aim Cap du faisceau (rad). @param {number} half Demi-angle.
 * @param {number} count Nombre de rayons. @param {number} range Portée max.
 * @param {Float32Array} edges Arêtes (cf. edgesFor).
 * @param {Float32Array} out Distances (rempli, zéro alloc).
 * @returns {Float32Array} out.
 */
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

/**
 * Atténuation spot classique : 1 / (c + l·d + q·d²), d = distance / portée.
 * @param {number} f Fraction de portée [0, 1].
 * @returns {number} Facteur [0, 1].
 */
function falloff(f) {
  const d = f < 0 ? 0 : f > 1 ? 1 : f;
  return 1 / (1 + 0.6 * d + 2.4 * d * d);
}

/**
 * Dessine une bande annulaire du fan (entre fractions f0 et f1 des impacts),
 * en une seule forme remplie.
 * @param {PIXI.Graphics} g Cible. @param {number} lx Lampe X. @param {number} ly Lampe Y.
 * @param {Float32Array} coss Cos par rayon. @param {Float32Array} sins Sin par rayon.
 * @param {Float32Array} hits Impacts par rayon. @param {number} f0 @param {number} f1 Fractions.
 * @param {string} color @param {number} alpha Alpha (déjà atténuée).
 * @returns {void}
 */
function drawFanBand(g, lx, ly, coss, sins, hits, f0, f1, color, alpha) {
  const n = hits.length;
  g.moveTo(lx + coss[0] * hits[0] * f0, ly + sins[0] * hits[0] * f0);
  for (let i = 1; i < n; i++) g.lineTo(lx + coss[i] * hits[i] * f0, ly + sins[i] * hits[i] * f0);
  for (let i = n - 1; i >= 0; i--) g.lineTo(lx + coss[i] * hits[i] * f1, ly + sins[i] * hits[i] * f1);
  g.closePath();
  g.fill({ color, alpha });
}

// Bandes du cône interne (cœur chaud) : fines pour un dégradé sans arcs.
const FAN_INNER_FR = [0, 0.1, 0.2, 0.32, 0.45, 0.6, 0.75, 0.9, 1.0];
// Bandes du halo externe (bords doux).
const FAN_OUTER_FR = [0, 0.22, 0.45, 0.7, 1.0];

/**
 * Met à jour l'éclairage par frame : cône de visibilité raycasté contre la
 * route (ombres exactes derrière les crêtes), atténuation physique en
 * distance, nappe lumineuse suivant la chaussée sous le faisceau, poussières
 * advectées (vent relatif + scintillement), micro-flicker de lampe.
 * Zéro alloc par frame (tampons pré-alloués sur car).
 * @param {object} car Voiture.
 * @param {number} dt Delta temps rendu (s).
 * @param {Array<{x:number,y:number}>|null} routePoints Points de la route (ou null).
 * @returns {void}
 */
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
  const edges = edgesFor(routePoints);
  const hits = castFan(lx, ly, aim, FAN_HALF, FAN_RAYS, FAN_RANGE, edges, car.fanHits);
  // Directions par rayon (réutilise le tampon fanHits via tableaux locaux
  // statiques : pas d'alloc).
  for (let i = 0; i < FAN_RAYS; i++) {
    const a = aim - FAN_HALF + (2 * FAN_HALF * i) / (FAN_RAYS - 1);
    fanCos[i] = Math.cos(a);
    fanSin[i] = Math.sin(a);
  }
  const flick = 1 + 0.022 * Math.sin(t * 12.9) + 0.014 * Math.sin(t * 5.7 + 1.7);
  car.lightGroup.alpha = 0.92 + 0.08 * flick;
  // Cône : cœur (8 bandes fines) + halo doux (4 bandes, angle plein).
  const fan = car.fanMesh;
  fan.clear();
  for (let j = 0; j < FAN_INNER_FR.length - 1; j++) {
    const mid = (FAN_INNER_FR[j] + FAN_INNER_FR[j + 1]) / 2;
    drawFanBand(fan, lx, ly, fanCos, fanSin, hits, FAN_INNER_FR[j], FAN_INNER_FR[j + 1], '#ffe3a1', 0.26 * falloff(mid) * flick);
  }
  for (let j = 0; j < FAN_OUTER_FR.length - 1; j++) {
    const mid = (FAN_OUTER_FR[j] + FAN_OUTER_FR[j + 1]) / 2;
    drawFanBand(fan, lx, ly, fanCos, fanSin, hits, FAN_OUTER_FR[j], FAN_OUTER_FR[j + 1], '#f6c453', 0.09 * falloff(mid) * flick);
  }
  // Nappe : suit la chaussée sous l'empreinte du faisceau (impacts réels).
  const wash = car.washMesh;
  wash.clear();
  let hx0 = Infinity;
  let hx1 = -Infinity;
  for (let i = 0; i < FAN_RAYS; i++) {
    if (hits[i] < FAN_RANGE - 1) {
      const px = lx + fanCos[i] * hits[i];
      if (px < hx0) hx0 = px;
      if (px > hx1) hx1 = px;
    }
  }
  if (hx1 - hx0 > 15) {
    const xA = Math.max(hx0 - 6, lx - 10);
    wash.moveTo(xA, routeYAt(routePoints, xA) - 2.5);
    for (let x = xA + 9; x <= hx1 + 6; x += 9) wash.lineTo(x, routeYAt(routePoints, x) - 2.5);
    wash.stroke({ width: 9, color: '#ffd88f', alpha: 0.16 * flick });
    wash.moveTo(xA, routeYAt(routePoints, xA) - 2.5);
    for (let x = xA + 9; x <= hx1 + 6; x += 9) wash.lineTo(x, routeYAt(routePoints, x) - 2.5);
    wash.stroke({ width: 3.5, color: '#ffe9b8', alpha: 0.2 * flick });
  }
  // Poussières : advectées par le vent relatif (vitesse voiture projetée sur
  // l'axe) + dérive propre, brillance = intensité locale × scintillement.
  // Clippées au polygone de visibilité (interpolation des impacts) : jamais
  // sous le sol ni derrière les crêtes — que de la lumière éclairée.
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
    // Portée éclairée dans cette direction (ombre respectée).
    const rel = p.a * 0.5 + 0.5;
    const fi = rel * (FAN_RAYS - 1);
    const i0 = fi <= 0 ? 0 : fi >= FAN_RAYS - 1 ? FAN_RAYS - 2 : Math.floor(fi);
    const fr = fi - i0;
    const maxR = hits[i0] * (1 - fr) + hits[i0 + 1] * fr;
    if (p.r > maxR - 6 || p.r < 12) p.r = 15 + p.seed * Math.max(20, maxR - 30);
    const px = lx + Math.cos(pa) * p.r;
    const py = ly + Math.sin(pa) * p.r;
    const bright = falloff(p.r / FAN_RANGE) * (1 - p.a * p.a) * (0.5 + 0.5 * Math.sin(t * p.tw + p.ph)) * flick;
    if (bright > 0.03) g.circle(px, py, p.sz).fill({ color: '#fff6d8', alpha: 0.6 * bright });
  }
}
/** Cos par rayon (tampon statique, zéro alloc). @type {Float32Array} */
const fanCos = new Float32Array(FAN_RAYS);
/** Sin par rayon (tampon statique, zéro alloc). @type {Float32Array} */
const fanSin = new Float32Array(FAN_RAYS);
/**
 * Transforme la voiture en fantôme de tombe : physique désactivée
 * (colliders off + corps fixes), visuel grisé transparent, phare éteint.
 * @param {import('@dimforge/rapier2d-compat').World} world Monde Rapier.
 * @param {object} car Voiture.
 * @returns {void}
 */
export function ghostifyCar(world, car) {
  for (const c of car.colliders) {
    try {
      c.setEnabled(false);
    } catch {
      /* ignore */
    }
  }
  for (const b of [car.chassis, car.wheelF, car.wheelR, ...(car.axles || [])]) {
    try {
      b.setBodyType(RAPIER.RigidBodyType.Fixed, true);
    } catch {
      /* ignore */
    }
  }
  drawBody(car.bodyMesh, car.spec, '#6b7280');
  for (const { mesh } of car.wheelMeshes) drawWheel(mesh, car.spec.wheelRadius, '#374151');
  car.container.alpha = 0.55;
  if (car.lightGroup) car.lightGroup.visible = false;
  for (const m of [car.fanMesh, car.washMesh, car.dustMesh]) {
    if (m) m.visible = false;
  }
  car.dead = true;
  void world;
}
