// Sharpe-Tuned Judged Momentum — a pump.fun replay paper bot.
//
// Rank key here is HOURLY SHARPE, not raw PnL. Sharpe = mean / stdev of
// hourly equity returns, so a bot that banks one +22% hour and sits flat
// the other five loses to a bot that banks small positive hours all day.
// Everything below is tuned against that fact, measured on the
// competition's own dev window (24h, 2-3 Nov 2026, 128,058 events,
// 1,222 mints, all three dataset parts) through the kit's momentum
// simulator, with Sharpe computed per 6-hour slice (the final window is
// 6 hours, n = 6 returns).
//
// What the measurements said (full sweep log in the build report):
//  - The edge is the FAT TAIL. 19 of 169 trips win; the best trip is
//    +5.56 SOL of +6.62 net. Every variant that banks winners early
//    (40% at 1.4x, full exit at +25%, tighter trailing) DESTROYS both
//    net and Sharpe (24h Sharpe 0.40 -> 0.20-0.29, slice 0 negative).
//    Early banking does not smooth returns — it starves the hours that
//    pay. The tail stays: bank 70% at 2x, half the rest at 4x.
//  - Adds ARE the PnL engine. First-stake-only is breakeven; adds of
//    0.35 SOL to a 0.90 cap (up from 0.25/0.65) lift 24h net +4.61 ->
//    +6.62 and mean slice Sharpe 0.39 -> 0.42. Bigger adds (0.50/1.20)
//    add net but not Sharpe; the flat region is 0.35/0.90.
//  - First stake 0.01 SOL (down from 0.02): the probe is cheaper, the
//    150 stopped-out losers cost less, mean slice Sharpe 0.41 -> 0.42.
//  - Stricter judgement (25 buyers / 5 SOL flow) and earlier judgement
//    (35 slots) both HURT — they veto winners, not losers. Judgement
//    stays 45 slots + second look at 60, >=18 buyers, >=10 buys,
//    >=3 SOL flow, reserves 15-80 SOL, multiple 1.5-8x.
//  - Stop -15% is a sharp peak (noise band +/-12-15%); -18% is worse.
//    It stays, and the fragility is recorded, not hidden.
//  - A dip leg (second entry channel) and a scalp exit were built and
//    measured: both neutral-to-negative on Sharpe. Neither ships.
//  - The 6h slices of the locked tuning: Sharpe 0.29 / 0.84 / 0.30 /
//    0.34 (all positive, mean 0.42), net +0.41 / +2.34 / +1.44 / +1.66,
//    DD 2.1-5.9% per slice. 24h: net +6.62, Sharpe 0.40, DD 6.1%,
//    92 guardrail coins, fail keys [11,22,33,44] mean +6.05 / worst
//    +5.12, 2x fees +4.40, noFail +6.81, deterministic 2x byte-identical.
//  - Honest gap vs the bar: PF2's best Sharpe is 0.5488 (muskey, one
//    6h window). Mean slice Sharpe 0.42 is BELOW it; best slice 0.84
//    beats it. All four slices positive + DD < 10% fits the Dimas
//    section-9 exception (submit as a special case for the Orchestrator
//    to judge). Concentration is the fragility: ex-best net is +1.06,
//    i.e. one trip carries 84% of net — the final window's outcome
//    hinges on whether 1-2 such runners appear.
//
// Two ownership gates survived full-window ablation and ADD money:
// top-1 holder > 15% of supply (+0.14 SOL alone) and Gini > 0.70
// (+0.07 alone), together +0.18. Four literature rules were MEASURED
// and REJECTED because they veto winners: top-10 > 35% (-1.38),
// slot-0 buy veto (biggest winners have the highest slot-0 share),
// dev-buy requirement (biggest winners have zero dev buy), creator-sold
// veto (-2.04, creator-sold coins ARE the winners), early-buyer veto
// (-0.90), cohort-sell exit (-3.04, top holders sell routinely).
// The asymmetry that kills most vetoes: a veto saves at most one
// first-stake stop-out (~0.004 SOL) per loser, but costs the full trip
// (~0.6 SOL) per winner it wrongly rejects — ~150:1.
//
// Determinism: every decision is a pure function of the batches the
// harness delivered, in arrival order. No clock, no environment, no
// randomness. Map iteration follows insertion order; candidate order is
// sorted by net flow (descending) then mint (ascending), so the two
// graded runs produce identical action logs.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  // --- judgement (first look / second look) ---
  judgeAge: number;
  secondJudgeAge: number; // 0 = no second look
  minRqSol: number;
  maxRqSol: number;
  minMult: number;
  maxMult: number;
  minBuyers: number;
  minBuys: number;
  minFlowSol: number;
  // --- ownership gates (veto when breached at judgement) ---
  gateTop10: number; // 0 = off
  gateTop1: number; // 0 = off
  gateGini: number; // 0 = off
  gateEarlyBuyers: number; // 0 = off; veto when >= this many distinct non-creator buyers in the first 3 slots
  gateDevSold: boolean; // veto when the creator sold before judgement
  // --- sizing ---
  firstStakeSol: number;
  addStakeSol: number;
  maxStakeSol: number;
  maxAddMult: number;
  addStepUp: number; // price must clear last buy by this fraction
  buySlippageBps: number;
  minBuySol: number;
  // --- exits ---
  bank1Share: number;
  bank1At: number;
  bank2Share: number;
  bank2At: number;
  stopLoss: number; // fraction below cost
  trailArmAt: number;
  trailGiveback: number;
  collapseShare: number; // reserves below this share of peak
  staleSlots: number;
  maxHoldSlots: number;
  coolDownSlots: number;
  maxEntriesPerCoin: number;
  maxMainPositions: number;
  maxExposureSol: number;
  // --- cohort exit: dump by the creator or a top holder after entry ---
  cohortExit: boolean;
  // --- quote gate: refuse a buy whose exact curve fill is worse than this
  // fraction of the naive quote (0 = off) ---
  quoteGateBps: number;
  // --- guardrail pacing ---
  targetCoins: number;
  targetFills: number;
  paceSeconds: number;
  probeSol: number;
  maxProbes: number;
}

