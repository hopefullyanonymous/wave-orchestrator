// USD per million tokens, keyed by the EXACT model id a response reports (`usage.model`): a lookup
// never matches a prefix, since `claude-opus-5` is one of `claude-opus-5-5`. Values from the Claude
// API reference bundled with Claude Code 2.1.289, whose price table is dated PRICES_CHECKED; a cache
// write costs 1.25x input for the 5-minute TTL (`cacheWrite5m`) and 2x for the 1-hour TTL
// (`cacheWrite1h`). Read by orchestrate-mod/hooks/cost.js `priceOf`.
export const PRICES_CHECKED = '2026-09-25';

export const PRICES = {
  'claude-opus-5-5': { in: 4, out: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 },
  'claude-sonnet-5-5': { in: 2, out: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 },
  'claude-haiku-4-5': { in: 1, out: 5, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2 },
  'claude-haiku-4-5-20251001': { in: 1, out: 5, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2 },
  'claude-fable-5-1': { in: 10, out: 50, cacheRead: 0.25, cacheWrite5m: 12.5, cacheWrite1h: 20 },
  'claude-fable-5': { in: 10, out: 50, cacheRead: 1, cacheWrite5m: 12.5, cacheWrite1h: 20 },
  'claude-opus-5': { in: 5, out: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
};
