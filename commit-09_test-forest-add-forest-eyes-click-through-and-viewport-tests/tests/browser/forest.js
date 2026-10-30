// Click through every Forest Eyes control; log errors per step + screenshots
const { chromium } = require('playwright-core');
const DIR = __dirname + '/shots';
require('fs').mkdirSync(DIR, { recursive: true });
const BASE = 'http://localhost:8080';

(async () => {
  const b = await chromium.launch({ channel: 'chrome', args: ['--use-gl=angle', '--enable-unsafe-swiftshader'] });
  const pg = await b.newPage({ viewport: { width: 1440, height: 900 } });
  let errs = [];
  pg.on('console', m => m.type() === 'error' && errs.push('console: ' + m.text().slice(0, 220)));
  pg.on('pageerror', e => errs.push('pageerror: ' + e.message.slice(0, 220)));
  pg.on('response', r => r.status() >= 400 && errs.push(`HTTP ${r.status()} ${r.url().replace(BASE, '').slice(0, 140)}`));
  pg.on('requestfailed', r => !/tile|arcgis|openstreetmap|\.png|\.jpg/.test(r.url()) && errs.push(`FAILED ${r.failure()?.errorText} ${r.url().replace(BASE, '').slice(0, 140)}`));
  let n = 0;
  async function step(name, fn) {
    errs = [];
    const t = Date.now();
    let result;
    try { result = await fn(); } catch (e) { result = 'EXCEPTION ' + e.message.split('\n')[0].slice(0, 200); }
    await pg.waitForTimeout(800);
    await pg.screenshot({ path: `${DIR}/f${String(++n).padStart(2, '0')}.png` });
    console.log(`\n[f${String(n).padStart(2, '0')}] ${name}  (${((Date.now() - t) / 1000).toFixed(1)} s)\n   -> ${result}`);
    [...new Set(errs)].forEach(e => console.log('   ! ' + e));
  }
  const text = (sel, len = 220) => pg.$eval(sel, e => e.innerText.replace(/\s+/g, ' ').trim()).then(s => s.slice(0, len)).catch(() => '(missing ' + sel + ')');
  const val = sel => pg.$eval(sel, e => e.value);

  await pg.goto(BASE + '/forest-eyes/', { waitUntil: 'load' });
  await pg.waitForTimeout(4000);

  await step('Search by name "Dehradun" + 🔍', async () => {
    await pg.fill('#location-search', 'Dehradun');
    await pg.click('#search-btn');
    await pg.waitForFunction(() => document.getElementById('lat-input').value !== '', null, { timeout: 30000 });
    return `lat=${await val('#lat-input')} lon=${await val('#lng-input')}`;
  });
  await step('Search by name via Enter key ("Shimla")', async () => {
    await pg.fill('#location-search', 'Shimla');
    await pg.press('#location-search', 'Enter');
    await pg.waitForFunction(() => Math.abs(Number(document.getElementById('lat-input').value) - 31.1) < 0.3, null, { timeout: 30000 });
    return `lat=${await val('#lat-input')} lon=${await val('#lng-input')}`;
  });
  await step('Coordinates 30.3165, 78.0322 + 🔍', async () => {
    await pg.fill('#lat-input', '30.3165'); await pg.fill('#lng-input', '78.0322');
    await pg.click('#coords-search-btn');
    return `lat=${await val('#lat-input')} lon=${await val('#lng-input')}, prefixes ${await text('#lat-prefix')}/${await text('#lng-prefix')}`;
  });
  await step('Radius slider -> 25 km', async () => {
    await pg.$eval('#radius-input', e => { e.value = 25; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); });
    return 'display: ' + await text('#radius-display');
  });
  await step('Analyze Deforestation', async () => {
    await pg.click('#analyze-btn');
    await pg.waitForFunction(() => !/Enter a location and click/.test(document.getElementById('results-panel').innerText) &&
      !/Analyz(ing|e) …|Fetching|Loading/i.test(document.getElementById('results-panel').innerText.slice(0, 300)), null, { timeout: 150000 });
    await pg.waitForTimeout(3000);
    return await text('#results-panel', 400);
  });

  for (const id of ['toggle-satellite', 'toggle-tree-cover', 'toggle-tree-loss', 'toggle-glad']) {
    await step(`Layer toggle #${id} (off/on)`, async () => {
      const before = await pg.$eval('#' + id, e => e.checked);
      await pg.click(`label:has(#${id})`); await pg.waitForTimeout(1500);
      const mid = await pg.$eval('#' + id, e => e.checked);
      await pg.click(`label:has(#${id})`); await pg.waitForTimeout(1500);
      const after = await pg.$eval('#' + id, e => e.checked);
      return `checked ${before} -> ${mid} -> ${after}${mid === before ? '  ✗ DID NOT TOGGLE' : ''}`;
    });
  }
  for (const opt of await pg.$$eval('#tree-loss-mode option', o => o.map(x => x.value))) {
    await step(`Tree Loss Form = ${opt}`, async () => {
      await pg.selectOption('#tree-loss-mode', opt); await pg.waitForTimeout(5000);
      return 'selected ' + await val('#tree-loss-mode');
    });
  }
  await pg.selectOption('#tree-loss-mode', 'dots').catch(() => {});

  await step('🌱 Which Trees Can Grow Here? (open planner)', async () => {
    await pg.click('#plant-btn');
    await pg.waitForSelector('.tp-switch', { timeout: 180000 });
    const nTrees = await pg.$$eval('.tp-switch', s => s.length);
    return `${nTrees} trees listed; place: ${await text('#tp-place', 80)}; site: ${await text('.tp-site', 260)}`;
  });
  await step('Planner: switch on first tree -> report', async () => {
    await pg.click('.tp-tree:first-child .tp-tree-head');
    await pg.waitForFunction(() => { const r = document.getElementById('tp-report'); return r && r.innerText.length > 80 && !/loading|writing/i.test(r.innerText.slice(0, 60)); }, null, { timeout: 120000 });
    return await text('#tp-report', 300);
  });
  await step('Planner: switch on a different tree (one at a time)', async () => {
    await pg.click('.tp-tree:nth-child(2) .tp-tree-head');
    await pg.waitForTimeout(1500);
    const on = await pg.$$eval('.tp-switch:checked', s => s.map(x => x.dataset.id));
    await pg.waitForFunction(() => { const r = document.getElementById('tp-report'); return r && r.innerText.length > 80 && !/loading|writing/i.test(r.innerText.slice(0, 60)); }, null, { timeout: 120000 }).catch(() => {});
    return `switched on: ${on.join(', ')}; report: ${await text('#tp-report', 160)}`;
  });
  await step('Planner: switch the tree off', async () => {
    await pg.click('.tp-switch:checked + .toggle-slider').catch(() => pg.click('.tp-tree.selected .tp-tree-head'));
    await pg.waitForTimeout(1000);
    return `switched on now: ${(await pg.$$eval('.tp-switch:checked', s => s.map(x => x.dataset.id))).join(', ') || 'none'}`;
  });
  await step('Planner: rainfall -> 500 mm', async () => {
    const before = await pg.$$eval('.tp-switch', s => s.length);
    await pg.fill('#tp-rain', '500'); await pg.press('#tp-rain', 'Enter'); await pg.$eval('#tp-rain', e => e.dispatchEvent(new Event('change', { bubbles: true })));
    await pg.waitForTimeout(1500);
    return `trees ${before} -> ${await pg.$$eval('.tp-switch', s => s.length)}; reset link: ${await text('.tp-rain-reset', 60)}`;
  });
  await step('Planner: "use the data" reset link', async () => {
    await pg.click('.tp-rain-reset');
    await pg.waitForTimeout(1000);
    return `rain=${await val('#tp-rain')}, trees ${await pg.$$eval('.tp-switch', s => s.length)}, reset link present: ${!!(await pg.$('.tp-rain-reset'))}`;
  });
  await step('Planner: close ✕', async () => {
    await pg.click('.tp-close'); await pg.waitForTimeout(800);
    return `planner visible: ${await pg.isVisible('.tp-close')}; plant-btn aria-expanded=${await pg.getAttribute('#plant-btn', 'aria-expanded')}`;
  });
  await step('Planner: reopen + Escape closes', async () => {
    await pg.click('#plant-btn'); await pg.waitForSelector('.tp-switch', { timeout: 60000 });
    await pg.keyboard.press('Escape'); await pg.waitForTimeout(800);
    return `planner visible after Escape: ${await pg.isVisible('.tp-close')}`;
  });

  await step('TREEKO pill (open chat)', async () => {
    await pg.click('#treeko-btn'); await pg.waitForSelector('.treeko-input', { state: 'visible', timeout: 15000 });
    return `chat open; chips: ${(await pg.$$eval('.treeko-chip', c => c.map(x => x.innerText))).join(' | ')}`;
  });
  await step('Treeko: quick-question chip', async () => {
    const before = await pg.$$eval('[class*=treeko-msg], [class*=treeko-bubble]', m => m.length).catch(() => 0);
    await pg.click('.treeko-chip');
    await pg.waitForTimeout(50000);
    return `messages ${before} -> ${await pg.$$eval('[class*=treeko-msg], [class*=treeko-bubble]', m => m.length).catch(() => '?')}; last: ${await pg.$$eval('[class*=treeko-msg], [class*=treeko-bubble]', m => (m.at(-1)?.innerText || '').replace(/\s+/g, ' ').slice(0, 260)).catch(() => '?')}`;
  });
  await step('Treeko: type a question + Send', async () => {
    await pg.fill('.treeko-input', 'Is the forest near here shrinking?');
    await pg.click('.treeko-send');
    await pg.waitForTimeout(50000);
    return `last: ${await pg.$$eval('[class*=treeko-msg], [class*=treeko-bubble]', m => (m.at(-1)?.innerText || '').replace(/\s+/g, ' ').slice(0, 260)).catch(() => '?')}`;
  });
  for (const act of ['map', 'copy']) {
    await step(`Treeko: answer action [data-act=${act}]`, async () => {
      const btn = await pg.$(`[data-act=${act}]`);
      if (!btn) return 'no such button shown';
      await btn.click(); await pg.waitForTimeout(1500);
      return 'clicked: ' + (await btn.innerText().catch(() => ''));
    });
  }
  await step('Treeko: close ✕', async () => {
    await pg.click('.treeko-chat-close'); await pg.waitForTimeout(800);
    return `chat input visible: ${await pg.isVisible('.treeko-input')}`;
  });

  await step('Leaflet + / − zoom', async () => {
    const z0 = await pg.evaluate(() => typeof map?.getZoom === 'function' ? map.getZoom() : '?');
    await pg.click('.leaflet-control-zoom-in'); await pg.waitForTimeout(1200);
    const z1 = await pg.evaluate(() => typeof map?.getZoom === 'function' ? map.getZoom() : '?');
    await pg.click('.leaflet-control-zoom-out'); await pg.waitForTimeout(1200);
    return `zoom ${z0} -> ${z1} -> ${await pg.evaluate(() => typeof map?.getZoom === 'function' ? map.getZoom() : '?')}`;
  });
  await step('Zoom far out -> 3D globe opens', async () => {
    for (let i = 0; i < 14; i++) { await pg.click('.leaflet-control-zoom-out').catch(() => {}); await pg.waitForTimeout(500); }
    await pg.mouse.move(720, 450);
    for (let i = 0; i < 6; i++) { await pg.mouse.wheel(0, 600); await pg.waitForTimeout(500); }
    await pg.waitForSelector('#globe-zoom-in', { state: 'visible', timeout: 30000 });
    return 'globe visible: ' + await pg.isVisible('#globe-container');
  });
  for (const id of ['globe-zoom-in', 'globe-zoom-out', 'globe-spin', 'globe-spin', 'globe-reset']) {
    await step(`Globe control #${id}`, async () => {
      await pg.click('#' + id); await pg.waitForTimeout(2000);
      return `aria-pressed=${await pg.getAttribute('#' + id, 'aria-pressed')}`;
    });
  }
  await step('Globe: zoom in a lot -> back to flat map', async () => {
    for (let i = 0; i < 12; i++) { await pg.click('#globe-zoom-in').catch(() => {}); await pg.waitForTimeout(500); }
    await pg.waitForTimeout(4000);
    return `globe visible: ${await pg.isVisible('#globe-container')}, leaflet visible: ${await pg.isVisible('#map')}`;
  });
  await b.close();
})();
