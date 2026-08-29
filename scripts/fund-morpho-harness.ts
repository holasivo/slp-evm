/**
 * TESTNET ONLY: funds the MorphoHarness with loan liquidity by sweeping the
 * UniswapHook's free stablecoin float into it (the hook's sweep() ops
 * function, MANAGER-restricted). The harness needs loan-token balance to
 * serve flash loans and borrows for the multiply flow.
 *
 * Refuses to run on mainnet, where the real Morpho singleton has its own
 * liquidity and sweeps go to RWA deployment instead.
 *
 *   npx hardhat run scripts/fund-morpho-harness.ts --network sepolia
 */
import { readFileSync } from 'fs';
import hre from 'hardhat';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { Address, erc20Abi, formatUnits } from 'viem';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const n = await hre.network.getOrCreate();
  const { chainId } = n.networkConfig;
  if (!chainId || chainId === 1) {
    throw new Error('testnet-only script; refusing to run on this chain');
  }
  const params = JSON.parse(
    readFileSync(
      resolve(__dirname, '../ignition/parameters/sepolia.json'),
      'utf-8',
    ),
  ) as { HookProxy?: { usdc?: Address; usdt?: Address } };
  const deployed = JSON.parse(
    readFileSync(
      resolve(
        __dirname,
        `../ignition/deployments/chain-${chainId}/deployed_addresses.json`,
      ),
      'utf-8',
    ),
  ) as Record<string, Address>;
  const hook = deployed['SlpRolesModule#UniswapHook'];
  const morpho = deployed['MorphoHarnessModule#MorphoHarness'];
  const { usdc, usdt } = params.HookProxy ?? {};
  if (!hook || !morpho || !usdc || !usdt) {
    throw new Error('missing hook/morpho/asset addresses');
  }

  const hookArtifact = await hre.artifacts.readArtifact('UniswapHook');
  const publicClient = await n.viem.getPublicClient();
  const [wallet] = await n.viem.getWalletClients();

  for (const [label, asset] of [
    ['USDC', usdc],
    ['USDT', usdt],
  ] as const) {
    const sweepable = (await publicClient.readContract({
      address: hook,
      abi: hookArtifact.abi,
      functionName: 'sweepable',
      args: [asset],
    })) as bigint;
    if (sweepable === 0n) {
      console.log(`${label}: nothing sweepable; skipping`);
      continue;
    }
    const hash = await wallet.writeContract({
      address: hook,
      abi: hookArtifact.abi,
      functionName: 'sweep',
      args: [asset, morpho],
    });
    await publicClient.waitForTransactionReceipt({ hash });
    console.log(
      `${label}: swept ${formatUnits(sweepable, 6)} into morpho: ${hash}`,
    );
    const balance = await publicClient.readContract({
      address: asset,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [morpho],
    });
    console.log(`${label}: morpho loan liquidity ${formatUnits(balance, 6)}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
