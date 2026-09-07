---
name: withdrawal-queue
description: Show the current state of the UniswapHook withdrawal (redeem) queue for USDC and USDT on any deployed chain (mainnet, sepolia, …) — live unfilled requests, pending SLP, claimable stablecoin, hook balance, and the request/fill/cancel/claim history. Use whenever the user asks about the withdrawal queue, redemption queue, pending or unfilled redemptions, "who is waiting to withdraw", how much is claimable or needs replenishing, whether a request was filled, or asks to "show me the queue" — even if they don't name the hook contract.
---

# UniswapHook withdrawal queue

The SLP exit path is an asynchronous, FIFO withdrawal queue on the `UniswapHook`
proxy (`SlpRolesModule#UniswapHook` in `ignition/deployments/chain-<id>/deployed_addresses.json`),
one queue per stablecoin (USDC, USDT). Lifecycle: `requestWithdraw` → filled by
inbound deposits / `fill` / operator `replenish` (price locked at fill) → `claimWithdraw`.

## Step 1 — Run the script

```bash
npm run queue:show -- --chain 1 --pretty
```

Omit `--chain` for every deployed chain; omit `--pretty` for JSON. The script
(`scripts/withdrawal-queue.ts`):

- discovers the hook per chain and reads the two assets from `supportedAssets()`,
- reads the on-chain aggregates: `queueLength` (requests ever queued, i.e. the tail
  index), `totalPendingShares`, `totalClaimableAssets`, `sweepable`, hook token
  balance, `minRequestShares`, `paused`, and the SLP/asset oracle statuses,
- fetches the full `RedeemRequest` / `RedeemClaimable` / `RedeemCancel` / `Withdraw` /
  `UniswapHookReplenish` history via `eth_getLogs` (RPC resolved like hardhat.config:
  `RPC_URL_<NETWORK>` override, else Alchemy via `ALCHEMY_API_KEY`), and
- reconstructs each live request's remaining SLP. The contract has **no per-request
  getter** (only per-controller `pendingWithdraw` / `claimableWithdraw`), so the replay
  applies fills oldest-first and cancels newest-first per controller, exactly like
  `UniswapHook.sol`, then cross-checks against the on-chain views. `checks` is empty
  when everything matches; if it is not, report the mismatch verbatim instead of trusting
  the per-request breakdown.

A transient RPC timeout on the full-range `eth_getLogs` is worth a retry or two.
Fallback without RPC credentials: read the aggregate views on the hook's Etherscan
"Read as Proxy" tab and the events tab (latest 20 events only — say so if truncated).

## Step 2 — Render

Lead with the answer per asset: how many requests are live and how much is still
unfilled, then the table.

| Id | Controller | Requested SLP | Remaining SLP | Requested at | Tx |
|---|---|---|---|---|---|

Then a short aggregate line per asset: pending SLP, claimable stablecoin, hook
balance, sweepable, peg status. Note that `hookBalance − totalClaimableAssets` is the
free stablecoin available to fill (this is what `sweepable` reports), and that
`queueLength` counts requests ever queued, not live ones. Include the history only when
the user asks how a request got to its state or when it explains something odd (e.g. a
partial fill, a cancel).

Label addresses from `deployed_addresses.json` and the repo (e.g. the operator that
called `replenish`); for unknown EOAs say they don't appear in the repo rather than
guessing. Flag anything security- or ops-relevant: `paused=true`, a non-OK oracle or
peg status (fills are blocked while an asset is unpegged), a large pending balance with
zero free stablecoin (operator needs to `replenish`), or claimable funds sitting
unclaimed for a long time.
