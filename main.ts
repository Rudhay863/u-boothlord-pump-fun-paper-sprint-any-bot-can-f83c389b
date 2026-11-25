// Pump.fun Paper Sprint — reserve-gated momentum bot (fresh implementation).
//
// Strategy (simple, robust, built for a 6-hour window):
//   * BUY PROVEN COINS ONLY. A coin is bought the first time its real SOL
//     reserves reach 20 SOL (and it has at least 5 trades): 20 SOL of net
//     buying means real demand, not a blip, and the 1%-of-reserves order
//     cap then allows a meaningful ~0.18 SOL buy. At the same time the
//     coin must still be rising (price up >= 2% since its first trade)
//     with buyers in control (>= 50% of the last 5 trades' SOL volume
//     was buys). Each coin is considered for entry exactly once. Cheap
//     early tickets on thin coins lose money: thin coins gap-crash straight
//     through any stop-loss, while reserve-backed coins hold their levels.
//   * Size up to 0.4 SOL, capped at 90% of the per-mint order-size cap
//     (1% of real reserves), at most 5 open positions.
//   * SELL on take-profit +100%, stop-loss -20%, a 25% trailing stop once
//     a position is +30% up, a time stop (sell after 100 trades held
//     unless up at least +3%), or a dead-coin stop (sell when the coin
//     has not traded for 10,000 slots: a silent coin never pumps again,
//     and holding it only blocks one of the 5 slots).
//   * A round trip costs ~1.25% in curve fees per side plus 105,000
//     lamports of transaction fees, so exits are wide enough that fees
//     never decide a trade.
//
// Determinism: no clock, no Math.random, no environment reads. All decisions
// come from the harness stream (slots, reserves, trade counts) only, so two
// executions produce byte-identical action logs.

import { runBot } from './vendor/makefun-bot.ts';
import type { Batch, BotState } from './vendor/makefun-bot.ts';

// ---- tunables -------------------------------------------------------------
const BUY_SIZE_LAMPORTS = 400_000_000n; // 0.4 SOL per position (cap-bound)
const MIN_BUY_LAMPORTS = 50_000_000n; // 0.05 SOL: below this, skip the coin
const MAX_POSITIONS = 5;
const MIN_TRADES = 5; // trades before a coin can be bought
const MIN_REAL_RESERVES_SOL = 20; // buy once real reserves first reach this
const ENTRY_BUY_SHARE = 0.5; // >= 50% of last-5-trades SOL volume was buys
const ENTRY_MIN_RISE = 0.02; // price up >= 2% from first trade
const TAKE_PROFIT = 2.0; // +200%
const STOP_LOSS = -0.2; // -20%
const TRAIL_ARM = 0.3; // trailing stop arms once +30% up
const TRAIL_DROP = 0.4; // sell on a 40% fall from the peak
const MAX_HOLD_TRADES = 100; // time stop, in trades on that mint
const TIME_STOP_MIN_GAIN = 0.03; // sell at time stop unless up >= +3%
const DEAD_SLOTS = 10000; // sell a coin that has not traded for this many slots
const SLIPPAGE_BPS = 500; // 5% max slippage

// ---- per-mint tracking ----------------------------------------------------
interface Coin {
  trades: number; // total trades seen
  buySol: number[]; // SOL volume of buys, last 5 trades
  sellSol: number[]; // SOL volume of sells, last 5 trades
  firstPrice: number; // price at the first trade seen
  considered: boolean; // entry already evaluated once
  traded: boolean; // we have bought (and sold) this coin
  lastTradeSlot: number; // slot of its most recent trade
}

interface Position {
  mint: string;
  entryCost: bigint; // lamports spent (fees included) at buy fill
  tokens: bigint;
  entryPrice: number; // price at buy time
  peakGain: number; // best mark-to-market gain seen
  entryTrades: number; // mint trade count at entry
}

const coins = new Map<string, Coin>();
const held = new Map<string, Position>();

function priceOf(vQuote: bigint, vToken: bigint): number {
  if (vToken === 0n) return 0;
  return Number(vQuote) / Number(vToken);
}

function getCoin(mint: string): Coin {
  let c = coins.get(mint);
  if (!c) {
    c = {
      trades: 0,
      buySol: [],
      sellSol: [],
      firstPrice: 0,
      considered: false,
      traded: false,
      lastTradeSlot: 0,
    };
    coins.set(mint, c);
  }
  return c;
}

function markPrice(state: BotState, mint: string): number {
  const curve = state.curves.get(mint);
  if (!curve) return 0;
  return priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
}

type OrderInput = {
  side: 'buy' | 'sell';
  mint: string;
  quote_lamports?: bigint;
  token_amount?: bigint;
  max_slippage_bps: number;
};

