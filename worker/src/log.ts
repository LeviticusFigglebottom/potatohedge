type Level = 'debug' | 'info' | 'warn' | 'error';

function emit(level: Level, msg: string, data?: Record<string, unknown>) {
  const line = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(data ?? {}),
  };
  const out = level === 'error' || level === 'warn' ? console.error : console.log;
  out(JSON.stringify(line));
}

export const log = {
  debug: (msg: string, data?: Record<string, unknown>) => emit('debug', msg, data),
  info: (msg: string, data?: Record<string, unknown>) => emit('info', msg, data),
  warn: (msg: string, data?: Record<string, unknown>) => emit('warn', msg, data),
  error: (msg: string, data?: Record<string, unknown>) => emit('error', msg, data),
};
