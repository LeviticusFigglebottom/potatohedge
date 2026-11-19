/** US/Eastern helpers (exchange time) without external dependencies. */

const fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hourCycle: 'h23',
});

export interface EtParts { year: number; month: number; day: number; hour: number; minute: number; second: number; date: string }

export function etParts(ms: number): EtParts {
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(new Date(ms))) p[part.type] = part.value;
  const year = +p.year, month = +p.month, day = +p.day;
  return {
    year, month, day,
    hour: +p.hour % 24, minute: +p.minute, second: +p.second,
    date: `${p.year}-${p.month}-${p.day}`,
  };
}

/** ET offset from UTC in ms (negative, e.g. −5h or −4h) at the given instant. */
export function etOffsetMs(ms: number): number {
  const p = etParts(ms);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** Epoch ms for an ET wall-clock time on a YYYY-MM-DD date. */
export function etToMs(date: string, hour: number, minute = 0): number {
  const [y, m, d] = date.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, hour, minute);
  const off = etOffsetMs(guess);
  const t = guess - off;
  // re-check across DST boundary
  const off2 = etOffsetMs(t);
  return off2 === off ? t : guess - off2;
}

/** Minutes since ET midnight. */
export function etMinuteOfDay(ms: number): number {
  const p = etParts(ms);
  return p.hour * 60 + p.minute;
}

/** Regular trading hours 09:30–16:00 ET (inclusive start, exclusive end). */
export function isRTH(ms: number): boolean {
  const m = etMinuteOfDay(ms);
  return m >= 570 && m < 960;
}

export function isWeekday(date: string): boolean {
  const [y, m, d] = date.split('-').map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return wd !== 0 && wd !== 6;
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

/** Most recent weekday on or before `date` (holidays not modelled). */
export function lastWeekday(date: string): string {
  let d = date;
  while (!isWeekday(d)) d = addDays(d, -1);
  return d;
}

/** N previous weekdays ending at (and including) `date`, oldest first. */
export function weekdaysEnding(date: string, n: number): string[] {
  const out: string[] = [];
  let d = lastWeekday(date);
  while (out.length < n) { out.unshift(d); d = lastWeekday(addDays(d, -1)); }
  return out;
}

export function dayOfWeek(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Friday of the week containing `date`. */
export function fridayOf(date: string): string {
  const wd = dayOfWeek(date);
  return addDays(date, (5 - wd + 7) % 7);
}

export function todayEt(): string {
  return etParts(Date.now()).date;
}