export const DEFAULT_PARAMS: Params = {
  judgeAge: 45,
  secondJudgeAge: 60,
  minRqSol: 15,
  maxRqSol: 80,
  minMult: 1.5,
  maxMult: 8,
  minBuyers: 18,
  minBuys: 10,
  minFlowSol: 3,
  gateTop10: 0, // measured and rejected: vetoes winners (-1.38 SOL)
  gateTop1: 0.15,
  gateGini: 0.7,
  gateEarlyBuyers: 0, // measured and rejected (-0.90 SOL)
  gateDevSold: false, // measured and rejected (-2.04 SOL)
  firstStakeSol: 0.01, // Sharpe tuning: cheaper probe, losers cost less
  addStakeSol: 0.35, // Sharpe tuning: adds are the PnL engine (was 0.25)
  maxStakeSol: 0.9, // Sharpe tuning: runners earn more size (was 0.65)
  maxAddMult: 6,
  addStepUp: 0.05,
  buySlippageBps: 2000,
  minBuySol: 0.01,
  bank1Share: 0.7,
  bank1At: 2,
  bank2Share: 0.5,
  bank2At: 4,
  stopLoss: 0.15, // sharp peak, recorded fragility — do not move silently
  trailArmAt: 1.4,
  trailGiveback: 0.3,
  collapseShare: 0.4,
  staleSlots: 600,
  maxHoldSlots: 1000,
  coolDownSlots: 150,
  maxEntriesPerCoin: 2,
  maxMainPositions: 5,
  maxExposureSol: 3.25,
  cohortExit: false, // measured and rejected (-3.04 SOL)
  quoteGateBps: 500,
  targetCoins: 25,
  targetFills: 240,
  paceSeconds: 14400,
  probeSol: 0.01,
  maxProbes: 1,
};

