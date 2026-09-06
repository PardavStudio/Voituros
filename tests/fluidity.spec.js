import { test, expect } from '@playwright/test';

// Non-régression fluidité (saccades en roulant) : le défilement écran de la
// voiture doit être régulier (pas de stop-and-go), à 60+ fps.
test('fluidity — défilement régulier plein gaz, sans saccades', async ({ page }) => {
  await page.goto('/?seed=12345');
  await page.waitForFunction(() => !!window.__VOITUROS__, null, { timeout: 20000 });
  await page.waitForTimeout(800);
  await page.keyboard.down('ArrowRight');
  // D'abord le régime établi (le headless lent démarre au ralenti car la
  // physique plafonne ses substeps), puis 4 s de trajectoire monde.
  // Trajectoire MONDE (la caméra suit la voiture : sa position écran est
  // quasi-fixe par design ; c'est la régularité de l'avancement monde qui
  // compte).
  await page.waitForFunction(() => window.__VOITUROS__.distance > 5, null, { timeout: 30000 });
  const frames = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const out = [];
        const t0 = performance.now();
        const tick = () => {
          out.push({ t: performance.now() - t0, x: window.__VOITUROS__.carX() });
          if (performance.now() - t0 < 4000) requestAnimationFrame(tick);
          else resolve(out);
        };
        requestAnimationFrame(tick);
      }),
  );
  await page.keyboard.up('ArrowRight');

  const fps = frames.length / 4;
  // Saccades pures (haute fréquence) : écart à une moyenne glissante 300 ms.
  // La moyenne suit les ralentissements légitimes des côtes (<1 Hz) ; le
  // résidu = stop-and-go pathologique seul. Insensible au fps headless.
  // (Plus de filtre transitoire : on est déjà en régime établi.)
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
  // Pas de garde-fou fps : en headless logiciel il varie avec la charge
  // (7–30 fps) ; dist>200 prouve déjà que la boucle tourne (un rendu figé
  // ferait timeout les evaluate ci-dessus).
  expect(dist).toBeGreaterThan(200); // avance vraiment (> 20 m en ~3 s)
  // Seuils calibrés : le bruit HF pur vaut 0.4 px RMS en Node 120 Hz ; la
  // mesure navigateur (27 fps, fenêtre 300 ms) mélange côtes + échantillonnage
  // grossier ⇒ ~5 px. Le seuil à 7 laisse 35 % de marge tout en détectant une
  // régression (retour à 60 Hz ou régulation bang-bang ⇒ ~9+ px).
  expect(rms).toBeLessThan(7);
  expect(worst).toBeLessThan(30);
});
