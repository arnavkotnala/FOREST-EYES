// Click through River Eyes, Hazard Lens and the Forest/River shell; log errors per step + screenshots
const { chromium } = require('playwright-core');
const DIR = __dirname + '/shots';
require('fs').mkdirSync(DIR, { recursive: true });
const BASE = 'http://localhost:8080';

(async () => {
  const b = await chromium.launch({ channel: 'chrome', args: ['--use-gl=angle', '--enable-unsafe-swiftshader'] });
  let pg, errs = [], n = 0, tag = '';
  async function open(path, t) {
    if (pg) await pg.close();
    tag = t;
    pg = await b.newPage({ viewport: { width: 1440, height: 900 } });
    pg.on('console', m => m.type() === 'error' && errs.push('console: ' + m.text().slice(0, 220)));
    pg.on('pageerror', e => errs.push('pageerror: ' + e.message.slice(0, 220)));
    pg.on('response', r => r.status() >= 400 && errs.push(`HTTP ${r.status()} ${r.url().replace(BASE, '').slice(0, 140)}`));
    pg.on('dialog', d => { errs.push('dialog: ' + d.message().slice(0, 160)); d.dismiss(); });
    await pg.goto(BASE + path, { waitUntil: 'load' });
    await pg.waitForTimeout(4000);
  }
  async function step(name, fn) {
    errs = [];
    const t = Date.now();
    let result;
    try { result = await fn(); } catch (e) { result = 'EXCEPTION ' + e.message.split('\n')[0].slice(0, 200); }
    await pg.waitForTimeout(800);
    const id = `${tag}${String(++n).padStart(2, '0')}`;
    await pg.screenshot({ path: `${DIR}/${id}.png` });
    console.log(`\n[${id}] ${name}  (${((Date.now() - t) / 1000).toFixed(1)} s)\n   -> ${result}`);
    [...new Set(errs)].forEach(e => console.log('   ! ' + e));
  }
  const text = (sel, len = 220) => pg.$eval(sel, e => e.innerText.replace(/\s+/g, ' ').trim()).then(s => s.slice(0, len)).catch(() => '(missing ' + sel + ')');
  const visiblePanels = () => pg.$$eval('[id$=-panel], .drawer, [id*=aqua]', els => els.filter(e => e.offsetParent !== null && e.innerText.trim()).map(e => e.id || e.className.split(' ')[0]));
  const waitQuiet = async (ms = 60000) => { await pg.waitForLoadState('networkidle', { timeout: ms }).catch(() => {}); };

  // ---------- Shell: Forest / River tabs, Hazard Lens ----------
  await open('/', 's');
  await step('Shell: River tab', async () => { await pg.click('#btn-river'); await pg.waitForTimeout(4000); return `river selected=${await pg.getAttribute('#btn-river', 'aria-selected')}, river frame visible=${await pg.isVisible('#frame-river')}`; });
  await step('Shell: Forest tab', async () => { await pg.click('#btn-forest'); await pg.waitForTimeout(4000); return `forest selected=${await pg.getAttribute('#btn-forest', 'aria-selected')}, forest frame visible=${await pg.isVisible('#frame-forest')}`; });
  await step('Shell: "T" keyboard shortcut', async () => { await pg.mouse.click(720, 30); await pg.keyboard.press('t'); await pg.waitForTimeout(4000); return `river selected=${await pg.getAttribute('#btn-river', 'aria-selected')}`; });
  await step('Shell: Hazard Lens on', async () => { await pg.click('label:has(#lens-toggle)'); await pg.waitForTimeout(5000); return `checked=${await pg.$eval('#lens-toggle', e => e.checked)}, lens frame visible=${await pg.isVisible('#hazard-lens-frame')}`; });
  await step('Shell: Hazard Lens off', async () => { await pg.click('label:has(#lens-toggle)'); await pg.waitForTimeout(2000); return `checked=${await pg.$eval('#lens-toggle', e => e.checked)}, lens frame visible=${await pg.isVisible('#hazard-lens-frame')}`; });

  // ---------- Hazard Lens ----------
  await open('/hazard/', 'h');
  const presets = await pg.$$eval('#presets button', bs => bs.map(x => x.innerText));
  for (const [i, p] of presets.entries()) {
    await step(`Hazard preset "${p}"`, async () => {
      await pg.click(`#presets button >> nth=${i}`);
      await waitQuiet(90000); await pg.waitForTimeout(2000);
      return (await pg.evaluate(() => document.querySelector('main, #result, .result, [aria-live]')?.innerText || document.body.innerText)).replace(/\s+/g, ' ').slice(0, 260);
    });
  }
  await step('Hazard: search "Dehradun" + Go', async () => {
    await pg.fill('#q', 'Dehradun'); await pg.click('button[type=submit]');
    await waitQuiet(90000); await pg.waitForTimeout(2000);
    return (await pg.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').slice(0, 260);
  });
  for (const v of ['data', 'reading']) {
    await step(`Hazard: tab ${v}`, async () => {
      const t = await pg.$(`[data-view=${v}]`);
      if (!t || !(await t.isVisible())) return 'tab not shown';
      await t.click(); await pg.waitForTimeout(1500);
      return `aria-selected=${await t.getAttribute('aria-selected')}`;
    });
  }

  // ---------- River Eyes ----------
  await open('/river-eyes/', 'r');
  const opts = await pg.$$eval('#world-river-select option', o => o.map(x => x.value));
  await step(`River select (${opts.length} rivers) -> 2nd option`, async () => { await pg.selectOption('#world-river-select', opts[1]); await waitQuiet(30000); return 'selected ' + await pg.$eval('#world-river-select', e => e.value); });
  await step('River select -> back to 1st', async () => { await pg.selectOption('#world-river-select', opts[0]); await waitQuiet(30000); return 'selected ' + await pg.$eval('#world-river-select', e => e.value); });
  await step('City "Shimla" + 🔍', async () => {
    await pg.fill('#plan-city', 'Shimla'); await pg.click('#plan-city-go'); await waitQuiet(30000);
    return `target ${await pg.$eval('#target-lat', e => e.value)}, ${await pg.$eval('#target-lon', e => e.value)} (${await pg.$eval('#target-location-name', e => e.value)})`;
  });
  await step('Sliders MW / radius', async () => {
    for (const id of ['mw-slider', 'plan-radius']) await pg.$eval('#' + id, e => { e.value = e.max / 2; e.dispatchEvent(new Event('input', { bubbles: true })); });
    return `${await text('#mw-label')} / ${await text('#plan-radius-val')}`;
  });
  await step('Rank radio "nearest"', async () => { await pg.check('input[name=plan-rank][value=nearest]'); return 'nearest checked=' + await pg.isChecked('input[name=plan-rank][value=nearest]'); });
  await step('Find Dam Sites for this City', async () => {
    await pg.click('button:has-text("Find Dam Sites for this City")');
    await waitQuiet(150000); await pg.waitForTimeout(3000);
    return 'panels: ' + (await visiblePanels()).join(', ') + ' | ' + (await pg.$$eval('button', bs => bs.filter(b => /Satellite|Gemma|Review/i.test(b.innerText) && b.offsetParent).length)) + ' site buttons';
  });
  await step('Dam site result: first "satellite/fly" button', async () => {
    const btn = pg.locator('button[onclick^="showSatellite"]').first();
    if (!(await btn.count())) return 'no site result buttons shown';
    await btn.click(); await pg.waitForTimeout(3000); return 'clicked ' + (await btn.innerText()).trim();
  });
  await step('Dam site result: "review with Gemma" button', async () => {
    const btn = pg.locator('button[onclick^="reviewSiteWithGemma"]').first();
    if (!(await btn.count())) return 'no site result buttons shown';
    await btn.click(); await pg.waitForTimeout(30000); return 'after: ' + (await btn.evaluate(b => b.closest('div')?.parentElement?.innerText || '')).replace(/\s+/g, ' ').slice(0, 220);
  });
  await step('Scan the Ganga', async () => {
    await pg.click('button:has-text("Scan the")');
    await waitQuiet(150000); await pg.waitForTimeout(3000);
    return 'panels: ' + (await visiblePanels()).join(', ');
  });
  await step('Pick a river on the map -> click map', async () => {
    await pg.click('#pick-river-btn'); await pg.waitForTimeout(800);
    const label = await text('#pick-river-btn', 80);
    await pg.mouse.click(860, 420); await waitQuiet(60000); await pg.waitForTimeout(2000);
    return `button said "${label}", now "${await text('#pick-river-btn', 80)}"`;
  });
  await step('⚡ Plan Dam Siting (MW)', async () => { await pg.click('button:has-text("Plan Dam Siting")'); await pg.waitForTimeout(3000); return 'panels: ' + (await visiblePanels()).join(', '); });
  for (const p of ['dam-planner-panel', 'water-panel', 'geotech-panel']) {
    await step(`Close ${p}`, async () => {
      const btn = pg.locator(`button[onclick="closePanel('${p}')"]`);
      if (!(await btn.isVisible())) return 'panel not open';
      await btn.click(); await pg.waitForTimeout(800); return 'panel visible after: ' + await pg.isVisible('#' + p);
    });
  }
  await step('✨ Aqua (Gemma 4) open', async () => { await pg.click('button.btn-aqua:has-text("Aqua")'); await pg.waitForTimeout(1500); return 'aqua input visible: ' + await pg.isVisible('#aqua-input'); });
  await step('Aqua: ask a question (Enter)', async () => {
    await pg.fill('#aqua-input', 'Is the Ganga at Rishikesh good for a small dam?'); await pg.press('#aqua-input', 'Enter');
    await pg.waitForTimeout(30000);
    return (await pg.evaluate(() => { const d = document.getElementById('aqua-input').closest('[id], .drawer'); return d ? d.innerText : ''; })).replace(/\s+/g, ' ').slice(-300);
  });
  await step('Aqua: close', async () => { await pg.click('button[onclick="toggleAqua(false)"]'); await pg.waitForTimeout(800); return 'aqua input visible: ' + await pg.isVisible('#aqua-input'); });
  await step('Aqua pill (bottom) opens drawer', async () => { await pg.click('.aqua-pill'); await pg.waitForTimeout(1500); const v = await pg.isVisible('#aqua-input'); await pg.click('button[onclick="toggleAqua(false)"]').catch(() => {}); return 'aqua input visible: ' + v; });
  await step('Leaflet layer checkboxes (each off/on)', async () => {
    const boxes = pg.locator('.leaflet-control-layers-selector');
    await pg.hover('.leaflet-control-layers'); await pg.waitForTimeout(500);
    const res = [];
    for (let i = 0; i < await boxes.count(); i++) {
      const lbl = (await boxes.nth(i).evaluate(e => e.parentElement.innerText)).trim();
      await boxes.nth(i).click({ force: true }); await pg.waitForTimeout(700);
      await boxes.nth(i).click({ force: true }); await pg.waitForTimeout(700);
      res.push(lbl);
    }
    return 'toggled: ' + res.join(' | ');
  });
  await b.close();
})();
