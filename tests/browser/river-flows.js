// River Eyes controls that only appear inside tabs, results and Aqua: clicks each in a real user order
// and reports whether the page changed and which errors came up. Usage: node river-flows.js
const { chromium } = require('playwright-core');
const BASE = process.env.BASE || 'http://localhost:8080';
(async () => {
  const b = await chromium.launch({ channel: 'chrome', args: ['--use-gl=angle', '--enable-unsafe-swiftshader'] });
  const pg = await b.newPage({ viewport: { width: 1440, height: 900 } });
  let errs = [];
  pg.on('console', m => m.type() === 'error' && errs.push('console: ' + m.text().slice(0, 140)));
  pg.on('pageerror', e => errs.push('pageerror: ' + e.message.slice(0, 160)));
  pg.on('response', r => r.status() >= 400 && errs.push(`HTTP ${r.status()} ${r.url().replace(BASE, '').slice(0, 80)}`));
  await pg.goto(BASE + '/river-eyes/', { waitUntil: 'load' });
  await pg.waitForTimeout(6000);

  const visibleText = sel => pg.$eval(sel, e => e.offsetParent ? e.innerText.replace(/\s+/g, ' ').trim().slice(0, 160) : '(hidden)').catch(() => '(missing)');
  async function step(name, sel, { wait = 2500, until, show } = {}) {
    errs = [];
    const before = await pg.evaluate(() => document.body.innerHTML.length + '|' + [...document.querySelectorAll('.panel, [id$=-panel], #aqua-chat, .aqua-chat')].map(e => e.offsetParent ? 1 : 0).join(''));
    let res = 'ok';
    try { await pg.click(sel, { timeout: 8000 }); } catch (e) { res = 'CLICK FAILED ' + e.message.split('\n')[0].slice(0, 90); }
    if (until) await pg.waitForFunction(until, null, { timeout: 150000 }).catch(() => { res = 'TIMED OUT waiting for result'; });
    await pg.waitForTimeout(wait);
    const after = await pg.evaluate(() => document.body.innerHTML.length + '|' + [...document.querySelectorAll('.panel, [id$=-panel], #aqua-chat, .aqua-chat')].map(e => e.offsetParent ? 1 : 0).join(''));
    if (res === 'ok' && before === after) res = 'NO PAGE CHANGE';
    console.log(`${res.padEnd(14)} ${name}${show ? '  -> ' + await visibleText(show) : ''}`);
    [...new Set(errs)].forEach(e => console.log('               ! ' + e));
  }

  await step('Brand: switchRiver(ganga)', '.brand-section');
  await step('Tab: Water Quality', '#nav-water', { show: '#water-panel' });
  await step('Water: Analyse water quality here', '#water-run', {
    until: () => { const b = document.getElementById('water-run'); return b && !b.disabled && !/…|\.\.\./.test(b.innerText); }, wait: 2000, show: '#water-panel' });
  await step('Water panel: ✕', `[onclick="closePanel('water-panel')"]`);
  await step('Tab: Site Conditions', '#nav-geotech', { wait: 8000, show: '#geotech-panel' });
  await step('Site panel: ✕', `[onclick="closePanel('geotech-panel')"]`);
  await step('Header: Plan Dam Siting (MW)', '[onclick="openDamPlannerTab()"]', { show: '#dam-planner-panel' });
  await step('Dam planner: Scan the selected river', `[onclick="runRiverAtlas('selected')"]`, {
    until: () => document.querySelector('.atlas-row') || /no feasible|failed|error|could not/i.test(document.body.innerText), wait: 2000 });
  await step('Atlas: first site row', '.atlas-row');
  await step('Dam planner panel: ✕', `[onclick="closePanel('dam-planner-panel')"]`);
  await pg.fill('#plan-city', 'Dehradun');
  await step('City plan: Find Dam Sites for this City', '[onclick="runCityPlan()"]', {
    until: () => document.querySelector('.dam-site-card') || /no feasible|failed|error|could not|not found/i.test(document.getElementById('dam-plan-results')?.innerText || ''), wait: 2000 });
  await step('City site card: Inspect on satellite', '.dam-site-card [onclick^="showSatellite()"]');
  await step('City site card: Gemma 4 site review', '.dam-site-card [onclick^="reviewSiteWithGemma"]', { wait: 15000, show: '.dam-site-card .gemma-review' });
  await step('Header: Aqua (Gemma 4)', '.btn-aqua[onclick="toggleAqua(true)"]');
  await pg.fill('#aqua-input, .aqua-input input, textarea', 'What is the 2-year flood level of this river?').catch(() => console.log('               (no Aqua input found to type into)'));
  await step('Aqua: Send', '[onclick="submitAquaMessage()"]', { wait: 8000 });
  console.log('               Aqua last message:', await pg.$$eval('.aqua-msg, .msg, [class*=message]', es => (es.at(-1)?.innerText || '(none)').replace(/\s+/g, ' ').slice(0, 160)));
  await step('Aqua: ✕', '[onclick="toggleAqua(false)"]');
  await pg.screenshot({ path: __dirname + '/shots/river-flows.png' });
  await b.close();
})();
