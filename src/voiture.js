/**
 * Voiture low-poly : spec aléatoire, création physique Rapier
 * (châssis convexHull + 2 roues ball + joints revolute + ressort manuel),
 * propulsion par couple, rendu Pixi (carrosserie + phare + faisceau + roues).
 * @module voiture
 */
import RAPIER from '@dimforge/rapier2d-compat';
import * as PIXI from 'pixi.js';
import { routeYAt } from './route.js';
import { randomPaint, drawPaint, drawGlint, shade } from './peinture.js';

/** Palette historique des teintes vives (conservée pour compat, la peinture
 * procédurale de peinture.js a pris le relais). */
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
 * @returns {{ bodyVerts: Array<{x:number,y:number}>, wheelRadius: number, wheelBase: number, color: string, bodyLen: number, bodyH: number, paint: import('./peinture.js').Paint }}
 */
export function randomCarSpec(rng) {
  const L = 70 + rng() * 40; // longueur 70–110 px
  const H = 22 + rng() * 16; // hauteur 22–38 px
  const wheelRadius = 14 + rng() * 10; // rayon 14–24 px
  const wheelBase = Math.min(55 + rng() * 40, L - 14); // empattement, borné à la caisse
  const paint = randomPaint(rng);
  const color = paint.base; // compat : teinte principale
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
  return { bodyVerts, wheelRadius, wheelBase, color, bodyLen: L, bodyH: H, paint };
}

/**
 * Peinture grise d'épave (tombe : même système, teinte ciment, sans motif).
 */
export const GRAVE_PAINT = { base: '#6b7280', secondary: '#4b5563', pattern: 'solid', metal: 0, pearl: 0, seed: 0 };

/**
 * Dessine une roue réaliste (homogène avec la carrosserie) : pneu en dégradé
 * (flanc éclairé en haut), jante alliage 5 branches (le métal suit celui de
 * la peinture), moyeu + écrous. Que des aplats, aucun contour. Les branches
 * rendent la rotation visible (physique, pas de marqueur artificiel).
 * @param {PIXI.Graphics} g Graphics cible.
 * @param {number} r Rayon.
 * @param {{ metal: number }} paint Peinture (métal des branches).
 * @returns {void}
 */
