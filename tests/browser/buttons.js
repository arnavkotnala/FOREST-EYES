// Dead-button crawler: clicks every visible control on each page (including ones that appear after earlier clicks)
// and reports controls that do nothing (no DOM change, no request, no visual change, no download/dialog/navigation)
// or that cause errors. Usage: node buttons.js [page ...]   e.g. node buttons.js hazard shell
const { chromium } = require('playwright-core');
const BASE = process.env.BASE || 'http://localhost:8080';
// Plain names, so Git Bash doesn't turn "/hazard/" into a Windows path
const ALL = { shell: '/', forest: '/forest-eyes/', river: '/river-eyes/', hazard: '/hazard/' };
const PAGES = process.argv.slice(2).length ? process.argv.slice(2).map(a => ALL[a] || a) : Object.values(ALL);
const MAX_CLICKS = 150;
const SETTLE_MS = Number(process.env.SETTLE_MS) || 20000; // max wait for requests started by a click

(async () => {
  const b = await chromium.launch({ channel: 'chrome', args: ['--use-gl=angle', '--enable-unsafe-swiftshader'] });
  const summary = [];
  for (const path of PAGES) {
    const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
    await ctx.addInitScript(() => {
      window.__muts = 0;
      new MutationObserver(l => { window.__muts += l.length; })
        .observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    });
    const pg = await ctx.newPage();
    let errs = [], inflight = 0, reqs = 0, events = [];
    pg.on('console', m => m.type() === 'error' && errs.push('console: ' + m.text().slice(0, 160)));
    pg.on('pageerror', e => errs.push('pageerror: ' + e.message.slice(0, 160)));
    pg.on('request', () => { inflight++; reqs++; });
    pg.on('requestfinished', () => inflight--);
    pg.on('requestfailed', r => { inflight--; if (!/ERR_ABORTED/.test(r.failure()?.errorText)) errs.push(`FAILED ${r.failure()?.errorText} ${r.url().replace(BASE, '').slice(0, 100)}`); });
    pg.on('response', r => r.status() >= 400 && errs.push(`HTTP ${r.status()} ${r.url().replace(BASE, '').slice(0, 100)}`));
    pg.on('dialog', d => { events.push('dialog: ' + d.message().slice(0, 80)); d.dismiss(); });
    pg.on('download', d => events.push('download: ' + d.suggestedFilename()));
    ctx.on('page', p => { events.push('popup: ' + p.url().slice(0, 80)); p.close().catch(() => {}); });

    const settle = async () => {
      const t = Date.now();
      while (Date.now() - t < SETTLE_MS) {
        await pg.waitForTimeout(500);
        if (inflight <= 0 && Date.now() - t > 1500) break;
      }
    };
    const loadErrs = [];
    await pg.goto(BASE + path, { waitUntil: 'load', timeout: 60000 }).catch(e => loadErrs.push('goto: ' + e.message));
    await settle(); await pg.waitForTimeout(3000);
    loadErrs.push(...errs); errs = [];
    console.log(`\n===== ${path}`);
    if (loadErrs.length) [...new Set(loadErrs)].forEach(e => console.log('  load ! ' + e));

    // Fill empty text inputs so search / chat buttons have something to act on
    const fillInputs = () => pg.$$eval('input[type=text], input[type=search], input:not([type]), textarea', els => {
      for (const e of els) {
        if (e.offsetParent === null || e.value || e.disabled || e.readOnly) continue;
        const h = `${e.id} ${e.name} ${e.placeholder} ${e.getAttribute('aria-label')}`.toLowerCase();
        e.value = /lat/.test(h) && !/lon/.test(h) ? '30.32' : /lon|lng/.test(h) && !/lat/.test(h) ? '78.03'
          : /coord|lat.*lon/.test(h) ? '30.32, 78.03' : /city|place|search|location|town/.test(h) ? 'Dehradun'
          : /mw|demand|power/.test(h) ? '200' : 'Which native trees suit this place?';
        e.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });

    const seen = new Set(), results = [];
    let reloads = 0, repeats = 0;
    const groupTried = {};
    for (let i = 0; i < MAX_CLICKS; i++) {
      await fillInputs().catch(() => {});
      // Visible controls, keyed by tag/id/class/text (+ nth among equal keys)
      const ctrls = await pg.$$eval('button, [role=button], [role=tab], a[href], input[type=checkbox], input[type=radio], select, [onclick]', els => {
        const count = {};
        return els.map((e, idx) => {
          const r = e.getBoundingClientRect(), st = getComputedStyle(e);
          const visible = r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none' && (e.offsetParent !== null || st.position === 'fixed');
          const text = (e.innerText || (e.tagName === 'INPUT' && e.closest('label')?.innerText) || e.title || e.getAttribute('aria-label') || e.value || '').trim().replace(/\s+/g, ' ').slice(0, 45);
          const cls = (e.className?.baseVal ?? e.className ?? '').toString().split(' ')[0];
          let key = `${e.tagName.toLowerCase()}#${e.id || '-'}.${cls} "${text}"`;
          count[key] = (count[key] || 0) + 1; key += count[key] > 1 ? ` [${count[key]}]` : '';
          const href = e.tagName === 'A' ? e.getAttribute('href') : null;
          e.setAttribute('data-crawl', idx);
          // Is it covered by something else at its centre?
          const top = visible ? document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) : null;
          const covered = visible && r.y + r.height / 2 < innerHeight && top && !e.contains(top) && !top.contains(e);
          // Close / back buttons hide the other buttons of their panel, so they go last
          const closer = /^(×|✕|✖|x|close|back|←)$/i.test(text) || /close|dismiss/i.test(`${cls} ${e.getAttribute('aria-label') || ''} ${e.getAttribute('onclick') || ''}`);
          // Repeats = same kind of control; buttons with a generic class (.btn) only repeat when the label matches too
          const group = e.id ? key : `${e.tagName.toLowerCase()}.${cls}${e.tagName === 'BUTTON' ? ' ' + text : ''}`;
          return { idx, key, group, visible, closer, disabled: !!e.disabled, href, tag: e.tagName, type: e.type, covered: covered ? (top.id || top.className?.toString().split(' ')[0] || top.tagName) : null };
        });
      });
      // Long lists of the same control (one switch per tree, one marker per site): try the first 3
      const groupSize = {};
      for (const c of ctrls) groupSize[c.group] = (groupSize[c.group] || 0) + 1;
      for (const c of ctrls) if (c.visible && !seen.has(c.key) && groupSize[c.group] > 8 && (groupTried[c.group] || 0) >= 3) { seen.add(c.key); repeats++; }
      const todo = ctrls.filter(c => c.visible && !c.disabled && !seen.has(c.key));
      // Controls under an open panel/overlay wait until it is closed (Escape, its close button, or a reload)
      const clickable = todo.filter(c => !c.covered || c.tag === 'SELECT');
      const next = clickable.find(c => !c.closer) || clickable[0];
      if (!next) {
        if (!todo.length) break;
        if (reloads >= 6) { todo.forEach(c => results.push({ key: c.key, verdict: 'NEVER UNCOVERED', note: `covered by ${c.covered}` })); break; }
        await pg.keyboard.press('Escape'); await pg.waitForTimeout(1000);
        const still = await pg.$$eval(todo.map(c => `[data-crawl="${c.idx}"]`).join(','), els => els.some(e => {
          const r = e.getBoundingClientRect(), top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          return top && !e.contains(top) && !top.contains(e);
        })).catch(() => true);
        if (still) { reloads++; await pg.goto(BASE + path, { waitUntil: 'load' }).catch(() => {}); await settle(); await pg.waitForTimeout(3000); }
        continue;
      }
      seen.add(next.key);
      groupTried[next.group] = (groupTried[next.group] || 0) + 1;
      const sel = `[data-crawl="${next.idx}"]`;

      if (next.href && !next.href.startsWith('#') && !next.href.startsWith('javascript')) {
        // Links: check the target answers instead of navigating away (one retry for slow sites)
        const url = new URL(next.href, pg.url()).href;
        const get = () => pg.request.get(url, { timeout: 20000, failOnStatusCode: false }).then(r => r.status());
        const st = await get().catch(get).catch(e => 'ERR ' + e.message.split('\n')[0].slice(0, 60));
        results.push({ key: next.key, verdict: st === 200 || (st >= 300 && st < 400) ? 'link ok' : `LINK BROKEN (${st})`, note: url.slice(0, 90) });
        continue;
      }

      errs = []; events = [];
      const url0 = pg.url();
      const m0 = await pg.evaluate(() => window.__muts);
      await pg.waitForTimeout(1000);
      const m1 = await pg.evaluate(() => window.__muts);
      const shot1 = await pg.screenshot().catch(() => null);
      await pg.waitForTimeout(400);
      const shot2 = await pg.screenshot().catch(() => null);
      const animating = !(shot1 && shot2 && shot1.equals(shot2));
      const baseline = m1 - m0;
      reqs = 0;
      let clickErr = null;
      try {
        if (next.tag === 'SELECT') {
          const opts = await pg.$$eval(`${sel} option`, os => os.map(o => o.value));
          const cur = await pg.$eval(sel, s => s.value);
          await pg.selectOption(sel, opts.find(v => v !== cur) ?? cur, { timeout: 5000 });
        } else if (/checkbox|radio/.test(next.type)) {
          // Styled switches hide the real input: click what the user sees (its label or slider)
          const alt = await pg.$eval(sel, e => {
            const r = e.getBoundingClientRect();
            if (r.width > 4 && r.height > 4 && getComputedStyle(e).opacity !== '0') return null;
            const t = e.closest('label') || (e.id && document.querySelector(`label[for="${e.id}"]`)) || e.nextElementSibling;
            t?.setAttribute('data-crawl-alt', '1');
            return t ? '[data-crawl-alt="1"]' : null;
          });
          await pg.click(alt || sel, { timeout: 5000 });
          if (alt) await pg.$eval(alt, e => e.removeAttribute('data-crawl-alt')).catch(() => {}); // may be re-rendered already
        } else {
          await pg.click(sel, { timeout: 5000 });
        }
      } catch (e) {
        clickErr = e.message.split('\n')[0].slice(0, 120);
      }
      await pg.waitForTimeout(1500);
      await settle();
      const m2 = await pg.evaluate(() => window.__muts).catch(() => m1);
      const shot3 = await pg.screenshot().catch(() => null);
      const domChange = (m2 - m1) > baseline * 3 + 2;
      const visual = !animating && shot3 && !shot3.equals(shot2);
      const navigated = pg.url() !== url0;
      const did = [domChange && 'dom', reqs && `${reqs} req`, visual && 'visual', navigated && 'nav', ...events].filter(Boolean);
      const verdict = clickErr ? `CLICK FAILED (${clickErr})`
        : errs.length ? 'ERRORS'
        : did.length ? 'ok' : animating ? 'NO DOM CHANGE (page animating, visual not checked)' : 'DEAD?';
      results.push({ key: next.key, verdict, note: [did.join(', '), next.covered && `covered by ${next.covered}`, ...new Set(errs)].filter(Boolean).join(' | ') });
      console.log(`  ${verdict.padEnd(10)} ${next.key}  ${results.at(-1).note}`);
      if (navigated) { await pg.goto(BASE + path, { waitUntil: 'load' }).catch(() => {}); await pg.waitForTimeout(3000); }
    }
    for (const r of results.filter(r => /^(link|LINK|NEVER)/.test(r.verdict))) console.log(`  ${r.verdict.padEnd(10)} ${r.key}  ${r.note}`);
    const bad = results.filter(r => r.verdict !== 'ok' && r.verdict !== 'link ok');
    summary.push(`${path}: ${results.length} controls tried, ${bad.length} need a look, ${repeats} repeats of an already-tried control skipped`);
    await ctx.close();
  }
  console.log('\n===== SUMMARY'); summary.forEach(s => console.log('  ' + s));
  await b.close();
})();
