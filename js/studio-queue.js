/**
 * Nativoya Studio — durable upload queue.
 *
 * Every confirmed take is written to IndexedDB on the talent's own device
 * BEFORE the upload starts. If the connection drops (or the tab is closed,
 * or the phone dies) the take is still there; it is retried automatically
 * with exponential back-off and flushed again as soon as the browser comes
 * back online or the page is re-opened.
 *
 * "Permanent" errors (validation failures, 4xx) are NOT retried — retrying
 * a rejected file would just fail forever.
 */
(function () {
  "use strict";

  const DB_NAME = "nativoya-studio-queue";
  const STORE = "pending";

  function openDb() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) return reject(new Error("no-indexeddb"));
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "key" });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function tx(mode, fn) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const store = t.objectStore(STORE);
      const result = fn(store);
      t.oncomplete = () => { db.close(); resolve(result && result.result !== undefined ? result.result : undefined); };
      t.onerror = () => { db.close(); reject(t.error); };
    });
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Best-effort: if IndexedDB is unavailable (private mode on some browsers)
  // the queue silently degrades to "retry in memory only".
  async function put(item) { try { await tx("readwrite", (s) => s.put(item)); } catch (_) {} }
  async function remove(key) { try { await tx("readwrite", (s) => s.delete(key)); } catch (_) {} }
  async function all() {
    try { return await tx("readonly", (s) => s.getAll()) || []; } catch (_) { return []; }
  }

  function isPermanent(err) {
    return !!(err && err.status && err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429);
  }

  /**
   * Upload with retries. Resolves { ok: true } on success,
   * { ok: false, permanent: true, error } when the server rejected the file,
   * { ok: false, permanent: false } when the network never recovered.
   */
  async function attempt(item, uploadFn, retries) {
    let lastErr = null;
    for (let i = 0; i <= retries; i++) {
      try {
        await uploadFn(item);
        return { ok: true };
      } catch (err) {
        lastErr = err;
        if (isPermanent(err)) return { ok: false, permanent: true, error: err };
        if (i < retries) await sleep(800 * Math.pow(2, i)); // 0.8s, 1.6s, 3.2s
      }
    }
    return { ok: false, permanent: false, error: lastErr };
  }

  /**
   * Stores the take durably, then tries to upload it.
   * item: { key, token, sampleId, blob, filename, duration }
   */
  async function submit(item, uploadFn, retries = 3) {
    await put({ ...item, createdAt: Date.now() });
    const result = await attempt(item, uploadFn, retries);
    if (result.ok || result.permanent) await remove(item.key);
    return result;
  }

  /** Items for one session that never made it to the server. */
  async function pendingFor(token) {
    return (await all()).filter((i) => i.token === token);
  }

  /** Retries everything stored for this session. Calls onResult(item, result). */
  async function flush(token, uploadFn, onResult) {
    const items = await pendingFor(token);
    for (const item of items) {
      const result = await attempt(item, uploadFn, 1);
      if (result.ok || result.permanent) await remove(item.key);
      if (onResult) onResult(item, result);
    }
    return items.length;
  }

  window.StudioQueue = { submit, pendingFor, flush, remove };
})();
