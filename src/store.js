/**
 * Durable ledger snapshots.
 *
 * A small JSON file is enough for one process: writes are atomic
 * (tmp + rename) and debounced, and a corrupt file only loses the snapshot,
 * never the live ledger. When `persistence.enabled` is false the plugin keeps
 * everything in memory (the same trade-off as dsh-budget's degraded mode).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

/** Expand `~` and `$DSH_HOME` into an absolute path. */
export function expandPath(file) {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  const expanded = file.replace(/^\$DSH_HOME(?=$|\/)/, home).replace(/^~(?=$|\/)/, homedir());
  return resolve(expanded);
}

/**
 * @param {{file: string, flushMs: number, ledger: import('./ledger.js').Ledger, logger: object}} options
 */
export function createStore({ file, flushMs, ledger, logger }) {
  const path = expandPath(file);
  let timer = null;
  let disposed = false;

  function load() {
    if (!existsSync(path)) return false;
    try {
      const state = JSON.parse(readFileSync(path, 'utf8'));
      ledger.restore(state);
      return true;
    } catch (error) {
      logger.warn(`ledger load failed (${path}): ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  function flush() {
    try {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(ledger.serialize(), null, 2), { mode: 0o600 });
      renameSync(tmp, path);
    } catch (error) {
      logger.warn(`ledger flush failed (${path}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function markDirty() {
    if (disposed || timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, flushMs);
    timer.unref?.();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    flush();
  }

  return { path, load, markDirty, flush, dispose };
}
