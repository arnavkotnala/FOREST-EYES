/**
 * NatureWaterTransition — Ultra-Lightweight 60fps Canvas Transition Engine
 * ========================================================================
 * 1. Forest ➔ River: Screen floods with rising water, bubbles, light rays,
 *    and schools of BIGGER majestic river fish (Koi, Salmon, Trout, Perch)
 *    swimming across the submerged screen with oscillating fins and tails.
 * 2. River ➔ Forest: Simple flat geometric PINE TREES (triangular layered)
 *    rise from the bottom, accompanied by flocks of BIRDS soaring across the
 *    canopy and sky with flapping wings and bird audio chirps.
 *    Curtain parts to seamlessly reveal Forest Eyes.
 * 3. Web Audio API synthesized sounds (water flood, forest rumble, birds).
 */

class NatureWaterTransition {
  constructor(canvasId) {
    this.canvas = document.getElementById(canvasId);
    if (!this.canvas) {
      console.error(`Transition canvas '${canvasId}' not found.`);
      return;
    }
    this.ctx = this.canvas.getContext('2d', { alpha: true });
    this.isAnimating = false;
    this.animId = null;
    this.audioEnabled = true;
    this.audioCtx = null;

    this.width = 0;
    this.height = 0;
    this.dpr = 1; // Force DPR=1 for maximum performance

    this.resize();
    window.addEventListener('resize', () => this.resize());

    this.bubbles = [];
    this.droplets = [];
    this.fishes = [];
    this.pineTrees = [];
    this.birds = [];
    this._leaves = [];
  }

