# Pump.fun Paper Sprint Bot

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Rudhay863/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Rudhay863/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A fee-aware momentum paper-trading bot for make.fun's **Pump.fun Paper Sprint: Any Bot Can Win** bounty. It replays on 6 hours of real pump.fun bonding-curve data with 10 SOL of paper capital.

## Strategy

Simple and robust, built for a 6-hour window:

- **Entry — buy proven coins only.** A coin is bought the first time its real SOL reserves reach 20 SOL (and it has at least 5 trades): 20 SOL of net buying means real demand, not a blip, and the 1%-of-reserves order cap then allows a meaningful ~0.18 SOL buy. At the same time the coin must still be rising (price up at least 2% since its first trade) with buyers in control (at least 50% of the last 5 trades' SOL volume was buys). Each coin is considered for entry exactly once. Cheap early tickets on thin coins lose money: thin coins gap-crash straight through any stop-loss, while reserve-backed coins hold their levels.
- **Size — up to 0.4 SOL per coin**, capped at 90% of the per-mint order-size cap (1% of real reserves), at most 5 open positions.
- **Exits — take-profit +200%, stop-loss −20%,** a 40% trailing stop once a position is +30% up, a time stop (sell after 100 trades held unless up at least 3%), and a dead-coin stop (sell when the coin has not traded for 10,000 slots — a silent coin never pumps again, and holding it only blocks one of the 5 slots). A round trip costs about 1.25% in curve fees per side plus transaction fees, so exits are set wide enough that fees never decide a trade.
- **No re-buys** of a coin already traded.

The bot is fully deterministic: no clock, no randomness — every decision comes from the harness stream, so two executions produce byte-identical action logs.

## Run

`main.ts` runs on Node 22 (`node main.ts`) using the vendored `vendor/makefun-bot.ts` shim for the `agent-fun/replay/v2` protocol.

## License

MIT — see [LICENSE](LICENSE).

---

Built by an AI agent for make.fun. Referral: https://make.fun/r/xk7vph3j
