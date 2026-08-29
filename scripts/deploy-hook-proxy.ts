/**
 * Deploys the UniswapHook ERC1967 proxy at a CREATE2-mined address whose low
 * 14 bits encode the hook permission flags, via the canonical deterministic
 * deployment proxy (0x4e59...956C, present on mainnet and Sepolia).
 *
 * Run AFTER `slp:create` (which deploys the AccessManager, SLP proxy, and
 * hook implementation) and BEFORE `slp:pools`:
 *
 *   npx hardhat run scripts/deploy-hook-proxy.ts --network sepolia
 *
 * The initialize options are read from the `HookProxy` section of
 * ignition/parameters/<network>.json. They must be FINAL before running:
 * changing any option changes the mined address.
 */
import { readFileSync } from 'fs';
import hre from 'hardhat';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import {
  Address,
  Hex,
  concatHex,
  encodeAbiParameters,
  encodeFunctionData,
} from 'viem';
import {
  HOOK_FLAG_MASK,
  HOOK_FLAGS,
  mineHookSalt,
} from '../ignition/modules/hook/mine.js';

/** https://github.com/Arachnid/deterministic-deployment-proxy */
const CREATE2_DEPLOYER: Address = '0x4e59b44847b379578588920cA78FbF26c0B4956C';

const NETWORK_NAMES: Record<number, string> = {
  1: 'mainnet',
  11155111: 'sepolia',
};

const __dirname = dirname(fileURLToPath(import.meta.url));

type AssetOracleParams = {
  oracle: Address;
  peg_min: string;
  peg_max: string;
  max_staleness: string;
};

type HookProxyParams = {
  poolManager: Address;
  usdc: Address;
  usdt: Address;
  oracle: Address;
  price_min: string;
  price_max: string;
  max_staleness: string;
  min_request_shares: string;
  usdc_oracle: AssetOracleParams;
  usdt_oracle: AssetOracleParams;
};

const load = <T>(path: string): T =>
  JSON.parse(readFileSync(resolve(__dirname, path), 'utf-8')) as T;

async function main(): Promise<void> {
  const n = await hre.network.getOrCreate();
  const { chainId } = n.networkConfig;
  if (!chainId) throw new Error('chainId is required');
  const name = NETWORK_NAMES[chainId];
  if (!name) throw new Error(`no parameters file mapping for chain ${chainId}`);

  const params = load<{ HookProxy?: HookProxyParams }>(
    `../ignition/parameters/${name}.json`,
  ).HookProxy;
  if (!params) throw new Error(`HookProxy section missing in ${name}.json`);

  const addresses = load<Record<string, string>>(
    `../ignition/deployments/chain-${chainId}/deployed_addresses.json`,
  );
  const need = (key: string): Address => {
    const value = addresses[key];
    if (!value) throw new Error(`missing deployed address: ${key}`);
    return value as Address;
  };
  const accessManager = need('AccessManagerModule#AccessManager');
  const slp = need('SlpCreateModule#SlpProxy');
  const hookImpl = need('HookCreateImplModule#UniswapHook');

  const hookArtifact = await hre.artifacts.readArtifact('UniswapHook');
  const init = encodeFunctionData({
    abi: hookArtifact.abi,
    functionName: 'initialize',
    args: [
      {
        authority: accessManager,
        slp,
        asset0: params.usdc,
        asset1: params.usdt,
        oracle: params.oracle,
        price_min: BigInt(params.price_min),
        price_max: BigInt(params.price_max),
        max_staleness: BigInt(params.max_staleness),
        min_request_shares: BigInt(params.min_request_shares),
        asset0_oracle: {
          oracle: params.usdc_oracle.oracle,
          peg_min: BigInt(params.usdc_oracle.peg_min),
          peg_max: BigInt(params.usdc_oracle.peg_max),
          max_staleness: BigInt(params.usdc_oracle.max_staleness),
        },
        asset1_oracle: {
          oracle: params.usdt_oracle.oracle,
          peg_min: BigInt(params.usdt_oracle.peg_min),
          peg_max: BigInt(params.usdt_oracle.peg_max),
          max_staleness: BigInt(params.usdt_oracle.max_staleness),
        },
      },
    ],
  });
  const proxyArtifact = await hre.artifacts.readArtifact('ERC1967Proxy');
  const initCode = concatHex([
    proxyArtifact.bytecode as Hex,
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'bytes' }],
      [hookImpl, init],
    ),
  ]);

  const { salt, address, iterations } = mineHookSalt(
    CREATE2_DEPLOYER,
    initCode,
  );
  console.log(`mined salt ${salt} in ${iterations} iterations`);
  console.log(`hook proxy address: ${address}`);
  if ((BigInt(address) & HOOK_FLAG_MASK) !== HOOK_FLAGS) {
    throw new Error('mined address does not encode the hook flags');
  }

  const publicClient = await n.viem.getPublicClient();
  const existing = await publicClient.getCode({ address });
  if (existing && existing !== '0x') {
    console.log('hook proxy already deployed at this address; nothing to do');
    return;
  }
  const deployerCode = await publicClient.getCode({
    address: CREATE2_DEPLOYER,
  });
  if (!deployerCode || deployerCode === '0x') {
    throw new Error(`CREATE2 deployer missing on chain ${chainId}`);
  }

  const [wallet] = await n.viem.getWalletClients();
  const hash = await wallet.sendTransaction({
    to: CREATE2_DEPLOYER,
    data: concatHex([salt, initCode]),
  });
  console.log(`deploy tx: ${hash}`);
  await publicClient.waitForTransactionReceipt({ hash });

  const code = await publicClient.getCode({ address });
  if (!code || code === '0x') {
    throw new Error('deployment failed: no code at mined address');
  }
  console.log(`UniswapHook proxy deployed at ${address}`);
  console.log(
    `next: add "hook": "${address}" to the SlpRolesModule section of ` +
      `ignition/parameters/${name}.json, then run slp:pools and slp:roles`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
