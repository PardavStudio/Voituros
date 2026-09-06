import * as PIXI from 'pixi.js';
import RAPIER from '@dimforge/rapier2d-compat';
import { Game } from './game.js';
import { createCamera } from './camera.js';
import { createSky } from './sky.js';
import { createEngineAudio, wireEngineUI } from './engine.js';
import { createSnow, drawSnow } from './neige.js';
import { beamLight } from './voiture.js';
import { routeYAt } from './route.js';

const STEP = 1 / 120;
const $ = (id) => document.getElementById(id);

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

  }
  return { seed: seed ?? String((Math.random() * 100000) | 0), difficulty: difficulty || 'medium', best };
}

function persist(seed, difficulty) {
  try {
    localStorage.setItem('voituros.seed', String(seed));
    localStorage.setItem('voituros.difficulty', difficulty);
  } catch {

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

  const sky = createSky();
  app.stage.addChildAt(sky.container, 0);

  const worldLayer = new PIXI.Container();
  app.stage.addChild(worldLayer);
  const camera = createCamera(app, worldLayer);

  const snowLayer = new PIXI.Container();
  app.stage.addChild(snowLayer);
  const snowGfx = new PIXI.Graphics();
  snowLayer.addChild(snowGfx);
  const snow = createSnow(7);

  const snowEnv = {
    camVX: 0,
    camX: 0,
    camY: 0,
    zoom: 1,
    beam: (wx, wy) => (game.car ? beamLight(game.car, wx, wy) : 0),
    groundY: (wx) => (game.route ? routeYAt(game.route.points, wx) : 1e9),
  };

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

  const engineUI = wireEngineUI(engine, $('btn-mute'));
  applyRoute(settings.seed, settings.difficulty, null);
  showHint(4);

  const splashEl = $('splash');
  let splashHidden = false;
  const hideSplash = () => {
    if (splashHidden || !splashEl) return;
    splashHidden = true;
    splashEl.classList.add('hide');
  };
  setTimeout(hideSplash, 2600);
  window.addEventListener('keydown', hideSplash, { once: true, passive: true });
  window.addEventListener('pointerdown', hideSplash, { once: true, passive: true });

  const held = { left: false, right: false };
  let last = null;
  let joyDir = 0;
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

  let acc = 0;
  let prev = performance.now();
  let muteTick = 0;
  let prevCamX = 0;
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

    game.frame(Math.min(1, Math.max(0, acc / STEP)), dt);
    camera.update(dt, { x: game.carX, y: game.carY }, game.carVel);
    sky.update(dt, camera.camX, camera.camY);

    game.updateIce(dt, camera.camX, (app.screen.width || innerWidth) / (camera.zoom || 1));
    const camVX = dt > 0 ? (camera.camX - prevCamX) / dt : 0;
    prevCamX = camera.camX;
    snowEnv.camVX = camVX;
    snowEnv.camX = camera.camX;
    snowEnv.camY = camera.camY;
    snowEnv.zoom = camera.zoom || 1;
    drawSnow(snowGfx, snow, dt, app.screen.width || innerWidth, app.screen.height || innerHeight, camVX, snowEnv);

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

    if ((muteTick++ & 31) === 0) engineUI.paint();
  });
}

boot();

