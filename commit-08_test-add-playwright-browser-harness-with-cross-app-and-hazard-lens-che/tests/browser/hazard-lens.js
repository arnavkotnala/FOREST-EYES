// Hazard Lens inside the main app's overlay: assess a place, Retry, Download PDF from the iframe, Esc closes.
// Usage: node hazard-lens.js   (saves the PDF into shots/)
const { chromium } = require('playwright-core');
const BASE = process.env.BASE || 'http://localhost:8080';
(async () => {
  const b = await chromium.launch({ channel: 'chrome', args: ['--use-gl=angle', '--enable-unsafe-swiftshader'] });
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const pg = await ctx.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('pageerror: ' + e.message.slice(0, 160)));
  pg.on('console', m => m.type() === 'error' && errs.push('console: ' + m.text().slice(0, 140)));
  const out = (name, r) => console.log(`${String(r).startsWith('FAIL') ? 'FAIL' : 'ok  '}  ${name}: ${r}`);

  await pg.goto(BASE + '/#lens', { waitUntil: 'load' });
  await pg.waitForTimeout(5000);
  const frame = () => pg.frames().find(f => f.url().includes('/hazard/'));
  out('#lens opens the overlay', frame() && await pg.isVisible('#hazard-lens-frame') ? 'overlay visible' : 'FAIL overlay not visible');

  const f = frame();
  await f.click('#presets button >> nth=0');
  await f.waitForSelector('#pdf', { timeout: 170000 }).then(() => out('preset in overlay', 'result drawn'), () => out('preset in overlay', 'FAIL no result'));

  const retry = await f.$('#retry');
  if (retry) {
    await retry.click();
    await f.waitForSelector('.loading', { timeout: 5000 }).then(() => {}, () => {});
    await f.waitForSelector('#pdf', { timeout: 170000 })
      .then(async () => out('↻ Retry with Gemma 4', `re-assessed (reading source now: ${await f.$eval('.source-tag', e => e.textContent.trim())})`),
        () => out('↻ Retry with Gemma 4', 'FAIL no new result'));
  } else out('↻ Retry with Gemma 4', 'not shown (Gemma answered, nothing to retry)');

  const [dl] = await Promise.all([pg.waitForEvent('download', { timeout: 30000 }).catch(() => null), f.click('#pdf')]);
  if (dl) { await dl.saveAs(__dirname + '/shots/' + dl.suggestedFilename()); out('Download PDF inside the overlay', dl.suggestedFilename()); }
  else out('Download PDF inside the overlay', 'FAIL no download');

  await f.press('body', 'Escape');
  await pg.waitForTimeout(2000);
  out('Esc closes the overlay', await pg.isVisible('#hazard-lens-frame') ? 'FAIL still visible' : 'closed');
  [...new Set(errs)].forEach(e => console.log('      ! ' + e));
  await b.close();
})();