await runBot({
  onBatch(state: BotState, batch: Batch) {
    const orders: OrderInput[] = [];

    // 1. Fold this batch's events into per-coin history. A coin becomes a
    // candidate in the batch where its real reserves first reach the bar.
    const candidates: string[] = [];
    for (const e of batch.events) {
      if (e.event === 'TradeEvent') {
        const c = getCoin(e.mint);
        c.lastTradeSlot = e.slot;
        c.trades += 1;
        if (c.trades === 1) {
          c.firstPrice = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
        }
        const sol = Number(BigInt(e.sol_amount)) / 1e9;
        c.buySol.push(e.is_buy ? sol : 0);
        c.sellSol.push(e.is_buy ? 0 : sol);
        if (c.buySol.length > 5) c.buySol.shift();
        if (c.sellSol.length > 5) c.sellSol.shift();
        const realSol = Number(BigInt(e.real_sol_reserves)) / 1e9;
        if (
          !c.considered &&
          !c.traded &&
          c.trades >= MIN_TRADES &&
          realSol >= MIN_REAL_RESERVES_SOL
        ) {
          candidates.push(e.mint);
        }
      }
    }

    // 2. Sync held positions with the harness account (fills, flatten closes).
    const live = new Map<string, { tokens: bigint; cost: bigint }>();
    for (const p of state.account.positions) {
      live.set(p.mint, { tokens: BigInt(p.token_amount), cost: BigInt(p.cost_lamports) });
    }
    for (const [mint] of [...held]) {
      if (!live.has(mint)) {
        getCoin(mint).traded = true;
        held.delete(mint);
      }
    }
    for (const [mint, p] of live) {
      if (!held.has(mint)) {
        const c = getCoin(mint);
        held.set(mint, {
          mint,
          entryCost: p.cost,
          tokens: p.tokens,
          entryPrice: markPrice(state, mint),
          peakGain: 0,
          entryTrades: c.trades,
        });
      } else {
        const pos = held.get(mint)!;
        pos.tokens = p.tokens;
        pos.entryCost = p.cost;
      }
    }

    const pendingSell = new Set<string>();
    const pendingBuy = new Set<string>();
    for (const p of state.pending.values()) {
      if (p.order.side === 'sell') pendingSell.add(p.order.mint);
      else pendingBuy.add(p.order.mint);
    }

    // 3. Exits first: free slots before considering new entries.
    for (const [mint, pos] of [...held]) {
      if (pendingSell.has(mint)) continue; // sell already in flight
      const price = markPrice(state, mint);
      if (price <= 0 || pos.entryPrice <= 0) continue;
      const valueSol = (Number(pos.tokens) * price) / 1e9;
      const costSol = Number(pos.entryCost) / 1e9;
      const gain = valueSol / costSol - 1;
      if (gain > pos.peakGain) pos.peakGain = gain;
      const c = coins.get(mint);
      const heldTrades = c ? c.trades - pos.entryTrades : 0;

      let sell = false;
      if (gain >= TAKE_PROFIT) sell = true;
      else if (gain <= STOP_LOSS) sell = true;
      else if (pos.peakGain >= TRAIL_ARM && gain <= pos.peakGain - TRAIL_DROP) sell = true;
      else if (heldTrades >= MAX_HOLD_TRADES && gain < TIME_STOP_MIN_GAIN) sell = true;
      else if (c && batch.slot - c.lastTradeSlot > DEAD_SLOTS) sell = true;

      if (sell) {
        orders.push({
          side: 'sell',
          mint,
          token_amount: pos.tokens,
          max_slippage_bps: SLIPPAGE_BPS,
        });
        held.delete(mint);
        getCoin(mint).traded = true;
      }
    }

    // 4. Entries: one buy per proven coin, sized within the order cap.
    const openCount = state.committedPositionCount();
    if (openCount < MAX_POSITIONS) {
      let slots = MAX_POSITIONS - openCount;
      for (const mint of candidates) {
        if (slots <= 0) break;
        const c = coins.get(mint)!;
        c.considered = true;
        if (held.has(mint) || pendingBuy.has(mint) || c.traded) continue;
        const curve = state.curves.get(mint);
        if (!curve || curve.complete) continue;
        let buys = 0;
        let sells = 0;
        for (let i = 0; i < c.buySol.length; i++) {
          buys += c.buySol[i];
          sells += c.sellSol[i];
        }
        if (buys + sells <= 0) continue;
        if (buys / (buys + sells) < ENTRY_BUY_SHARE) continue;
        const price = markPrice(state, mint);
        if (c.firstPrice <= 0 || price <= 0) continue;
        if (price / c.firstPrice - 1 < ENTRY_MIN_RISE) continue;

        const cap = state.maxBuyLamports(mint);
        let size = BUY_SIZE_LAMPORTS;
        const capLimit = (cap * 90n) / 100n;
        if (size > capLimit) size = capLimit;
        if (size < MIN_BUY_LAMPORTS) continue;
        if (state.freeCashLamports() < size + state.txFeeLamports()) continue;

        orders.push({
          side: 'buy',
          mint,
          quote_lamports: size,
          max_slippage_bps: SLIPPAGE_BPS,
        });
        c.traded = true;
        slots -= 1;
      }
    }
    // Mark the rest of this batch's candidates considered even when out of
    // slots, so no coin is entered late on a later batch.
    for (const mint of candidates) coins.get(mint)!.considered = true;

    return orders;
  },
});
