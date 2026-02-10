/**
 * Server-side persistence layer for historical data.
 *
 * Storage hierarchy:
 * 1. Upstash Redis (primary) — fast key-value, free tier: 10K commands/day, 256MB
 *    Env: UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
 *    (also accepts KV_REST_API_URL + KV_REST_API_TOKEN for Vercel KV compat)
 * 2. Vercel Blob (fallback) — object store, free tier included with Hobby
 *    Env: BLOB_READ_WRITE_TOKEN
 * 3. Returns empty array if neither is configured (localStorage-only mode)
 *
 * Keys follow the pattern: optix:{type}:{identifier}
 *   - optix:metrics:{TICKER} — daily metric snapshots per ticker
 *   - optix:flow:market — daily market-wide flow history
 *   - optix:flow:{TICKER} — daily per-ticker flow history
 */

const MAX_RECORDS = 365;

// ─── Provider Detection ─────────────────────────────────────

function getRedisConfig(): { url: string; token: string } | null {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (url && token) return { url, token };
  return null;
}

function isBlobAvailable(): boolean {
  return !!process.env.BLOB_READ_WRITE_TOKEN;
}

// Lazy-initialized Redis client
let _redis: import('@upstash/redis').Redis | null = null;

async function getRedis(): Promise<import('@upstash/redis').Redis | null> {
  const config = getRedisConfig();
  if (!config) return null;
  if (!_redis) {
    const { Redis } = await import('@upstash/redis');
    _redis = new Redis({ url: config.url, token: config.token });
  }
  return _redis;
}

// ─── Redis Implementation ──────────────────────────────────

async function redisGet<T>(key: string): Promise<T[] | null> {
  const redis = await getRedis();
  if (!redis) return null;
  return redis.get<T[]>(key);
}

async function redisSet<T>(key: string, data: T[]): Promise<void> {
  const redis = await getRedis();
  if (!redis) return;
  // Set with no expiry — data persists until overwritten or deleted
  await redis.set(key, JSON.stringify(data));
}

// ─── Blob Implementation ───────────────────────────────────

async function blobGet<T>(key: string): Promise<T[] | null> {
  if (!isBlobAvailable()) return null;
  const { list } = await import('@vercel/blob');
  const path = `optix-history/${key}.json`;
  const blobs = await list({ prefix: path, limit: 1 });
  if (blobs.blobs.length === 0) return null;

  const res = await fetch(blobs.blobs[0].url, {
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) return null;
  return res.json();
}

async function blobSet<T>(key: string, data: T[]): Promise<void> {
  if (!isBlobAvailable()) return;
  const { put } = await import('@vercel/blob');
  const path = `optix-history/${key}.json`;
  await put(path, JSON.stringify(data), {
    access: 'public',
    addRandomSuffix: false,
  });
}

// ─── Public API ────────────────────────────────────────────

export type HistoryRecord = Record<string, unknown> & { date: string; timestamp: number };

/**
 * Load historical records for a key. Tries Redis first, then Blob.
 */
export async function loadHistory<T extends HistoryRecord>(
  key: string,
  days: number = MAX_RECORDS
): Promise<T[]> {
  // Try Redis
  try {
    const data = await redisGet<T>(key);
    if (data && data.length > 0) return data.slice(-days);
  } catch { /* fall through */ }

  // Try Blob
  try {
    const data = await blobGet<T>(key);
    if (data && data.length > 0) return data.slice(-days);
  } catch { /* no persistence available */ }

  return [];
}

/**
 * Save a single daily record. Deduplicates by date, trims to MAX_RECORDS.
 * Fire-and-forget — callers should not await this in hot paths.
 */
export async function saveDaily<T extends HistoryRecord>(
  key: string,
  record: T
): Promise<void> {
  // Load existing
  let existing: T[] = [];
  try {
    const data = await redisGet<T>(key);
    if (data) existing = data;
  } catch {
    try {
      const data = await blobGet<T>(key);
      if (data) existing = data;
    } catch { /* start fresh */ }
  }

  // Deduplicate by date
  const filtered = existing.filter(r => r.date !== record.date);
  filtered.push(record);
  filtered.sort((a, b) => a.timestamp - b.timestamp);
  const trimmed = filtered.slice(-MAX_RECORDS);

  // Save to Redis (primary)
  let savedToRedis = false;
  try {
    await redisSet(key, trimmed);
    savedToRedis = true;
  } catch { /* fall through */ }

  // Save to Blob (fallback/mirror)
  if (!savedToRedis) {
    try {
      await blobSet(key, trimmed);
    } catch { /* no persistence available */ }
  }
}

/**
 * Bulk-save an array of records (replaces all data for this key).
 * Used for client→server sync of existing localStorage data.
 */
export async function saveHistoryBulk<T extends HistoryRecord>(
  key: string,
  records: T[]
): Promise<void> {
  // Load existing server data and merge
  let existing: T[] = [];
  try {
    const data = await redisGet<T>(key);
    if (data) existing = data;
  } catch {
    try {
      const data = await blobGet<T>(key);
      if (data) existing = data;
    } catch { /* start fresh */ }
  }

  // Merge: server records + client records, dedup by date (client wins)
  const byDate = new Map<string, T>();
  for (const r of existing) byDate.set(r.date, r);
  for (const r of records) byDate.set(r.date, r);

  const merged = Array.from(byDate.values());
  merged.sort((a, b) => a.timestamp - b.timestamp);
  const trimmed = merged.slice(-MAX_RECORDS);

  // Save
  try {
    await redisSet(key, trimmed);
  } catch {
    try {
      await blobSet(key, trimmed);
    } catch { /* no persistence available */ }
  }
}

/**
 * Check which persistence backends are available.
 */
export function getPersistenceStatus(): { redis: boolean; blob: boolean } {
  return {
    redis: !!getRedisConfig(),
    blob: isBlobAvailable(),
  };
}
