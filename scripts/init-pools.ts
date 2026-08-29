/**
 * Initializes the two sanctioned Uniswap v4 pools (SLP/USDC and SLP/USDT) on
 * the PoolManager. Run AFTER slp:hook-proxy and BEFORE slp:roles.
 *
 * The pool keys are read from the hook itself (hook.poolKey sorts the
 * currencies), so this script cannot drift from the on-chain configuration.
 * Idempotent: pools that are already initialized are skipped.
 *
 *   npx hardhat run scripts/init-pools.ts --network sepolia
 */
import { readFileSync } from 'fs';
import hre from 'hardhat';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { Address, BaseError, ContractFunctionRevertedError } from 'viem';

/** Pool init price is cosmetic: the pools hold no curve liquidity */
const SQRT_PRICE_1_1 = 79228162514264337593543950336n;

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
    SlpRolesModule?: {
      poolManager?: Address;
      hook?: Address;
      usdc?: Address;
      usdt?: Address;
    };
  };
  const cfg = params.SlpRolesModule;
  if (!cfg?.poolManager || !cfg.hook || !cfg.usdc || !cfg.usdt) {
    throw new Error(`SlpRolesModule section incomplete in ${name}.json`);
  }

  const hookArtifact = await hre.artifacts.readArtifact('UniswapHook');
  const pmArtifact = await hre.artifacts.readArtifact('PoolManager');
  const publicClient = await n.viem.getPublicClient();
  const [wallet] = await n.viem.getWalletClients();

  for (const asset of [cfg.usdc, cfg.usdt]) {
    const key = await publicClient.readContract({
      address: cfg.hook,
      abi: hookArtifact.abi,
      functionName: 'poolKey',
      args: [asset],
    });
    try {
      const hash = await wallet.writeContract({
        address: cfg.poolManager,
        abi: pmArtifact.abi,
        functionName: 'initialize',
        args: [key, SQRT_PRICE_1_1],
      });
      await publicClient.waitForTransactionReceipt({ hash });
      console.log(`initialized pool for asset ${asset}: ${hash}`);
    } catch (error) {
      const revert =
        error instanceof BaseError
          ? error.walk((e) => e instanceof ContractFunctionRevertedError)
          : undefined;
      // PoolAlreadyInitialized lives in the Pool library, not the
      // PoolManager ABI, so viem can only surface its raw selector
      const alreadyInitialized =
        revert instanceof ContractFunctionRevertedError &&
        (revert.data?.errorName === 'PoolAlreadyInitialized' ||
          revert.signature === '0x7983c051');
      if (alreadyInitialized) {
        console.log(`pool for asset ${asset} already initialized; skipping`);
        continue;
      }
      throw error;
    }
  }
  console.log('next: run slp:roles to wire the AccessManager');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
