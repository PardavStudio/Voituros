/**
 * Boot Voituros : Pixi + Rapier, boucle 60 Hz, HUD DOM, inputs, hooks debug.
 * @module main
 */
import * as PIXI from 'pixi.js';
import RAPIER from '@dimforge/rapier2d-compat';
import { Game } from './game.js';
import { createCamera } from './camera.js';
import { createSky } from './sky.js';
import { createEngineAudio, wireEngineUI } from './engine.js';

const STEP = 1 / 120;
const $ = (id) => document.getElementById(id);

/** Lit les réglages (URL prioritaire, puis localStorage, puis défauts). */
function loadSettings() {
  const q = new URLSearchParams(location.search);
  let seed = q.get('seed');
  let difficulty = q.get('difficulty');
  let best = 0;
  try {
    seed = seed ?? localStorage.getItem('voituros.seed');
    difficulty = difficulty ?? localStorage.getItem('voituros.difficulty');
    best = parseFloat(localStorage.getItem('voituros.best') || '0') || 0;
  } catch {
    /* stockage indisponible */
  }
  return { seed: seed ?? String((Math.random() * 100000) | 0), difficulty: difficulty || 'medium', best };
}

function persist(seed, difficulty) {
  try {
    localStorage.setItem('voituros.seed', String(seed));
    localStorage.setItem('voituros.difficulty', difficulty);
  } catch {
    /* ignore */
  }
}

