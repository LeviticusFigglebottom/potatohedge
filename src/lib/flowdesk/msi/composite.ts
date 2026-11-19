/**
 * MSI composite, driven entirely by a JSON config (no code change to swap formula).
 *
 * {
 *   "name": "...", "version": 1, "status": "uncalibrated",
 *   "normalize": "expanding_zscore" | "zscore" | "minmax" | "none",
 *   "components": [ { "id": "gamma_all", "weight": 0.35, "invert": false }, ... ],
 *   "output": { "transform": "logistic" | "minmax" | "none", "scale": 100 }
 * }
 *
 * composite(t) = output( Σ_i weight_i · (invert_i ? −1 : 1) · normalize(component_i)(t) )
 * "expanding_zscore" only uses samples up to t (causal); "zscore"/"minmax" use the whole day.
 */

import { MSI_COMPONENTS, type MsiComponentId, type MsiSample } from './components';

export type Normalize = 'expanding_zscore' | 'zscore' | 'minmax' | 'none';
export type OutputTransform = 'logistic' | 'minmax' | 'none';

export interface MsiConfig {
  name: string;
  version: number;
  status?: string;
  description?: string;
  normalize: Normalize;
  components: { id: MsiComponentId; weight: number; invert?: boolean }[];
  output: { transform: OutputTransform; scale: number };
}

const IDS = new Set(MSI_COMPONENTS.map((c) => c.id));

export function validateMsiConfig(raw: unknown): { ok: true; config: MsiConfig } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'config must be an object' };
  const c = raw as Record<string, unknown>;
  const normalize = (c.normalize ?? 'expanding_zscore') as Normalize;
  if (!['expanding_zscore', 'zscore', 'minmax', 'none'].includes(normalize)) return { ok: false, error: `unknown normalize "${String(normalize)}"` };
  if (!Array.isArray(c.components) || c.components.length === 0) return { ok: false, error: 'components must be a non-empty array' };
  const components: MsiConfig['components'] = [];
  for (const item of c.components as Record<string, unknown>[]) {
    if (!item || typeof item.id !== 'string' || !IDS.has(item.id as MsiComponentId)) return { ok: false, error: `unknown component id "${String(item?.id)}"` };
    const weight = Number(item.weight);
    if (!Number.isFinite(weight)) return { ok: false, error: `weight for ${item.id} must be a number` };
    components.push({ id: item.id as MsiComponentId, weight, invert: !!item.invert });
  }
  const out = (c.output ?? {}) as Record<string, unknown>;
  const transform = (out.transform ?? 'logistic') as OutputTransform;
  if (!['logistic', 'minmax', 'none'].includes(transform)) return { ok: false, error: `unknown output.transform "${String(transform)}"` };
  const scale = out.scale == null ? 100 : Number(out.scale);
  return {
    ok: true,
    config: {
      name: String(c.name ?? 'MSI'),
      version: Number(c.version ?? 1),
      status: c.status ? String(c.status) : undefined,
      description: c.description ? String(c.description) : undefined,
      normalize,
      components,
      output: { transform, scale: Number.isFinite(scale) ? scale : 100 },
    },
  };
}

export function normalizeSeries(xs: number[], mode: Normalize): number[] {
  if (mode === 'none') return xs.slice();
  if (mode === 'minmax') {
    const mn = Math.min(...xs), mx = Math.max(...xs);
    return xs.map((x) => (mx > mn ? (x - mn) / (mx - mn) * 2 - 1 : 0));
  }
  if (mode === 'zscore') {
    const m = xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length || 1));
    return xs.map((x) => (sd > 0 ? (x - m) / sd : 0));
  }
  // expanding (causal) z-score
  let n = 0, mean = 0, m2 = 0;
  return xs.map((x) => {
    n++;
    const d = x - mean;
    mean += d / n;
    m2 += d * (x - mean);
    const sd = n > 1 ? Math.sqrt(m2 / (n - 1)) : 0;
    return sd > 0 ? (x - mean) / sd : 0;
  });
}

export function computeMsiComposite(samples: MsiSample[], config: MsiConfig): { time: number; value: number }[] {
  if (samples.length === 0) return [];
  const raw = new Array<number>(samples.length).fill(0);
  for (const comp of config.components) {
    const norm = normalizeSeries(samples.map((s) => s.values[comp.id]), config.normalize);
    norm.forEach((v, i) => { raw[i] += comp.weight * (comp.invert ? -v : v); });
  }
  let out = raw;
  const scale = config.output.scale;
  if (config.output.transform === 'logistic') out = raw.map((x) => scale / (1 + Math.exp(-x)));
  else if (config.output.transform === 'minmax') {
    const mn = Math.min(...raw), mx = Math.max(...raw);
    out = raw.map((x) => (mx > mn ? ((x - mn) / (mx - mn)) * scale : scale / 2));
  }
  return samples.map((s, i) => ({ time: s.time, value: out[i] }));
}
