/**
 * Moteur audio Greenwood (GTA SA, berline devant la maison de CJ) :
 * synthèse granulaire type vrais jeux (RPM/charge/rapports, crossfade,
 * pitch, filtre), à partir des boucles d'origine extraites de GENRL.
 * @module engine
 *
 * Sources (banques GENRL) :
 * - `greenwood-coast-low.wav` : décélération bas régime (~90 Hz, 0.81 s, loop, bank 88)
 * - `greenwood-coast-high.wav` : décélération haut régime (~145 Hz, 0.75 s, loop, bank 88)
 * - `greenwood-power-low.wav` : accélération boucle longue (~150 Hz, 3.22 s, loop, bank 89)
 * - `greenwood-power-high.wav` : accélération haut régime (partie bouclée, 1.26 s, bank 89)
 * - `greenwood-idle-hum.wav` : ronron médium stable (~500 Hz, 1.46 s, loop,
 *   bank 53 « Hums (??Engines??) ») — la couche qui fait exister le ralenti
 *   et la décélération sur les petits haut-parleurs (83 % de son énergie en
 *   200-2000 Hz, contre 68 % sous 200 Hz pour le coast-low)
 * - `greenwood-tipin.wav` : transient d'attaque gaz (0.70 s, one-shot)
 * - `greenwood-start.wav` : démarreur (1.54 s, one-shot)
 *
 * Implémentation calquée sur le moteur audio de GTA SA (sources : header
 * `CAEVehicleAudioEntity` du plugin-sdk DK22Pac — pair accel/decel, gas &
 * brake states, inhibit timers, 12 slots ; `cTransmission` — rapports
 * {MaxVelocity, ChangeUpVelocity, ChangeDownVelocity} ; table
 * `gVehicleAudioSettings[232]` — Greenwood = accel 95 / decel 94 ;
 * répertoire SAAT de pdescobar) :
 * 1. Vraie boîte auto à état, 4 rapports comme la Greenwood d'origine
 *    (handling.cfg GREENWOO : 4 rapports, 160 km/h) : montée au rupteur
 *    (0.97), descente à bas régime (0.30, hystérésis anti-pompage),
 *    kickdown pied dedans, verrou 0.45 s, micro-coupure d'allumage au
 *    passage + régime recalculé dans le nouveau rapport (chute 0.97 → 0.55).
 *    Flare de régime au patinage convertisseur (coups de gaz à l'arrêt :
 *    montée franche, retombée lente ~1 s, verrouillé en roulage).
 * 2. Double set charge (power) / décélération (coast) crossfadé par la charge.
 * 3. Dans chaque set, 2 couches bas/haut régime crossfadées par le RPM.
 * 4. Pitch (playbackRate) proportionnel au RPM par couche.
 * 5. Passe-bas global piloté par charge + RPM, volume avec plancher de
 *    ralenti (moteur allumé à l'arrêt = audible, jamais muet sauf mort/muet).
 * 6. One-shots : démarrage au spawn, transient à l'attaque des gaz.
 * 7. Ralenti = coast-low (grave ~90 Hz) + pointe de power-low (harmoniques
 *    300-600 Hz audibles sur petits haut-parleurs qui coupent sous 200 Hz).
 */

const BASE = import.meta.env.BASE_URL || '/';
const FILES = {
  coastLow: `${BASE}engine/greenwood-coast-low.wav`,
  coastHigh: `${BASE}engine/greenwood-coast-high.wav`,
  powerLow: `${BASE}engine/greenwood-power-low.wav`,
  powerHigh: `${BASE}engine/greenwood-power-high.wav`,
  idleHum: `${BASE}engine/greenwood-idle-hum.wav`,
  tipin: `${BASE}engine/greenwood-tipin.wav`,
  start: `${BASE}engine/greenwood-start.wav`,
};