async function boot() {
  const settings = loadSettings();
  await RAPIER.init();

  const app = new PIXI.Application();
  try {
    await app.init({
      background: '#0b0e14',
      resizeTo: window,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      antialias: true,
    });
  } catch {
    $('nogl').classList.remove('hidden');
    return;
  }
  $('app').appendChild(app.canvas);
  app.canvas.setAttribute('data-testid', 'game-canvas');

  // Voie lactée en fond (hors monde : dérive lente + parallaxe caméra).
  const sky = createSky();
  app.stage.addChildAt(sky.container, 0);

  const worldLayer = new PIXI.Container();
  app.stage.addChild(worldLayer);
  const camera = createCamera(app, worldLayer);

  // HUD.
  const elDist = $('hud-distance');
  const elBest = $('hud-best');
  const elDeaths = $('hud-deaths');
  const elSeed = $('hud-seed');
  const elWarn = $('flip-warning');
  const elWarnText = $('flip-warning-text');
  const elWarnBar = $('flip-bar');
  const elToast = $('toast');
  const elHint = $('hint');
  const btns = { easy: $('btn-easy'), medium: $('btn-medium'), hard: $('btn-hard') };
  let lastDist = '';
  let lastBest = '';
  let lastDeaths = '';
  let warnVisible = false;
  const toast = (msg) => {
    elToast.textContent = msg;
    elToast.classList.add('show');
  };
  const setFlip = (visible, remaining, frac) => {
    if (visible === warnVisible && !visible) return;
    warnVisible = visible;
    elWarn.classList.toggle('hidden', !visible);
    if (visible) {
      elWarnText.textContent = `⚠ Retourné ! ${remaining.toFixed(1)}s`;
      elWarnBar.style.width = `${Math.round(frac * 100)}%`;
    }
  };
  let hintTimer = 0;
  const showHint = (secs = 4) => {
    elHint.classList.remove('hidden');
    hintTimer = secs;
  };

  // Son moteur Greenwood (Greenwood devant la maison de CJ, banques GENRL
  // 88/89) : inactif jusqu'au premier geste (autoplay policy), muet si
  // l'audio est indisponible — jamais d'erreur console.
  const engine = createEngineAudio();

  const game = new Game({
    world: new RAPIER.World({ x: 0, y: 980 }),
    worldLayer,
    camera,
    best: settings.best,
    audio: engine,
    ui: { toast, flip: setFlip, hint: () => showHint() },
  });
  game.world.timestep = STEP;
  // Échelle moteur : Rapier plafonne les vélocités à 400·lengthUnit px/s en
  // dur (non exposé). À lengthUnit = 1 la voiture ne pouvait jamais dépasser
  // 400 px/s quel que soit le couple ; à 10 le plafond passe à 4000
  // (vitesses atteintes ~600-700, contacts inchangés en mesure).
  game.world.integrationParameters.lengthUnit = 10;
  const applyRoute = (seed, difficulty, label) => {
    const r = game.newRoute(seed, difficulty);
    persist(r.seed, r.difficulty);
    elSeed.textContent = `#${r.seed}`;
    for (const [k, b] of Object.entries(btns)) {
      b.classList.toggle('active', k === r.difficulty);
      b.setAttribute('aria-pressed', k === r.difficulty ? 'true' : 'false');
    }
    if (label) toast(label);
  };

  btns.easy.onclick = () => applyRoute(game.seed, 'easy', `Nouvelle route Easy #${game.seed}`);
  btns.medium.onclick = () => applyRoute(game.seed, 'medium', `Nouvelle route Medium #${game.seed}`);
  btns.hard.onclick = () => applyRoute(game.seed, 'hard', `Nouvelle route Hard #${game.seed}`);
  $('btn-new-route').onclick = () => {
    applyRoute((Math.random() * 100000) | 0, game.difficulty, null);
    toast(`Nouvelle route ${game.difficulty[0].toUpperCase() + game.difficulty.slice(1)} #${game.seed}`);
  };
  $('btn-restart').onclick = () => game.reset();
  // Son moteur Greenwood : bouton 🔈/🔊/🔇 + déblocage au premier geste.
  const engineUI = wireEngineUI(engine, $('btn-mute'));
  applyRoute(settings.seed, settings.difficulty, null);
  showHint(4);

  // Inputs (priorité au dernier en appui simultané, 0 au relâchement).
  const held = { left: false, right: false };
  let last = null;
  let joyDir = 0; // joystick tactile (−1|0|1), clavier prioritaire
  const input = { dir: 0, brake: false };
  const recompute = () => {
    const kb = held.left && held.right ? (last === 'right' ? 1 : -1) : held.right ? 1 : held.left ? -1 : 0;
    input.dir = kb !== 0 ? kb : joyDir;
  };
  window.addEventListener('keydown', (e) => {
    if (e.code === 'ArrowRight' || e.code === 'KeyD') {
      held.right = true;
      last = 'right';
      recompute();
      e.preventDefault();
    } else if (e.code === 'ArrowLeft' || e.code === 'KeyA') {
      held.left = true;
      last = 'left';
      recompute();
      e.preventDefault();
    } else if (e.code === 'KeyR') {
      game.reset();
    } else if (e.code === 'KeyM') {
      engineUI.toggle();
    } else if (e.code === 'Space') {
      input.brake = true;
      e.preventDefault();
    }
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'ArrowRight' || e.code === 'KeyD') {
      held.right = false;
      if (last === 'right') last = held.left ? 'left' : null;
      recompute();
    } else if (e.code === 'ArrowLeft' || e.code === 'KeyA') {
      held.left = false;
      if (last === 'left') last = held.right ? 'right' : null;
      recompute();
    } else if (e.code === 'Space') {
      input.brake = false;
    }
  });

  // Joystick tactile (mobile) : révélé au premier toucher, glisser horizontal.
  // Zone morte 10 px, course ±38 px, un seul doigt suivi (multi-touch safe).
  const joyEl = $('joystick');
  const joyKnob = $('joy-knob');
  const JOY_DEAD = 10;
  const JOY_RANGE = 38;
  let joyTouchId = null;
  let joyCenterX = 0;
  const joySet = (dx) => {
    const cx = Math.max(-JOY_RANGE, Math.min(JOY_RANGE, dx));
    joyKnob.style.transform = `translateX(${cx}px)`;
    joyDir = cx > JOY_DEAD ? 1 : cx < -JOY_DEAD ? -1 : 0;
    recompute();
  };
  const joyReset = () => {
    joyTouchId = null;
    joyKnob.style.transform = '';
    joyDir = 0;
    recompute();
  };
  window.addEventListener(
    'touchstart',
    () => {
      document.body.classList.add('touch');
    },
    { once: true, passive: true },
  );
  joyEl.addEventListener(
    'touchstart',
    (e) => {
      e.preventDefault();
      if (joyTouchId !== null) return;
      const t = e.changedTouches[0];
      joyTouchId = t.identifier;
      joyCenterX = joyEl.getBoundingClientRect().left + joyEl.getBoundingClientRect().width / 2;
      joySet(t.clientX - joyCenterX);
    },
    { passive: false },
  );
  joyEl.addEventListener(
    'touchmove',
    (e) => {
      e.preventDefault();
      for (const t of e.changedTouches) {
        if (t.identifier === joyTouchId) {
          joySet(t.clientX - joyCenterX);
          break;
        }
      }
    },
    { passive: false },
  );
  for (const ev of ['touchend', 'touchcancel']) {
    joyEl.addEventListener(
      ev,
      (e) => {
        // Plus aucun doigt sur le joystick ⇒ stop (couvre aussi les fins
        // synthétiques sans changedTouches détaillés).
        if (e.touches.length === 0) {
          joyReset();
          return;
        }
        for (const t of e.changedTouches) {
          if (t.identifier === joyTouchId) {
            joyReset();
            break;
          }
        }
      },
      { passive: true },
    );
  }

  // Hooks debug / tests (documentés, préfixés debug si action).
  const V = {
    carX() {
      return game.carX;
    },
    screenInfo() {
      const w = app.screen.width || innerWidth;
      const h = app.screen.height || innerHeight;
      return {
        carScreenX: (game.carX - camera.camX) * camera.zoom + w / 2,
        carScreenY: (game.carY - camera.camY) * camera.zoom + h * 0.55,
        viewportW: w,
        viewportH: h,
        centerX: w / 2,
        centerY: h * 0.55,
        zoom: camera.zoom,
      };
    },
    debugFlip() {
      game.debugFlip();
    },
    debugState() {
      return game.debugState();
    },
    teleport(x) {
      game.teleport(x);
    },
    reset() {
      game.reset();
    },
    audioState() {
      return engine.state();
    },
    toggleMute() {
      return engineUI.toggle();
    },
  };
  V.carX.valueOf = () => game.carX;
  V.carX.toString = () => String(game.carX);
  Object.defineProperties(V, {
    difficulty: { get: () => game.difficulty, enumerable: true },
    graves: { get: () => game.graves, enumerable: true },
    deaths: { get: () => game.deaths, enumerable: true },
    distance: { get: () => game.distance, enumerable: true },
    carSpec: { get: () => game.carSpec, enumerable: true },
  });
  window.__VOITUROS__ = V;

  // Boucle : accumulateur 120 Hz (max 4 substeps = couvre 30 fps),
  // sync interpolée, caméra, HUD.
  let acc = 0;
  let prev = performance.now();
  let muteTick = 0;
  app.ticker.add(() => {
    const now = performance.now();
    const dt = Math.min((now - prev) / 1000, 0.1);
    prev = now;
    game.setInput(input.dir, input.brake);
    acc += dt;
    let n = 0;
    while (acc >= STEP && n < 4) {
      game.fixedStep(STEP);
      acc -= STEP;
      n++;
    }
    if (n === 4) acc = 0;
    // Interpolation de rendu : alpha = reste/STEP (0 step sur écran 120 Hz+,
    // step sauté/doublé à 60 Hz) ⇒ défilement continu, sans paliers.
    game.frame(Math.min(1, Math.max(0, acc / STEP)), dt);
    camera.update(dt, { x: game.carX, y: game.carY }, game.carVel);
    sky.update(dt, camera.camX, camera.camY);
    // Moteur Greenwood : RPM via rapports (dents de scie), charge = gaz,
    // roues libres quand retourné (ça mouline), coupé si mort.
    engine.update(dt, {
      speed: game.carLongSpeed,
      throttle: input.dir !== 0 ? 1 : 0,
      dead: game.state === 'dead',
      free: game.state === 'flipped',
    });

    const d = `${game.distance.toFixed(1)} m`;
    if (d !== lastDist) {
      elDist.textContent = d;
      lastDist = d;
    }
    const b = `${game.best.toFixed(1)} m`;
    if (b !== lastBest) {
      elBest.textContent = b;
      lastBest = b;
    }
    const dd = String(game.deaths);
    if (dd !== lastDeaths) {
      elDeaths.textContent = dd;
      lastDeaths = dd;
    }
    if (hintTimer > 0) {
      hintTimer -= dt;
      if (hintTimer <= 0) elHint.classList.add('hidden');
    }
    // État du bouton son (débloqué/muet) : 2×/s suffisent, pas d'alloc chaude.
    if ((muteTick++ & 31) === 0) engineUI.paint();
  });
}

boot();
