import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export type StabilitySeverity = 'green' | 'yellow' | 'red' | 'unknown';

export interface AxisStatusV1 {
  severity: StabilitySeverity;
  score?: number;
  summary?: string;
  metrics?: Record<string, unknown>;
}

export interface StabilityReportV1 {
  schema_version: '1.0.0';
  generated_at_utc: string;
  system_id?: string;
  axes: {
    orbital: AxisStatusV1;
    axial: AxisStatusV1;
    tidal: AxisStatusV1;
    atmospheric: AxisStatusV1;
    habitable_zone: AxisStatusV1;
  };
  bodies?: Array<{
    id: string;
    name?: string;
    orbital?: AxisStatusV1;
    axial?: AxisStatusV1;
    tidal?: AxisStatusV1;
    atmospheric?: AxisStatusV1;
    habitable_zone?: AxisStatusV1;
  }>;
  notes?: string[];
}

/** Returns path to the JSON Schema file (for AJV or docs). */
export function stabilityReportSchemaPath(): string {
  return join(__dirname, '..', 'schemas', 'stability-report.json');
}

export function readStabilityReportSchemaJson(): string {
  return readFileSync(stabilityReportSchemaPath(), 'utf-8');
}

export function exampleStabilityReport(): StabilityReportV1 {
  return {
    schema_version: '1.0.0',
    generated_at_utc: new Date().toISOString(),
    system_id: 'demo',
    axes: {
      orbital: { severity: 'green', summary: 'No close encounters within integration window', metrics: { megno: 2.1 } },
      axial: { severity: 'yellow', summary: 'Large obliquity oscillations', metrics: { obliquity_deg_range: [18, 62] } },
      tidal: { severity: 'green', summary: 'Lock timescale >> system age', metrics: { lock_time_gyr: 120 } },
      atmospheric: { severity: 'unknown', summary: 'Retention model not run' },
      habitable_zone: { severity: 'green', summary: 'Planet-averaged flux within optimistic HZ', metrics: { seff: 1.02 } },
    },
  };
}
