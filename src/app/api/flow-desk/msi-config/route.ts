import { NextResponse } from 'next/server';
import fs from 'node:fs/promises';
import defaultConfig from '../../../../../config/flow-desk/msi.json';
import { validateMsiConfig } from '@/lib/flowdesk/msi/composite';

export const dynamic = 'force-dynamic';

/**
 * MSI formula hook. Order: FLOW_DESK_MSI_CONFIG (path to a JSON file) → bundled
 * config/flow-desk/msi.json. The client may further override it locally.
 */
export async function GET() {
  let raw: unknown = defaultConfig;
  let source = 'config/flow-desk/msi.json';
  const p = process.env.FLOW_DESK_MSI_CONFIG;
  if (p) {
    try { raw = JSON.parse(await fs.readFile(p, 'utf8')); source = 'FLOW_DESK_MSI_CONFIG'; }
    catch (e) { return NextResponse.json({ error: `FLOW_DESK_MSI_CONFIG unreadable: ${(e as Error).message}` }, { status: 500 }); }
  }
  const v = validateMsiConfig(raw);
  if (!v.ok) return NextResponse.json({ error: v.error, source }, { status: 500 });
  return NextResponse.json({ config: v.config, source });
}