  resize() {
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  // =========================================================================
  // AUDIO ENGINE (Web Audio API Synthesizer)
  // =========================================================================
  initAudio() {
    if (!this.audioEnabled) return;
    try {
      if (!this.audioCtx) {
        this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (this.audioCtx.state === 'suspended') this.audioCtx.resume();
    } catch (e) {}
  }

  playWaterAudio() {
    if (!this.audioEnabled || !this.audioCtx) return;
    const ctx = this.audioCtx, now = ctx.currentTime;
    try {
      // Water surge pink noise
      const buf = ctx.createBuffer(1, ctx.sampleRate * 2.2, ctx.sampleRate);
      const d = buf.getChannelData(0);
      let b0 = 0, b1 = 0, b2 = 0;
      for (let i = 0; i < d.length; i++) {
        const w = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + w * 0.0555;
        b1 = 0.99332 * b1 + w * 0.0751;
        b2 = 0.969 * b2 + w * 0.1539;
        d[i] = (b0 + b1 + b2) * 0.13;
      }
      const src = ctx.createBufferSource(); src.buffer = buf;
      const flt = ctx.createBiquadFilter(); flt.type = 'lowpass';
      flt.frequency.setValueAtTime(120, now);
      flt.frequency.exponentialRampToValueAtTime(1100, now + 1);
      flt.frequency.exponentialRampToValueAtTime(200, now + 2.1);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.001, now);
      g.gain.linearRampToValueAtTime(0.32, now + 0.9);
      g.gain.exponentialRampToValueAtTime(0.001, now + 2.1);
      src.connect(flt); flt.connect(g); g.connect(ctx.destination);
      src.start(now); src.stop(now + 2.2);
    } catch (e) {}
  }

  playForestAudio() {
    if (!this.audioEnabled || !this.audioCtx) return;
    const ctx = this.audioCtx, now = ctx.currentTime;
    try {
      // 1. Earth growth low harmonic rumble
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(55, now);
      osc.frequency.exponentialRampToValueAtTime(105, now + 0.6);
      osc.frequency.exponentialRampToValueAtTime(40, now + 1.5);
      g.gain.setValueAtTime(0.001, now);
      g.gain.linearRampToValueAtTime(0.24, now + 0.5);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 1.8);
      osc.connect(g); g.connect(ctx.destination);
      osc.start(now); osc.stop(now + 1.8);

      // 2. Wind canopy swoosh
      const buf = ctx.createBuffer(1, ctx.sampleRate * 1.8, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * 0.1;
      const src = ctx.createBufferSource(); src.buffer = buf;
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.8;
      bp.frequency.setValueAtTime(200, now);
      bp.frequency.exponentialRampToValueAtTime(1200, now + 0.8);
      bp.frequency.exponentialRampToValueAtTime(250, now + 1.7);
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(0.001, now);
      ng.gain.linearRampToValueAtTime(0.26, now + 0.7);
      ng.gain.exponentialRampToValueAtTime(0.001, now + 1.8);
      src.connect(bp); bp.connect(ng); ng.connect(ctx.destination);
      src.start(now); src.stop(now + 1.8);

      // 3. Cheerful Forest Bird Chirps
      const chirpTimes = [now + 0.32, now + 0.68, now + 1.08];
      const chirpPitches = [
        [2400, 3600, 2700],
        [3000, 4400, 3200],
        [2700, 3900, 2900]
      ];
      chirpTimes.forEach((ct, idx) => {
        try {
          const cOsc = ctx.createOscillator();
          const cGain = ctx.createGain();
          cOsc.type = 'sine';
          const [f0, f1, f2] = chirpPitches[idx];
          cOsc.frequency.setValueAtTime(f0, ct);
          cOsc.frequency.exponentialRampToValueAtTime(f1, ct + 0.04);
          cOsc.frequency.exponentialRampToValueAtTime(f2, ct + 0.12);
          cGain.gain.setValueAtTime(0.0001, ct);
          cGain.gain.linearRampToValueAtTime(0.07, ct + 0.02);
          cGain.gain.exponentialRampToValueAtTime(0.0001, ct + 0.13);
          cOsc.connect(cGain);
          cGain.connect(ctx.destination);
          cOsc.start(ct);
          cOsc.stop(ct + 0.14);
        } catch(e) {}
      });
    } catch (e) {}
  }

  // =========================================================================
  // TRANSITION 1: FOREST ➔ RIVER (Water Flood + BIGGER Swimming Fish)
  // =========================================================================
  floodToRiver(onMidpoint, onComplete) {
    if (this.isAnimating) return;
    this.isAnimating = true;
    this.initAudio();
    this.playWaterAudio();

    this.canvas.style.display = 'block';
    this.canvas.style.opacity = '1';

    const overlay = document.getElementById('transition-ambient-overlay');
    if (overlay) overlay.className = 'transition-ambient-overlay active-water';

    this.bubbles = [];
    this.droplets = [];
    for (let i = 0; i < 65; i++) {
      this.bubbles.push({
        x: Math.random() * this.width,
        y: this.height + Math.random() * 200,
        r: 2 + Math.random() * 5.5,
        sy: 2.2 + Math.random() * 4.2,
        ws: 2 + Math.random() * 3,
        wd: 5 + Math.random() * 10,
        a: 0.35 + Math.random() * 0.55
      });
    }

    // Initialize bigger fish
    this.initFishes();

    const dur = 2300;
    const t0 = performance.now();
    let mid = false;

    const loop = (now) => {
      const el = now - t0;
      const p = Math.min(el / dur, 1);
      const t = el / 1000;
      this.ctx.clearRect(0, 0, this.width, this.height);

      let waterY;
      if (p < 0.48) {
        const e = p / 0.48;
        const ease = e < 0.5 ? 4*e*e*e : 1 - Math.pow(-2*e+2, 3) / 2;
        waterY = this.height - (this.height + 90) * ease;
      } else if (p <= 0.55) {
        waterY = -90;
      } else {
        const e = (p - 0.55) / 0.45;
        waterY = -90 + (this.height + 180) * e * e * (3 - 2*e);
      }

      if (p >= 0.50 && !mid) { mid = true; if (onMidpoint) onMidpoint(); }

      this.drawWater(waterY, t, p);

      if (p < 1) {
        this.animId = requestAnimationFrame(loop);
      } else {
        this.finish(onComplete);
      }
    };
    this.animId = requestAnimationFrame(loop);
  }

  initFishes() {
    this.fishes = [];
    const w = this.width, h = this.height;

    // Vibrant palettes for majestic river fish
    const pals = [
      // Golden / Orange Japanese Koi with crimson spots
      { body: '#ea580c', belly: '#fef08a', fin: '#f97316', spots: '#dc2626' },
      // Shimmering Turquoise River Perch / Blue Moonfish
      { body: '#0284c7', belly: '#e0f2fe', fin: '#38bdf8', spots: '#06b6d4' },
      // Ruby King Salmon
      { body: '#e11d48', belly: '#ffe4e6', fin: '#fb7185', spots: '#be123c' },
      // Emerald Mountain Trout
      { body: '#059669', belly: '#dcfce7', fin: '#34d399', spots: '#047857' },
      // Royal Azure Arapaima
      { body: '#2563eb', belly: '#dbeafe', fin: '#60a5fa', spots: '#1d4ed8' },
    ];

    // 1. Five BIG / GIANT River Fish (Length 125px – 170px!)
    // Placed across the screen so they are immediately visible as water rises
    const bigDepths = [
      { yRatio: 0.32, dir: 1,  sz: 145, spd: 4.5, palIdx: 0, xStart: w * 0.15 },
      { yRatio: 0.50, dir: -1, sz: 160, spd: 4.8, palIdx: 1, xStart: w * 0.85 },
      { yRatio: 0.68, dir: 1,  sz: 135, spd: 4.2, palIdx: 2, xStart: w * 0.05 },
      { yRatio: 0.82, dir: -1, sz: 150, spd: 4.6, palIdx: 3, xStart: w * 0.90 },
      { yRatio: 0.40, dir: 1,  sz: 130, spd: 5.0, palIdx: 4, xStart: -80 }
    ];

    for (let i = 0; i < bigDepths.length; i++) {
      const cfg = bigDepths[i];
      this.fishes.push({
        x: cfg.xStart,
        y: h * cfg.yRatio,
        baseY: h * cfg.yRatio,
        vx: cfg.dir * cfg.spd,
        dir: cfg.dir,
        sz: cfg.sz,
        depth: 2, // foreground
        isBig: true,
        wSpd: 5.2 + Math.random() * 1.5, // Majestic slower tail wag
        wPh: i * 1.2,
        sA: 8 + Math.random() * 6,
        sF: 1.1 + Math.random() * 0.4,
        pal: pals[cfg.palIdx]
      });
    }

    // 2. Six Medium Fish (Length 65px – 90px)
    for (let i = 0; i < 6; i++) {
      const dir = (i % 2 === 0) ? 1 : -1;
      const yR = 0.22 + i * 0.11;
      const spd = 4.8 + Math.random() * 1.5;
      const sz = 65 + Math.random() * 25;
      const xStart = dir > 0 ? (i * w * 0.18) % w : w - ((i * w * 0.18) % w);
      this.fishes.push({
        x: xStart,
        y: h * yR,
        baseY: h * yR,
        vx: dir * spd,
        dir, sz,
        depth: 1, // midground
        isBig: false,
        wSpd: 7.5 + Math.random() * 3,
        wPh: Math.random() * Math.PI * 2,
        sA: 6 + Math.random() * 6,
        sF: 1.5 + Math.random() * 0.8,
        pal: pals[(i + 1) % pals.length]
      });
    }

    // 3. Seven Schooling Small Fish (Length 28px – 42px)
    for (let i = 0; i < 7; i++) {
      const dir = (i % 3 === 0) ? -1 : 1;
      const yR = 0.18 + (i % 5) * 0.15;
      const spd = 5.2 + Math.random() * 2.2;
      const sz = 28 + Math.random() * 14;
      const xStart = dir > 0 ? (i * 140) : w - (i * 140);
      this.fishes.push({
        x: xStart,
        y: h * yR,
        baseY: h * yR,
        vx: dir * spd,
        dir, sz,
        depth: 0, // background
        isBig: false,
        wSpd: 11 + Math.random() * 4,
        wPh: Math.random() * Math.PI * 2,
        sA: 4 + Math.random() * 4,
        sF: 2.0 + Math.random() * 1.0,
        pal: pals[(i + 2) % pals.length]
      });
    }
  }

  drawWater(waterY, t, progress) {
    const ctx = this.ctx, w = this.width, h = this.height;
    if (waterY >= h) return;

    // Water body gradient
    const bg = ctx.createLinearGradient(0, Math.max(0, waterY), 0, h);
    bg.addColorStop(0, 'rgba(8,47,73,0.96)');
    bg.addColorStop(0.35, 'rgba(3,105,161,0.93)');
    bg.addColorStop(1, 'rgba(2,6,23,0.98)');
    ctx.fillStyle = bg;
    ctx.fillRect(0, Math.max(0, waterY), w, h - Math.max(0, waterY));

    // Light rays
    if (waterY < h * 0.5) {
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      for (let i = 0; i < 5; i++) {
        const rx = w * 0.2 * i + Math.sin(t * 1.2 + i) * 45;
        const rg = ctx.createLinearGradient(rx, waterY, rx + 70, h);
        rg.addColorStop(0, 'rgba(56,189,248,0.22)');
        rg.addColorStop(1, 'rgba(6,182,212,0)');
        ctx.fillStyle = rg;
        ctx.beginPath();
        ctx.moveTo(rx - 25, Math.max(0, waterY));
        ctx.lineTo(rx + 75, Math.max(0, waterY));
        ctx.lineTo(rx + 190, h);
        ctx.lineTo(rx + 25, h);
        ctx.fill();
      }
      ctx.restore();
    }

    // Waves at water surface
    this.wave(waterY + 12, 0.007, 3.2, t, 18, 'rgba(2,132,199,0.85)');
    this.wave(waterY, 0.012, -2.4, t, 14, 'rgba(6,182,212,0.9)');
    this.wave(waterY - 6, 0.017, 4.2, t, 10, 'rgba(56,189,248,0.95)', true);

    // Swimming fish (Bigger fish included!)
    this.drawFish(waterY, t);

    // Bubbles
    for (const b of this.bubbles) {
      b.y -= b.sy;
      if (b.y < waterY) { b.y = h + Math.random() * 30; b.x = Math.random() * w; }
      const bx = b.x + Math.sin(t * b.ws + b.r) * b.wd;
      ctx.beginPath(); ctx.arc(bx, b.y, b.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(224,242,254,${b.a * 0.65})`; ctx.fill();
      ctx.beginPath(); ctx.arc(bx - b.r * 0.3, b.y - b.r * 0.3, b.r * 0.35, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,255,255,${b.a * 0.9})`; ctx.fill();
    }

    // Splash droplets
    if (progress < 0.48 && waterY > 0 && Math.random() < 0.55) {
      this.droplets.push({
        x: Math.random() * w, y: waterY,
        vx: (Math.random() - 0.5) * 8, vy: -Math.random() * 11 - 3,
        r: 1.5 + Math.random() * 2.8, a: 1
      });
    }
    for (let i = this.droplets.length - 1; i >= 0; i--) {
      const d = this.droplets[i];
      d.x += d.vx; d.y += d.vy; d.vy += 0.48; d.a -= 0.026;
      if (d.a <= 0 || d.y > h) { this.droplets.splice(i, 1); continue; }
      ctx.beginPath(); ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(186,230,253,${d.a})`; ctx.fill();
    }
  }

  drawFish(waterY, t) {
    const ctx = this.ctx, h = this.height;

    for (const f of this.fishes) {
      f.x += f.vx;
      f.y = f.baseY + Math.sin(t * f.sF + f.wPh) * f.sA;

      // Only draw when underwater
      if (f.y < waterY - 30 || f.y > h + 60) continue;

      ctx.save();
      ctx.translate(f.x, f.y);
      if (f.dir < 0) ctx.scale(-1, 1);

      const s = f.sz;
      const wig = Math.sin(t * f.wSpd + f.wPh);
      const ta = wig * 0.36;

      ctx.globalAlpha = f.depth === 2 ? 0.98 : (f.depth === 1 ? 0.86 : 0.65);

      // 1. CAUDAL FIN (Tail)
      ctx.save();
      ctx.translate(-s * 0.45, 0);
      ctx.rotate(ta);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      // Top lobe of tail
      ctx.bezierCurveTo(-s * 0.2, -s * 0.16, -s * 0.42, -s * 0.38, -s * 0.58, -s * 0.32 + wig * 3);
      // Tail center indent
      ctx.bezierCurveTo(-s * 0.42, -s * 0.1, -s * 0.38, 0, -s * 0.35, 0);
      // Bottom lobe of tail
      ctx.bezierCurveTo(-s * 0.38, 0, -s * 0.42, s * 0.1, -s * 0.58, s * 0.32 - wig * 3);
      ctx.bezierCurveTo(-s * 0.42, s * 0.38, -s * 0.2, s * 0.16, 0, 0);
      ctx.fillStyle = f.pal.fin;
      ctx.fill();

      // Tail fin rays for big fish
      if (f.isBig) {
        ctx.strokeStyle = 'rgba(255,255,255,0.45)';
        ctx.lineWidth = 1.3;
        ctx.beginPath();
        ctx.moveTo(0, 0); ctx.lineTo(-s * 0.54, -s * 0.28 + wig * 3);
        ctx.moveTo(0, 0); ctx.lineTo(-s * 0.46, -s * 0.11);
        ctx.moveTo(0, 0); ctx.lineTo(-s * 0.46, s * 0.11);
        ctx.moveTo(0, 0); ctx.lineTo(-s * 0.54, s * 0.28 - wig * 3);
        ctx.stroke();
      }
      ctx.restore();

      // 2. MAIN BODY
      ctx.beginPath();
      ctx.moveTo(s * 0.52, 0); // Snout
      // Upper back curve
      ctx.bezierCurveTo(s * 0.3, -s * 0.26, -s * 0.15, -s * 0.24, -s * 0.45, 0);
      // Lower belly curve
      ctx.bezierCurveTo(-s * 0.15, s * 0.24, s * 0.3, s * 0.24, s * 0.52, 0);
      ctx.closePath();

      const bg = ctx.createLinearGradient(0, -s * 0.25, 0, s * 0.25);
      bg.addColorStop(0, f.pal.body);
      bg.addColorStop(0.65, f.pal.body);
      bg.addColorStop(1, f.pal.belly);
      ctx.fillStyle = bg;
      ctx.fill();

      // Spot markings for big fish (Koi pattern)
      if (f.isBig && f.pal.spots) {
        ctx.save();
        ctx.fillStyle = f.pal.spots;
        ctx.beginPath();
        ctx.ellipse(s * 0.15, -s * 0.08, s * 0.13, s * 0.07, -0.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.ellipse(-s * 0.1, -s * 0.09, s * 0.14, s * 0.08, 0.15, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.ellipse(-s * 0.28, -s * 0.04, s * 0.08, s * 0.05, -0.1, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      // 3. DORSAL FIN (On Back)
      ctx.beginPath();
      ctx.moveTo(-s * 0.18, -s * 0.18);
      ctx.quadraticCurveTo(0, -s * 0.42, s * 0.18, -s * 0.16);
      ctx.quadraticCurveTo(0, -s * 0.22, -s * 0.18, -s * 0.18);
      ctx.fillStyle = f.pal.fin;
      ctx.fill();

      // 4. PECTORAL FIN (Fluttering with swim rhythm)
      const pecAngle = Math.sin(t * f.wSpd * 1.3 + f.wPh) * 0.22;
      ctx.save();
      ctx.translate(s * 0.22, s * 0.06);
      ctx.rotate(0.3 + pecAngle);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.quadraticCurveTo(s * 0.08, s * 0.18, -s * 0.16, s * 0.22);
      ctx.quadraticCurveTo(-s * 0.08, s * 0.08, 0, 0);
      ctx.fillStyle = f.pal.fin;
      ctx.globalAlpha = 0.88;
      ctx.fill();
      ctx.restore();

      // 5. GILL COVER CURVE (Operculum)
      ctx.beginPath();
      ctx.arc(s * 0.18, 0, s * 0.16, -Math.PI * 0.42, Math.PI * 0.42);
      ctx.strokeStyle = 'rgba(0,0,0,0.22)';
      ctx.lineWidth = Math.max(1, s * 0.015);
      ctx.stroke();

      // 6. EYE (Realistic with bright catchlight)
      const eyeR = Math.max(2, s * 0.052);
      const eyeX = s * 0.36;
      const eyeY = -s * 0.06;
      ctx.beginPath();
      ctx.arc(eyeX, eyeY, eyeR, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(eyeX + eyeR * 0.15, eyeY, eyeR * 0.65, 0, Math.PI * 2);
      ctx.fillStyle = '#0f172a';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(eyeX + eyeR * 0.35, eyeY - eyeR * 0.25, eyeR * 0.28, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();

      // 7. BARBEL / WHISKERS (For Big Majestic Koi)
      if (f.isBig) {
        ctx.beginPath();
        ctx.moveTo(s * 0.5, s * 0.02);
        ctx.quadraticCurveTo(s * 0.57, s * 0.08 + wig * 2, s * 0.53, s * 0.15);
        ctx.strokeStyle = f.pal.fin;
        ctx.lineWidth = 1.6;
        ctx.stroke();
      }

      // 8. SCALE IRIDESCENT SHEEN
      ctx.beginPath();
      ctx.ellipse(s * 0.05, -s * 0.06, s * 0.24, s * 0.06, -0.08, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.32)';
      ctx.fill();

      ctx.restore();
    }
  }

  wave(baseY, freq, speed, t, amp, fill, foam = false) {
    const ctx = this.ctx, w = this.width, h = this.height;
    ctx.save(); ctx.beginPath(); ctx.moveTo(0, h);
    const step = 10;
    for (let x = 0; x <= w + step; x += step) {
      const y = baseY + Math.sin(x * freq + t * speed) * amp + Math.cos(x * freq * 1.8 - t * 1.5) * (amp * 0.4);
      ctx.lineTo(x, y);
    }
    ctx.lineTo(w, h); ctx.closePath();
    ctx.fillStyle = fill; ctx.fill();
    if (foam) {
      ctx.beginPath();
      for (let x = 0; x <= w + step; x += step) {
        const y = baseY + Math.sin(x * freq + t * speed) * amp + Math.cos(x * freq * 1.8 - t * 1.5) * (amp * 0.4);
        if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.lineWidth = 2.5; ctx.strokeStyle = '#f0f9ff'; ctx.stroke();
    }
    ctx.restore();
  }

  // =========================================================================
  // TRANSITION 2: RIVER ➔ FOREST (Pine Trees + Soaring Flocks of Birds)
  // Simple flat GEOMETRIC PINE TREES (triangular layered) + Flocks of Birds
  // ZERO LAG — ultra-lightweight pure vector fills.
  // =========================================================================
  treesAbsorbToForest(onMidpoint, onComplete) {
    if (this.isAnimating) return;
    this.isAnimating = true;
    this.initAudio();
    this.playForestAudio();

    this.canvas.style.display = 'block';
    this.canvas.style.opacity = '1';

    const overlay = document.getElementById('transition-ambient-overlay');
    if (overlay) overlay.className = 'transition-ambient-overlay active-forest';

    // 1. Pre-generate simple flat pine trees
    this.initPineTrees();

    // 2. Pre-generate soaring flocks of birds
    this.initBirds();

    const dur = 1850; // Snappy and smooth
    const t0 = performance.now();
    let mid = false;

    const loop = (now) => {
      const el = now - t0;
      const p = Math.min(el / dur, 1);
      const t = el / 1000;
      this.ctx.clearRect(0, 0, this.width, this.height);

      let growth = 0, dissolve = 0;
      if (p < 0.45) {
        const e = p / 0.45;
        growth = Math.min(1, e * e * (3 - 2*e) * 1.1);
      } else if (p <= 0.55) {
        growth = 1;
      } else {
        growth = 1;
        const e = (p - 0.55) / 0.45;
        dissolve = e * e * (3 - 2*e);
      }

      if (p >= 0.48 && !mid) { mid = true; if (onMidpoint) onMidpoint(); }

      // 1. Forest green sky & ground background
      this.drawForestGround(growth, dissolve);

      // 2. Flat geometric pine trees rising from bottom
      this.drawPineTrees(growth, dissolve);

      // 3. Flocks of BIRDS soaring across the canopy and sky
      this.drawBirds(growth, dissolve, t);

      // 4. Floating leaf particles during dissolve
      this.drawLeafParticles(p, dissolve, t);

      if (p < 1) {
        this.animId = requestAnimationFrame(loop);
      } else {
        this.finish(onComplete);
      }
    };
    this.animId = requestAnimationFrame(loop);
  }

  initPineTrees() {
    this.pineTrees = [];
    const w = this.width;

    const count = 28;
    for (let i = 0; i < count; i++) {
      const layer = i % 3; // 0=back, 1=mid, 2=fore
      const x = (i / count) * (w + 200) - 100 + (Math.random() - 0.5) * (w / count) * 0.6;

      let treeH, trunkW, trunkH;
      if (layer === 0) {
        treeH = 180 + Math.random() * 100;
        trunkW = 10 + Math.random() * 4;
        trunkH = 22 + Math.random() * 8;
      } else if (layer === 1) {
        treeH = 240 + Math.random() * 130;
        trunkW = 13 + Math.random() * 5;
        trunkH = 28 + Math.random() * 10;
      } else {
        treeH = 320 + Math.random() * 180;
        trunkW = 16 + Math.random() * 8;
        trunkH = 35 + Math.random() * 14;
      }

      const baseW = treeH * (0.55 + Math.random() * 0.15);

      const greens = [
        { dark: '#2d6a1e', mid: '#4a8c3f', light: '#6aad5a' },
        { dark: '#1e6630', mid: '#3a8a50', light: '#5aaa6a' },
        { dark: '#3a7a2a', mid: '#5a9a4a', light: '#7aba6a' },
        { dark: '#2a7035', mid: '#4a9055', light: '#6ab075' },
        { dark: '#357a25', mid: '#559a45', light: '#75ba65' },
      ];
      const col = greens[i % greens.length];

      this.pineTrees.push({
        x, layer, treeH, baseW, trunkW, trunkH,
        col,
        trunkColor: '#6b4423',
        delay: layer * 0.06 + Math.random() * 0.08
      });
    }

    this.pineTrees.sort((a, b) => a.layer - b.layer);
  }

  // =========================================================================
  // BIRDS FLOCK SYSTEM (River ➔ Forest)
  // =========================================================================
  initBirds() {
    this.birds = [];
    const w = this.width, h = this.height;

    // Vibrant high-contrast forest bird species
    const birdColors = [
      // Golden Hawk / Eagle (Warm radiant amber & gold)
      { body: '#d97706', farWing: '#b45309', nearWing: '#fbbf24' },
      // Silver Crane / White Swift (Crisp high-contrast white & silver)
      { body: '#f1f5f9', farWing: '#cbd5e1', nearWing: '#ffffff' },
      // Azure Mountain Bluebird / Kingfisher (Vibrant electric blue)
      { body: '#0284c7', farWing: '#0369a1', nearWing: '#38bdf8' },
      // Fiery Crimson Cardinal (Ruby & coral)
      { body: '#e11d48', farWing: '#be123c', nearWing: '#fb7185' },
      // Sleek Dark Forest Falcon (Deep midnight silhouette)
      { body: '#0f172a', farWing: '#020617', nearWing: '#334155' },
    ];

    // Group A: High Soaring Flock (6-7 birds flying across upper sky in loose V formation)
    const flockCount = 7;
    const vApexX = w * 0.25;
    const vApexY = h * 0.14;
    for (let i = 0; i < flockCount; i++) {
      const side = (i % 2 === 0) ? 1 : -1;
      const rank = Math.floor((i + 1) / 2);
      const bx = vApexX - rank * 42 + (Math.random() - 0.5) * 15;
      const by = vApexY + side * rank * 24 + (Math.random() - 0.5) * 12;

      this.birds.push({
        x: bx,
        y: by,
        baseY: by,
        vx: 6.2 + Math.random() * 1.5,
        vy: -0.4 + Math.random() * 0.6,
        dir: 1,
        ws: 28 + Math.random() * 12, // wingspan
        flapSpd: 11 + Math.random() * 3,
        flapPhase: i * 0.6,
        isGliding: false,
        colors: birdColors[i % birdColors.length],
        alpha: 0.88
      });
    }

    // Group B: Foreground Majestic Soaring Birds (3 large birds swooping across upper-mid screen)
    const bigBirds = [
      { x: -60, y: h * 0.26, vx: 7.5, vy: -1.0, ws: 68, flapSpd: 7.5, colorIdx: 0 },
      { x: w * 0.35, y: h * 0.20, vx: 6.8, vy: 0.3, ws: 58, flapSpd: 8.2, colorIdx: 1 },
      { x: -140, y: h * 0.38, vx: 8.2, vy: -1.2, ws: 62, flapSpd: 7.8, colorIdx: 2 }
    ];
    for (const b of bigBirds) {
      this.birds.push({
        x: b.x,
        y: b.y,
        baseY: b.y,
        vx: b.vx,
        vy: b.vy,
        dir: 1,
        ws: b.ws,
        flapSpd: b.flapSpd,
        flapPhase: Math.random() * Math.PI * 2,
        isGliding: false,
        colors: birdColors[b.colorIdx],
        alpha: 0.95
      });
    }

    // Group C: Forest Take-Off Birds (4 birds ascending from the rising tree line into the sky)
    for (let i = 0; i < 4; i++) {
      const bx = w * 0.15 + i * w * 0.22 + (Math.random() - 0.5) * 40;
      const by = h * 0.52 + Math.random() * 50;
      this.birds.push({
        x: bx,
        y: by,
        baseY: by,
        vx: 5.0 + Math.random() * 2.0,
        vy: -4.5 - Math.random() * 2.5, // Ascending upwards into the sky
        dir: 1,
        ws: 34 + Math.random() * 14,
        flapSpd: 13 + Math.random() * 3, // Rapid flapping during take-off
        flapPhase: i * 0.9,
        isGliding: false,
        colors: birdColors[(i + 3) % birdColors.length],
        alpha: 0.92
      });
    }
  }

  drawBirds(growth, dissolve, t) {
    if (growth <= 0.05) return;
    const ctx = this.ctx;
    const alphaFade = Math.min(1, growth * 2.2) * (1 - dissolve * 0.92);
    if (alphaFade <= 0) return;

    for (const b of this.birds) {
      // Advance bird position
      b.x += b.vx;
      b.y += b.vy + Math.sin(t * 2.5 + b.flapPhase) * 0.8;

      ctx.save();
      ctx.translate(b.x, b.y);
      if (b.dir < 0) ctx.scale(-1, 1);

      // Pitch follows trajectory
      const pitch = Math.atan2(b.vy, b.vx) * 0.5;
      ctx.rotate(pitch);

      ctx.globalAlpha = b.alpha * alphaFade;

      const ws = b.ws;
      // Wing flapping cycle
      const flap = Math.sin(t * b.flapSpd + b.flapPhase);
      const wingRot = flap * 0.65;

      // 1. Bird Body & Tail (Aerodynamic profile)
      ctx.fillStyle = b.colors.body;
      ctx.beginPath();
      // Beak tip
      ctx.moveTo(ws * 0.44, 0);
      // Head crown to back
      ctx.quadraticCurveTo(ws * 0.22, -ws * 0.09, 0, -ws * 0.06);
      // Lower back to tail
      ctx.lineTo(-ws * 0.34, -ws * 0.04);
      // Forked tail feathers
      ctx.lineTo(-ws * 0.54, -ws * 0.12);
      ctx.lineTo(-ws * 0.42, 0);
      ctx.lineTo(-ws * 0.54, ws * 0.12);
      // Tail base to belly
      ctx.lineTo(-ws * 0.34, ws * 0.04);
      // Throat and breast
      ctx.quadraticCurveTo(ws * 0.12, ws * 0.12, ws * 0.34, ws * 0.04);
      ctx.closePath();
      ctx.fill();

      // 2. Far Wing (Background wing)
      ctx.save();
      ctx.translate(-ws * 0.02, -ws * 0.04);
      ctx.rotate(-wingRot);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.quadraticCurveTo(ws * 0.08, -ws * 0.42, ws * 0.02, -ws * 0.88);
      ctx.quadraticCurveTo(-ws * 0.16, -ws * 0.68, -ws * 0.22, 0);
      ctx.closePath();
      ctx.fillStyle = b.colors.farWing;
      ctx.fill();
      ctx.restore();

      // 3. Near Wing (Foreground wing)
      ctx.save();
      ctx.translate(ws * 0.04, 0);
      ctx.rotate(wingRot * 0.96);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.quadraticCurveTo(ws * 0.14, -ws * 0.48, ws * 0.06, -ws * 0.98);
      ctx.quadraticCurveTo(-ws * 0.18, -ws * 0.78, -ws * 0.24, 0);
      ctx.closePath();
      ctx.fillStyle = b.colors.nearWing;
      ctx.fill();
      ctx.restore();

      ctx.restore();
    }
  }

  drawForestGround(growth, dissolve) {
    const ctx = this.ctx, w = this.width, h = this.height;
    if (growth <= 0.02) return;

    const coverH = h * Math.min(growth * 1.4, 1.15);
    const topY = h - coverH;
    const alpha = Math.min(1, growth * 2) * (1 - dissolve * 0.92);
    if (alpha <= 0) return;

    ctx.save();
    ctx.globalAlpha = alpha;

    const g = ctx.createLinearGradient(0, topY, 0, h);
    g.addColorStop(0, '#1a4d1a');
    g.addColorStop(0.4, '#2d6a2d');
    g.addColorStop(0.8, '#1a5c1a');
    g.addColorStop(1, '#0f3d0f');
    ctx.fillStyle = g;
    ctx.fillRect(0, Math.max(0, topY), w, h - Math.max(0, topY));

    ctx.restore();
  }

  drawPineTrees(growth, dissolve) {
    const ctx = this.ctx, w = this.width, h = this.height;
    const alpha = (1 - dissolve * 0.96);
    if (alpha <= 0 || growth <= 0) return;

    ctx.save();
    ctx.globalAlpha = alpha;

    for (const tree of this.pineTrees) {
      const treeGrowth = Math.max(0, Math.min(1, (growth - tree.delay) / (1 - tree.delay)));
      if (treeGrowth <= 0) continue;

      // Curtain parting during dissolve
      const isLeft = tree.x < w * 0.5;
      const partDir = isLeft ? -1 : 1;
      const partOffset = partDir * dissolve * w * 0.48;

      const cx = tree.x + partOffset;
      const baseY = h;
      const visibleH = tree.treeH * treeGrowth;

      // Draw trunk
      const trunkTop = baseY - tree.trunkH * treeGrowth;
      ctx.fillStyle = tree.trunkColor;
      ctx.fillRect(cx - tree.trunkW / 2, trunkTop, tree.trunkW, tree.trunkH * treeGrowth);

      // Draw 3 triangular tiers
      const tierCount = 3;
      const tierH = visibleH / (tierCount + 0.3);

      for (let ti = 0; ti < tierCount; ti++) {
        const tierIdx = tierCount - 1 - ti;
        const widthScale = 0.45 + tierIdx * 0.28;
        const halfW = tree.baseW * widthScale * treeGrowth / 2;

        const tierBottom = baseY - tree.trunkH * treeGrowth - tierIdx * tierH * 0.72;
        const tierTop = tierBottom - tierH;

        let fillColor;
        if (tierIdx === 0) fillColor = tree.col.light;
        else if (tierIdx === 1) fillColor = tree.col.mid;
        else fillColor = tree.col.dark;

        ctx.fillStyle = fillColor;
        ctx.beginPath();
        ctx.moveTo(cx, tierTop);
        ctx.lineTo(cx - halfW, tierBottom);
        ctx.lineTo(cx + halfW, tierBottom);
        ctx.closePath();
        ctx.fill();
      }
    }

    ctx.restore();
  }

  drawLeafParticles(progress, dissolve, t) {
    if (dissolve <= 0.05) return;
    const ctx = this.ctx;

    if (Math.random() < 0.4 && (!this._leaves || this._leaves.length < 22)) {
      if (!this._leaves) this._leaves = [];
      this._leaves.push({
        x: Math.random() * this.width,
        y: Math.random() * this.height * 0.8,
        vx: 3 + Math.random() * 5,
        vy: 0.5 + Math.random() * 2,
        rot: Math.random() * Math.PI * 2,
        spin: (Math.random() - 0.5) * 0.15,
        sz: 6 + Math.random() * 10,
        a: 1,
        col: ['#4a8c3f', '#6aad5a', '#3a8a50', '#559a45', '#7aba6a'][Math.floor(Math.random() * 5)]
      });
    }

    if (this._leaves) {
      for (let i = this._leaves.length - 1; i >= 0; i--) {
        const l = this._leaves[i];
        l.x += l.vx;
        l.y += l.vy + Math.sin(t * 3 + l.sz) * 1.2;
        l.rot += l.spin;
        l.a -= 0.018;
        if (l.a <= 0 || l.x > this.width + 50) { this._leaves.splice(i, 1); continue; }

        ctx.save();
        ctx.translate(l.x, l.y);
        ctx.rotate(l.rot);
        ctx.globalAlpha = l.a;
        ctx.fillStyle = l.col;
        ctx.beginPath();
        ctx.ellipse(0, 0, l.sz, l.sz * 0.4, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }
  }

  renderPreview(mode = 'river', progress = 0.5) {
    this.canvas.style.display = 'block';
    this.canvas.style.opacity = '1';
    this.ctx.clearRect(0, 0, this.width, this.height);
    if (mode === 'river') {
      if (!this.fishes || this.fishes.length === 0) this.initFishes();
      const waterY = this.height * (1 - progress);
      this.drawWater(waterY, 1.2, progress);
    } else {
      if (!this.pineTrees || this.pineTrees.length === 0) this.initPineTrees();
      if (!this.birds || this.birds.length === 0) this.initBirds();
      const growth = Math.min(1, progress * 1.5);
      const dissolve = Math.max(0, (progress - 0.5) * 2);
      this.drawForestGround(growth, dissolve);
      this.drawPineTrees(growth, dissolve);
      this.drawBirds(growth, dissolve, 1.2);
    }
  }

  finish(onComplete) {
    this.canvas.style.opacity = '0';
    this._leaves = [];
    this.birds = [];
    this.fishes = [];
    setTimeout(() => {
      this.canvas.style.display = 'none';
      const overlay = document.getElementById('transition-ambient-overlay');
      if (overlay) overlay.className = 'transition-ambient-overlay';
      this.isAnimating = false;
      if (onComplete) onComplete();
    }, 250);
  }
}

window.NatureWaterTransition = NatureWaterTransition;
