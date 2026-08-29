import type { MetaTransactionData } from '@safe-global/types-kit';
import { readFileSync } from 'fs';
import hre from 'hardhat';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import type { Address } from 'viem';
import { encodeUpgrade, proposeSafeTransaction } from './helpers.js';

type DeployedAddresses = Record<string, string>;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const NETWORK_NAMES: Record<number, string> = {
  1: 'mainnet',
  11155111: 'sepolia',
};

const loadDeployedAddresses = (chainId: number): DeployedAddresses => {
  const path = resolve(
    __dirname,
    `../deployments/chain-${chainId}/deployed_addresses.json`,
  );
  return JSON.parse(readFileSync(path, 'utf-8')) as DeployedAddresses;
};

const getAddress = (addresses: DeployedAddresses, key: string): Address => {
  const value = addresses[key];
  if (!value) throw new Error(`Missing deployed address for key: ${key}`);
  return value as Address;
};

/** The mined hook proxy is deployed by scripts/deploy-hook-proxy.ts (not
 * Ignition), so its address lives in the parameters file. */
const loadHookProxy = (chainId: number): Address => {
  const name = NETWORK_NAMES[chainId];
  if (!name) throw new Error(`no parameters file mapping for chain ${chainId}`);
  const params = JSON.parse(
    readFileSync(resolve(__dirname, `../parameters/${name}.json`), 'utf-8'),
  ) as { SlpRolesModule?: { hook?: string } };
  const hook = params.SlpRolesModule?.hook;
  if (!hook) throw new Error(`SlpRolesModule.hook missing in ${name}.json`);
  return hook as Address;
};

const toTx = (proxy: Address, impl: Address): MetaTransactionData => ({
  to: proxy,
  data: encodeUpgrade(impl),
  value: '0',
});

/**
 * Proposes upgradeToAndCall transactions to the Safe for the SLP protocol
 * proxies. Run `slp:upgrade` and/or `hook:upgrade` first to deploy the new
 * implementations, then this script.
 */
async function main(): Promise<void> {
  const n = await hre.network.getOrCreate();
  if (!('url' in n.networkConfig)) throw new Error('HTTP network required');
  const { chainId, url } = n.networkConfig;
  if (!chainId) throw new Error('chainId is required');
  const rpcUrl = await url.getUrl();
  const addresses = loadDeployedAddresses(chainId);
  const txs: MetaTransactionData[] = [];
  {
    const proxy = getAddress(addresses, 'SlpCreateModule#SlpProxy');
    const impl = getAddress(addresses, 'SlpUpgradeImplModule#SLP');
    console.log(`SLP: ${proxy} -> ${impl}`);
    txs.push(toTx(proxy, impl));
  }
  {
    const proxy = loadHookProxy(chainId);
    const impl = getAddress(addresses, 'HookUpgradeImplModule#UniswapHook');
    console.log(`UniswapHook: ${proxy} -> ${impl}`);
    txs.push(toTx(proxy, impl));
  }
  await proposeSafeTransaction({ rpcUrl, chainId, txs });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
