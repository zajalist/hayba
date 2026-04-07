/* ════════════════════════════════════════════════════════════
   GAEAMCP — Cinematic Animations
   ════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  /* ─── 3D Isometric Terrain Canvas ─── */
  function initTerrainCanvas(canvasId) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let W, H, animId;

    const mobile = () => window.innerWidth < 640;
    let COLS = mobile() ? 36 : 72;
    let ROWS = mobile() ? 24 : 48;

    let timeX = 0;
    let buildProgress = 0;
    let buildStart = null;

    function resize() {
      W = canvas.width  = canvas.offsetWidth;
      H = canvas.height = canvas.offsetHeight;
      COLS = mobile() ? 36 : 72;
      ROWS = mobile() ? 24 : 48;
    }
    resize();
    window.addEventListener('resize', resize);

    // Multi-octave trig noise — no external lib
    function noise(x, y) {
      return (
        Math.sin(x * 1.2 + y * 0.9)  * 0.38 +
        Math.sin(x * 2.7 - y * 1.6)  * 0.22 +
        Math.sin(x * 5.3 + y * 3.1)  * 0.14 +
        Math.sin(x * 10.7 - y * 7.3) * 0.08 +
        Math.sin(x * 0.4 + y * 0.3)  * 0.18
      );
    }

    function getHeight(col, row) {
      const nx = col / COLS * 5.5 - 2.75 + timeX;
      const ny = row / ROWS * 4.0 - 2.0;
      const rawH = (noise(nx, ny) + 0.85) / 1.7;

      // Radial fade — peaks cluster toward center, flat at edges
      const dx = (col / COLS - 0.48) * 2;
      const dy = (row / ROWS - 0.55) * 2;
      const fade = Math.max(0, 1 - (dx * dx * 0.65 + dy * dy * 0.85));

      return rawH * fade * buildProgress;
    }

    function project(col, row, h) {
      const tileW = W * 2.4 / (COLS + ROWS);
      const tileH = tileW * 0.5;
      const hScale = Math.min(W, H) * 0.3;
      const ox = W * 1.1 - COLS * tileW * 0.5; // right edge at W*1.1
      const oy = H * 0.22;
      return [
        ox + (col - row) * tileW * 0.5,
        oy + (col + row) * tileH * 0.5 - h * hScale
      ];
    }

    function heightColor(h) {
      const t = Math.max(0, Math.min(1, h));
      let r, g, b, a;
      if (t < 0.15) {
        r = 8;  g = 5;  b = 3;  a = 0.08 + t * 0.4;
      } else if (t < 0.42) {
        const p = (t - 0.15) / 0.27;
        r = Math.round(8  + p * 88);  g = Math.round(5 + p * 22);  b = 3;
        a = 0.18 + p * 0.42;
      } else if (t < 0.72) {
        const p = (t - 0.42) / 0.30;
        r = Math.round(96  + p * 159); g = Math.round(27 + p * 80); b = 3;
        a = 0.60 + p * 0.30;
      } else {
        const p = (t - 0.72) / 0.28;
        r = 255; g = Math.round(107 + p * 60); b = Math.round(3 + p * 48);
        a = 0.9 + p * 0.1;
      }
      return `rgba(${r},${g},${b},${a})`;
    }

    function draw(ts) {
      if (!buildStart) buildStart = ts;
      const elapsed = ts - buildStart;
      const raw = Math.min(1, elapsed / 2800);
      // Ease in-out cubic
      buildProgress = raw < 0.5 ? 4 * raw * raw * raw : 1 - Math.pow(-2 * raw + 2, 3) / 2;
      if (raw >= 1) timeX += 0.00025; // very slow drift once built

      ctx.clearRect(0, 0, W, H);

      // Precompute heights
      const C1 = COLS + 1, R1 = ROWS + 1;
      const hArr = new Float32Array(C1 * R1);
      for (let j = 0; j < R1; j++)
        for (let i = 0; i < C1; i++)
          hArr[j * C1 + i] = getHeight(i, j);

      // Precompute projected points
      const px = new Float32Array(C1 * R1);
      const py = new Float32Array(C1 * R1);
      for (let j = 0; j < R1; j++) {
        for (let i = 0; i < C1; i++) {
          const [sx, sy] = project(i, j, hArr[j * C1 + i]);
          px[j * C1 + i] = sx;
          py[j * C1 + i] = sy;
        }
      }

      // Draw quads back-to-front (row 0 = far back)
      for (let j = 0; j < ROWS; j++) {
        for (let i = 0; i < COLS; i++) {
          const i00 = j * C1 + i, i10 = j * C1 + i + 1;
          const i01 = (j+1) * C1 + i, i11 = (j+1) * C1 + i + 1;

          const avgH = (hArr[i00] + hArr[i10] + hArr[i01] + hArr[i11]) * 0.25;
          if (avgH < 0.012) continue;

          const x00 = px[i00], y00 = py[i00];
          const x10 = px[i10], y10 = py[i10];
          const x11 = px[i11], y11 = py[i11];
          const x01 = px[i01], y01 = py[i01];

          // Frustum cull
          if (Math.max(x00,x10,x11,x01) < -20 || Math.min(x00,x10,x11,x01) > W + 20) continue;
          if (Math.max(y00,y10,y11,y01) < -20) continue;

          ctx.strokeStyle = heightColor(avgH);
          ctx.lineWidth = avgH > 0.65 ? 0.75 : 0.38;

          ctx.beginPath();
          ctx.moveTo(x00, y00);
          ctx.lineTo(x10, y10);
          ctx.lineTo(x11, y11);
          ctx.lineTo(x01, y01);
          ctx.closePath();
          ctx.stroke();

          // Subtle fill for high peaks only
          if (avgH > 0.58) {
            const p = (avgH - 0.58) / 0.42;
            ctx.fillStyle = `rgba(255,107,53,${p * 0.05})`;
            ctx.fill();
          }
        }
      }

      animId = requestAnimationFrame(draw);
    }

    animId = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(animId); window.removeEventListener('resize', resize); };
  }

  initTerrainCanvas('terrainCanvas');
  initTerrainCanvas('ctaCanvas');

  /* ─── Floating Particles ─── */
  function initParticles(canvasId) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let W, H, animId;

    const COUNT = 55;
    const particles = Array.from({ length: COUNT }, (_, i) => ({
      x: Math.random(),
      y: Math.random(),
      r: 0.6 + Math.random() * 1.8,
      vx: (Math.random() - 0.5) * 0.00012,
      vy: (Math.random() - 0.5) * 0.00009 - 0.00004,
      alpha: 0.08 + Math.random() * 0.22,
      orange: Math.random() < 0.35,
      phase: Math.random() * Math.PI * 2,
    }));

    function resize() {
      W = canvas.width  = canvas.offsetWidth;
      H = canvas.height = canvas.offsetHeight;
    }
    resize();
    window.addEventListener('resize', resize);

    function tick(t) {
      ctx.clearRect(0, 0, W, H);
      for (const p of particles) {
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < 0) p.x = 1;
        if (p.x > 1) p.x = 0;
        if (p.y < 0) p.y = 1;
        if (p.y > 1) p.y = 0;
        const pulse = 0.6 + 0.4 * Math.sin(t * 0.0008 + p.phase);
        const a = p.alpha * pulse;
        ctx.beginPath();
        ctx.arc(p.x * W, p.y * H, p.r, 0, Math.PI * 2);
        ctx.fillStyle = p.orange
          ? `rgba(255,107,53,${a})`
          : `rgba(255,255,255,${a * 0.5})`;
        ctx.fill();
      }
      animId = requestAnimationFrame(tick);
    }
    animId = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(animId); window.removeEventListener('resize', resize); };
  }

  initParticles('particlesCanvas');

  /* ─── Nav hide/show on scroll ─── */
  const nav = document.getElementById('mainNav');
  let lastY = 0;
  window.addEventListener('scroll', () => {
    const y = window.scrollY;
    if (y > lastY && y > 100) nav.classList.add('hide');
    else nav.classList.remove('hide');
    lastY = y;
  }, { passive: true });

  /* ─── Counter animation ─── */
  function animateCounter(el) {
    const target = parseInt(el.dataset.target, 10);
    if (isNaN(target)) return;
    const duration = 1200;
    const start = performance.now();
    function step(now) {
      const p = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - p, 3);
      el.textContent = Math.round(eased * target);
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  // Trigger counters when hero is visible
  const counters = document.querySelectorAll('[data-target]');
  const counterObs = new IntersectionObserver((entries) => {
    entries.forEach(e => {
      if (e.isIntersecting) {
        animateCounter(e.target);
        counterObs.unobserve(e.target);
      }
    });
  }, { threshold: 0.5 });
  counters.forEach(c => counterObs.observe(c));

  /* ─── Scroll reveal ─── */
  const reveals = document.querySelectorAll('[data-reveal]');
  const revealObs = new IntersectionObserver((entries) => {
    entries.forEach((e, i) => {
      if (e.isIntersecting) {
        // Stagger siblings
        const siblings = [...e.target.parentElement.querySelectorAll('[data-reveal]')];
        const idx = siblings.indexOf(e.target);
        setTimeout(() => e.target.classList.add('revealed'), idx * 80);
        revealObs.unobserve(e.target);
      }
    });
  }, { threshold: 0.1, rootMargin: '0px 0px -40px 0px' });
  reveals.forEach(r => revealObs.observe(r));

  /* ─── Platform tabs ─── */
  document.querySelectorAll('.platform-tabs').forEach(tabGroup => {
    tabGroup.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        const tabName = tab.dataset.tab;
        const body = tab.closest('.setup-step-body');
        tabGroup.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        body.querySelectorAll('.tab-content').forEach(c => {
          c.classList.remove('active');
          c.style.display = 'none';
        });
        const target = body.querySelector('#' + tabName + '-content');
        if (target) { target.classList.add('active'); target.style.display = 'block'; }
      });
    });
  });

  /* ─── Pipeline node hover ripple ─── */
  document.querySelectorAll('.pipeline-node').forEach(node => {
    node.addEventListener('mouseenter', () => {
      // Speed up pulse on hovered connector
      const idx = node.dataset.node;
      document.querySelectorAll('.pipeline-pulse').forEach((p, i) => {
        if (i >= parseInt(idx)) {
          p.style.animationDuration = '0.8s';
        }
      });
    });
    node.addEventListener('mouseleave', () => {
      document.querySelectorAll('.pipeline-pulse').forEach((p, i) => {
        p.style.animationDuration = '2s';
      });
    });
  });

  /* ─── THOUGHT. letter-by-letter scramble reveal ─── */
  (function () {
    const accentLine = document.querySelector('.accent-line');
    if (!accentLine) return;

    const finalText = accentLine.textContent.trim(); // "THOUGHT."
    const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#@!';
    const SCRAMBLE_ROUNDS = 6;   // how many fake chars per letter before locking
    const LETTER_STAGGER = 55;   // ms between each letter starting
    const ROUND_SPEED   = 40;    // ms per scramble frame

    // Replace text with individual <span> per letter
    accentLine.textContent = '';
    accentLine.style.opacity = '1'; // override the CSS animation — JS handles it now
    accentLine.style.transform = 'none';
    accentLine.style.animation = 'accent-pulse 3s ease-in-out 2s infinite';

    const spans = finalText.split('').map(char => {
      const s = document.createElement('span');
      s.textContent = char === ' ' ? '\u00A0' : '\u00A0'; // invisible placeholder
      s.style.cssText = `
        display:inline-block;
        opacity:0;
        color:var(--orange);
        transition:color 0.15s;
      `;
      accentLine.appendChild(s);
      return { el: s, final: char };
    });

    const DELAY_BEFORE_START = 650; // ms after page load before starting

    function revealLetter(span, finalChar, done) {
      let round = 0;
      span.el.style.opacity = '1';
      const iv = setInterval(() => {
        if (round >= SCRAMBLE_ROUNDS) {
          clearInterval(iv);
          span.el.textContent = finalChar;
          span.el.style.color = 'var(--orange)';
          span.el.style.textShadow = '0 0 20px rgba(255,107,53,0.8)';
          // fade the glow away
          setTimeout(() => { span.el.style.textShadow = ''; }, 300);
          if (done) done();
          return;
        }
        span.el.textContent = finalChar === '.' ? '.'
          : CHARS[Math.floor(Math.random() * CHARS.length)];
        span.el.style.color = round < SCRAMBLE_ROUNDS / 2
          ? '#fff'
          : 'var(--orange)';
        round++;
      }, ROUND_SPEED);
    }

    setTimeout(() => {
      spans.forEach((span, i) => {
        if (span.final === ' ') { span.el.textContent = ' '; span.el.style.opacity = '1'; return; }
        setTimeout(() => revealLetter(span, span.final), i * LETTER_STAGGER);
      });
    }, DELAY_BEFORE_START);
  })();

  /* ─── Cursor glow effect on hero ─── */
  const heroSection = document.querySelector('.hero');
  if (heroSection) {
    let glowEl = null;
    heroSection.addEventListener('mousemove', (e) => {
      if (!glowEl) {
        glowEl = document.createElement('div');
        glowEl.style.cssText = `
          position:absolute;pointer-events:none;z-index:3;
          width:300px;height:300px;border-radius:50%;
          background:radial-gradient(circle,rgba(255,107,53,0.06) 0%,transparent 70%);
          transform:translate(-50%,-50%);
          transition:left 0.1s ease,top 0.1s ease;
        `;
        heroSection.appendChild(glowEl);
      }
      const rect = heroSection.getBoundingClientRect();
      glowEl.style.left = (e.clientX - rect.left) + 'px';
      glowEl.style.top  = (e.clientY - rect.top)  + 'px';
    });
  }

  /* ─── Feature cards stagger on load ─── */
  document.querySelectorAll('.feature').forEach((el, i) => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(16px)';
    el.style.transition = `opacity 0.5s ease ${i * 0.1 + 0.3}s, transform 0.5s ease ${i * 0.1 + 0.3}s`;
    requestAnimationFrame(() => {
      el.style.opacity = '1';
      el.style.transform = 'translateY(0)';
    });
  });

  /* ─── Glitch effect on heading hover ─── */
  const heroTitle = document.querySelector('.hero-title');
  if (heroTitle) {
    const accentLine = heroTitle.querySelector('.accent-line');
    if (accentLine) {
      heroTitle.addEventListener('mouseenter', () => {
        accentLine.style.animation = 'accent-pulse 0.3s ease-in-out infinite, glitch 0.4s step-end';
      });
      heroTitle.addEventListener('mouseleave', () => {
        accentLine.style.animation = 'accent-pulse 3s ease-in-out infinite';
      });
    }
  }

  /* ─── Tool rows scan effect ─── */
  document.querySelectorAll('.tool-row').forEach(row => {
    row.addEventListener('mouseenter', () => {
      row.style.transition = 'background 0.1s';
    });
  });

})();