/** Vitesse max prise en compte pour l'étagement (== CHASSIS_MAX_VX). */
export const VMAX = 1050;
/** Vitesses au rupteur par rapport (fractions de VMAX) : 4 vitesses comme la
 * Greenwood d'origine (handling.cfg GREENWOO : 4 rapports, 160 km/h).
 * Le régime suit la vitesse divisée par le rapport courant (vrais rapports
 * qui se recouvrent) : passage 1→2 = chute 0.97 → ~0.55, pas au ralenti. */
export const GEARS = [0.28, 0.5, 0.74, 1.0];
/** Régime de ralenti / rupteur (normalisé). */
export const RPM_IDLE = 0.18;
export const RPM_RED = 1.0;
/** Seuils de passage : montée au rupteur pied dedans, économique pied levé
 * (vraie cartographie BVA : points de passage pilotés par la charge),
 * descente à bas régime (hystérésis anti-pompage), kickdown à 0.45. */
export const SHIFT_UP_RPM = 0.97;
export const SHIFT_ECO_RPM = 0.55;
export const SHIFT_DOWN_RPM = 0.3;
export const KICKDOWN_RPM = 0.45;
/** Verrou anti-patinage de boîte après un passage (s). */
export const SHIFT_LOCK = 0.45;
/** Plancher de volume au ralenti (moteur allumé, voiture à l'arrêt). */
export const IDLE_VOL = 0.3;
/** Gain du ronron idle (couche médium, toujours sous les loops moteur). */
export const HUM_IDLE_GAIN = 0.3;
/** Résidu de ronron en roulage (liant sonore, jamais de trou). */
export const HUM_COAST_GAIN = 0.05;
/** Seuil de vitesse sous lequel on considère la voiture à l'arrêt. */
export const IDLE_SPEED = 30;
/** Lissage régime : attaque rapide, relâchement plus lent (inertie). */
const RPM_ATTACK = 7;
const RPM_RELEASE = 3.2;
/** Lissage charge : attaque franche, relâchement LENT (façon SA : le son
 * suit le régime en ~1 s au lâcher, jamais coupé net — cf. inhibit timers). */
const LOAD_ATTACK = 6;
const LOAD_RELEASE = 1.6;

/**
 * smoothstep scalaire.
 * @param {number} a Seuil bas.
 * @param {number} b Seuil haut.
 * @param {number} x Entrée.
 * @returns {number} [0, 1].
 */
function sstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/**
 * RPM normalisé dans un rapport donné : régime = vitesse / rapport (droite
 * par l'origine, plancher au ralenti — comme un convertisseur de couple).
 * À vitesse route égale, le rapport supérieur donne un régime plus bas :
 * c'est ce recouvrement qui rend les passages audibles et justes.
 * @param {number} speed Vitesse longitudinale (px/s, signée : < 0 = recul).
 * @param {number} throttle Gaz [0, 1] (inutilisé en prise : le régime suit
 * la vitesse ; gardé pour compatibilité d'API).
 * @param {boolean} free Roues libres (retourné / en l'air : ça mouline).
 * @param {number} [gear] Rapport imposé (1-4, défaut 1).
 * @returns {{ rpm: number, gear: number }}
 */
export function rpmFor(speed, throttle, free, gear = 1) {
  if (free) return { rpm: 0.35 + 0.6 * (throttle ? 1 : 0), gear: 1 };
  const s = Math.min(1, Math.max(0, Math.abs(speed) / VMAX));
  const g = Math.min(4, Math.max(1, gear | 0 || 1));
  const top = GEARS[g - 1] || 1;
  return { rpm: Math.min(1.05, Math.max(RPM_IDLE, s / top)), gear: g };
}

/**
 * Crée le moteur audio (inactif tant que `unlock()` n'a pas réussi :
 * autoplay-policy safe, tests headless safe, zéro erreur console).
 * @returns {{ unlock: () => void, update: (dt: number, tele: object) => void, onSpawn: () => void, onDeath: () => void, setMuted: (m: boolean) => void, muted: boolean, state: () => object }}
 */
