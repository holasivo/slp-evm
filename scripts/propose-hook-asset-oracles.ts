/**
 * Proposes the M001 + L002 remediation transactions to the ADMIN Safe:
 *
 *   1. UniswapHook.upgradeToAndCall(<new impl>, "") — install the
 *      implementation that gates deposits and fills on each stablecoin's
 *      own USD feed sitting inside a tight peg band (run `hook:upgrade`
 *      first to deploy it)
 *   2. UniswapHook.setAssetOracle(USDC, <USDC/USD feed>, staleness, band)
 *   3. UniswapHook.setAssetOracle(USDT, <USDT/USD feed>, staleness, band)
 *   4. AccessManager.setTargetFunctionRole(hook, [fill], OPERATOR) — L002
 *   5. AccessManager.setTargetFunctionRole(hook, [setAssetOracle], MANAGER)
 *
 * Between executing (1) and (3) the hook fails closed: deposits and fills
 * revert with UniswapHookAssetOracleUnset until both feeds are configured,
 * so the transactions should be executed back to back. Execution order
 * (enforced by consecutive Safe nonces) also matters for (5): the ADMIN
 * Safe can call setAssetOracle only while the selector is unmapped
 * (unmapped selectors default to ADMIN), so the MANAGER handoff must land
 * after (2) and (3).
 *
 * The hook address is read from SlpRolesModule.hook and the feed
 * configuration from HookProxy.usdc_oracle / HookProxy.usdt_oracle in
 * ignition/parameters/<network>.json. Each feed is sanity-checked on-chain
 * (decimals and a current answer inside the peg band) before anything is
 * proposed. SAFE_ADDRESS must hold ADMIN on the AccessManager (the
 * MANAGER-mapped functions here execute before the mapping exists).
 * Idempotent: steps already satisfied on-chain are skipped.
 *
 *   npx hardhat run scripts/propose-hook-asset-oracles.ts --network mainnet
 */
import type { MetaTransactionData } from '@safe-global/types-kit';
import env from 'env-var';
import { readFileSync } from 'fs';
import hre from 'hardhat';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import {
  Address,
  encodeFunctionData,
  getAddress,
  parseAbi,
  toFunctionSelector,
} from 'viem';

import {
  encodeUpgrade,
  proposeSafeTransaction,
} from '../ignition/modules/helpers.js';
import { HookFunctionRoles, Roles } from '../ignition/modules/hook/roles.js';

const NETWORK_NAMES: Record<number, string> = {
  1: 'mainnet',
  11155111: 'sepolia',
};

/** ERC-1967 implementation slot */
const IMPL_SLOT =
  '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';

const HOOK_ABI = parseAbi([
  'function setAssetOracle(address asset, address oracle, uint256 maxStaleness, int256 pegMin, int256 pegMax)',
  'function assetOracleConfig(address asset) view returns (address oracle, uint8 oracleDecimals, uint256 maxStaleness, int256 pegMin, int256 pegMax)',
]);

const FEED_ABI = parseAbi([
  'function decimals() view returns (uint8)',
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
]);

const ACCESS_MANAGER_ABI = parseAbi([
  'function hasRole(uint64 roleId, address account) view returns (bool isMember, uint32 executionDelay)',
  'function getTargetFunctionRole(address target, bytes4 selector) view returns (uint64)',
  'function setTargetFunctionRole(address target, bytes4[] selectors, uint64 roleId)',
]);

type AssetOracleParams = {
  oracle: Address;
  peg_min: string;
  peg_max: string;
  max_staleness: string;
};

const __dirname = dirname(fileURLToPath(import.meta.url));

const load = <T>(path: string): T =>
  JSON.parse(readFileSync(resolve(__dirname, path), 'utf-8')) as T;

