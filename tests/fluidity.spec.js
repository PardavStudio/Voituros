import { test, expect } from '@playwright/test';

test('fluidity — défilement régulier plein gaz, sans saccades', async ({ page }) => {
  await page.goto('/?seed=12345');
  await page.waitForFunction(() => !!window.__VOITUROS__, null, { timeout: 20000 });
  await page.waitForTimeout(800);
  await page.keyboard.down('ArrowRight');

  await page.waitForFunction(() => window.__VOITUROS__.distance > 5, null, { timeout: 60000 });
  // Fenêtre adaptative : on échantillonne jusqu'à 400 px parcourus (12 s
  // max). En rendu logiciel le jeu tourne au ralenti mais la régularité
  // (rms/worst) se mesure à tout fps.
  const frames = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const out = [];
        const t0 = performance.now();
        const x0 = window.__VOITUROS__.carX();
        const tick = () => {
          out.push({ t: performance.now() - t0, x: window.__VOITUROS__.carX() });
          if (performance.now() - t0 < 12000 && window.__VOITUROS__.carX() - x0 < 400) requestAnimationFrame(tick);
          else resolve(out);
        };
        requestAnimationFrame(tick);
      }),
  );
  await page.keyboard.up('ArrowRight');

  const fps = frames.length / Math.max(0.5, (frames[frames.length - 1].t - frames[0].t) / 1000);

  const reg = frames;
  const W = 300;
  let sum2 = 0;
  let worst = 0;
  let n = 0;
  for (let i = 0; i < reg.length; i++) {
    let m = 0;
    let c = 0;
    for (let j = 0; j < reg.length; j++) {
      if (Math.abs(reg[j].t - reg[i].t) <= W / 2) {
        m += reg[j].x;
        c++;
      }
    }
    m /= c;
    const e = Math.abs(reg[i].x - m);
    worst = Math.max(worst, e);
    sum2 += e * e;
    n++;
  }
  const rms = Math.sqrt(sum2 / n);
  const dist = reg[reg.length - 1].x - reg[0].x;
  console.log(JSON.stringify({ fps: fps.toFixed(0), dist: dist.toFixed(0), rms: rms.toFixed(2), worst: worst.toFixed(2), n }));

  expect(dist).toBeGreaterThan(200);

  expect(rms).toBeLessThan(7);
  expect(worst).toBeLessThan(30);
});