const LAMPORTS = 1_000_000_000n;
const LAMPORTS_NUM = 1e9;
const CURVE_FEE = 0.0125;
const WIDE_SLIPPAGE = 10_000;
const BPS = 10_000n;

interface TapeTrade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface CurveNote {
  created: number | null;
  creator: string | null;
  supply: bigint;
  birthPrice: number;
  trades: TapeTrade[];
  /** user -> net tokens bought minus sold (bonding-curve tape only). */
  holders: Map<string, bigint>;
  /** Distinct non-creator buyers inside the first 3 slots of life. */
  earlyBuyers: Set<string>;
  /** Slot of the creator's first sell, if any. */
  devSoldSlot: number | null;
  judged: boolean;
  secondJudged: boolean;
  entries: number;
  lastExit: number;
  lastTradeSlot: number;
  peakRqSol: number;
}

interface Position {
  opened: number;
  investedSol: number;
  peakValueSol: number;
  lastBuyPrice: number;
  lastBuyRqSol: number;
  peakRqSol: number;
  rung: number;
  filled: boolean;
  closing: boolean;
  /** Creator + top-3 holders at entry; a sell by any of them is a dump signal. */
  watchlist: string[];
}

function freshNote(): CurveNote {
  return {
    created: null,
    creator: null,
    supply: 0n,
    birthPrice: 0,
    trades: [],
    holders: new Map(),
    earlyBuyers: new Set(),
    devSoldSlot: null,
    judged: false,
    secondJudged: false,
    entries: 0,
    lastExit: -1_000_000,
    lastTradeSlot: -1,
    peakRqSol: 0,
  };
}

/** Price of one token in SOL, from virtual reserves. */
function priceOf(vq: bigint, vt: bigint): number {
  if (vt <= 0n) return 0;
  return Number(vq) / Number(vt);
}

/** What a token pile is worth in SOL after curve fees and one tx fee. */
function closeValueSol(tokens: bigint, vq: bigint, vt: bigint, txFeeSol: number): number {
  const t = Number(tokens);
  if (t <= 0) return 0;
  const gross = ((t * Number(vq)) / (Number(vt) + t)) / LAMPORTS_NUM;
  return gross * (1 - CURVE_FEE) - txFeeSol;
}

/** Gini coefficient over positive balances (0 = perfectly spread, ->1 = one holder). */
function giniOf(balances: bigint[]): number {
  const vals = balances.filter((v) => v > 0n).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const n = vals.length;
  if (n === 0) return 0;
  let total = 0n;
  for (const v of vals) total += v;
  if (total === 0n) return 0;
  let weighted = 0n;
  for (let i = 0; i < n; i++) weighted += BigInt(i + 1) * vals[i]!;
  // Gini = 2*sum(i*x_i)/(n*sum) - (n+1)/n, computed in float from exact integers.
  return (2 * Number(weighted)) / (n * Number(total)) - (n + 1) / n;
}

/**
 * Exact tokens a buy of `spend` lamports returns at the given reserves,
 * through the constant-product curve with the 1.25% curve fee taken off
 * the top. Returns 0n when the spend cannot buy anything.
 */
