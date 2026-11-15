/**
 * Budget policy: turn spend totals + caps into one admission decision.
 *
 * The engine is pure so the same decision can be exercised by tests, the
 * `/gateway` command, and the HTTP control plane without a live DSH host.
 *
 * Decision order:
 *   1. an over-cap scope (unless the user lifted it for the current spend) wins;
 *   2. otherwise the highest ratio crossing `warnRatio` warns;
 *   3. `overLimit: 'degrade'` turns either stage into a model downgrade when a
 *      mapping exists, and falls back to block (hard stage) when it does not.
 */

export const SCOPES = ['session', 'daily', 'monthly'];

function ratioOf(spent, cap) {
  if (cap === null || cap === undefined) return null;
  if (cap <= 0) return Number.POSITIVE_INFINITY;
  return spent / cap;
}

/**
 * @param {object} input
 * @param {{session: number, daily: number, monthly: number}} input.totals spend in USD
 * @param {{session?: number|null, daily?: number|null, monthly?: number|null}} input.budgets
 * @param {number} input.warnRatio
 * @param {'alert'|'block'|'degrade'} input.overLimit
 * @param {'warn'|'hard'} [input.degradeAt]
 * @param {Record<string, string>} [input.degradation]
 * @param {string} [input.model]
 * @param {Record<string, number>} [input.overrides] scope -> spend at unblock time
 */
export function evaluateBudget({
  totals,
  budgets,
  warnRatio,
  overLimit,
  degradeAt = 'hard',
  degradation = {},
  model = '',
  overrides = {},
}) {
  const entries = SCOPES.map((scope) => {
    const cap = budgets[scope] ?? null;
    const spent = totals[scope] ?? 0;
    return { scope, cap, spent, ratio: ratioOf(spent, cap) };
  }).filter((entry) => entry.ratio !== null);

  const target = degradation[model];
  const canDegrade = typeof target === 'string' && target.length > 0 && target !== model;
  const highest = entries.reduce((best, entry) => (best === null || entry.ratio > best.ratio ? entry : best), null);

  if (highest === null) {
    return allow(entries, 'no budget caps configured');
  }

  const overridden = (entry) => {
    const watermark = overrides[entry.scope];
    return typeof watermark === 'number' && entry.spent <= watermark + 1e-9;
  };

  const over = entries
    .filter((entry) => entry.ratio >= 1 && !overridden(entry))
    .sort((a, b) => b.ratio - a.ratio)[0];

  if (over !== undefined) {
    const reason = `${over.scope} budget exceeded (${over.spent.toFixed(4)} / ${over.cap} USD)`;
    if (overLimit === 'alert') {
      return { action: 'warn', over: true, scope: over.scope, ratio: over.ratio, cap: over.cap, spent: over.spent, targetModel: null, reason: `${reason}; alert only` };
    }
    if (overLimit === 'degrade' && canDegrade) {
      return { action: 'degrade', over: true, scope: over.scope, ratio: over.ratio, cap: over.cap, spent: over.spent, targetModel: target, reason: `${reason}; degrading ${model} -> ${target}` };
    }
    return { action: 'block', over: true, scope: over.scope, ratio: over.ratio, cap: over.cap, spent: over.spent, targetModel: null, reason };
  }

  if (highest.ratio >= warnRatio) {
    if (overLimit === 'degrade' && degradeAt === 'warn' && canDegrade) {
      return { action: 'degrade', over: false, scope: highest.scope, ratio: highest.ratio, cap: highest.cap, spent: highest.spent, targetModel: target, reason: `${highest.scope} budget at ${Math.round(highest.ratio * 100)}%; degrading ${model} -> ${target}` };
    }
    return { action: 'warn', over: false, scope: highest.scope, ratio: highest.ratio, cap: highest.cap, spent: highest.spent, targetModel: null, reason: `${highest.scope} budget at ${Math.round(highest.ratio * 100)}%` };
  }

  return allow(entries, `highest ${highest.scope} budget at ${Math.round(highest.ratio * 100)}%`);
}

function allow(entries, reason) {
  const highest = entries.reduce((best, entry) => (best === null || entry.ratio > best.ratio ? entry : best), null);
  return {
    action: 'allow',
    over: false,
    scope: highest?.scope ?? null,
    ratio: highest?.ratio ?? 0,
    cap: highest?.cap ?? null,
    spent: highest?.spent ?? 0,
    targetModel: null,
    reason,
  };
}

/**
 * Ratios for the status surfaces (no policy applied).
 * @param {{session: number, daily: number, monthly: number}} totals
 * @param {object} budgets
 */
export function budgetRatios(totals, budgets) {
  const out = {};
  for (const scope of SCOPES) {
    const cap = budgets[scope] ?? null;
    out[scope] = { spent: totals[scope] ?? 0, cap, ratio: ratioOf(totals[scope] ?? 0, cap) };
  }
  return out;
}
