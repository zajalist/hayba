import React, { useEffect, useRef } from 'react';

// Orthographic height field, lit from the northwest and cut along its contour intervals.
export function Terrain() {
  const ref = useRef(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas.getContext('2d');
    const n = 75,
      scale = 2;
    canvas.width = 460 * scale;
    canvas.height = 260 * scale;
    ctx.scale(scale, scale);
    const height = (x, y) => {
      const ridge = (cx, cy, wx, wy, amp) => amp * Math.exp(-((x - cx) ** 2 / wx + (y - cy) ** 2 / wy));
      const dx = x + 0.32 * y;
      const z =
        ridge(-0.17, -0.21, 0.14, 0.31, 1.08) +
        ridge(0.32, -0.04, 0.15, 0.22, 0.83) +
        ridge(-0.52, 0.26, 0.07, 0.22, 0.53);
      const erosion = 0.1 * Math.sin(9 * dx + 3 * Math.sin(5 * y)) + 0.045 * Math.cos(19 * dx - 9 * y);
      return Math.max(0, z * (1 + erosion));
    };
    const project = (x, y, z) => [232 + (x - y) * 96, 153 + (x + y) * 44 - z * 83];
    const face = (points, fill) => {
      ctx.beginPath();
      points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.strokeStyle = fill;
      ctx.lineWidth = 0.44;
      ctx.stroke();
    };
    const point = (x, y) => project(x, y, height(x, y));
    for (let row = 0; row < n; row++)
      for (let col = 0; col < n; col++) {
        const x = -1 + (col * 2) / n,
          y = -1 + (row * 2) / n,
          d = 2 / n;
        const h = height(x + d / 2, y + d / 2);
        const shade = (height(x + d, y) - height(x, y + d)) * 295;
        let l = 72 + h * 5 + shade;
        face(
          [point(x, y), point(x + d, y), point(x + d, y + d), point(x, y + d)],
          'hsl(258,27%,' + Math.max(35, Math.min(89, l)) + '%)',
        );
      }
    // Interpolate contour crossings between adjacent samples so ridges stay continuous.
    const samples = Array.from({ length: n + 1 }, (_, j) =>
      Array.from({ length: n + 1 }, (_, i) => {
        const x = -1 + (i * 2) / n,
          y = -1 + (j * 2) / n;
        return { x, y, z: height(x, y) };
      }),
    );
    ctx.strokeStyle = 'rgba(68,49,96,.47)';
    ctx.lineWidth = 0.64;
    for (let z = 0.043; z < 1.7; z += 0.052) {
      ctx.beginPath();
      for (let j = 0; j < n; j++)
        for (let i = 0; i < n; i++) {
          const cell = [samples[j][i], samples[j][i + 1], samples[j + 1][i + 1], samples[j + 1][i]];
          const cuts = [];
          for (let k = 0; k < 4; k++) {
            const a = cell[k],
              b = cell[(k + 1) % 4];
            if (a.z > z === b.z > z) continue;
            const t = (z - a.z) / (b.z - a.z);
            cuts.push(project(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, z));
          }
          for (let k = 1; k < cuts.length; k += 2) {
            ctx.moveTo(...cuts[k - 1]);
            ctx.lineTo(...cuts[k]);
          }
        }
      ctx.stroke();
    }
    for (const [a, b, color] of [
      [[1, -1], [1, 1], '#9b90ad'],
      [[-1, 1], [1, 1], '#b8aec8'],
    ]) {
      const p = point(...a),
        q = point(...b);
      face([p, q, [q[0], q[1] + 8], [p[0], p[1] + 8]], color);
      ctx.beginPath();
      ctx.moveTo(p[0], p[1] + 4);
      ctx.lineTo(q[0], q[1] + 4);
      ctx.strokeStyle = '#776986';
      ctx.stroke();
    }
  }, []);
  return <canvas ref={ref} className="terrain" aria-hidden="true" />;
}
