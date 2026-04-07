import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { Project, Zone } from '../../types';
import { api } from '../../api';
import { paintStroke, eraseStroke, canvasToBase64, createMaskCanvas } from '../../canvas/brushEngine';
import './ZonePainter.css';

type Tool = 'paint' | 'erase';
const CANVAS_SIZE = 1024;
const ZONE_COLORS = ['#3a6e3a', '#6e5a2a', '#3a4a6e', '#6e3a3a', '#5a6e3a', '#6e3a6e'];

function generateId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function ZonePainter({ project }: { project: Project }) {
  const displayRef = useRef<HTMLCanvasElement>(null);
  const [zones, setZones] = useState<Zone[]>([]);
  const [activeZoneId, setActiveZoneId] = useState<string | null>(null);
  const [maskCanvases, setMaskCanvases] = useState<Map<string, HTMLCanvasElement>>(new Map());
  const [tool, setTool] = useState<Tool>('paint');
  const [brushRadius, setBrushRadius] = useState(40);
  const [brushStrength, setBrushStrength] = useState(0.8);
  const [brushFalloff, setBrushFalloff] = useState(0.55);
  const [phase, setPhase] = useState<'a' | 'b'>('a');
  const [heightmapImg, setHeightmapImg] = useState<HTMLImageElement | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const isPainting = useRef(false);

  // Load heightmap for phase B
  useEffect(() => {
    if (phase === 'b') {
      api.zones.getHeightmap(project.id).then(({ heightmapPath }) => {
        if (heightmapPath) {
          const img = new Image();
          img.src = `/api/heightmap-proxy?path=${encodeURIComponent(heightmapPath)}`;
          img.onload = () => setHeightmapImg(img);
        }
      });
    }
  }, [phase, project.id]);

  // Redraw display canvas whenever zones/masks change
  const redraw = useCallback(() => {
    const canvas = displayRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

    // Background: heightmap or dark grid
    if (phase === 'b' && heightmapImg) {
      ctx.drawImage(heightmapImg, 0, 0, CANVAS_SIZE, CANVAS_SIZE);
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
    }

    // Draw each visible zone mask in its color
    zones.forEach(zone => {
      if (!zone.visible) return;
      const maskCanvas = maskCanvases.get(zone.id);
      if (!maskCanvas) return;
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 0.6;
      // Tint the mask with zone color
      const tmp = document.createElement('canvas');
      tmp.width = CANVAS_SIZE; tmp.height = CANVAS_SIZE;
      const tCtx = tmp.getContext('2d')!;
      tCtx.drawImage(maskCanvas, 0, 0);
      tCtx.globalCompositeOperation = 'source-in';
      tCtx.fillStyle = zone.color;
      tCtx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
      ctx.drawImage(tmp, 0, 0);
    });
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }, [zones, maskCanvases, phase, heightmapImg]);

  useEffect(() => { redraw(); }, [redraw]);

  const getCanvasPos = (e: React.MouseEvent<HTMLCanvasElement>): { x: number; y: number } => {
    const rect = displayRef.current!.getBoundingClientRect();
    const scaleX = CANVAS_SIZE / rect.width;
    const scaleY = CANVAS_SIZE / rect.height;
    return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY };
  };

  const paint = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isPainting.current || !activeZoneId) return;
    const maskCanvas = maskCanvases.get(activeZoneId);
    if (!maskCanvas) return;
    const ctx = maskCanvas.getContext('2d')!;
    const pos = getCanvasPos(e);
    if (tool === 'paint') {
      paintStroke(ctx, pos.x, pos.y, { radius: brushRadius, strength: brushStrength, falloff: brushFalloff });
    } else {
      eraseStroke(ctx, pos.x, pos.y, { radius: brushRadius, strength: brushStrength, falloff: brushFalloff });
    }
    redraw();
  };

  const addZone = () => {
    const id = generateId();
    const color = ZONE_COLORS[zones.length % ZONE_COLORS.length];
    const zone: Zone = { id, name: `Zone ${zones.length + 1}`, color, type: 'placement', placementCategory: 'foliage', maskPath: '', visible: true };
    const mask = createMaskCanvas(CANVAS_SIZE);
    setMaskCanvases(prev => new Map(prev).set(id, mask));
    setZones(prev => [...prev, zone]);
    setActiveZoneId(id);
  };

  const handleSubmit = async () => {
    if (zones.length === 0) return;
    setSubmitting(true);
    const masks = zones.map(z => ({
      zoneId: z.id,
      pngBase64: canvasToBase64(maskCanvases.get(z.id)!),
    }));
    await api.zones.submit({ projectId: project.id, zones, masks, canvasSize: CANVAS_SIZE, phase });
    setSubmitting(false);
    alert('Zones submitted! Claude can now read them.');
  };

  const TOOLS: { id: Tool; label: string; icon: string }[] = [
    { id: 'paint', label: 'Paint', icon: '✏' },
    { id: 'erase', label: 'Erase', icon: '⬜' },
  ];

  return (
    <div className="zone-painter">
      {/* Left toolbar */}
      <div className="zp-toolbar">
        {TOOLS.map(t => (
          <button key={t.id} className={`zp-tool-btn ${tool === t.id ? 'active' : ''}`} onClick={() => setTool(t.id)} title={t.label}>
            {t.icon}
          </button>
        ))}
        <div className="zp-tool-sep" />
        <button className="zp-tool-btn" title="Undo (Ctrl+Z)">↩</button>
      </div>

      {/* Canvas area */}
      <div className="zp-canvas-area">
        <div className="zp-canvas-toolbar">
          <div className="zp-slider-group">
            <span className="muted uppercase">Size</span>
            <input type="range" className="slider" min={4} max={200} value={brushRadius} onChange={e => setBrushRadius(+e.target.value)} />
            <span className="mono muted">{brushRadius}</span>
          </div>
          <div className="zp-canvas-sep" />
          <div className="zp-slider-group">
            <span className="muted uppercase">Strength</span>
            <input type="range" className="slider" min={1} max={100} value={Math.round(brushStrength * 100)} onChange={e => setBrushStrength(+e.target.value / 100)} />
            <span className="mono muted">{Math.round(brushStrength * 100)}%</span>
          </div>
          <div className="zp-canvas-sep" />
          <div className="zp-slider-group">
            <span className="muted uppercase">Active</span>
            {activeZoneId && zones.find(z => z.id === activeZoneId) && (
              <>
                <div className="zp-swatch" style={{ background: zones.find(z => z.id === activeZoneId)!.color }} />
                <span>{zones.find(z => z.id === activeZoneId)!.name}</span>
              </>
            )}
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
            <button className={`zp-phase-btn ${phase === 'a' ? 'active' : ''}`} onClick={() => setPhase('a')}>A · Blockout</button>
            <button className={`zp-phase-btn ${phase === 'b' ? 'active' : ''}`} onClick={() => setPhase('b')}>B · Heightmap</button>
          </div>
        </div>

        <div className="zp-viewport">
          <canvas
            ref={displayRef}
            width={CANVAS_SIZE}
            height={CANVAS_SIZE}
            className="zp-canvas"
            style={{ cursor: tool === 'erase' ? 'crosshair' : 'crosshair' }}
            onMouseDown={() => { isPainting.current = true; }}
            onMouseUp={() => { isPainting.current = false; }}
            onMouseLeave={() => { isPainting.current = false; }}
            onMouseMove={paint}
          />
        </div>
      </div>

      {/* Right panel */}
      <div className="zp-right">
        <div className="zp-panel-header uppercase muted">Zones <span className="muted">({zones.length})</span></div>
        <div className="zp-zone-list">
          {zones.map(z => (
            <div key={z.id} className={`zp-zone-item ${activeZoneId === z.id ? 'active' : ''}`} onClick={() => setActiveZoneId(z.id)}>
              <div className="zp-zone-swatch" style={{ background: z.color }} />
              <span className="zp-zone-name">{z.name}</span>
              <button
                className="zp-zone-vis"
                onClick={e => { e.stopPropagation(); setZones(prev => prev.map(p => p.id === z.id ? { ...p, visible: !p.visible } : p)); }}
                title={z.visible ? 'Hide' : 'Show'}
              >
                {z.visible ? '◉' : '○'}
              </button>
            </div>
          ))}
        </div>
        <button className="zp-add-zone" onClick={addZone}>+ New Zone</button>

        <div className="zp-panel-header uppercase muted" style={{ marginTop: 8 }}>Brush</div>
        <div className="zp-props">
          {[
            { label: 'Radius', value: brushRadius, min: 4, max: 200, onChange: (v: number) => setBrushRadius(v) },
            { label: 'Strength', value: Math.round(brushStrength * 100), min: 1, max: 100, onChange: (v: number) => setBrushStrength(v / 100) },
            { label: 'Falloff', value: Math.round(brushFalloff * 100), min: 0, max: 100, onChange: (v: number) => setBrushFalloff(v / 100) },
          ].map(p => (
            <div key={p.label} className="zp-prop-row">
              <span className="zp-prop-label muted">{p.label}</span>
              <input type="range" className="slider" style={{ flex: 1 }} min={p.min} max={p.max} value={p.value} onChange={e => p.onChange(+e.target.value)} />
              <span className="mono muted zp-prop-val">{p.value}</span>
            </div>
          ))}
        </div>

        <div style={{ flex: 1 }} />
        <button className="btn btn-primary zp-submit" onClick={handleSubmit} disabled={submitting || zones.length === 0}>
          {submitting ? 'Submitting...' : 'Submit Zones →'}
        </button>
      </div>
    </div>
  );
}
