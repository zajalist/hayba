/* ════════════════════════════════════════════════════════════
   GAEAMCP — Cinematic Animations
   ════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  /* ─── Terrain Canvas ─── */
  function initTerrainCanvas(canvasId) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let W, H, animId;
    let t = 0;

    function resize() {
      W = canvas.width  = canvas.offsetWidth;
      H = canvas.height = canvas.offsetHeight;
    }
    resize();
    window.addEventListener('resize', resize);

    // Simplex-style noise using trig harmonics (no external lib needed)
    function noise(x, y, z) {
      return (
        Math.sin(x * 1.3 + z)       * 0.35 +
        Math.sin(y * 0.9 - z * 0.7) * 0.25 +
        Math.sin((x + y) * 0.6 + z * 1.2) * 0.20 +
        Math.sin(x * 2.1 - y * 1.7 + z * 0.5) * 0.12 +
        Math.sin(x * 3.4 + y * 2.8 - z * 1.1) * 0.08
      );
    }

    // Contour lines
    function drawContours() {
      const COLS = 120, ROWS = 68;
      const cw = W / COLS, ch = H / ROWS;
      const levels = 18;

      ctx.clearRect(0, 0, W, H);

      // Build height field
      const field = new Float32Array((COLS + 1) * (ROWS + 1));
      for (let j = 0; j <= ROWS; j++) {
        for (let i = 0; i <= COLS; i++) {
          const nx = (i / COLS) * 4 - 2;
          const ny = (j / ROWS) * 3 - 1.5;
          field[j * (COLS + 1) + i] = noise(nx, ny, t * 0.18);
        }
      }

      // Draw contour lines via marching squares (simplified)
      for (let lev = 0; lev < levels; lev++) {
        const threshold = -0.9 + (lev / levels) * 1.8;
        const progress = (threshold + 0.9) / 1.8; // 0..1

        // Bright orange for peaks, dim for valleys
        const peakness = Math.max(0, (threshold - 0.1) / 0.8);
        const alpha = 0.04 + peakness * 0.18;
        const r = Math.round(30 + peakness * 225);
        const g = Math.round(5  + peakness * 100);
        const b = Math.round(0  + peakness * 45);
        ctx.strokeStyle = `rgba(${r},${g},${b},${alpha})`;
        ctx.lineWidth = 0.5 + peakness * 0.8;

        ctx.beginPath();
        for (let j = 0; j < ROWS; j++) {
          for (let i = 0; i < COLS; i++) {
            const v00 = field[j * (COLS+1) + i];
            const v10 = field[j * (COLS+1) + i+1];
            const v01 = field[(j+1)*(COLS+1) + i];
            const v11 = field[(j+1)*(COLS+1) + i+1];
            const x = i * cw, y = j * ch;

            // Interpolate edge crossings
            function lerp(a, b, v) { return (v - a) / (b - a); }
            const c00 = v00 >= threshold ? 8 : 0;
            const c10 = v10 >= threshold ? 4 : 0;
            const c11 = v11 >= threshold ? 2 : 0;
            const c01 = v01 >= threshold ? 1 : 0;
            const msCase = c00 | c10 | c11 | c01;
            if (msCase === 0 || msCase === 15) continue;

            const e0x = x + lerp(v00, v10, threshold) * cw, e0y = y;
            const e1x = x + cw, e1y = y + lerp(v10, v11, threshold) * ch;
            const e2x = x + lerp(v01, v11, threshold) * cw, e2y = y + ch;
            const e3x = x, e3y = y + lerp(v00, v01, threshold) * ch;

            switch (msCase) {
              case 1:case 14: ctx.moveTo(e2x,e2y); ctx.lineTo(e3x,e3y); break;
              case 2:case 13: ctx.moveTo(e1x,e1y); ctx.lineTo(e2x,e2y); break;
              case 3:case 12: ctx.moveTo(e1x,e1y); ctx.lineTo(e3x,e3y); break;
              case 4:case 11: ctx.moveTo(e0x,e0y); ctx.lineTo(e1x,e1y); break;
              case 6:case 9:  ctx.moveTo(e0x,e0y); ctx.lineTo(e2x,e2y); break;
              case 7:case 8:  ctx.moveTo(e0x,e0y); ctx.lineTo(e3x,e3y); break;
              case 5:
                ctx.moveTo(e0x,e0y); ctx.lineTo(e1x,e1y);
                ctx.moveTo(e2x,e2y); ctx.lineTo(e3x,e3y); break;
              case 10:
                ctx.moveTo(e0x,e0y); ctx.lineTo(e3x,e3y);
                ctx.moveTo(e1x,e1y); ctx.lineTo(e2x,e2y); break;
            }
          }
        }
        ctx.stroke();
      }

      // Hotspot particles — glowing orange dots at terrain peaks
      const dots = 60;
      for (let d = 0; d < dots; d++) {
        const px = (Math.sin(d * 2.399) * 0.5 + 0.5);
        const py = (Math.cos(d * 1.618 + 0.3) * 0.5 + 0.5);
        const nx = (px * 4 - 2), ny = (py * 3 - 1.5);
        const h = noise(nx, ny, t * 0.18);
        if (h < 0.3) continue;
        const sx = px * W, sy = py * H;
        const alpha = (h - 0.3) / 0.7 * 0.6;
        const r2 = 1.5 + h * 2;
        const grad = ctx.createRadialGradient(sx, sy, 0, sx, sy, r2 * 4);
        grad.addColorStop(0, `rgba(255,107,53,${alpha * 0.9})`);
        grad.addColorStop(1, 'rgba(255,107,53,0)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(sx, sy, r2 * 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    function tick() {
      t += 0.016;
      drawContours();
      animId = requestAnimationFrame(tick);
    }
    tick();

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
        accentLine.style.animation = 'line-in 0.7s var(--ease-out) 0.54s both, accent-pulse 3s ease-in-out 1.5s infinite';
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