async function main(): Promise<void> {
  const safeAddress = getAddress(env.get('SAFE_ADDRESS').required().asString());

  const n = await hre.network.getOrCreate();
  if (!('url' in n.networkConfig)) throw new Error('HTTP network required');
  const { chainId, url } = n.networkConfig;
  if (!chainId) throw new Error('chainId is required');
  const name = NETWORK_NAMES[chainId];
  if (!name) throw new Error(`no parameters file mapping for chain ${chainId}`);
  const rpcUrl = await url.getUrl();
  const publicClient = await n.viem.getPublicClient();

  const params = load<{
    SlpRolesModule?: { hook?: Address };
    HookProxy?: {
      usdc?: Address;
      usdt?: Address;
      usdc_oracle?: AssetOracleParams;
      usdt_oracle?: AssetOracleParams;
    };
  }>(`../ignition/parameters/${name}.json`);
  const hook = params.SlpRolesModule?.hook;
  const { usdc, usdt, usdc_oracle, usdt_oracle } = params.HookProxy ?? {};
  if (!hook || !usdc || !usdt || !usdc_oracle || !usdt_oracle) {
    throw new Error(`SlpRolesModule/HookProxy incomplete in ${name}.json`);
  }

  const deployed = load<Record<string, Address>>(
    `../ignition/deployments/chain-${chainId}/deployed_addresses.json`,
  );
  const impl = deployed['HookUpgradeImplModule#UniswapHook'];
  if (!impl) throw new Error('run hook:upgrade first to deploy the new impl');
  const accessManager = deployed['AccessManagerModule#AccessManager'];
  if (!accessManager) throw new Error('AccessManager not in deployment');

  console.log(`chain ${chainId}`);
  console.log(`safe: ${safeAddress}`);
  console.log(`hook: ${hook} -> impl ${impl}`);

  // ---- verify the Safe holds the role the proposal needs ------------------
  const [isAdmin] = await publicClient.readContract({
    address: accessManager,
    abi: ACCESS_MANAGER_ABI,
    functionName: 'hasRole',
    args: [Roles.ADMIN, safeAddress],
  });
  if (!isAdmin) {
    throw new Error(
      `SAFE_ADDRESS ${safeAddress} does not hold ADMIN; refusing to propose`,
    );
  }

  // ---- sanity-check both feeds on-chain before wiring them in -------------
  const feedTargets: [string, Address, AssetOracleParams][] = [
    ['USDC', usdc, usdc_oracle],
    ['USDT', usdt, usdt_oracle],
  ];
  for (const [symbol, , cfg] of feedTargets) {
    const [decimals, [, answer]] = await Promise.all([
      publicClient.readContract({
        address: cfg.oracle,
        abi: FEED_ABI,
        functionName: 'decimals',
      }),
      publicClient.readContract({
        address: cfg.oracle,
        abi: FEED_ABI,
        functionName: 'latestRoundData',
      }),
    ]);
    console.log(
      `${symbol}/USD feed ${cfg.oracle}: decimals ${decimals}, answer ${answer}, ` +
        `band [${cfg.peg_min}, ${cfg.peg_max}], staleness ${cfg.max_staleness}s`,
    );
    if (answer < BigInt(cfg.peg_min) || answer > BigInt(cfg.peg_max)) {
      throw new Error(
        `${symbol}/USD feed answer ${answer} is outside the configured peg band; ` +
          `wrong feed address or a live depeg — refusing to propose`,
      );
    }
  }

  // ---- build only the transactions still needed ---------------------------
  const txs: MetaTransactionData[] = [];
  let assetOracleTxNeeded = false;

  const currentImplWord = await publicClient.getStorageAt({
    address: hook,
    slot: IMPL_SLOT,
  });
  const currentImpl = getAddress(`0x${(currentImplWord ?? '0x').slice(-40)}`);
  if (currentImpl === getAddress(impl)) {
    console.log(`1. upgrade: hook already runs ${impl} — skipping`);
  } else {
    console.log(`1. upgradeToAndCall(${impl}, "")`);
    txs.push({ to: hook, value: '0', data: encodeUpgrade(impl) });
  }

  for (const [symbol, asset, cfg] of feedTargets) {
    const configured = await publicClient
      .readContract({
        address: hook,
        abi: HOOK_ABI,
        functionName: 'assetOracleConfig',
        args: [asset],
      })
      .catch(() => null); // pre-upgrade impl has no assetOracleConfig
    if (
      configured &&
      getAddress(configured[0]) === getAddress(cfg.oracle) &&
      configured[2] === BigInt(cfg.max_staleness) &&
      configured[3] === BigInt(cfg.peg_min) &&
      configured[4] === BigInt(cfg.peg_max)
    ) {
      console.log(`setAssetOracle(${symbol}): already configured — skipping`);
      continue;
    }
    console.log(
      `setAssetOracle(${symbol}=${asset}, ${cfg.oracle}, ${cfg.max_staleness}, ` +
        `${cfg.peg_min}, ${cfg.peg_max})`,
    );
    assetOracleTxNeeded = true;
    txs.push({
      to: hook,
      value: '0',
      data: encodeFunctionData({
        abi: HOOK_ABI,
        functionName: 'setAssetOracle',
        args: [
          asset,
          cfg.oracle,
          BigInt(cfg.max_staleness),
          BigInt(cfg.peg_min),
          BigInt(cfg.peg_max),
        ],
      }),
    });
  }

  // ---- role wiring: L002 fill→OPERATOR, M001 setAssetOracle→MANAGER -------
  const roleNames: Record<string, string> = {
    [`${Roles.MANAGER}`]: 'MANAGER',
    [`${Roles.OPERATOR}`]: 'OPERATOR',
    [`${Roles.PAUSER}`]: 'PAUSER',
  };
  const setAssetOracleSelector = toFunctionSelector(
    'function setAssetOracle(address,address,uint256,int256,int256)',
  );
  for (const { role, selectors } of HookFunctionRoles) {
    const current = await Promise.all(
      selectors.map((selector) =>
        publicClient.readContract({
          address: accessManager,
          abi: ACCESS_MANAGER_ABI,
          functionName: 'getTargetFunctionRole',
          args: [hook, selector],
        }),
      ),
    );
    const missing = selectors.filter((_, i) => current[i] !== role);
    if (missing.length === 0) continue;
    console.log(
      `setTargetFunctionRole(hook, [${missing.join(', ')}], ` +
        `${roleNames[`${role}`] ?? role})`,
    );
    txs.push({
      to: accessManager,
      value: '0',
      data: encodeFunctionData({
        abi: ACCESS_MANAGER_ABI,
        functionName: 'setTargetFunctionRole',
        args: [hook, [...missing], role],
      }),
    });
  }

  // The ADMIN Safe can only execute setAssetOracle while the selector is
  // still unmapped (unmapped selectors default to ADMIN); once it maps to
  // MANAGER those calls must come from a MANAGER role member instead.
  if (assetOracleTxNeeded) {
    const mapped = await publicClient.readContract({
      address: accessManager,
      abi: ACCESS_MANAGER_ABI,
      functionName: 'getTargetFunctionRole',
      args: [hook, setAssetOracleSelector],
    });
    if (mapped !== Roles.ADMIN) {
      throw new Error(
        `setAssetOracle is already mapped to role ${mapped}; the ADMIN Safe ` +
          `cannot execute the proposed setAssetOracle calls — run them via a ` +
          `MANAGER role member instead`,
      );
    }
  }

  if (txs.length === 0) {
    console.log('nothing to propose; M001 remediation already applied');
    return;
  }
  await proposeSafeTransaction({ rpcUrl, chainId, txs });
  console.log(
    'next: collect Safe signatures and execute all txs back to back — the ' +
      'hook rejects deposits and fills until both asset feeds are set',
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
