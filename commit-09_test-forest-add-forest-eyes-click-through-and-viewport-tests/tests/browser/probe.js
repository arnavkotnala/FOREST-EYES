const { chromium } = require('playwright-core');
(async () => {
  const b = await chromium.launch({ channel: 'chrome' });
  for (const [w, h] of [[1440, 900], [1920, 1080], [1280, 720]]) {
    const pg = await b.newPage({ viewport: { width: w, height: h } });
    await pg.goto('http://localhost:8080/forest-eyes/', { waitUntil: 'load' }); await pg.waitForTimeout(3000);
    const r = await pg.evaluate(() => [...document.querySelectorAll('.leaflet-control-zoom a')].map(a => {
      const bb = a.getBoundingClientRect(); const top = document.elementFromPoint(bb.x + bb.width / 2, bb.y + bb.height / 2);
      return `${a.className.split(' ')[0]} at ${Math.round(bb.x)},${Math.round(bb.y)} ${Math.round(bb.width)}x${Math.round(bb.height)}; on top: ${top ? top.tagName + '#' + top.id + '.' + String(top.className).split(' ')[0] : 'nothing (off-screen)'}`;
    }));
    console.log(`${w}x${h}:`, r.join(' | '));
    await pg.close();
  }
  await b.close();
})();
