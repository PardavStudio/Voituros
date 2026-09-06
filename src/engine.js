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

export const VMAX = 1050;

export const GEARS = [0.28, 0.5, 0.74, 1.0];

export const RPM_IDLE = 0.18;
export const RPM_RED = 1.0;

export const SHIFT_UP_RPM = 0.97;
export const SHIFT_ECO_RPM = 0.55;
export const SHIFT_DOWN_RPM = 0.3;
export const KICKDOWN_RPM = 0.45;

export const SHIFT_LOCK = 0.45;

export const IDLE_VOL = 0.3;

export const HUM_IDLE_GAIN = 0.3;

export const HUM_COAST_GAIN = 0.05;

export const IDLE_SPEED = 30;

const RPM_ATTACK = 7;
const RPM_RELEASE = 3.2;

const LOAD_ATTACK = 6;
const LOAD_RELEASE = 1.6;

function sstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export function rpmFor(speed, throttle, free, gear = 1) {
  if (free) return { rpm: 0.35 + 0.6 * (throttle ? 1 : 0), gear: 1 };
  const s = Math.min(1, Math.max(0, Math.abs(speed) / VMAX));
  const g = Math.min(4, Math.max(1, gear | 0 || 1));
  const top = GEARS[g - 1] || 1;
  return { rpm: Math.min(1.05, Math.max(RPM_IDLE, s / top)), gear: g };
}

