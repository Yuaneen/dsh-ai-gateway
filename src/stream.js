/**
 * Stream shapes used at the `llm/stream` waterfall.
 *
 * A blocked call must still look like a normal assistant stream so the agent
 * loop settles the step instead of retrying a transport failure: one text
 * block carrying the refusal, then an `error` finish with a stable code.
 */

/**
 * @param {string} message user-facing refusal
 * @param {string} [code] stable machine code
 * @returns {AsyncIterable<object>}
 */
export function blockedStream(message, code = 'BUDGET_BLOCKED') {
  return (async function* blocked() {
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: message };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: message } };
    yield { type: 'finish', reason: { kind: 'error', failure: { message, code } } };
  })();
}

/**
 * Forward chunks unchanged while observing the first `usage` chunk.
 * Usage is emitted once before `finish`; a missing usage chunk (failed call)
 * records nothing rather than a fabricated estimate.
 *
 * @param {AsyncIterable<object>} source
 * @param {(usage: object) => void} onUsage
 */
export async function* meteredStream(source, onUsage) {
  let recorded = false;
  for await (const chunk of source) {
    if (!recorded && chunk?.type === 'usage' && chunk.usage !== undefined) {
      recorded = true;
      onUsage(chunk.usage);
    }
    yield chunk;
  }
}
