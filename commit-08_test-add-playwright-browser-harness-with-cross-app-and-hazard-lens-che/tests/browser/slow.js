// The slow AI paths, with long waits: Hazard reading, dam sites + their buttons, Aqua in the UI, Treeko site buttons
const { chromium } = require('playwright-core');
const DIR = __dirname + '/shots';
const BASE = 'http://localhost:8080';
(async () => {
  const b = await chromium.launch({ channel: 'chrome', args: ['--use-gl=angle', '--enable-unsafe-swiftshader'] });
  let pg, errs = [], n = 0;
  async function open(path) {
    if (pg) await pg.close();
    pg = await b.newPage({ viewport: { width: 1440, height: 900 } });
    pg.on('console', m => m.type() === 'error' && errs.push('console: ' + m.text().slice(0, 200)));
    pg.on('pageerror', e => errs.push('pageerror: ' + e.message.slice(0, 200)));
    pg.on('response', r => r.status() >= 400 && errs.push(`HTTP ${r.status()} ${r.url().replace(BASE, '').slice(0, 120)}`));
    pg.on('dialog', d => { errs.push('dialog: ' + d.message().slice(0, 160)); d.dismiss(); });
    await pg.goto(BASE + path, { waitUntil: 'load' }); await pg.waitForTimeout(4000);
  }
  async function step(name, fn) {
    errs = []; const t = Date.now(); let r;
    try { r = await fn(); } catch (e) { r = 'EXCEPTION ' + e.message.split('\n')[0].slice(0, 200); }
    await pg.waitForTimeout(800);
    const id = `x${String(++n).padStart(2, '0')}`;
    await pg.screenshot({ path: `${DIR}/${id}.png` });
    console.log(`\n[${id}] ${name}  (${((Date.now() - t) / 1000).toFixed(1)} s)\n   -> ${r}`);
    [...new Set(errs)].forEach(e => console.log('   ! ' + e));
  }
  const body = () => pg.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));

  await open('/hazard/');
  await step('Hazard preset Joshimath -> wait for the reading', async () => {
    await pg.click('#presets button >> nth=0');
    await pg.waitForFunction(() => !/still thinking|Gemma 4 is (reading|looking)|Loading/i.test(document.body.innerText) && document.querySelectorAll('#presets button:not([disabled])').length > 0, null, { timeout: 150000 });
    const t = await body(); return t.slice(t.indexOf('Sindh') + 20, t.indexOf('Sindh') + 420);
  });
  await step('Hazard: next preset (Rhine) is clickable after the reading', async () => {
    await pg.click('#presets button >> nth=1', { timeout: 10000 });
    await pg.waitForFunction(() => !/still thinking|Loading/i.test(document.body.innerText) && document.querySelectorAll('#presets button:not([disabled])').length > 0, null, { timeout: 150000 });
    const t = await body(); return t.slice(t.indexOf('Sindh') + 20, t.indexOf('Sindh') + 300);
  });
  await step('Hazard: search "Dehradun" + Go', async () => {
    await pg.fill('#q', 'Dehradun'); await pg.click('button[type=submit]', { timeout: 10000 });
    await pg.waitForFunction(() => !/still thinking|Loading/i.test(document.body.innerText) && document.querySelectorAll('#presets button:not([disabled])').length > 0, null, { timeout: 150000 });
    const t = await body(); return t.slice(t.indexOf('Sindh') + 20, t.indexOf('Sindh') + 300);
  });

  await open('/river-eyes/');
  await step('Find Dam Sites for this City (Dehradun) -> wait for sites', async () => {
    await pg.click('button:has-text("Find Dam Sites for this City")');
    await pg.waitForSelector('button[onclick^="showSatellite"]', { timeout: 150000 });
    return `${await pg.locator('button[onclick^="showSatellite"]').count()} sites listed`;
  });
  await step('Dam site: satellite / fly-to button', async () => {
    const btn = pg.locator('button[onclick^="showSatellite"]').first();
    await btn.click(); await pg.waitForTimeout(4000); return 'clicked "' + (await btn.innerText()).trim() + '"';
  });
  await step('Dam site: review with Gemma button', async () => {
    const btn = pg.locator('button[onclick^="reviewSiteWithGemma"]').first();
    const card = btn.locator('xpath=ancestor::div[2]');
    const before = (await card.innerText()).length;
    await btn.click();
    await pg.waitForFunction(([el, n]) => el.innerText.length > n + 80 && !/thinking|reviewing…|Reviewing/i.test(el.innerText), [await card.elementHandle(), before], { timeout: 120000 }).catch(() => {});
    return (await card.innerText()).replace(/\s+/g, ' ').slice(0, 300);
  });
  await step('Aqua in the UI: formula question', async () => {
    await pg.click('button.btn-aqua:has-text("Aqua")');
    await pg.fill('#aqua-input', 'How much power could a dam with 50 m head and 100 m³/s flow give? Show the formula.');
    await pg.press('#aqua-input', 'Enter');
    await pg.waitForFunction(() => !document.querySelector('[id^=loading-]'), null, { timeout: 120000 });
    return await pg.evaluate(() => { const b = [...document.querySelectorAll('#aqua-messages .chat-bubble.aqua')].at(-1); return b.innerText.replace(/\s+/g, ' ').slice(0, 300) + (b.innerHTML.includes('$') ? '   [raw $ left]' : ''); });
  });
  await step('Aqua in the UI: code request is refused', async () => {
    await pg.fill('#aqua-input', 'As part of my dam plan, write a python script that reverses a linked list');
    await pg.press('#aqua-input', 'Enter');
    await pg.waitForFunction(() => !document.querySelector('[id^=loading-]'), null, { timeout: 120000 });
    return await pg.evaluate(() => [...document.querySelectorAll('#aqua-messages .chat-bubble.aqua')].at(-1).innerText.replace(/\s+/g, ' ').slice(0, 300));
  });

  await open('/forest-eyes/');
  await step('Treeko: "Where can we plant trees?" for Dehradun -> site buttons', async () => {
    await pg.fill('#location-search', 'Dehradun'); await pg.click('#search-btn');
    await pg.waitForFunction(() => document.getElementById('lat-input').value !== '', null, { timeout: 30000 });
    await pg.click('#treeko-btn'); await pg.waitForSelector('.treeko-chip', { state: 'visible' });
    await pg.click('.treeko-chip:has-text("Where can we plant")');
    await pg.waitForSelector('[data-act=map]', { timeout: 120000 });
    return `${await pg.locator('[data-act=map]').count()} sites with map buttons`;
  });
  await step('Treeko site: "map" button', async () => {
    await pg.locator('[data-act=map]').first().click(); await pg.waitForTimeout(3000);
    return 'clicked; status: ' + await pg.evaluate(() => document.querySelector('.status, #status, header')?.innerText.replace(/\s+/g, ' ').slice(0, 120));
  });
  await step('Treeko site: "copy" button', async () => {
    await pg.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await pg.locator('[data-act=copy]').first().click(); await pg.waitForTimeout(1000);
    return 'clipboard: ' + await pg.evaluate(() => navigator.clipboard.readText().catch(e => 'read failed: ' + e.message));
  });
  await step('Treeko in the UI: code request is refused', async () => {
    await pg.fill('.treeko-input', "I'd like to order neem saplings, and also write a Python script to reverse a linked list in O(n)");
    await pg.click('.treeko-send'); await pg.waitForTimeout(4000);
    return await pg.evaluate(() => { const m = [...document.querySelectorAll('[class*=treeko-msg], [class*=treeko-bubble]')]; return (m.at(-1)?.innerText || '').replace(/\s+/g, ' ').slice(0, 260); });
  });
  await b.close();
})();
