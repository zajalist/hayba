import React, { useEffect, useState } from 'react';
import type { Project, EncyclopediaEntry } from '../../types';
import { api } from '../../api';
import './EncyclopediaView.css';

const TYPE_ICONS: Record<string, string> = {
  foliage: '▲',
  vegetation: '◆',
  rocks: '■',
  props: '●',
  'terrain-feature': '◈',
};

export function EncyclopediaView({ project }: { project: Project }) {
  const [entries, setEntries] = useState<EncyclopediaEntry[]>([]);
  const [selected, setSelected] = useState<EncyclopediaEntry | null>(null);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    api.encyclopedia.getEntries(project.id).then(setEntries);
  }, [project.id]);

  const importTemplates = async () => {
    const templates = await api.encyclopedia.getTemplates();
    for (const t of templates) {
      await api.encyclopedia.addEntry(project.id, t);
    }
    setEntries(await api.encyclopedia.getEntries(project.id));
  };

  const deleteEntry = async (id: string) => {
    await api.encyclopedia.deleteEntry(project.id, id);
    setEntries(prev => prev.filter(e => e.id !== id));
    if (selected?.id === id) setSelected(null);
  };

  const filtered = entries.filter(e =>
    e.name.toLowerCase().includes(filter.toLowerCase()) ||
    (e.scientificName ?? '').toLowerCase().includes(filter.toLowerCase())
  );

  return (
    <div className="enc-view">
      {/* Left: entry list */}
      <div className="enc-list">
        <div className="enc-list-header">
          <input className="input" placeholder="Search..." value={filter} onChange={e => setFilter(e.target.value)} style={{ flex: 1 }} />
          <button className="btn btn-ghost" onClick={importTemplates} title="Import base templates" style={{ padding: '0 8px' }}>↓ Templates</button>
          <button className="btn btn-primary" onClick={() => {}}>+</button>
        </div>
        <div className="enc-entries">
          {filtered.map(entry => (
            <div
              key={entry.id}
              className={`enc-entry-row ${selected?.id === entry.id ? 'active' : ''}`}
              onClick={() => setSelected(entry)}
            >
              <span className="enc-type-icon accent">{TYPE_ICONS[entry.type] ?? '●'}</span>
              <div className="enc-entry-info">
                <span className="enc-entry-name">{entry.name}</span>
                {entry.scientificName && <span className="enc-entry-sci muted">{entry.scientificName}</span>}
              </div>
              {entry.isBaseEntry && <span className="enc-badge muted">base</span>}
            </div>
          ))}
          {filtered.length === 0 && (
            <div className="muted" style={{ padding: '16px 12px', fontSize: 10 }}>
              No entries. Click "↓ Templates" to import base species, or "+" to add your own.
            </div>
          )}
        </div>
      </div>

      {/* Right: detail panel */}
      <div className="enc-detail">
        {selected ? (
          <>
            <div className="enc-detail-header">
              <div>
                <div className="enc-detail-name">{selected.name}</div>
                {selected.scientificName && <div className="enc-detail-sci muted">{selected.scientificName}</div>}
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                {selected.fabLink && (
                  <a href={selected.fabLink} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)', fontSize: 10 }}>↗ FAB</a>
                )}
                <button className="btn btn-ghost" style={{ fontSize: 9 }} onClick={() => deleteEntry(selected.id)}>Delete</button>
              </div>
            </div>
            <div className="enc-detail-body">
              <div className="enc-detail-section">
                <div className="enc-section-title uppercase muted">Attributes</div>
                {Object.entries(selected.attributes).map(([k, v]) => v !== undefined && (
                  <div key={k} className="enc-attr-row">
                    <span className="enc-attr-label muted">{k.replace(/([A-Z])/g, ' $1').toLowerCase()}</span>
                    <div className="enc-attr-slider-wrap">
                      {typeof v === 'number' && (
                        <div className="enc-slider-track">
                          <div className="enc-slider-fill" style={{ width: `${Math.min(100, v * 100)}%` }} />
                        </div>
                      )}
                      <span className="mono muted enc-attr-val">{v}</span>
                    </div>
                  </div>
                ))}
              </div>
              {selected.lore && (
                <div className="enc-detail-section">
                  <div className="enc-section-title uppercase muted">Lore</div>
                  <div className="enc-lore muted">{selected.lore}</div>
                </div>
              )}
              <div className="enc-detail-section">
                <div className="enc-section-title uppercase muted">UE5 Mesh</div>
                {selected.ueMeshPath ? (
                  <div className="mono" style={{ fontSize: 10 }}>{selected.ueMeshPath}</div>
                ) : (
                  <div className="muted" style={{ fontSize: 10 }}>No mesh set.{selected.fabLink ? ' Use the FAB link above to find a compatible asset.' : ''}</div>
                )}
              </div>
            </div>
          </>
        ) : (
          <div className="enc-detail-empty muted">Select an entry to view details</div>
        )}
      </div>
    </div>
  );
}
