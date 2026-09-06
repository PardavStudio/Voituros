import { test, expect } from '@playwright/test';

// Joystick tactile (mobile) : caché sur desktop, révélé au premier toucher,
// glisser à droite = avancer, à gauche = reculer, relâcher = stop.
test('mobile-joystick — visible au toucher, pilote la voiture', async ({ browser }) => {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  try {
    await page.goto('/?seed=12345');
    await page.waitForFunction(() => !!window.__VOITUROS__, null, { timeout: 20000 });
    await page.waitForTimeout(800);

    const joy = page.getByTestId('joystick');
    await expect(joy).toBeHidden(); // pas de tactile utilisé ⇒ caché

    const cdp = await ctx.newCDPSession(page);
    const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });

    // Premier toucher (n'importe où en bas-droite) ⇒ le joystick apparaît.
    await touch('touchStart', [{ x: 330, y: 760, id: 1 }]);
    await touch('touchEnd', []);
    await expect(joy).toBeVisible();
    const box = await joy.boundingBox();
    expect(box).not.toBeNull();
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    // Glisser à droite ⇒ avance (comme ArrowRight).
    const x0 = await page.evaluate(() => window.__VOITUROS__.carX());
    const knob = () => page.$eval('#joy-knob', (el) => el.style.transform);
    await touch('touchStart', [{ x: cx, y: cy, id: 2 }]);
    await touch('touchMove', [{ x: cx + 35, y: cy, id: 2 }]);
    expect(await knob()).toContain('35');
    await page.waitForFunction(() => window.__VOITUROS__.distance > 2, null, { timeout: 15000 });
    await page.screenshot({ path: 'screenshots/mobile-joystick.png' });
    const x1 = await page.evaluate(() => window.__VOITUROS__.carX());
    expect(x1).toBeGreaterThan(x0 + 10);
    await touch('touchEnd', []);
    expect(await knob()).toBe('');

    // Glisser à gauche ⇒ recule, pas de marche avant fantôme.
    // (On repart de l'arrêt comme le test clavier : à haute vitesse la
    // quantité de mouvement domine sur 1,5 s.)
    await page.getByTestId('btn-restart').click();
    await page.waitForTimeout(500);
    await touch('touchStart', [{ x: cx, y: cy, id: 3 }]);
    await touch('touchMove', [{ x: cx - 35, y: cy, id: 3 }]);
    expect(await knob()).toContain('-35');
    await page.waitForTimeout(1500);
    await touch('touchEnd', []);
    expect(await knob()).toBe('');
    const x2 = await page.evaluate(() => window.__VOITUROS__.carX());
    expect(x2).toBeLessThan(30);
  } finally {
    await ctx.close();
  }
});
