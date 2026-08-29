---
name: access-manager-roles
description: Regenerate the AccessManager role membership table, grouped by address, for any deployed chain (mainnet, sepolia, …). Use this whenever the user asks who holds which AccessManager roles, wants the role membership table refreshed, asks "which wallets have ADMIN/MANAGER/OPERATOR/PAUSER/MINTER", or wants to audit role grants/revocations or function-role wiring on the deployed contracts — even if they just say "show me the roles" or paste the AccessManager's Etherscan link.
---

# AccessManager role membership table

Produce a current-membership table for the deployed AccessManager(s) by replaying
`RoleGranted` / `RoleRevoked` events, grouped by address.

## Step 1 — Run the audit script (deterministic, all chains)

```bash
npm run roles:audit
```

Add `-- --chain 1` to limit to one chain id. The script
(`scripts/access-manager-events.ts`):

- discovers every `ignition/deployments/chain-<id>/` with an
  `AccessManagerModule#AccessManager` entry,
- fetches the complete event history via `eth_getLogs` (RPC resolved like
  hardhat.config: `RPC_URL_<NETWORK>` override, else Alchemy via `ALCHEMY_API_KEY`),
- replays grants/revokes into current membership and applies last-wins semantics to
  `TargetFunctionRoleUpdated`, and
- prints JSON: per chain `membership` (sorted by address, with role names from
  `ignition/modules/hook/roles.ts`), `roleLabels`, and `functionRoles` per target.

A transient RPC timeout on the full-range `eth_getLogs` (most likely on mainnet) is
worth one or two retries before concluding anything is broken.

Fallback if no RPC credentials are available or RPC keeps failing: scrape the Etherscan events tab in the
Browser pane. The event list lives in a same-origin iframe — extract with
`javascript_tool`: `document.getElementById('eventsIframe').contentDocument.body.innerText`
(the `#events` URL hash does not activate the tab; click it first). Etherscan shows only
the latest 20 events, so only trust that view if the oldest visible event is the
contract-creation `RoleGranted` of role 0; otherwise say the history is truncated.

## Step 2 — Label the addresses

Label contract addresses from
`ignition/deployments/chain-<id>/deployed_addresses.json` (SLP,
UniswapHook, SlpOracle, …). Mark the deployer: authoritatively, it's the `"from"`
address in `ignition/deployments/chain-<id>/journal.jsonl` (the constructor also grants
it role 0, so it has the lowest block in the output). For unknown EOAs, grep the repo;
if absent, say they don't appear in the repo rather than speculating which wallet they
are.

## Step 3 — Render

| Address | Roles | Notes |
|---|---|---|
| `0x…` | ADMIN (0), MINTER (4) | Deployer EOA — granted at deployment |
| `0x…` | MINTER (4) | UniswapHook contract — mints/burns SLP |

One table per chain when auditing several. After the table, mention anything
security-relevant you noticed in passing: addresses holding many roles (especially
ADMIN + others), revocations, non-zero `delay` values (all grants so far have
`delay: 0` — call it out if that changes), or function-role remappings. Remember role 0
is AccessManager's built-in ADMIN and unmapped selectors (e.g. `upgradeToAndCall`)
default to it.