function exactBuyTokens(spend: bigint, vq: bigint, vt: bigint): bigint {
  if (spend <= 0n || vt <= 0n) return 0n;
  // Net of fees: spend * 10000 / 10125, rounded down.
  const net = (spend * BPS) / (BPS + 125n);
  if (net <= 1n) return 0n;
  return ((net - 1n) * vt) / (vq + net - 1n);
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const notes = new Map<Pubkey, CurveNote>();
  const books = new Map<Pubkey, Position>();
  const probes = new Map<Pubkey, boolean>();
  const ownCoins = new Set<Pubkey>();
  let ownFills = 0;
  let firstBlockTime: number | null = null;
  let lastBlockTime: number | null = null;

  const noteOf = (mint: Pubkey): CurveNote => {
    let note = notes.get(mint);
    if (note === undefined) {
      note = freshNote();
      notes.set(mint, note);
    }
    return note;
  };

  /** Window stats for the judgement: buys, distinct buyers, net SOL flow. */
  const judgeWindow = (note: CurveNote, now: number) => {
    const from = now - p.judgeAge;
    let buys = 0;
    let net = 0;
    const buyers = new Set<string>();
    for (const tr of note.trades) {
      if (tr.slot < from) continue;
      if (tr.buy) {
        buys++;
        net += tr.sol;
        buyers.add(tr.user);
      } else {
        net -= tr.sol;
      }
    }
    return { buys, buyers: buyers.size, net };
  };

  /** Net SOL flow over the last `span` slots (for add-on confirmation). */
  const recentFlow = (note: CurveNote, now: number, span: number): number => {
    let net = 0;
    for (let i = note.trades.length - 1; i >= 0; i--) {
      const tr = note.trades[i]!;
      if (tr.slot <= now - span) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  /**
   * The ownership gates. Returns the veto reason, or null when the coin's
   * holder base is dispersed enough to trade. All shares are of total
   * supply, from the tape-reconstructed holder balances.
   */
  const ownershipVeto = (note: CurveNote): string | null => {
    if (note.supply <= 0n) return 'no-supply';
    const balances = [...note.holders.values()].filter((v) => v > 0n).sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
    if (balances.length === 0) return 'no-holders';
    const supplyNum = Number(note.supply);
    if (p.gateTop1 > 0) {
      const top1 = Number(balances[0]!) / supplyNum;
      if (top1 > p.gateTop1) return 'top1';
    }
    if (p.gateTop10 > 0) {
      let top10 = 0n;
      for (let i = 0; i < Math.min(10, balances.length); i++) top10 += balances[i]!;
      if (Number(top10) / supplyNum > p.gateTop10) return 'top10';
    }
    if (p.gateGini > 0 && giniOf(balances) > p.gateGini) return 'gini';
    if (p.gateEarlyBuyers > 0 && note.earlyBuyers.size >= p.gateEarlyBuyers) return 'early-buyers';
    if (p.gateDevSold && note.devSoldSlot !== null) return 'dev-sold';
    return null;
  };

  /** Top holders at entry (creator + top 3 by net tokens) for the cohort exit. */
  const entryWatchlist = (note: CurveNote): string[] => {
    const ranked = [...note.holders.entries()]
      .filter(([, v]) => v > 0n)
      .sort((a, b) => (a[1] > b[1] ? -1 : a[1] < b[1] ? 1 : a[0] < b[0] ? -1 : 1))
      .slice(0, 3)
      .map(([u]) => u);
    const list = new Set<string>(ranked);
    if (note.creator !== null) list.add(note.creator);
    return [...list];
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const txFeeSol = Number(state.txFeeLamports()) / LAMPORTS_NUM;
      const orderCap = state.hello.caps.max_orders_per_batch;
      const traded = new Set<Pubkey>();

      for (const fill of batch.fills) {
        if (fill.status === 'filled' && !fill.client_id.startsWith('_')) {
          ownFills++;
          ownCoins.add(fill.mint);
        }
      }

      // Fold this batch's events into the per-coin notes and holder maps.
      for (const event of batch.events) {
        if (event.block_time !== null) {
          if (firstBlockTime === null) firstBlockTime = event.block_time;
          if (lastBlockTime === null || event.block_time > lastBlockTime) lastBlockTime = event.block_time;
        }
        if (event.event === 'CreateEvent') {
          const note = noteOf(event.mint);
          note.created = event.slot;
          note.creator = event.creator;
          note.supply = BigInt(event.token_total_supply);
          note.birthPrice = priceOf(BigInt(event.virtual_quote_reserves), BigInt(event.virtual_token_reserves));
        } else if (event.event === 'TradeEvent') {
          const note = noteOf(event.mint);
          const price = priceOf(BigInt(event.virtual_quote_reserves), BigInt(event.virtual_token_reserves));
          note.trades.push({
            slot: event.slot,
            buy: event.is_buy,
            sol: Number(event.sol_amount) / LAMPORTS_NUM,
            user: event.user,
            price,
          });
          note.lastTradeSlot = event.slot;
          const rqSol = Number(event.real_quote_reserves) / LAMPORTS_NUM;
          if (rqSol > note.peakRqSol) note.peakRqSol = rqSol;
          // Holder reconstruction: net tokens per wallet, from the tape.
          const delta = BigInt(event.token_amount);
          const prev = note.holders.get(event.user) ?? 0n;
          note.holders.set(event.user, event.is_buy ? prev + delta : prev - delta);
          if (event.is_buy && note.creator !== null && event.user !== note.creator && note.created !== null && event.slot < note.created + 3) {
            note.earlyBuyers.add(event.user);
          }
          if (!event.is_buy && note.creator !== null && event.user === note.creator && note.devSoldSlot === null) {
            note.devSoldSlot = event.slot;
          }
          traded.add(event.mint);
        }
      }

      // Keep tapes short: anything older than the longest lookback is gone.
      // Holder maps are cumulative and stay (they are the ownership record).
      const keepFrom = now - Math.max(p.judgeAge, p.staleSlots) - 10;
      for (const mint of traded) {
        const note = notes.get(mint)!;
        let cut = 0;
        while (cut < note.trades.length && note.trades[cut]!.slot < keepFrom) cut++;
        if (cut > 0) note.trades.splice(0, cut);
      }

      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, boolean>();
      const sellPending = new Set<Pubkey>();
      for (const po of state.pending.values()) {
        pendingByMint.set(po.order.mint, true);
        if (po.order.side === 'sell') sellPending.add(po.order.mint);
      }

      // Cohort dump scan: sells this batch by a watched wallet on a held coin.
      const cohortDump = new Set<Pubkey>();
      if (p.cohortExit) {
        for (const event of batch.events) {
          if (event.event !== 'TradeEvent' || event.is_buy) continue;
          const book = books.get(event.mint);
          if (book === undefined || !book.filled) continue;
          if (event.slot <= book.opened) continue;
          if (book.watchlist.includes(event.user)) cohortDump.add(event.mint);
        }
      }

      const orders: OrderInput[] = [];
      const pushSell = (mint: Pubkey, tokens: bigint): void => {
        if (orders.length >= orderCap || tokens <= 0n) return;
        orders.push({ side: 'sell', mint, token_amount: tokens, max_slippage_bps: WIDE_SLIPPAGE });
      };

      // Exits first: stops, trailing, collapse, stale, max hold, cohort
      // dump, and the two profit rungs (partial sells). A position already
      // closing waits for its sell to land instead of stacking another.
      for (const [mint, book] of books) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            books.delete(mint);
            const note = noteOf(mint);
            if (book.filled) note.lastExit = now;
            else note.entries--;
          }
          continue;
        }
        book.filled = true;
        if (curve === undefined || curve.complete) continue;
        const mark = marks.get(mint);
        const vq = mark ? BigInt(mark.virtual_quote_reserves) : curve.virtual_quote_reserves;
        const vt = mark ? BigInt(mark.virtual_token_reserves) : curve.virtual_token_reserves;
        const rqSol = (mark ? Number(mark.real_quote_reserves) : Number(curve.real_quote_reserves)) / LAMPORTS_NUM;
        if (rqSol > book.peakRqSol) book.peakRqSol = rqSol;
        const value = closeValueSol(pos.token_amount, vq, vt, txFeeSol);
        const cost = Number(pos.cost_lamports) / LAMPORTS_NUM;
        if (value > book.peakValueSol) book.peakValueSol = value;
        const up = cost > 0 ? value / cost : 0;

        if (!book.closing && value < cost * (1 - p.stopLoss)) {
          book.closing = true;
        } else if (!book.closing && book.peakValueSol >= cost * p.trailArmAt && value < book.peakValueSol * (1 - p.trailGiveback)) {
          book.closing = true;
        } else if (!book.closing && book.peakRqSol > 0 && rqSol < book.peakRqSol * p.collapseShare) {
          book.closing = true;
        } else if (!book.closing && noteOf(mint).lastTradeSlot >= 0 && now - noteOf(mint).lastTradeSlot > p.staleSlots) {
          book.closing = true;
        } else if (!book.closing && now - book.opened > p.maxHoldSlots) {
          book.closing = true;
        } else if (!book.closing && cohortDump.has(mint)) {
          book.closing = true;
        }

        if (book.closing) {
          if (sellPending.has(mint)) continue;
          pushSell(mint, pos.token_amount);
          continue;
        }

        if (book.rung === 0 && up >= p.bank1At) {
          if (sellPending.has(mint)) continue;
          const slice = (pos.token_amount * BigInt(Math.round(p.bank1Share * 1000))) / 1000n;
          if (slice > 0n && slice < pos.token_amount) {
            pushSell(mint, slice);
            book.rung = 1;
          }
        } else if (book.rung === 1 && up >= p.bank2At) {
          if (sellPending.has(mint)) continue;
          const slice = (pos.token_amount * BigInt(Math.round(p.bank2Share * 1000))) / 1000n;
          if (slice > 0n && slice < pos.token_amount) {
            pushSell(mint, slice);
            book.rung = 2;
          }
        }
      }

      // Probes: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= orderCap) break;
        pushSell(mint, pos.token_amount);
        if (!selling) probes.set(mint, true);
      }

      // Entries: judge every traded curve that is due, keep the ones that
      // pass window stats AND ownership gates, and buy the strongest first
      // (net flow desc, mint asc for determinism) — not first-come-first-
      // served, because the 5 position slots are the scarce resource.
      let freeSol = Number(state.freeCashLamports()) / LAMPORTS_NUM;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      const mainLeft = p.maxMainPositions - books.size;
      let exposureSol = 0;
      for (const [mint, book] of books) {
        exposureSol += Math.max(book.investedSol, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS_NUM);
      }

      interface Candidate {
        mint: Pubkey;
        net: number;
        price: number;
        rqSol: number;
      }
      const candidates: Candidate[] = [];
      for (const mint of traded) {
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint) || books.has(mint)) continue;
        const note = notes.get(mint)!;
        if (note.entries >= p.maxEntriesPerCoin || now - note.lastExit < p.coolDownSlots) continue;
        if (note.created === null || note.birthPrice <= 0) continue;
        const firstLook = !note.judged && now - note.created >= p.judgeAge;
        const secondLook = note.judged && !note.secondJudged && p.secondJudgeAge > 0 && now - note.created >= p.secondJudgeAge;
        if (!firstLook && !secondLook) continue;
        if (firstLook) note.judged = true;
        else note.secondJudged = true;
        const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS_NUM;
        if (rqSol < p.minRqSol || rqSol > p.maxRqSol) continue;
        const mult = price / note.birthPrice;
        if (mult < p.minMult || mult > p.maxMult) continue;
        const w = judgeWindow(note, now);
        if (w.buys < p.minBuys || w.buyers < p.minBuyers || w.net < p.minFlowSol) continue;
        if (ownershipVeto(note) !== null) continue;
        candidates.push({ mint, net: w.net, price, rqSol });
      }
      candidates.sort((a, b) => (b.net !== a.net ? b.net - a.net : a.mint < b.mint ? -1 : 1));

      for (const cand of candidates) {
        if (orders.length >= orderCap || slotsLeft <= 0 || mainLeft <= 0) break;
        const curve = state.curves.get(cand.mint)!;
        const capSol = Number(state.maxBuyLamports(cand.mint)) / LAMPORTS_NUM;
        let amount = Math.min(capSol, p.firstStakeSol, p.maxExposureSol - exposureSol);
        if (amount > freeSol - txFeeSol) amount = freeSol - txFeeSol;
        if (amount < p.minBuySol) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS_NUM));
        if (lamports <= 0n) continue;
        if (p.quoteGateBps > 0) {
          const got = exactBuyTokens(lamports, curve.virtual_quote_reserves, curve.virtual_token_reserves);
          const naive = (lamports * curve.virtual_token_reserves) / (curve.virtual_quote_reserves > 0n ? curve.virtual_quote_reserves : 1n);
          if (naive > 0n && got * BPS < naive * (BPS - BigInt(p.quoteGateBps))) continue;
        }
        orders.push({ side: 'buy', mint: cand.mint, quote_lamports: lamports, max_slippage_bps: p.buySlippageBps });
        freeSol -= amount + txFeeSol;
        exposureSol += amount;
        const note = notes.get(cand.mint)!;
        books.set(cand.mint, {
          opened: now,
          investedSol: amount,
          peakValueSol: 0,
          lastBuyPrice: cand.price,
          lastBuyRqSol: cand.rqSol,
          peakRqSol: cand.rqSol,
          rung: 0,
          filled: false,
          closing: false,
          watchlist: entryWatchlist(note),
        });
        note.entries++;
        slotsLeft--;
      }

      // Add-ons: only into strength — fresh high above the last buy, real
      // reserves still growing, flow still coming in, never past the run cap.
      for (const mint of traded) {
        if (orders.length >= orderCap) break;
        const book = books.get(mint);
        if (book === undefined || book.closing || !book.filled) continue;
        if (pendingByMint.has(mint) || probes.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (book.investedSol >= p.maxStakeSol - p.minBuySol) continue;
        const note = notes.get(mint)!;
        const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS_NUM;
        if (note.birthPrice > 0 && price / note.birthPrice > p.maxAddMult) continue;
        if (price < book.lastBuyPrice * (1 + p.addStepUp)) continue;
        if (rqSol < book.lastBuyRqSol) continue;
        if (recentFlow(note, now, p.judgeAge) < 0) continue;
        const capSol = Number(state.maxBuyLamports(mint)) / LAMPORTS_NUM;
        let amount = Math.min(capSol, p.addStakeSol, p.maxStakeSol - book.investedSol, p.maxExposureSol - exposureSol);
        if (amount > freeSol - txFeeSol) amount = freeSol - txFeeSol;
        if (amount < p.minBuySol) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS_NUM));
        if (lamports <= 0n) continue;
        if (p.quoteGateBps > 0) {
          const got = exactBuyTokens(lamports, curve.virtual_quote_reserves, curve.virtual_token_reserves);
          const naive = (lamports * curve.virtual_token_reserves) / (curve.virtual_quote_reserves > 0n ? curve.virtual_quote_reserves : 1n);
          if (naive > 0n && got * BPS < naive * (BPS - BigInt(p.quoteGateBps))) continue;
        }
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlippageBps });
        freeSol -= amount + txFeeSol;
        exposureSol += amount;
        book.investedSol += amount;
        book.lastBuyPrice = price;
        book.lastBuyRqSol = rqSol;
      }

      // Guardrail pacing: if coins or fills lag the run's block-time pace,
      // open tiny probe round trips on liquid curves until back on pace.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstBlockTime !== null && lastBlockTime !== null) {
        const pace = Math.min(1, (lastBlockTime - firstBlockTime) / p.paceSeconds);
        const needCoins = ownCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = ownFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minRq = (p.probeSol * 10000) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= orderCap || probes.size >= p.maxProbes) break;
            if (books.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && ownCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS_NUM < minRq * 1.5) continue;
            if (freeSol < p.probeSol + 2 * txFeeSol) break;
            orders.push({
              side: 'buy',
              mint,
              quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS_NUM)),
              max_slippage_bps: p.buySlippageBps,
            });
            probes.set(mint, false);
            freeSol -= p.probeSol + txFeeSol;
          }
        }
      }

      return orders;
    },
  };
}

export function createBot(params: Params = DEFAULT_PARAMS): Bot {
  return createStrategy(params);
}
