/**
 * Points the UniswapHook at the deployed SlpOracle. Run AFTER oracle:create.
 *
 * The oracle address is read from the network's Ignition journal
 * (SlpOracleModule#SlpOracle); the hook address and price band are read from
 * the network's parameters file (SlpRolesModule.hook and HookProxy), so the
 * cutover cannot drift from the deployed configuration. The caller must hold
 * the MANAGER role on the AccessManager. Idempotent: exits early when the
 * hook already points at the oracle.
 *
 *   npx hardhat run scripts/set-oracle.ts --network sepolia
 */
import { readFileSync } from 'fs';
import hre from 'hardhat';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { Address, getAddress } from 'viem';

const NETWORK_NAMES: Record<number, string> = {
  1: 'mainnet',
  11155111: 'sepolia',
};

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const n = await hre.network.getOrCreate();
  const { chainId } = n.networkConfig;
  if (!chainId) throw new Error('chainId is required');
  const name = NETWORK_NAMES[chainId];
  if (!name) throw new Error(`no parameters file mapping for chain ${chainId}`);

  const params = JSON.parse(
    readFileSync(
      resolve(__dirname, `../ignition/parameters/${name}.json`),
      'utf-8',
    ),
  ) as {
    SlpRolesModule?: { hook?: Address };
    HookProxy?: {
      price_min?: string;
      price_max?: string;
      max_staleness?: string;
    };
  };
  const hook = params.SlpRolesModule?.hook;
  const band = params.HookProxy;
  if (!hook || !band?.price_min || !band.price_max || !band.max_staleness) {
    throw new Error(`SlpRolesModule/HookProxy incomplete in ${name}.json`);
  }

  const deployed = JSON.parse(
    readFileSync(
      resolve(
        __dirname,
        `../ignition/deployments/chain-${chainId}/deployed_addresses.json`,
      ),
      'utf-8',
    ),
  ) as Record<string, Address>;
  const oracle = deployed['SlpOracleModule#SlpOracle'];
  if (!oracle) throw new Error('SlpOracleModule#SlpOracle not deployed');

  const hookArtifact = await hre.artifacts.readArtifact('UniswapHook');
  const publicClient = await n.viem.getPublicClient();
  const [wallet] = await n.viem.getWalletClients();

  const current = (await publicClient.readContract({
    address: hook,
    abi: hookArtifact.abi,
    functionName: 'oracle',
  })) as Address;
  if (getAddress(current) === getAddress(oracle)) {
    console.log(`hook already points at SlpOracle ${oracle}; skipping`);
    return;
  }

  console.log(`hook ${hook}: oracle ${current} -> ${oracle}`);
  const hash = await wallet.writeContract({
    address: hook,
    abi: hookArtifact.abi,
    functionName: 'setOracle',
    args: [
      oracle,
      BigInt(band.max_staleness),
      BigInt(band.price_min),
      BigInt(band.price_max),
    ],
  });
  await publicClient.waitForTransactionReceipt({ hash });
  console.log(`setOracle: ${hash}`);

  const status = await publicClient.readContract({
    address: hook,
    abi: hookArtifact.abi,
    functionName: 'priceStatus',
  });
  console.log(`hook.priceStatus: ${status} (0 = InRange)`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