export function createEngineAudio() {
  /** @type {AudioContext|null} */
  let ctx = null;
  /** @type {AudioBuffer|null} Buffers décodés. */
  const buf = { coastLow: null, coastHigh: null, powerLow: null, powerHigh: null, idleHum: null, tipin: null, start: null };
  /** Voix bouclées : source -> gain couche -> filtre master -> gain master. */
  let voices = null;
  let master = null;
  let filter = null;
  let ready = false;
  let muted = false;
  try {
    muted = localStorage.getItem('voituros.muted') === '1';
  } catch {
    /* stockage indisponible */
  }
  let rpmSm = 0.18;
  let loadSm = 0;
  let lastThrottle = 0;
  let deadSm = 0; // 0 vivant, 1 mort (fondu moteur coupé)
  let everUnlocked = false;
  let loading = false; // chargement/décodage en cours (anti-doublon)
  let idleT = 0; // horloge du ralenti (instabilité régime)
  let pendingStart = false; // spawn arrivé avant la fin du chargement
  let gear = 1; // rapport engagé (boîte auto à état, pas dérivé de la vitesse)
  let shiftTimer = 0; // verrou anti-patinage après un passage (s restant)
  let reversing = false; // marche arrière (1er imposé, pas de passages)
  let shiftDip = 0; // micro-coupure d'allumage au passage (1 → 0)
  let flareSm = 0; // flare de régime aux coups de gaz (volant moteur)
  let sndT = 0; // horloge audio (cooldowns)
  let lastTipinT = -10; // dernier transient (anti-mitraillette)

  /**
   * Charge + décode un wav (échec silencieux : le moteur reste muet, jamais d'erreur).
   * @param {string} url URL asset.
   * @returns {Promise<AudioBuffer|null>}
   */
  async function loadOne(url) {
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      const ab = await res.arrayBuffer();
      // decodeAudioData callback-forme pour vieux navigateurs, promesse sinon.
      return await new Promise((resolve) => {
        try {
          const p = ctx.decodeAudioData(
            ab,
            (b) => resolve(b),
            () => resolve(null),
          );
          if (p && typeof p.then === 'function') p.then(resolve, () => resolve(null));
        } catch {
          resolve(null);
        }
      });
    } catch {
      return null;
    }
  }

  /** Démarre une voix bouclée (pitch 1, gain 0). */
  function startLoop(buffer, detuneCents = 0) {
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.playbackRate.value = 1;
    if (detuneCents) src.detune.value = detuneCents;
    const g = ctx.createGain();
    g.gain.value = 0;
    src.connect(g);
    g.connect(filter);
    try {
      src.start();
    } catch {
      /* déjà démarrée */
    }
    return { src, g };
  }

  /** Joue un one-shot (démarrage, transient) sans casser les boucles. */
  function oneShot(buffer, vol = 0.5, rate = 1) {
    if (!ctx || !buffer || muted) return;
    try {
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.loop = false;
      src.playbackRate.value = rate;
      const g = ctx.createGain();
      g.gain.value = vol;
      src.connect(g);
      g.connect(filter);
      src.start();
    } catch {
      /* audio indisponible */
    }
  }

  /** Resume sans throw ni rejection non trappée (zéro erreur console). */
  function safeResume() {
    try {
      const p = ctx && ctx.resume();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {
      /* ignore */
    }
  }

  /**
   * Débloque l'audio (à appeler sur geste utilisateur : clavier/touch/clic).
   * Idempotent, sans throw, sans log. Si un premier déblocage a échoué
   * (contexte suspendu, fetch/décodage raté), les appels suivants relancent
   * le chargement — le moteur finit toujours par démarrer après un geste.
   * @returns {void}
   */
  function unlock() {
    if (ctx) safeResume();
    if (ready) return;
    if (!everUnlocked) {
      everUnlocked = true;
      let AC = null;
      try {
        AC = window.AudioContext || window.webkitAudioContext;
      } catch {
        return;
      }
      if (!AC) return;
      try {
        ctx = new AC({ latencyHint: 'interactive' });
      } catch {
        try {
          ctx = new AC();
        } catch {
          return;
        }
      }
      if (!ctx) return;
      safeResume();
      try {
        master = ctx.createGain();
        master.gain.value = muted ? 0 : 1;
        filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 1100;
        filter.Q.value = 0.7;
        filter.connect(master);
        master.connect(ctx.destination);
      } catch {
        return;
      }
    }
    if (loading || !ctx || !master || !filter) return;
    loading = true;
    // Chargement asynchrone des 7 samples ; les voix démarrent dès que les
    // 4 boucles moteur sont prêtes (le hum et les one-shots peuvent suivre :
    // jamais de silence total pour un sample bonus manquant).
    // `loading` retombe à false en cas d'échec pour permettre un retry
    // au prochain geste (unlock).
    (async () => {
      try {
        const [cl, ch, pl, ph, hu, ti, st] = await Promise.all([
          loadOne(FILES.coastLow),
          loadOne(FILES.coastHigh),
          loadOne(FILES.powerLow),
          loadOne(FILES.powerHigh),
          loadOne(FILES.idleHum),
          loadOne(FILES.tipin),
          loadOne(FILES.start),
        ]);
        buf.coastLow = cl;
        buf.coastHigh = ch;
        buf.powerLow = pl;
        buf.powerHigh = ph;
        buf.idleHum = hu;
        buf.tipin = ti;
        buf.start = st;
        loading = false;
        if (!ctx || ctx.state === 'closed') return;
        safeResume();
        if (cl && ch && pl && ph) {
          voices = {
            coastLow: startLoop(cl),
            coastHigh: startLoop(ch, 4),
            powerLow: startLoop(pl, -3),
            powerHigh: startLoop(ph, 3),
            idleHum: hu ? startLoop(hu, 2) : null,
          };
          ready = true;
          // Le premier spawn arrive presque toujours avant la fin du
          // chargement (fetch + decode async) : le démarreur part ici,
          // sinon le tout premier ralenti serait muet.
          if (pendingStart && buf.start) {
            pendingStart = false;
            oneShot(buf.start, 0.5, 1);
          }
        }
      } catch {
        loading = false; // retry au prochain geste
      }
    })();
  }

  /**
   * Mise à jour par frame : lissage RPM/charge façon ECU, crossfades,
   * pitch par couche, filtre + volume (setTargetAtTime = pas de clics).
   * Le ralenti est un état à part entière : plancher de volume, filtre
   * ouvert et instabilité de régime (le moteur « tourne » à l'arrêt).
   * @param {number} dt Delta temps (s).
   * @param {{ speed: number, throttle: number, dead: boolean, free: boolean }} tele Télémétrie.
   * @returns {void}
   */
  function update(dt, tele) {
    if (!ctx || !ready || !voices) return;
    if (muted) return;
    const step = Math.min(0.1, Math.max(0, dt || 0));
    if (!Number.isFinite(step) || step <= 0) return;
    const rawSpeed = Number.isFinite(tele.speed) ? tele.speed : 0;
    const speed = Math.abs(rawSpeed);
    const throttle = tele.throttle ? 1 : 0;
    const free = !!tele.free;
    sndT += step;
    // Flare de régime (volant moteur) : montée franche aux coups de gaz,
    // retombée lente ~1 s. Sans ça, les blips pédale ne feraient que
    // cracher le transient + s'éteindre (le régime suivrait la vitesse = 0).
    flareSm += ((throttle ? 0.62 : 0) - flareSm) * (1 - Math.exp(-step * (throttle ? 6 : 0.9)));
    // Patinage convertisseur : à l'arrêt le régime est libre (flare),
    // en roulage il est verrouillé sur le rapport (comme une vraie BVA).
    const slip = 1 - sstep(0, 150, speed);
    // Marche arrière : 1er imposé, aucun passage (comme une vraie BVA).
    reversing = !free && !tele.dead && rawSpeed < -5;
    if (reversing && gear !== 1) gear = 1;
    // Boîte auto à état : montée au rupteur, descente à bas régime,
    // kickdown pied dedans, verrou anti-patinage. Les passages se décident
    // sur le régime BOÎTE (pas flaré : sinon un coup de gaz à l'arrêt
    // ferait monter les rapports tout seul).
    /** @type {number} */
    let rpm;
    /** @type {number} */
    let rpmGear;
    if (free) {
      rpmGear = 0.35 + 0.6 * throttle;
      rpm = rpmGear;
    } else {
      shiftTimer = Math.max(0, shiftTimer - step);
      rpmGear = rpmFor(rawSpeed, throttle, false, gear).rpm;
      if (!tele.dead && !reversing && shiftTimer <= 0) {
        // Point de montée piloté par la charge : 0.55 pied levé (conduite
        // économique, on ne reste pas en 2e à 0.86 en croisière), 0.97
        // pied dedans (rupteur).
        const upAt = SHIFT_ECO_RPM + (SHIFT_UP_RPM - SHIFT_ECO_RPM) * loadSm;
        if (rpmGear >= upAt && gear < 4) {
          gear += 1;
          shiftDip = 1;
          shiftTimer = SHIFT_LOCK;
          rpmGear = rpmFor(rawSpeed, throttle, false, gear).rpm;
        } else if (rpmGear <= SHIFT_DOWN_RPM && gear > 1) {
          gear -= 1;
          shiftDip = 0.7;
          shiftTimer = SHIFT_LOCK;
          rpmGear = rpmFor(rawSpeed, throttle, false, gear).rpm;
        } else if (throttle === 1 && gear > 1 && rpmGear < KICKDOWN_RPM) {
          gear -= 1;
          shiftDip = 0.8;
          shiftTimer = SHIFT_LOCK;
          rpmGear = rpmFor(rawSpeed, throttle, false, gear).rpm;
        }
      }
      rpm = Math.max(rpmGear, RPM_IDLE + flareSm * slip);
    }
    shiftDip *= Math.exp(-step * 7); // la coupure se referme en ~0.3 s
    const kRpm = 1 - Math.exp(-step * (rpm > rpmSm ? RPM_ATTACK : RPM_RELEASE));
    rpmSm += (rpm - rpmSm) * kRpm;
    const kLoad = 1 - Math.exp(-step * (throttle > loadSm ? LOAD_ATTACK : LOAD_RELEASE));
    loadSm += (throttle - loadSm) * kLoad;
    const kDead = 1 - Math.exp(-step * 8);
    deadSm += ((tele.dead ? 1 : 0) - deadSm) * kDead;
    // Charge effective : creux au passage de rapport.
    const loadEff = loadSm * (1 - 0.65 * shiftDip);

    // Ralenti : voiture à l'arrêt, moteur allumé, pas de gaz. On ajoute une
    // instabilité de régime (±1 % à ~1.5 Hz + harmonique) comme un vrai
    // ralenti — sans ça le loop statique sonne « sample figé ».
    const idling = !tele.dead && throttle === 0 && speed < IDLE_SPEED && !tele.free;
    idleT += step;
    const wobble = idling
      ? 0.008 * Math.sin(idleT * 9.4) + 0.005 * Math.sin(idleT * 23.7 + 1.3)
      : 0;
    const rpmEff = Math.max(0.12, rpmSm + wobble);

    // Crossfades (courbes en S, somme ≈ constante par set).
    // - Au ralenti : base coast grave + pointe de power-low + ronron médium
    //   (le trio qui passe les petits haut-parleurs).
    // - Pied levé en roulage : grogne de frein moteur (fond de power-low
    //   piloté par le régime, max à mi-régime où le coast-low est trop sourd
    //   pour les petits HP, effacé à haut régime où coast-high porte déjà) +
    //   couche brillante coast-high précoce — un moteur essence reste audible
    //   en décélération, jamais muet.
    const growl = 0.5 * sstep(0.28, 0.5, rpmEff) * (1 - sstep(0.62, 0.8, rpmEff));
    const powerW = idling ? 0.4 : Math.max(sstep(0.12, 0.7, loadEff), growl);
    const coastW = 1 - powerW;
    const hiW = idling ? 0 : sstep(0.28, 0.58, rpmEff);
    const loW = 1 - hiW;
    // Volume façon SA : le régime porte le volume AUTANT que la charge
    // (le decel reste à ~5 dB de la charge, jamais coupé) ; plancher idle.
    const vol = (IDLE_VOL + 0.1 * rpmEff + 0.22 * loadEff) * (1 - deadSm);
    // Ronron : franc au ralenti, filet en décélération, présence prolongée
    // en roulage lent (pas de trou à mi-régime : le coast à 0.35-0.5 de RPM
    // serait sinon plus sourd que le ralenti).
    const humSlow = 0.18 * (1 - sstep(0.25, 0.55, rpmEff)) * coastW;
    const humW = Math.max(idling ? HUM_IDLE_GAIN : 0, HUM_COAST_GAIN * coastW + humSlow);
    const t = ctx.currentTime;

    /** @param {{src: AudioBufferSourceNode, g: GainNode}} v @param {number} w @param {number} rate */
    const setVoice = (v, w, rate) => {
      try {
        v.g.gain.setTargetAtTime(Math.max(0, vol * w), t, 0.045);
        v.src.playbackRate.setTargetAtTime(Math.min(2.2, Math.max(0.5, rate)), t, 0.03);
      } catch {
        /* ignore */
      }
    };
    // Chaque couche couvre sa bande avec un pitch centré différemment
    // (chœur + plage utile large, comme les Sampler Instruments auto).
    // Au ralenti : pitch figé bas (~80 Hz) + léger tremblement, pas de
    // suivi de rpm — le ralenti ne doit pas « chanter » avec le wobble.
    const idleRate = 0.86 + wobble * 2;
    setVoice(voices.coastLow, coastW * loW, idling ? idleRate : 0.72 + 0.95 * rpmEff);
    setVoice(voices.coastHigh, coastW * hiW, 0.58 + 1.05 * rpmEff);
    setVoice(voices.powerLow, powerW * loW, idling ? 0.55 : 0.68 + 1.12 * rpmEff);
    setVoice(voices.powerHigh, powerW * hiW, 0.52 + 1.18 * rpmEff);
    // Ronron médium : la présence du moteur à bas régime (ralenti franc,
    // filet en décélération). Gain absolu calibré (hors `vol`, déjà plancher),
    // voix optionnelle (sample bonus).
    if (voices.idleHum) {
      setVoice(voices.idleHum, vol > 0.001 ? (humW * (1 - deadSm)) / vol : 0, 0.5 + wobble);
    }
    try {
      // Filtre ouvert au ralenti (~1100 Hz) : le ralenti étouffé sous un
      // passe-bas trop fermé était la raison du « pas de son à l'arrêt ».
      filter.frequency.setTargetAtTime(850 + 3200 * loadEff + 1500 * rpmEff, t, 0.06);
      master.gain.setTargetAtTime(muted ? 0 : 1, t, 0.05);
    } catch {
      /* ignore */
    }
    // Transient d'attaque des gaz (vrai réflexe sound-design auto),
    // avec cooldown : sans ça les petits coups répétés mitraillent.
    if (throttle === 1 && lastThrottle === 0 && buf.tipin && sndT - lastTipinT > 0.35) {
      oneShot(buf.tipin, 0.35, 0.9 + 0.3 * rpmSm);
      lastTipinT = sndT;
    }
    lastThrottle = throttle;
  }

  /** À appeler au spawn : démarreur Greenwood (si audio prêt, sinon no-op). */
  function onSpawn() {
    rpmSm = 0.18;
    loadSm = 0;
    deadSm = 0;
    idleT = 0;
    gear = 1;
    shiftTimer = 0;
    shiftDip = 0;
    reversing = false;
    flareSm = 0;
    lastTipinT = -10;
    if (buf.start && ready) oneShot(buf.start, 0.5, 1);
    else pendingStart = true; // joué dès la fin du chargement (cf. unlock)
  }

  /** À appeler à la mort : le fondu `deadSm` coupe le moteur en ~0.3 s. */
  function onDeath() {
    // Rien d'immédiat : update() fane via deadSm (pas de coupure clic).
  }

  /**
   * Coupe/rétablit le son (persisté).
   * @param {boolean} m Muet ?
   */
  function setMuted(m) {
    muted = !!m;
    try {
      localStorage.setItem('voituros.muted', muted ? '1' : '0');
    } catch {
      /* ignore */
    }
    if (ctx && master) {
      try {
        master.gain.setTargetAtTime(muted ? 0 : 1, ctx.currentTime, 0.03);
      } catch {
        /* ignore */
      }
    }
  }

  /** Télémétrie debug (tests + diagnostic HUD). */
  function state() {
    const slots = [voices?.coastLow, voices?.coastHigh, voices?.powerLow, voices?.powerHigh, voices?.idleHum];
    const gains = voices
      ? slots.map((v) => {
          try {
            return v ? +v.g.gain.value.toFixed(3) : 0;
          } catch {
            return 0;
          }
        })
      : [0, 0, 0, 0, 0];
    const ctxState = ctx ? ctx.state : 'none';
    return {
      ready,
      muted,
      rpm: +rpmSm.toFixed(3),
      load: +loadSm.toFixed(3),
      gear,
      reverse: reversing,
      shift: +shiftDip.toFixed(2),
      gains,
      ctxState,
      live: ready && !!voices && ctxState === 'running',
      idle: loadSm < 0.12 && rpmSm < 0.42,
    };
  }

  return { unlock, update, onSpawn, onDeath, setMuted, get muted() { return muted; }, state };
}

