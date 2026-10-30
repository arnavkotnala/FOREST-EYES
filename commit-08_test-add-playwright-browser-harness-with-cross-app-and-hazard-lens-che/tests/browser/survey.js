const { chromium } = require('playwright-core');
const out = process.argv[2];
(async () => {
  const b = await chromium.launch({ channel: 'chrome', args: ['--use-gl=angle', '--enable-unsafe-swiftshader'] });
  for (const p of ['/', '/forest-eyes/', '/river-eyes/', '/hazard/']) {
    const pg = await b.newPage({ viewport: { width: 1440, height: 900 } });
    const errs = [];
    pg.on('console', m => m.type() === 'error' && errs.push('console: ' + m.text().slice(0, 200)));
    pg.on('pageerror', e => errs.push('pageerror: ' + e.message.slice(0, 200)));
    pg.on('response', r => r.status() >= 400 && errs.push(`HTTP ${r.status()} ${r.url().slice(0, 150)}`));
    await pg.goto('http://localhost:8080' + p, { waitUntil: 'load', timeout: 60000 }).catch(e => errs.push('goto: ' + e.message));
    await pg.waitForTimeout(6000);
    const btns = await pg.$$eval('button, [role=button], a[href], input[type=checkbox], input[type=radio], select', els => els
      .filter(e => e.offsetParent !== null || getComputedStyle(e).position === 'fixed')
      .map(e => `${e.tagName.toLowerCase()}#${e.id || '-'} .${(e.className?.baseVal ?? e.className ?? '').toString().split(' ')[0]} "${(e.innerText || e.title || e.getAttribute('aria-label') || e.value || '').trim().slice(0, 40).replace(/\n/g, ' ')}"${e.disabled ? ' [disabled]' : ''}`));
    console.log(`\n===== ${p}  (${btns.length} visible controls)`); btns.forEach(x => console.log('  ' + x));
    console.log('  -- errors:'); [...new Set(errs)].forEach(x => console.log('  ! ' + x));
    await pg.screenshot({ path: `${out}/survey${p.replace(/\//g, '_')}.png` });
    await pg.close();
  }
  await b.close();
})();
