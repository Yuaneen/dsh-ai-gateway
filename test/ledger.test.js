import assert from 'node:assert/strict';
import test from 'node:test';

import { Ledger } from '../src/ledger.js';

const ZONE = 'Asia/Shanghai';
const T = Date.parse('2026-11-16T10:00:00+08:00');

function usage(input = 1_000, output = 100) {
  return { inputTokens: input, outputTokens: output, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

test('records into session, day, month and model buckets', () => {
  const ledger = new Ledger({ timeZone: ZONE });
  ledger.record({ sessionId: 's1', provider: 'deepseek-official', model: 'deepseek-v4-pro', usage: usage(), costUsd: 0.01, at: T });

  assert.equal(ledger.totals('s1', T).session, 0.01);
  assert.equal(ledger.totals('s1', T).daily, 0.01);
  assert.equal(ledger.totals('s1', T).monthly, 0.01);

  const models = ledger.modelBreakdown();
  assert.equal(models.length, 1);
  assert.equal(models[0].model, 'deepseek-v4-pro');
  assert.equal(models[0].calls, 1);
  assert.equal(models[0].tokens, 1_100);
});

test('day buckets roll over at the billing zone midnight', () => {
  const ledger = new Ledger({ timeZone: ZONE });
  const late = Date.parse('2026-11-15T23:59:00+08:00');
  const early = Date.parse('2026-11-16T00:01:00+08:00');

  ledger.record({ sessionId: 's1', provider: 'p', model: 'm', usage: usage(), costUsd: 1, at: late });
  assert.equal(ledger.totals('s1', early).daily, 0);
  assert.equal(ledger.totals('s1', late).daily, 1);
  assert.equal(ledger.totals('s1', early).monthly, 1);
});

test('sessions are isolated but share daily and monthly totals', () => {
  const ledger = new Ledger({ timeZone: ZONE });
  ledger.record({ sessionId: 'a', provider: 'p', model: 'm', usage: usage(), costUsd: 2, at: T });
  ledger.record({ sessionId: 'b', provider: 'p', model: 'm', usage: usage(), costUsd: 3, at: T });

  assert.equal(ledger.totals('a', T).session, 2);
  assert.equal(ledger.totals('b', T).session, 3);
  assert.equal(ledger.totals('a', T).daily, 5);
});

test('overrides are session-scoped for session, global for day/month', () => {
  const ledger = new Ledger({ timeZone: ZONE });
  ledger.setOverride('session', 1.25, 's1');
  assert.equal(ledger.overrides.get('session:s1'), 1.25);
  assert.deepEqual(ledger.getOverrides('s1'), { session: 1.25 });
  assert.deepEqual(ledger.getOverrides('s2'), {});

  ledger.setOverride('daily', 0.5, 's1');
  assert.deepEqual(ledger.getOverrides('s2'), { daily: 0.5 });

  ledger.clearOverride('session', 's1');
  assert.equal(ledger.overrides.has('session:s1'), false);
});

test('serialize/restore round-trips all buckets', () => {
  const ledger = new Ledger({ timeZone: ZONE });
  ledger.record({ sessionId: 's1', provider: 'p', model: 'm', usage: usage(10, 20), costUsd: 0.5, at: T });
  ledger.setOverride('daily', 0.5);

  const restored = new Ledger({ timeZone: ZONE });
  assert.equal(restored.restore(ledger.serialize()), true);
  assert.deepEqual(restored.totals('s1', T), ledger.totals('s1', T));
  assert.equal(restored.modelBreakdown()[0].tokens, 30);
  assert.equal(restored.overrides.get('daily'), 0.5);
});

test('restore ignores corrupt buckets instead of throwing', () => {
  const ledger = new Ledger({ timeZone: ZONE });
  ledger.restore({ sessions: { s1: { spentUsd: 'oops', calls: 2 } }, days: null });
  assert.equal(ledger.totals('s1', T).session, 0);
});
