const { chromium } = require('playwright-core');
(async () => {
  const b = await chromium.launch({ channel: 'chrome', args: ['--use-gl=angle', '--enable-unsafe-swiftshader'] });
  const pg = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = []; pg.on('response', r => r.status() >= 400 && errs.push(`HTTP ${r.status()} ${r.url().slice(21, 120)}`));
  pg.on('pageerror', e => errs.push('pageerror ' + e.message));
  await pg.goto('http://localhost:8080/river-eyes/', { waitUntil: 'load' }); await pg.waitForTimeout(4000);
  await pg.click('#nav-water'); await pg.waitForTimeout(800);
  const before = await pg.$eval('#water-panel', e => e.innerText.length);
  const t = Date.now();
  const resp = pg.waitForResponse(r => r.url().includes('/api/v1/water-quality'), { timeout: 180000 });
  await pg.click('#water-run');
  const r = await resp; await pg.waitForTimeout(2500);
  console.log(`water-quality API HTTP ${r.status()} after ${((Date.now() - t) / 1000).toFixed(0)} s; panel text ${before} -> ${await pg.$eval('#water-panel', e => e.innerText.length)} chars`);
  console.log((await pg.$eval('#water-panel', e => e.innerText.replace(/\s+/g, ' '))).slice(300, 800));
  console.log(errs.join('\n') || 'no errors');
  await pg.screenshot({ path: __dirname + '/shots/water.png' });
  await b.close();
})();
