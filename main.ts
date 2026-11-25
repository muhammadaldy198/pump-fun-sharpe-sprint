// Pump.fun Sharpe Sprint — entrypoint.
//
// The grader runs this file as `node /bot/main.ts` (Node 22.23.4,
// erasable TypeScript, no build step). All it does is connect the kit's
// protocol shim to the strategy in strategy.ts: the shim owns the
// hello/batch/orders/slot wire protocol, the strategy owns every
// trading decision.
//
// Strategy: Sharpe-tuned judged momentum (see strategy.ts). The rank key
// here is hourly Sharpe, not raw PnL, so the tuning goal is steady
// hourly equity: small first stakes, big pyramid adds only into
// confirmed runners, and exits that let the few real runners pay for
// the many small stopped-out probes.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

const bot = createStrategy(DEFAULT_PARAMS);

await runBot({
  onBatch: (state, batch) => bot.onBatch(state, batch),
});
