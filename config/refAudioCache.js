/**
 * Tiny in-memory cache for the head leader's reference clips.
 * Without it every "play" made two Google Drive calls, so a crowd of talents hitting the same sentences would
 * burn through Drive's rate limit. Now:
 *   - the same file is fetched from Drive ONCE per server instance (and re-used for TTL_MS),
 *   - simultaneous requests for a file that is still loading share that single Drive call,
 *   - memory is bounded (MAX_BYTES / MAX_ENTRIES, oldest dropped first) — reference clips are small.
 * A failed load is never cached.
 */
const TTL_MS = 10 * 60 * 1000;
const MAX_BYTES = 40 * 1024 * 1024;
const MAX_ENTRIES = 200;

const store = new Map();      // key -> { value: { buf, type }, at, size }
const loading = new Map();    // key -> Promise
let bytes = 0;

function evict() {
  for (const [k, e] of store) {
    if (store.size <= MAX_ENTRIES && bytes <= MAX_BYTES) break;
    bytes -= e.size; store.delete(k);          // Map keeps insertion order: the first key is the oldest
  }
}

/** loader() must resolve { buf: Buffer, type: string }. */
async function getOrLoad(key, loader, now = Date.now) {
  const hit = store.get(key);
  if (hit && now() - hit.at < TTL_MS) return hit.value;
  if (hit) { bytes -= hit.size; store.delete(key); }
  if (loading.has(key)) return loading.get(key);
  const p = (async () => {
    const value = await loader();
    const size = value.buf.length;
    if (size <= MAX_BYTES / 4) { store.set(key, { value, at: now(), size }); bytes += size; evict(); }
    return value;
  })().finally(() => loading.delete(key));
  loading.set(key, p);
  return p;
}

function _reset() { store.clear(); loading.clear(); bytes = 0; }
module.exports = { getOrLoad, _reset, _stats: () => ({ entries: store.size, bytes }) };