export function createEngineAudio() {

  let ctx = null;

  const buf = { coastLow: null, coastHigh: null, powerLow: null, powerHigh: null, idleHum: null, tipin: null, start: null };

  let voices = null;
  let master = null;
  let filter = null;
  let ready = false;
  let muted = false;
  try {
    muted = localStorage.getItem('voituros.muted') === '1';
  } catch {

  }
  let rpmSm = 0.18;
  let loadSm = 0;
  let lastThrottle = 0;
  let deadSm = 0;
  let everUnlocked = false;
  let loading = false;
  let idleT = 0;
  let pendingStart = false;
  let gear = 1;
  let shiftTimer = 0;
  let reversing = false;
  let shiftDip = 0;
  let flareSm = 0;
  let sndT = 0;
  let lastTipinT = -10;

  async function loadOne(url) {
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      const ab = await res.arrayBuffer();

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

    }
    return { src, g };
  }

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

    }
  }

  function safeResume() {
    try {
      const p = ctx && ctx.resume();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {

    }
  }

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

          if (pendingStart && buf.start) {
            pendingStart = false;
            oneShot(buf.start, 0.5, 1);
          }
        }
      } catch {
        loading = false;
      }
    })();
  }

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

    flareSm += ((throttle ? 0.62 : 0) - flareSm) * (1 - Math.exp(-step * (throttle ? 6 : 0.9)));

    const slip = 1 - sstep(0, 150, speed);

    reversing = !free && !tele.dead && rawSpeed < -5;
    if (reversing && gear !== 1) gear = 1;

    let rpm;

    let rpmGear;
    if (free) {
      rpmGear = 0.35 + 0.6 * throttle;
      rpm = rpmGear;
    } else {
      shiftTimer = Math.max(0, shiftTimer - step);
      rpmGear = rpmFor(rawSpeed, throttle, false, gear).rpm;
      if (!tele.dead && !reversing && shiftTimer <= 0) {

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
    shiftDip *= Math.exp(-step * 7);
    const kRpm = 1 - Math.exp(-step * (rpm > rpmSm ? RPM_ATTACK : RPM_RELEASE));
    rpmSm += (rpm - rpmSm) * kRpm;
    const kLoad = 1 - Math.exp(-step * (throttle > loadSm ? LOAD_ATTACK : LOAD_RELEASE));
    loadSm += (throttle - loadSm) * kLoad;
    const kDead = 1 - Math.exp(-step * 8);
    deadSm += ((tele.dead ? 1 : 0) - deadSm) * kDead;

    const loadEff = loadSm * (1 - 0.65 * shiftDip);

    const idling = !tele.dead && throttle === 0 && speed < IDLE_SPEED && !tele.free;
    idleT += step;
    const wobble = idling
      ? 0.008 * Math.sin(idleT * 9.4) + 0.005 * Math.sin(idleT * 23.7 + 1.3)
      : 0;
    const rpmEff = Math.max(0.12, rpmSm + wobble);

    const growl = 0.5 * sstep(0.28, 0.5, rpmEff) * (1 - sstep(0.62, 0.8, rpmEff));
    const powerW = idling ? 0.4 : Math.max(sstep(0.12, 0.7, loadEff), growl);
    const coastW = 1 - powerW;
    const hiW = idling ? 0 : sstep(0.28, 0.58, rpmEff);
    const loW = 1 - hiW;

    const vol = (IDLE_VOL + 0.1 * rpmEff + 0.22 * loadEff) * (1 - deadSm);

    const humSlow = 0.18 * (1 - sstep(0.25, 0.55, rpmEff)) * coastW;
    const humW = Math.max(idling ? HUM_IDLE_GAIN : 0, HUM_COAST_GAIN * coastW + humSlow);
    const t = ctx.currentTime;

    const setVoice = (v, w, rate) => {
      try {
        v.g.gain.setTargetAtTime(Math.max(0, vol * w), t, 0.045);
        v.src.playbackRate.setTargetAtTime(Math.min(2.2, Math.max(0.5, rate)), t, 0.03);
      } catch {

      }
    };

    const idleRate = 0.86 + wobble * 2;
    setVoice(voices.coastLow, coastW * loW, idling ? idleRate : 0.72 + 0.95 * rpmEff);
    setVoice(voices.coastHigh, coastW * hiW, 0.58 + 1.05 * rpmEff);
    setVoice(voices.powerLow, powerW * loW, idling ? 0.55 : 0.68 + 1.12 * rpmEff);
    setVoice(voices.powerHigh, powerW * hiW, 0.52 + 1.18 * rpmEff);

    if (voices.idleHum) {
      setVoice(voices.idleHum, vol > 0.001 ? (humW * (1 - deadSm)) / vol : 0, 0.5 + wobble);
    }
    try {

      filter.frequency.setTargetAtTime(850 + 3200 * loadEff + 1500 * rpmEff, t, 0.06);
      master.gain.setTargetAtTime(muted ? 0 : 1, t, 0.05);
    } catch {

    }

    if (throttle === 1 && lastThrottle === 0 && buf.tipin && sndT - lastTipinT > 0.35) {
      oneShot(buf.tipin, 0.35, 0.9 + 0.3 * rpmSm);
      lastTipinT = sndT;
    }
    lastThrottle = throttle;
  }

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
    else pendingStart = true;
  }

  function onDeath() {

  }

  function setMuted(m) {
    muted = !!m;
    try {
      localStorage.setItem('voituros.muted', muted ? '1' : '0');
    } catch {

    }
    if (ctx && master) {
      try {
        master.gain.setTargetAtTime(muted ? 0 : 1, ctx.currentTime, 0.03);
      } catch {

      }
    }
  }

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

export function wireEngineUI(engine, btn) {
  const paint = () => {
    let live = false;
    let muted = true;
    try {
      const st = engine.state();
      live = !!st.live;
      muted = !!st.muted;
    } catch {

    }
    try {
      btn.textContent = live && !muted ? '🔊' : !live ? '🔈' : '🔇';
      btn.setAttribute('aria-pressed', muted ? 'true' : 'false');
      btn.setAttribute(
        'aria-label',
        !live ? 'Activer le son moteur (cliquer)' : muted ? 'Rétablir le son moteur' : 'Couper le son moteur',
      );
    } catch {

    }
  };
  const toggle = () => {
    try {
      engine.unlock();
      engine.setMuted(!engine.muted);
    } catch {

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

      }
    };
    window.addEventListener('keydown', unlock, { passive: true });
    window.addEventListener('pointerdown', unlock, { passive: true });
    window.addEventListener('touchstart', unlock, { passive: true });
  } catch {

  }
  paint();
  return { paint, toggle };
}

