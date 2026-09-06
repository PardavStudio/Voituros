import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/?seed=12345');
  await page.waitForFunction(() => !!window.__VOITUROS__, null, { timeout: 20000 });
});

async function carX(page) {
  return page.evaluate(() => window.__VOITUROS__.carX());
}

test('boot — canvas, distance 0.0 m, zéro erreur console', async ({ page }) => {
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.reload();
  await expect(page.getByTestId('game-canvas')).toBeVisible();
  await expect(page.getByTestId('hud-distance')).toHaveText('0.0 m');
  await expect(page.getByTestId('hud-best')).toBeVisible();
  await expect(page.getByTestId('hud-deaths')).toHaveText('0');
  await expect(page.getByTestId('hud-seed')).toContainText('#');
  expect(errors).toEqual([]);
  await page.screenshot({ path: 'screenshots/boot.png' });
});

test('drive-forward — 3s de gaz ⇒ distance > 5 m, caméra a suivi', async ({ page }) => {
  const x0 = await carX(page);
  await page.keyboard.down('ArrowRight');
  await page.waitForFunction(() => window.__VOITUROS__.distance > 5, null, { timeout: 10000 });
  await page.waitForTimeout(2000);
  await page.keyboard.up('ArrowRight');
  const x1 = await carX(page);
  expect(x1).toBeGreaterThan(x0 + 10);
  await page.screenshot({ path: 'screenshots/drive.png' });
});

test('drive-backward — marche arrière, pas de marche avant fantôme', async ({ page }) => {
  await page.getByTestId('btn-restart').click();
  await page.waitForTimeout(500);
  const x0 = await carX(page);
  await page.keyboard.down('ArrowLeft');
  await page.waitForTimeout(2000);
  await page.keyboard.up('ArrowLeft');
  const x1 = await carX(page);
  expect(x1).toBeLessThan(x0 + 50); // < spawn + 5 m
});

test('difficulty-switch — Hard régénère la route', async ({ page }) => {
  await page.getByTestId('btn-easy').click();
  await expect.poll(() => page.evaluate(() => window.__VOITUROS__.difficulty)).toBe('easy');
  await page.screenshot({ path: 'screenshots/easy.png' });
  await page.getByTestId('btn-hard').click();
  await expect.poll(() => page.evaluate(() => window.__VOITUROS__.difficulty)).toBe('hard');
  await page.screenshot({ path: 'screenshots/hard.png' });
});

test('flip-death-tombstone — flip debug ⇒ warning, mort, tombe', async ({ page }) => {
  await page.evaluate(() => window.__VOITUROS__.debugFlip());
  await expect(page.getByTestId('flip-warning')).toBeVisible({ timeout: 5000 });
  await page.waitForFunction(() => window.__VOITUROS__.deaths === 1, null, { timeout: 15000 });
  await expect(page.getByTestId('toast')).toContainText('m');
  expect(await page.evaluate(() => window.__VOITUROS__.graves.length)).toBe(1);
  await page.screenshot({ path: 'screenshots/tombstone.png' });
});

test('respawn-new-car — nouvelle voiture au départ après la mort', async ({ page }) => {
  const spec1 = await page.evaluate(() => window.__VOITUROS__.carSpec);
  expect(spec1).not.toBeNull();
  await page.evaluate(() => window.__VOITUROS__.debugFlip());
  await page.waitForFunction(() => window.__VOITUROS__.deaths === 1, null, { timeout: 15000 });
  await page.waitForFunction((s1) => JSON.stringify(window.__VOITUROS__.carSpec) !== JSON.stringify(s1), spec1, {
    timeout: 10000,
  });
  const spec2 = await page.evaluate(() => window.__VOITUROS__.carSpec);
  expect(JSON.stringify(spec2)).not.toBe(JSON.stringify(spec1));
  expect(await page.evaluate(() => window.__VOITUROS__.distance)).toBeLessThan(2);
  expect(Math.abs(await carX(page))).toBeLessThan(150);
  const info = await page.evaluate(() => window.__VOITUROS__.screenInfo());
  expect(Math.abs(info.carScreenX - info.centerX)).toBeLessThan(0.4 * info.viewportW);
});

test('camera-follow — la voiture reste dans le viewport à vitesse max', async ({ page }) => {
  await page.keyboard.down('ArrowRight');
  await page.waitForTimeout(5000);
  await page.keyboard.up('ArrowRight');
  const info = await page.evaluate(() => window.__VOITUROS__.screenInfo());
  expect(Math.abs(info.carScreenX - info.centerX)).toBeLessThan(0.4 * info.viewportW);
  await page.screenshot({ path: 'screenshots/camera.png' });
});
