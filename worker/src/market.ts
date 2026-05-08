import { loadConfig } from './config.js';

export function isMarketOpenNow(now = new Date()): boolean {
  const tz = loadConfig().MARKET_TZ;
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    minute: 'numeric',
    weekday: 'short',
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const hours = parseInt(get('hour'), 10) || 0;
  const minutes = parseInt(get('minute'), 10) || 0;
  const day = get('weekday');
  if (day === 'Sat' || day === 'Sun') return false;
  const t = hours * 60 + minutes;
  return t >= 9 * 60 + 30 && t <= 16 * 60;
}

// Robust DTE calculation. Postgres reads `DATE` columns back as JS Date
// objects (not strings), so the same field can arrive here either way.
// Failing silently with NaN here is what let assignment-risk on bleeding
// short positions never trigger — defensively normalize first.
export function dteFromExpiration(expiration: string | Date, now = new Date()): number {
  let dateOnly: string;
  if (expiration instanceof Date) {
    dateOnly = expiration.toISOString().slice(0, 10);
  } else if (typeof expiration === 'string') {
    dateOnly = expiration.slice(0, 10);
  } else {
    throw new Error(`dteFromExpiration: bad input ${typeof expiration}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOnly)) {
    throw new Error(`dteFromExpiration: invalid date ${dateOnly}`);
  }
  const exp = new Date(`${dateOnly}T20:00:00-04:00`);
  if (Number.isNaN(exp.getTime())) {
    throw new Error(`dteFromExpiration: failed to parse ${dateOnly}`);
  }
  const ms = exp.getTime() - now.getTime();
  return Math.ceil(ms / (1000 * 60 * 60 * 24));
}
