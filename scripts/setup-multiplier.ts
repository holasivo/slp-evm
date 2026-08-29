/**
 * Configures the Multiplier after deployment (multiplier:create):
 *
 *   1. Syncs the MorphoOracleHarness price to the SLP NAV feed (testnets
 *      only — on mainnet the Morpho market uses a real Morpho oracle).
 *   2. Registers the USDC and USDT Morpho markets on the Multiplier
 *      (SLP collateral, 80% lltv).
 *   3. Funds the MorphoHarness with loan liquidity: mints our own USDT and
 *      transfers Circle USDC from the deployer when available.
 *
 * Idempotent: markets already registered and sufficient balances are
 * skipped.
 *
 *   npx hardhat run scripts/setup-multiplier.ts --network sepolia
 */
import { readFileSync } from 'fs';
import hre from 'hardhat';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import {
  Address,
  erc20Abi,
  isAddressEqual,
  parseUnits,
  zeroAddress,
} from 'viem';

/** 80% liquidation loan-to-value (WAD) → 4.6x max leverage in the UI */
const LLTV = 800_000_000_000_000_000n;
/** Morpho oracle scale for equal-decimals pairs: 1e36 = parity */
const MORPHO_PRICE_SCALE = 10n ** 36n;
/** Loan liquidity target for the MorphoHarness, in token units (6 dec) */
const TARGET_LIQUIDITY = parseUnits('1000000', 6);

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
    HookProxy?: { usdc?: Address; usdt?: Address; oracle?: Address };
  };
  const { usdc, usdt, oracle: navFeed } = params.HookProxy ?? {};
  if (!usdc || !usdt || !navFeed) {
    throw new Error(`HookProxy section incomplete in ${name}.json`);
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
  const morpho = deployed['MorphoHarnessModule#MorphoHarness'];
  const morphoOracle = deployed['MorphoHarnessModule#MorphoOracleHarness'];
  const multiplier = deployed['MultiplierCreateModule#Multiplier'];
  if (!morpho || !morphoOracle || !multiplier) {
    throw new Error('MorphoHarness/Multiplier not deployed on this chain');
  }

  const multiplierArtifact = await hre.artifacts.readArtifact('Multiplier');
  const morphoOracleArtifact = await hre.artifacts.readArtifact(
    'MorphoOracleHarness',
  );
  const oracleArtifact = await hre.artifacts.readArtifact('OracleHarness');
  const usdtArtifact = await hre.artifacts.readArtifact('TetherUSD');
  const publicClient = await n.viem.getPublicClient();
  const [wallet] = await n.viem.getWalletClients();
  const write = async (request: Parameters<typeof wallet.writeContract>[0]) => {
    const hash = await wallet.writeContract(request);
    await publicClient.waitForTransactionReceipt({ hash });
    return hash;
  };

  const slp = (await publicClient.readContract({
    address: multiplier,
    abi: multiplierArtifact.abi,
    functionName: 'slp',
  })) as Address;

  // 1. Sync the Morpho oracle to the NAV feed: NAV is 8 decimals, the
  // Morpho price is 1e36-scaled for the 6/6-decimals SLP/stable pair.
  const [, navAnswer] = (await publicClient.readContract({
    address: navFeed,
    abi: oracleArtifact.abi,
    functionName: 'latestRoundData',
  })) as [bigint, bigint, bigint, bigint, bigint];
  const morphoPrice = (navAnswer * MORPHO_PRICE_SCALE) / 10n ** 8n;
  const currentPrice = (await publicClient.readContract({
    address: morphoOracle,
    abi: morphoOracleArtifact.abi,
    functionName: 'price',
  })) as bigint;
  if (currentPrice !== morphoPrice) {
    await write({
      address: morphoOracle,
      abi: morphoOracleArtifact.abi,
      functionName: 'setPrice',
      args: [morphoPrice],
    });
    console.log(`synced morpho oracle price to NAV: ${morphoPrice}`);
  } else {
    console.log('morpho oracle price already in sync');
  }

  // 2. Register both stablecoin markets on the Multiplier
  for (const asset of [usdc, usdt]) {
    const market = (await publicClient.readContract({
      address: multiplier,
      abi: multiplierArtifact.abi,
      functionName: 'marketOf',
      args: [asset],
    })) as { loanToken: Address };
    if (!isAddressEqual(market.loanToken, zeroAddress)) {
      console.log(`market for ${asset} already registered; skipping`);
      continue;
    }
    const hash = await write({
      address: multiplier,
      abi: multiplierArtifact.abi,
      functionName: 'setMarket',
      args: [
        asset,
        {
          loanToken: asset,
          collateralToken: slp,
          oracle: morphoOracle,
          irm: zeroAddress,
          lltv: LLTV,
        },
      ],
    });
    console.log(`registered market for ${asset}: ${hash}`);
  }

  // 3. Loan liquidity: our USDT is mintable; Circle USDC has to come from
  // the deployer's faucet balance.
  const balanceOf = (token: Address, account: Address) =>
    publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [account],
    });
  const usdtBalance = await balanceOf(usdt, morpho);
  if (usdtBalance < TARGET_LIQUIDITY) {
    const usdtOwner = (await publicClient.readContract({
      address: usdt,
      abi: usdtArtifact.abi,
      functionName: 'owner',
    })) as Address;
    if (isAddressEqual(usdtOwner, wallet.account.address)) {
      const hash = await write({
        address: usdt,
        abi: usdtArtifact.abi,
        functionName: 'mint',
        args: [morpho, TARGET_LIQUIDITY - usdtBalance],
      });
      console.log(`minted USDT loan liquidity to morpho: ${hash}`);
    } else {
      console.log(
        `wallet is not the USDT owner (${usdtOwner}); fund the morpho ` +
          'loan liquidity manually (mint or transfer USDT to it)',
      );
    }
  } else {
    console.log('morpho already holds sufficient USDT liquidity');
  }
  const usdcMorpho = await balanceOf(usdc, morpho);
  if (usdcMorpho < TARGET_LIQUIDITY) {
    const usdcDeployer = await balanceOf(usdc, wallet.account.address);
    // keep half of the deployer's faucet USDC for regular deposit testing
    const transferable = usdcDeployer / 2n;
    if (transferable > 0n) {
      const amount =
        transferable < TARGET_LIQUIDITY - usdcMorpho
          ? transferable
          : TARGET_LIQUIDITY - usdcMorpho;
      const hash = await write({
        address: usdc,
        abi: erc20Abi,
        functionName: 'transfer',
        args: [morpho, amount],
      });
      console.log(`transferred ${amount} USDC loan liquidity: ${hash}`);
    } else {
      console.log(
        'deployer holds no USDC; fund the MorphoHarness from the Circle ' +
          'faucet before testing USDC leverage',
      );
    }
  } else {
    console.log('morpho already holds sufficient USDC liquidity');
  }

  console.log('multiplier setup complete', {
    multiplier,
    morpho,
    morphoOracle,
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
