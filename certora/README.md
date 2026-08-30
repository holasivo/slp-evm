# Certora Formal Verification

Formal verification specs for the Sivo SLP protocol using the [Certora Prover](https://www.certora.com/).
The specs verify the **queue solvency** of the oracle-priced Uniswap v4 hook that custodies user funds.

> The specs for the retired Vault/Share stack (ERC-4626/7540/7575, RWA
> deploy/recall, accrual time evolution) were removed together with those
> contracts; see the git history if you need them.

## Overview

The SLP protocol has two owned contracts: **SLP** (a plain UUPS ERC-20 share
token) and **UniswapHook** (one Uniswap v4 hook serving the SLP/USDC and
SLP/USDT pools). Deposits swap a stablecoin for freshly minted SLP at the
Chainlink NAV price; exits queue SLP in the hook's asynchronous FIFO
withdrawal queue, filled at the oracle price current at fill time.

### Specifications

| Spec                           | Conf                          | Description                                                                                                                                                                                           |
| ------------------------------ | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`hook.spec`](specs/hook.spec) | [`hook.conf`](conf/hook.conf) | UniswapHook queue solvency: claim reserves always backed by the hook's stablecoin balance, queued SLP always backed by the hook's SLP balance, sweep can never touch reserves or target the SLP token |

## Getting Started

### 1. Install the Certora Prover

Follow the official installation guide: [Certora Installation](https://docs.certora.com/en/latest/docs/user-guide/getting-started/install.html)

```bash
pip install certora-cli
```

After installation, set your Certora key as an environment variable:

```bash
export CERTORAKEY=<your-certora-key>
```

### 2. Install Solidity Dependencies

Make sure the project dependencies are installed from the repository root:

```bash
npm install
```

### 3. Run the Specifications

All commands must be run from the repository root:

```bash
certoraRun certora/conf/hook.conf
```

Each run will return a link to the Certora verification dashboard where you can inspect results once verification is complete. To build and typecheck locally without submitting (no key required):

```bash
certoraRun certora/conf/hook.conf --compilation_steps_only
```

## Project Structure

```
certora/
├── conf/
│   └── hook.conf          # Configuration for UniswapHook queue-solvency verification
├── specs/
│   └── hook.spec          # UniswapHook queue-solvency rules
└── README.md
```

## Verified Contracts

The spec verifies the following scene together:

- **`CertoraUniswapHookHarness.sol`** — Harness over `UniswapHook` (see its
  header for the `isSupportedAsset` equivalence rationale)
- **`SLP.sol`** — The SLP share token (plain UUPS ERC-20)
- **`Asset.sol` / `CertoraAssetB.sol`** — The two in-scene stablecoin instances
- **`OracleHarness.sol`** — Mock Chainlink feed

The Uniswap v4 PoolManager is intentionally out of scene; see the
summarization rationale in `hook.spec`.

## Properties Verified

### UniswapHook Queue Solvency (`hook.spec`)

- **Claim reserve backing** — For each supported stablecoin, the hook's
  physical balance covers `totalClaimableAssets` after every external method
  (parametric, including the PoolManager-driven `beforeSwap`): filled
  withdrawals can always be claimed
- **Queued SLP backing** — The hook's SLP balance covers the total unfilled
  queued SLP across both asset queues after every external method:
  cancellations can always return the caller's SLP
- **Sweep safety** — `sweep` never changes any claim reserve, never leaves a
  reserve unbacked, and always reverts when targeting the SLP token (backed
  by `initialize`'s `UniswapHookInvalidAssetConfig` distinctness validation)

The same invariants are exercised dynamically by the randomized-sequence
block in `test/UniswapHook.test.ts` ("solvency invariants").

## Additional Resources

- [Certora Prover Documentation](https://docs.certora.com/en/latest/)
- [CVL Language Reference](https://docs.certora.com/en/latest/docs/cvl/index.html)
- [Uniswap v4 Hooks](https://docs.uniswap.org/contracts/v4/concepts/hooks)
