/**
 * In-memory spend ledger with a serializable snapshot.
 *
 * Buckets:
 *   - per session  -> the session budget scope
 *   - per day      -> the daily scope (billing day in the configured zone)
 *   - per month    -> the monthly scope
 *   - per model    -> cost attribution / `usage` output
 *
 * The ledger is deliberately dependency-free and synchronous; persistence is a
 * separate concern (see store.js) so tests can exercise accounting directly.
 */

import { dayKey, monthKey } from './pricing.js';

const ZERO = Object.freeze({
  spentUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  calls: 0,
});

function emptyBucket() {
  return { ...ZERO };
}

function addUsage(bucket, usage, costUsd) {
  bucket.spentUsd += costUsd;
  bucket.inputTokens += usage.inputTokens ?? 0;
  bucket.outputTokens += usage.outputTokens ?? 0;
  bucket.cacheReadTokens += usage.cacheReadTokens ?? 0;
  bucket.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
  bucket.calls += 1;
}

function tokensOf(bucket) {
  return bucket.inputTokens + bucket.outputTokens + bucket.cacheReadTokens + bucket.cacheWriteTokens;
}

export class Ledger {
  /** @param {{timeZone?: string}} [options] */
  constructor({ timeZone = 'Asia/Shanghai' } = {}) {
    this.timeZone = timeZone;
    /** @type {Map<string, ReturnType<typeof emptyBucket>>} */
    this.sessions = new Map();
    /** @type {Map<string, ReturnType<typeof emptyBucket>>} */
    this.days = new Map();
    /** @type {Map<string, ReturnType<typeof emptyBucket>>} */
    this.months = new Map();
    /** @type {Map<string, ReturnType<typeof emptyBucket>>} */
    this.models = new Map();
    /** scope -> spend at the moment the user lifted the block */
    this.overrides = new Map();
  }

  /**
   * Record one metered model call.
   * @param {{sessionId: string, provider: string, model: string, usage: object, costUsd: number, at: number}} entry
   */
  record({ sessionId, provider, model, usage, costUsd, at }) {
    const session = String(sessionId || '__global__');
    const day = dayKey(at, this.timeZone);
    const month = monthKey(at, this.timeZone);
    const modelKey = `${provider}/${model}`;

    for (const [map, key] of [
      [this.sessions, session],
      [this.days, day],
      [this.months, month],
      [this.models, modelKey],
    ]) {
      const bucket = map.get(key) ?? emptyBucket();
      addUsage(bucket, usage, costUsd);
      map.set(key, bucket);
    }

    // Keep the day map bounded; monthly totals are cheap and stay.
    if (this.days.size > 400) {
      const oldest = [...this.days.keys()].sort()[0];
      this.days.delete(oldest);
    }
  }

  /**
   * Current spend for one session and the current day/month.
   * @param {string} sessionId
   * @param {number} at
   * @returns {{session: number, daily: number, monthly: number}}
   */
  totals(sessionId, at) {
    return {
      session: this.sessions.get(String(sessionId || '__global__'))?.spentUsd ?? 0,
      daily: this.days.get(dayKey(at, this.timeZone))?.spentUsd ?? 0,
      monthly: this.months.get(monthKey(at, this.timeZone))?.spentUsd ?? 0,
    };
  }

  /** Spend for one scope only (used by `/gateway unblock`). */
  spentFor(scope, sessionId, at) {
    return this.totals(sessionId, at)[scope] ?? 0;
  }

  /** Lift a hard block until spending grows past the current watermark. */
  setOverride(scope, spent, sessionId = '__global__') {
    this.overrides.set(this.overrideKey(scope, sessionId), spent);
  }

  clearOverride(scope, sessionId = '__global__') {
    this.overrides.delete(this.overrideKey(scope, sessionId));
  }

  /** Session-scoped overrides are keyed by session; day/month stay global. */
  overrideKey(scope, sessionId) {
    return scope === 'session' ? `session:${String(sessionId || '__global__')}` : scope;
  }

  /** The override values policy.js expects, resolved for one session. */
  getOverrides(sessionId) {
    const out = {};
    for (const scope of ['session', 'daily', 'monthly']) {
      const value = this.overrides.get(this.overrideKey(scope, sessionId));
      if (typeof value === 'number') out[scope] = value;
    }
    return out;
  }

  /** @returns {Array<object>} per-model attribution, highest spend first */
  modelBreakdown() {
    return [...this.models.entries()]
      .map(([key, bucket]) => {
        const slash = key.indexOf('/');
        return {
          provider: slash === -1 ? '' : key.slice(0, slash),
          model: slash === -1 ? key : key.slice(slash + 1),
          spentUsd: bucket.spentUsd,
          tokens: tokensOf(bucket),
          calls: bucket.calls,
        };
      })
      .sort((a, b) => b.spentUsd - a.spentUsd);
  }

  /** Serializable state for the persistence layer. */
  serialize() {
    const dump = (map) => Object.fromEntries([...map.entries()].map(([key, value]) => [key, { ...value }]));
    return {
      version: 1,
      timeZone: this.timeZone,
      sessions: dump(this.sessions),
      days: dump(this.days),
      months: dump(this.months),
      models: dump(this.models),
      overrides: Object.fromEntries(this.overrides),
    };
  }

  /** Restore a snapshot; corrupt or partial input is ignored bucket by bucket. */
  restore(state) {
    if (state === null || typeof state !== 'object') return false;
    const load = (map, source) => {
      if (source === null || typeof source !== 'object') return;
      for (const [key, value] of Object.entries(source)) {
        if (value === null || typeof value !== 'object') continue;
        const bucket = emptyBucket();
        for (const field of Object.keys(bucket)) {
          const number = value[field];
          if (typeof number === 'number' && Number.isFinite(number) && number >= 0) bucket[field] = number;
        }
        map.set(String(key), bucket);
      }
    };
    load(this.sessions, state.sessions);
    load(this.days, state.days);
    load(this.months, state.months);
    load(this.models, state.models);
    if (state.overrides && typeof state.overrides === 'object') {
      for (const [scope, spent] of Object.entries(state.overrides)) {
        if (typeof spent === 'number' && Number.isFinite(spent)) this.overrides.set(scope, spent);
      }
    }
    return true;
  }
}

export { tokensOf };