function drawWheel(g, r, paint) {
  g.clear();
  const metal = paint?.metal ?? 0.6;
  // Pneu : flanc éclairé en haut, gomme quasi noire en bas.
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
  // Bande de roulement (anneau externe légèrement plus clair en haut).
  g.circle(0, 0, r * 0.97).fill({ color: '#1d232c', alpha: 0.55 });
  // Lèvre polie (anneau fin clair = lecture du bord de jante).
  const rimR = r * 0.62;
  g.circle(0, 0, rimR + 0.8).fill({ color: '#d5dae2', alpha: 0.9 });
  // Puits de jante sombre.
  g.circle(0, 0, rimR - 0.8).fill({ color: '#0b0e13' });
  // Disque de frein (gris moyen + trous).
  g.circle(0, 0, rimR * 0.8).fill({ color: '#5b636e' });
  for (let k = 0; k < 6; k++) {
    const a = (k * Math.PI * 2) / 6 + 0.5;
    g.circle(Math.cos(a) * rimR * 0.55, Math.sin(a) * rimR * 0.55, Math.max(1, r * 0.022));
    g.fill({ color: '#2c333d' });
  }
  // 5 branches alliage (argent moyen, jamais blanc pur : sinon starburst ;
  // luminosité = métal de la peinture ; biseau sans contour).
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
  // Moyeu + cache + écrous.
  g.circle(0, 0, r * 0.15).fill({ color: '#3a414c' });
  for (let k = 0; k < 5; k++) {
    const a = (k * Math.PI * 2) / 5 + 0.3;
    g.circle(Math.cos(a) * r * 0.1, Math.sin(a) * r * 0.1, Math.max(1, r * 0.025));
    g.fill({ color: '#c9ced6' });
  }
  g.circle(0, 0, r * 0.06).fill({ color: '#e8ebf0' });
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
 * @param {{ bodyVerts: Array<{x:number,y:number}>, wheelRadius: number, wheelBase: number, color: string, bodyLen: number, bodyH: number, paint: object }} spec Spec voiture (inclut `paint`, cf. peinture.js).
 * @param {{ x: number, y: number }} spawn Position de spawn.
 * @returns {{ chassis: import('@dimforge/rapier2d-compat').RigidBody, wheelF: import('@dimforge/rapier2d-compat').RigidBody, wheelR: import('@dimforge/rapier2d-compat').RigidBody, axles: Array, joints: Array, colliders: Array, spec: object, container: PIXI.Container, bodyMesh: PIXI.Graphics, glintMesh: PIXI.Graphics, wheelMeshes: Array<{mesh:PIXI.Graphics,anchor:{x:number,y:number},body:object,axle:object,k:number,c:number}>, suspTravel: Array<number>, dead: boolean }}
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
  drawPaint(bodyMesh, spec, spec.paint); // peinture procédurale, SANS contour
  container.addChild(bodyMesh);
  // Reflet soleil dynamique (strie additive sur le flanc, suit le tangage).
  const glintMesh = new PIXI.Graphics();
  glintMesh.blendMode = 'add';
  drawGlint(glintMesh, spec, spec.paint, 0);
  container.addChild(glintMesh);

  // Éclairage : la lampe (halo chaud) vit dans le container châssis ; le
  // cône de visibilité (fan raycasté), la nappe route et les poussières sont
  // en coordonnées monde (ajoutés au carLayer par Game, sous la voiture) :
  // le terrain bloque la lumière rayon par rayon ⇒ vraies ombres.
  const noseX = spec.bodyLen / 2;
  const lightGroup = new PIXI.Container();
  lightGroup.position.set(noseX - 2, 0);
  const lampMesh = new PIXI.Graphics();
  lampMesh.blendMode = 'add';
  // Sphère de halo + cœur incandescent (uniquement).
  lampMesh.circle(0, 0, 8).fill({ color: '#ffe9b8', alpha: 0.4 });
  lampMesh.circle(0, 0, 3.6).fill({ color: '#fffef8', alpha: 0.95 });
  lightGroup.addChild(lampMesh);
  container.addChild(lightGroup);
  const fanMesh = new PIXI.Graphics();
  fanMesh.blendMode = 'add';
  // Ombre : sprites à blob radial (flou cuit en texture). Pas de nappe au
  // sol (retirée à la demande : le faisceau + poussières portent la lumière).
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
  // Éclairage monde (fan/wash/dust + sprites blobs vivent dans le carLayer).
  // Les sprites partagent les textures du module : removeFromParent suffit
  // (jamais de destroy de texture partagée).
  for (const m of [car.fanMesh, car.washMesh, car.dustMesh]) {
    try {
      m?.removeFromParent();
      m?.destroy();
    } catch {
      /* déjà nettoyé */
    }
  }
  for (const s of [car.shadowSpr1, car.shadowSpr2]) {
    try {
      s?.removeFromParent();
      s?.destroy();
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
  // Reflet soleil : glisse sur le flanc avec le tangage (1 quad, enfant du
  // container donc déjà synchronisé ; seul le motif change).
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

/** Blob radial doux partagé (ombre) : baked une fois en canvas 2D.
 * @type {PIXI.Texture|null} */
let shadowTex = null;

/**
 * Texture de blob radial (centre opaque → transparent).
 * @param {string} rgb Composantes `r,g,b` (ex. `'255,233,196'`).
 * @returns {PIXI.Texture|null} Texture (null si canvas indisponible).
 */
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
 * Dessine un polygone plein-fan (lampe → arc d'impacts entre deux rayons,
 * optionnellement ramené vers la lampe par `scale`) en UNE seule forme.
 * Le faisceau est composé de 4 polygones emboîtés (même teinte, alphas
 * étagées) : aucun découpage interne, donc aucune division visible —
 * seule la silhouette (vraie limite d'ombre) et un halo central existent.
 * @param {PIXI.Graphics} g Cible. @param {number} lx Lampe X. @param {number} ly Lampe Y.
 * @param {Float32Array} coss Cos par rayon. @param {Float32Array} sins Sin par rayon.
 * @param {Float32Array} hits Impacts par rayon.
 * @param {number} i0 Premier rayon. @param {number} i1 Dernier rayon.
 * @param {number} scale Fraction d'impact (1 = impacts réels, < 1 = hotspot).
 * @param {string} color @param {number} alpha Alpha (déjà atténuée).
 * @returns {void}
 */
function drawFanPoly(g, lx, ly, coss, sins, hits, i0, i1, scale, color, alpha) {
  g.moveTo(lx, ly);
  for (let i = i0; i <= i1; i++) g.lineTo(lx + coss[i] * hits[i] * scale, ly + sins[i] * hits[i] * scale);
  g.closePath();
  g.fill({ color, alpha });
}

/**
 * Met à jour l'éclairage par frame : faisceau raycasté contre la route
 * (ombres exactes derrière les crêtes), profil angulaire doux (pénombre,
 * aucun bord net), dégradé chaud→ambré en distance, micro-tremblement de
 * visée (vibrations caisse), nappe lumineuse suivant la chaussée,
 * poussières advectées, micro-flicker de lampe.
 * Zéro alloc par frame (tampons pré-alloués sur car + statiques module).
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
  // Micro-tremblement de visée (±0.5°, vibrations de la caisse) : le faisceau
  // vit, les ombres frémissent — un projecteur réel n'est jamais figé.
  const aimEff = aim + 0.008 * Math.sin(t * 1.7) + 0.005 * Math.sin(t * 4.3 + 0.9);
  const edges = edgesFor(routePoints);
  const hits = castFan(lx, ly, aimEff, FAN_HALF, FAN_RAYS, FAN_RANGE, edges, car.fanHits);
  // Directions par rayon (réutilise le tampon fanHits via tableaux locaux
  // statiques : pas d'alloc).
  for (let i = 0; i < FAN_RAYS; i++) {
    const a = aimEff - FAN_HALF + (2 * FAN_HALF * i) / (FAN_RAYS - 1);
    fanCos[i] = Math.cos(a);
    fanSin[i] = Math.sin(a);
  }
  const flick = 1 + 0.022 * Math.sin(t * 12.9) + 0.014 * Math.sin(t * 5.7 + 1.7);
  car.lightGroup.alpha = 0.92 + 0.08 * flick;
  // Faisceau : 3 polygones plein-fan emboîtés, même teinte chaude (aucune
  // marche de couleur, aucun découpage interne → aucune division visible).
  // Largeurs et alphas étagées ≈ profil gaussien ; les silhouettes suivent
  // les impacts raycastés (ombres exactes = vraies limites d'ombre).
  // PAS de hotspot transverse : son arc coupait le faisceau en deux
  // (moitié proche claire, moitié loin sombre). La profondeur vient de la
  // nappe route + du halo lampe, pas d'un arc.
  const fan = car.fanMesh;
  fan.clear();
  const last = FAN_RAYS - 1;
  drawFanPoly(fan, lx, ly, fanCos, fanSin, hits, 0, last, 1, '#ffe9b8', 0.03 * flick);
  drawFanPoly(fan, lx, ly, fanCos, fanSin, hits, 6, last - 6, 1, '#ffe9b8', 0.035 * flick);
  drawFanPoly(fan, lx, ly, fanCos, fanSin, hits, 14, last - 14, 1, '#fff0cf', 0.05 * flick);
  // Pas de nappe au sol : le faisceau + les poussières portent la lumière.
  // (washMesh conservé vide pour compatibilité du layer.)
  const wash = car.washMesh;
  wash.clear();
  // Ombre de contact : 2 blobs sombres sous la caisse, PIVOTÉS selon la
  // pente locale (l'ombre épouse le terrain — jamais un rectangle).
  // carX est déjà lisse par la physique : aucun grouillement.
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
    if (p.r > maxR - 6 || p.r < 12) {
      // Re-tirage complet à chaque recyclage : angle, distance ET phase.
      // Avant, chaque particule rebouclait sur un rail fixe (même seed) —
      // à basse vitesse / en marche arrière, vent faible oblige, le pompage
      // en boucle devenait bien visible.
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
  drawPaint(car.bodyMesh, car.spec, GRAVE_PAINT);
  if (car.glintMesh) car.glintMesh.visible = false; // pas de reflet sur une épave
  for (const { mesh } of car.wheelMeshes) drawWheel(mesh, car.spec.wheelRadius, { metal: 0 });
  car.container.alpha = 0.55;
  if (car.lightGroup) car.lightGroup.visible = false;
  for (const m of [car.fanMesh, car.washMesh, car.dustMesh, car.shadowSpr1, car.shadowSpr2]) {
    if (m) m.visible = false;
  }
  car.dead = true;
  void world;
}
