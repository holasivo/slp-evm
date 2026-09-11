/**
 * Re-points the UniswapHook's NAV oracle (OracleGate) at the feed configured
 * in HookProxy.oracle by proposing a single transaction to the Safe:
 *
 *   UniswapHook.setOracle(<feed>, maxStaleness, priceMin, priceMax)
 *
 * Used to migrate the hook off Sivo's own SlpOracle and onto the Chainlink
 * SLP / USD Exchange Rate feed. setOracle takes the feed and its band
 * atomically so a feed with different decimals can never inherit a band
 * expressed in the old decimal basis.
 *
 * The hook address is read from SlpRolesModule.hook and the feed plus band
 * from HookProxy.oracle / price_min / price_max / max_staleness in
 * ignition/parameters/<network>.json, so the cutover cannot drift from the
 * deployed configuration. Before proposing, the script checks that
 * SAFE_ADDRESS holds whichever role the AccessManager maps setOracle to
 * (MANAGER on mainnet), that the feed answers inside the band and is not
 * already staler than maxStaleness, and that the call succeeds in an
 * eth_call from the Safe. Idempotent: exits early when the hook already
 * runs this exact configuration.
 *
 *   npx hardhat run scripts/propose-hook-oracle.ts --network mainnet
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

import { proposeSafeTransaction } from '../ignition/modules/helpers.js';
import { Roles } from '../ignition/modules/hook/roles.js';

const NETWORK_NAMES: Record<number, string> = {
  1: 'mainnet',
  11155111: 'sepolia',
};

const HOOK_ABI = parseAbi([
  'function setOracle(address oracle, uint256 maxStaleness, int256 priceMin, int256 priceMax)',
  'function oracle() view returns (address)',
  'function oracleDecimals() view returns (uint8)',
  'function maxStaleness() view returns (uint256)',
  'function priceMin() view returns (int256)',
  'function priceMax() view returns (int256)',
  'function priceStatus() view returns (uint8)',
]);

const FEED_ABI = parseAbi([
  'function decimals() view returns (uint8)',
  'function description() view returns (string)',
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
]);

const ACCESS_MANAGER_ABI = parseAbi([
  'function hasRole(uint64 roleId, address account) view returns (bool isMember, uint32 executionDelay)',
  'function getTargetFunctionRole(address target, bytes4 selector) view returns (uint64)',
]);

const __dirname = dirname(fileURLToPath(import.meta.url));

const load = <T>(path: string): T =>
  JSON.parse(readFileSync(resolve(__dirname, path), 'utf-8')) as T;

const roleNames: Record<string, string> = Object.fromEntries(
  Object.entries(Roles).map(([name, id]) => [`${id}`, name]),
);

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
      oracle?: Address;
      price_min?: string;
      price_max?: string;
      max_staleness?: string;
    };
  }>(`../ignition/parameters/${name}.json`);
  const hook = params.SlpRolesModule?.hook;
  const band = params.HookProxy;
  if (!hook || !band?.oracle || !band.price_min || !band.price_max) {
    throw new Error(`SlpRolesModule/HookProxy incomplete in ${name}.json`);
  }
  const oracle = getAddress(band.oracle);
  const maxStaleness = BigInt(band.max_staleness ?? '0');
  const priceMin = BigInt(band.price_min);
  const priceMax = BigInt(band.price_max);

  const deployed = load<Record<string, Address>>(
    `../ignition/deployments/chain-${chainId}/deployed_addresses.json`,
  );
  const accessManager = deployed['AccessManagerModule#AccessManager'];
  if (!accessManager) throw new Error('AccessManager not in deployment');

  console.log(`chain ${chainId}`);
  console.log(`safe: ${safeAddress}`);
  console.log(`hook: ${hook}`);

  // ---- verify the Safe holds the role setOracle is mapped to --------------
  const selector = toFunctionSelector(
    'function setOracle(address,uint256,int256,int256)',
  );
  const requiredRole = await publicClient.readContract({
    address: accessManager,
    abi: ACCESS_MANAGER_ABI,
    functionName: 'getTargetFunctionRole',
    args: [hook, selector],
  });
  const roleName = roleNames[`${requiredRole}`] ?? `${requiredRole}`;
  const [isMember] = await publicClient.readContract({
    address: accessManager,
    abi: ACCESS_MANAGER_ABI,
    functionName: 'hasRole',
    args: [requiredRole, safeAddress],
  });
  if (!isMember) {
    throw new Error(
      `setOracle is mapped to ${roleName} (${requiredRole}) but SAFE_ADDRESS ` +
        `${safeAddress} does not hold it; refusing to propose`,
    );
  }
  console.log(`setOracle role: ${roleName} (${requiredRole}) — Safe holds it`);

  // ---- sanity-check the feed before wiring it in --------------------------
  const [decimals, description, [, answer, , updatedAt], block] =
    await Promise.all([
      publicClient.readContract({
        address: oracle,
        abi: FEED_ABI,
        functionName: 'decimals',
      }),
      publicClient.readContract({
        address: oracle,
        abi: FEED_ABI,
        functionName: 'description',
      }),
      publicClient.readContract({
        address: oracle,
        abi: FEED_ABI,
        functionName: 'latestRoundData',
      }),
      publicClient.getBlock(),
    ]);
  const age = block.timestamp - updatedAt;
  console.log(
    `feed ${oracle} "${description}": decimals ${decimals}, answer ${answer}, ` +
      `age ${age}s, band [${priceMin}, ${priceMax}], staleness ${maxStaleness}s`,
  );
  if (answer < priceMin || answer > priceMax) {
    throw new Error(
      `feed answer ${answer} is outside the configured band; wrong feed ` +
        `address, wrong decimals or a live NAV excursion — refusing to propose`,
    );
  }
  if (maxStaleness > 0n && age > maxStaleness) {
    throw new Error(
      `feed is already ${age}s old, past the ${maxStaleness}s staleness ` +
        `limit; the breaker would trip on execution — refusing to propose`,
    );
  }

  // ---- skip when the hook already runs this configuration ----------------
  const [current, currentStaleness, currentMin, currentMax] = await Promise.all(
    (['oracle', 'maxStaleness', 'priceMin', 'priceMax'] as const).map((fn) =>
      publicClient.readContract({
        address: hook,
        abi: HOOK_ABI,
        functionName: fn,
      }),
    ),
  );
  if (
    getAddress(current as Address) === oracle &&
    currentStaleness === maxStaleness &&
    currentMin === priceMin &&
    currentMax === priceMax
  ) {
    console.log(`hook already runs feed ${oracle} with this band; skipping`);
    return;
  }
  console.log(`oracle: ${current as Address} -> ${oracle}`);

  // ---- prove the call lands before asking anyone to sign -----------------
  await publicClient.simulateContract({
    address: hook,
    abi: HOOK_ABI,
    functionName: 'setOracle',
    args: [oracle, maxStaleness, priceMin, priceMax],
    account: safeAddress,
  });
  console.log('eth_call from the Safe succeeds');

  const txs: MetaTransactionData[] = [
    {
      to: hook,
      value: '0',
      data: encodeFunctionData({
        abi: HOOK_ABI,
        functionName: 'setOracle',
        args: [oracle, maxStaleness, priceMin, priceMax],
      }),
    },
  ];
  await proposeSafeTransaction({ rpcUrl, chainId, txs });
  console.log(
    'next: collect Safe signatures, execute, then confirm hook.priceStatus ' +
      'reads 0 (InRange)',
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
