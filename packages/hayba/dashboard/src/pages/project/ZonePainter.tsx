import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { Project, Zone } from '../../types';
import { api } from '../../api';
import { paintStroke, eraseStroke, canvasToBase64, createMaskCanvas } from '../../canvas/brushEngine';
import './ZonePainter.css';

type Tool = 'paint' | 'erase';
const CANVAS_SIZE = 1024;
const ZONE_COLORS = ['#3a6e3a', '#6e5a2a', '#3a4a6e', '#6e3a3a', '#5a6e3a', '#6e3a6e'];

const IconBrush = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9.06 11.9l8.07-8.06a2.85 2.85 0 1 1 4.03 4.03l-8.06 8.08"/>
    <path d="M7.07 14.94c-1.66 0-3 1.35-3 3.02 0 1.33-2.5 1.52-2 2.02 1 1 2.48 1.02 3.5 1.02 2.2 0 3.5-1.8 3.5-4.02 0-1.67-1.35-3.04-3-3.04z"/>
  </svg>
);

const IconEraser = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 20H7L3 16l10-10 7 7-3.5 3.5"/>
    <path d="M6.0 11.0 L13 18"/>
  </svg>
);

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
  const [locked, setLocked] = useState(true);
  const [editingZoneId, setEditingZoneId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const isPainting = useRef(false);

  // Poll painter session — unlock only when AI opens this project
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const session = await fetch('/api/zones/painter-session').then(r => r.json()) as { projectId?: string; phase?: 'a' | 'b' };
        if (cancelled) return;
        const isUnlocked = session?.projectId === project.id;
        setLocked(!isUnlocked);
        if (isUnlocked && session.phase) setPhase(session.phase);
      } catch { /* server not ready */ }
    };
    poll();
    const interval = setInterval(poll, 3000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [project.id]);

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
    const zone: Zone = { id, name: `Zone ${zones.length + 1}`, description: '', color, type: 'placement', placementCategory: 'foliage', maskPath: '', visible: true };
    const mask = createMaskCanvas(CANVAS_SIZE);
    setMaskCanvases(prev => new Map(prev).set(id, mask));
    setZones(prev => [...prev, zone]);
    setActiveZoneId(id);
    setEditingZoneId(id);
    setEditingName(`Zone ${zones.length + 1}`);
  };

  const handleSubmit = async () => {
    if (zones.length === 0) return;
    setSubmitting(true);
    const masks = zones.map(z => ({
      zoneId: z.id,
      pngBase64: canvasToBase64(maskCanvases.get(z.id)!),
    }));
    await api.zones.submit({ projectId: project.id, zones, masks, canvasSize: CANVAS_SIZE, phase });
    await fetch('/api/zones/painter-session', { method: 'DELETE' });
    setSubmitting(false);
    setLocked(true);
  };

  const startRenameZone = (z: Zone, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingZoneId(z.id);
    setEditingName(z.name);
  };

  const commitRename = () => {
    if (!editingZoneId) return;
    const trimmed = editingName.trim();
    if (trimmed) setZones(prev => prev.map(z => z.id === editingZoneId ? { ...z, name: trimmed } : z));
    setEditingZoneId(null);
  };

  const TOOLS: { id: Tool; label: string; icon: React.ReactNode }[] = [
    { id: 'paint', label: 'Paint', icon: <IconBrush /> },
    { id: 'erase', label: 'Erase', icon: <IconEraser /> },
  ];

  if (locked) {
    return (
      <div className="zone-painter zone-painter--locked">
        <div className="zp-lock-overlay">
          <div className="zp-lock-icon">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="3" y="11" width="18" height="11" rx="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
          </div>
          <div className="zp-lock-title">Painter Locked</div>
          <div className="zp-lock-msg">
            Ask Claude to open the Zone Painter for this project.<br />
            <span className="muted">It will unlock automatically when ready.</span>
          </div>
        </div>
      </div>
    );
  }

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
          <div className="zp-canvas-wrapper">
            <canvas
              ref={displayRef}
              width={CANVAS_SIZE}
              height={CANVAS_SIZE}
              className="zp-canvas"
              onMouseDown={() => { isPainting.current = true; }}
              onMouseUp={() => { isPainting.current = false; }}
              onMouseLeave={() => { isPainting.current = false; }}
              onMouseMove={paint}
            />
          </div>
        </div>
      </div>

      {/* Right panel */}
      <div className="zp-right">
        <div className="zp-panel-header uppercase muted">Zones <span className="muted">({zones.length})</span></div>
        <div className="zp-zone-list">
          {zones.map(z => (
            <div key={z.id} className={`zp-zone-item ${activeZoneId === z.id ? 'active' : ''}`} onClick={() => setActiveZoneId(z.id)}>
              <div className="zp-zone-swatch" style={{ background: z.color }} />
              {editingZoneId === z.id ? (
                <input
                  className="zp-zone-name-input"
                  value={editingName}
                  autoFocus
                  onChange={e => setEditingName(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={e => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setEditingZoneId(null); }}
                  onClick={e => e.stopPropagation()}
                />
              ) : (
                <span className="zp-zone-name" title="Double-click to rename" onDoubleClick={e => startRenameZone(z, e)}>{z.name}</span>
              )}
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

        {activeZoneId && (() => {
          const az = zones.find(z => z.id === activeZoneId);
          if (!az) return null;
          return (
            <div className="zp-zone-details">
              <div className="zp-panel-header uppercase muted">Description</div>
              <textarea
                className="zp-zone-desc"
                placeholder="What does this zone represent? e.g. 'Main water channel running north–south'"
                value={az.description}
                onChange={e => setZones(prev => prev.map(z => z.id === activeZoneId ? { ...z, description: e.target.value } : z))}
              />
            </div>
          );
        })()}

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