/**
 * Câble le bouton son HUD + le déblocage au premier geste (autoplay policy :
 * clavier/tactile/souris). Le bouton affiche 🔈 tant que l'audio n'est pas
 * débloqué (le ralenti est nécessairement muet avant le premier geste),
 * puis 🔊/🔇. Sans throw, sans log.
 * @param {{ unlock: ()=>void, setMuted: (m:boolean)=>void, muted: boolean, state: ()=>object }} engine Moteur audio.
 * @param {HTMLElement} btn Bouton HUD.
 * @returns {{ paint: ()=>void, toggle: ()=>boolean }} paint() + toggle() (retourne muet ?).
 */
export function wireEngineUI(engine, btn) {
  const paint = () => {
    let live = false;
    let muted = true;
    try {
      const st = engine.state();
      live = !!st.live;
      muted = !!st.muted;
    } catch {
      /* audio indisponible */
    }
    try {
      btn.textContent = live && !muted ? '🔊' : !live ? '🔈' : '🔇';
      btn.setAttribute('aria-pressed', muted ? 'true' : 'false');
      btn.setAttribute(
        'aria-label',
        !live ? 'Activer le son moteur (cliquer)' : muted ? 'Rétablir le son moteur' : 'Couper le son moteur',
      );
    } catch {
      /* ignore */
    }
  };
  const toggle = () => {
    try {
      engine.unlock();
      engine.setMuted(!engine.muted);
    } catch {
      /* ignore */
    }
    paint();
    try {
      return engine.muted;
    } catch {
      return true;
    }
  };
  try {
    btn.onclick = toggle;
    const unlock = () => {
      try {
        engine.unlock();
      } catch {
        /* ignore */
      }
    };
    window.addEventListener('keydown', unlock, { passive: true });
    window.addEventListener('pointerdown', unlock, { passive: true });
    window.addEventListener('touchstart', unlock, { passive: true });
  } catch {
    /* ignore */
  }
  paint();
  return { paint, toggle };
}
