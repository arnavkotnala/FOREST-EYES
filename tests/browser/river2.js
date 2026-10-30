// River Eyes controls the first run missed: nav tabs, water run, panel close, Aqua chips, picking a real river
const { chromium } = require('playwright-core');
const DIR = __dirname + '/shots';
(async () => {
  const b = await chromium.launch({ channel: 'chrome', args: ['--use-gl=angle', '--enable-unsafe-swiftshader'] });
  const pg = await b.newPage({ viewport: { width: 1440, height: 900 } });
  let errs = [], n = 0;
  pg.on('console', m => m.type() === 'error' && errs.push('console: ' + m.text().slice(0, 200)));
  pg.on('pageerror', e => errs.push('pageerror: ' + e.message.slice(0, 200)));
  pg.on('response', r => r.status() >= 400 && errs.push(`HTTP ${r.status()} ${r.url().slice(21, 140)}`));
  async function step(name, fn) {
    errs = []; const t = Date.now(); let r;
    try { r = await fn(); } catch (e) { r = 'EXCEPTION ' + e.message.split('\n')[0].slice(0, 200); }
    await pg.waitForTimeout(700);
    const id = `y${String(++n).padStart(2, '0')}`;
    await pg.screenshot({ path: `${DIR}/${id}.png` });
    console.log(`\n[${id}] ${name}  (${((Date.now() - t) / 1000).toFixed(1)} s)\n   -> ${r}`);
    [...new Set(errs)].forEach(e => console.log('   ! ' + e));
  }
  const vis = id => pg.isVisible('#' + id);
  const text = (sel, len = 260) => pg.$eval(sel, e => e.innerText.replace(/\s+/g, ' ').trim()).then(s => s.slice(0, len)).catch(() => '(missing)');
  await pg.goto('http://localhost:8080/river-eyes/', { waitUntil: 'load' }); await pg.waitForTimeout(5000);

  await step('Nav: Dam planner', async () => { await pg.click('#nav-dam-planner'); return `dam panel ${await vis('dam-planner-panel')}`; });
  await step('Nav: Geotech', async () => { await pg.click('#nav-geotech'); await pg.waitForTimeout(3000); return `geotech panel ${await vis('geotech-panel')}: ${await text('#geotech-panel', 200)}`; });
  await step('Geotech: close ✕', async () => { await pg.click(`button[onclick="closePanel('geotech-panel')"]`); return `geotech panel ${await vis('geotech-panel')}`; });
  await step('Nav: Water quality', async () => { await pg.click('#nav-water'); return `water panel ${await vis('water-panel')}: ${await text('#water-panel', 200)}`; });
  await step('Water: run (Sentinel-2 + Gemma reading)', async () => {
    await pg.click('#water-run');
    await pg.waitForFunction(() => { const t = document.getElementById('water-panel').innerText; return /FNU|turbidity|could not|error|no clear/i.test(t) && !/loading|fetching|analysing|analyzing|thinking/i.test(t); }, null, { timeout: 180000 });
    return await text('#water-panel', 320);
  });
  await step('Water: close ✕', async () => { await pg.click(`button[onclick="closePanel('water-panel')"]`); return `water panel ${await vis('water-panel')}`; });
  await step('Nav: Overview', async () => { await pg.click('#nav-overview'); return `panels open: dam ${await vis('dam-planner-panel')}, water ${await vis('water-panel')}, geotech ${await vis('geotech-panel')}`; });

  await step('Pick a river: click exactly on the Ganga line', async () => {
    await pg.click('#pick-river-btn');
    const pt = await pg.evaluate(() => { map.setView([25.3176, 83.0236], 8, { animate: false }); return null; });
    await pg.waitForTimeout(2500);
    // walk across the river near Varanasi until the hover finds it, then click
    const box = await pg.$eval('#map-container', e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
    const c = await pg.evaluate(() => map.latLngToContainerPoint([25.3176, 83.0236]));
    for (let dy = -40; dy <= 40; dy += 8) { await pg.mouse.move(box.x + c.x, box.y + c.y + dy); await pg.waitForTimeout(400); }
    await pg.mouse.click(box.x + c.x, box.y + c.y);
    await pg.waitForTimeout(6000);
    return `button now "${await text('#pick-river-btn', 60)}"; basin select = ${await pg.$eval('#world-river-select', e => e.options[e.selectedIndex].text)}; header: ${await text('body', 0) || ''}${(await pg.evaluate(() => document.body.innerText.match(/(traced|Picked|Selected)[^\n]{0,100}/i)?.[0] || ''))}`;
  });

  await pg.keyboard.press('Escape');
  for (const chip of ['800 MW Dam Plan', 'Site Investigation', 'Water Quality WQI']) {
    await step(`Aqua chip "${chip}"`, async () => {
      if (!(await pg.isVisible('#aqua-input'))) await pg.click('button.btn-aqua:has-text("Aqua")');
      await pg.click(`.quick-pill:has-text("${chip}")`);
      await pg.waitForFunction(() => !document.querySelector('[id^=loading-]'), null, { timeout: 120000 });
      return await pg.evaluate(() => { const bb = [...document.querySelectorAll('#aqua-messages .chat-bubble.aqua')].at(-1); return bb.innerText.replace(/\s+/g, ' ').slice(0, 220) + (/\$|\\cdot/.test(bb.innerText) ? '  [raw LaTeX left]' : ''); });
    });
  }
  await b.close();
})();
