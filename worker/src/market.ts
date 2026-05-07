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

export function dteFromExpiration(expiration: string, now = new Date()): number {
  const exp = new Date(`${expiration}T20:00:00-04:00`);
  const ms = exp.getTime() - now.getTime();
  return Math.ceil(ms / (1000 * 60 * 60 * 24));
}
