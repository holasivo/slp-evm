/**
 * Proposes the Phase 1 UPGRADER split to the ADMIN Safe (timelock rollout):
 *
 *   1. AccessManager.grantRole(UPGRADER, <safe>, 0)
 *   2. AccessManager.setTargetFunctionRole(slp, [upgradeToAndCall], UPGRADER)
 *   3. AccessManager.setTargetFunctionRole(hook, [upgradeToAndCall], UPGRADER)
 *   4. AccessManager.setTargetFunctionRole(multiplier, [upgradeToAndCall],
 *      UPGRADER) — only on chains where the Multiplier is deployed
 *
 * Today upgradeToAndCall is unmapped and falls through to ADMIN, so upgrades
 * cannot be timelocked without delaying everything the Safe does. Mapping it
 * to a dedicated UPGRADER role (granted to the same Safe with delay 0) keeps
 * behavior identical for now while letting Phase 2 re-grant UPGRADER with an
 * execution delay.
 *
 * The grant is proposed first: Safe nonces enforce execution order, so there
 * is no window in which the selectors are mapped but nobody holds the role.
 * SAFE_ADDRESS must hold ADMIN on the AccessManager. Idempotent: steps
 * already satisfied on-chain are skipped.
 *
 *   npx hardhat run scripts/propose-upgrader-role.ts --network mainnet
 */
import type { MetaTransactionData } from '@safe-global/types-kit';
import env from 'env-var';
import { readFileSync } from 'fs';
import hre from 'hardhat';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { Address, encodeFunctionData, getAddress, parseAbi } from 'viem';

import { proposeSafeTransaction } from '../ignition/modules/helpers.js';
import { Roles, upgradeSelectors } from '../ignition/modules/hook/roles.js';

const NETWORK_NAMES: Record<number, string> = {
  1: 'mainnet',
  11155111: 'sepolia',
};

const ACCESS_MANAGER_ABI = parseAbi([
  'function hasRole(uint64 roleId, address account) view returns (bool isMember, uint32 executionDelay)',
  'function getTargetFunctionRole(address target, bytes4 selector) view returns (uint64)',
  'function setTargetFunctionRole(address target, bytes4[] selectors, uint64 roleId)',
  'function grantRole(uint64 roleId, address account, uint32 executionDelay)',
]);

const [upgradeSelector] = upgradeSelectors;

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

  const params = load<{ SlpRolesModule?: { hook?: Address } }>(
    `../ignition/parameters/${name}.json`,
  );
  const hook = params.SlpRolesModule?.hook;
  if (!hook) throw new Error(`SlpRolesModule.hook missing in ${name}.json`);

  const deployed = load<Record<string, Address>>(
    `../ignition/deployments/chain-${chainId}/deployed_addresses.json`,
  );
  const accessManager = deployed['AccessManagerModule#AccessManager'];
  if (!accessManager) throw new Error('AccessManager not in deployment');
  const slp = deployed['SlpCreateModule#SlpProxy'];
  if (!slp) throw new Error('SLP proxy not in deployment');
  const multiplier = deployed['MultiplierCreateModule#Multiplier'];

  const targets: [string, Address][] = [
    ['SLP', slp],
    ['UniswapHook', hook],
  ];
  if (multiplier) targets.push(['Multiplier', multiplier]);
  else console.log('Multiplier not deployed on this chain — skipping');

  console.log(`chain ${chainId}`);
  console.log(`safe: ${safeAddress}`);
  console.log(`accessManager: ${accessManager}`);

  // ---- verify the Safe holds ADMIN (required to execute all steps) --------
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

  // ---- build only the transactions still needed ----------------------------
  const txs: MetaTransactionData[] = [];

  const [isUpgrader, delay] = await publicClient.readContract({
    address: accessManager,
    abi: ACCESS_MANAGER_ABI,
    functionName: 'hasRole',
    args: [Roles.UPGRADER, safeAddress],
  });
  if (isUpgrader) {
    console.log(
      `grantRole: safe already holds UPGRADER (delay ${delay}s) — skipping`,
    );
  } else {
    console.log(`1. grantRole(UPGRADER, ${safeAddress}, 0)`);
    txs.push({
      to: accessManager,
      value: '0',
      data: encodeFunctionData({
        abi: ACCESS_MANAGER_ABI,
        functionName: 'grantRole',
        args: [Roles.UPGRADER, safeAddress, 0],
      }),
    });
  }

  for (const [label, target] of targets) {
    const current = await publicClient.readContract({
      address: accessManager,
      abi: ACCESS_MANAGER_ABI,
      functionName: 'getTargetFunctionRole',
      args: [target, upgradeSelector],
    });
    if (current === Roles.UPGRADER) {
      console.log(
        `setTargetFunctionRole(${label}): already mapped to UPGRADER — skipping`,
      );
      continue;
    }
    if (current !== Roles.ADMIN) {
      throw new Error(
        `${label} upgradeToAndCall is mapped to unexpected role ${current}; ` +
          `refusing to propose`,
      );
    }
    console.log(
      `setTargetFunctionRole(${label}=${target}, [upgradeToAndCall], UPGRADER)`,
    );
    txs.push({
      to: accessManager,
      value: '0',
      data: encodeFunctionData({
        abi: ACCESS_MANAGER_ABI,
        functionName: 'setTargetFunctionRole',
        args: [target, [upgradeSelector], Roles.UPGRADER],
      }),
    });
  }

  if (txs.length === 0) {
    console.log('nothing to propose; UPGRADER split already applied');
    return;
  }
  await proposeSafeTransaction({ rpcUrl, chainId, txs });
  console.log(
    'next: collect Safe signatures and execute in nonce order — the grant ' +
      'lands first so upgrades are never orphaned',
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
