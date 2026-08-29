import '@nomicfoundation/hardhat-ignition-viem';
import '@nomicfoundation/hardhat-network-helpers';
import '@nomicfoundation/hardhat-viem';
import '@nomicfoundation/hardhat-viem-assertions';
import hre, { network } from 'hardhat';
import {
  Account,
  Address,
  Hex,
  concatHex,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  getContract,
  zeroAddress,
} from 'viem';
import { mineHookSalt } from '../ignition/modules/hook/mine.js';
import { TestAssetModule } from '../ignition/modules/test/TestAsset.js';
const { viem, ignition, networkHelpers: nh } = await network.getOrCreate();
export { ignition, nh, viem };

const ξ = <T extends { address: Address }>(x: T) => {
  // apply checksum for test assertions
  x.address = getAddress(x.address);
};

export type WithAddress = { account: Account } | { address: Address };

export const toAddressMap = <T extends string>(
  x: Record<T, WithAddress>,
): Record<T, Address> => {
  return Object.keys(x).reduce(
    (prev, k_) => {
      const k = k_ as T;
      const v = x[k];
      const { address } = 'address' in v ? v : v.account;
      prev[k] = address;
      return prev;
    },
    {} as Record<T, Address>,
  );
};

type GetContractFunc = typeof getContract;
export const Ξ = <T extends ReturnType<GetContractFunc>>(
  client: Parameters<GetContractFunc>[0]['client'],
  { address, abi }: T,
) => getContract({ address, abi, client }) as unknown as T;

// ---------------------------------------------------------------------------
// SLP protocol (SLP token + oracle-priced Uniswap v4 pools via UniswapHook)
// ---------------------------------------------------------------------------

export const SQRT_PRICE_1_1 = 79228162514264337593543950336n;

import {
  HookFunctionRoles,
  Roles,
  SlpFunctionRoles,
} from '../ignition/modules/hook/roles.js';
export { Roles };

type SlpProtocolOptions = {
  decimals: number;
  oraclePrice: bigint;
  oracleDecimals: number;
  priceMin: bigint;
  priceMax: bigint;
  maxStaleness: bigint;
  minRequestShares: bigint;
  pegMin: bigint;
  pegMax: bigint;
  assetMaxStaleness: bigint;
};

const defaultSlpOptions: SlpProtocolOptions = {
  decimals: 6,
  oraclePrice: 100_000_000n, // 1.00 in 8 decimals
  oracleDecimals: 8,
  priceMin: 50_000_000n, // 0.50
  priceMax: 200_000_000n, // 2.00
  maxStaleness: 86_400n,
  minRequestShares: 0n,
  pegMin: 99_500_000n, // 0.995, matching the legacy Vault's peg band
  pegMax: 100_500_000n, // 1.005
  assetMaxStaleness: 86_400n,
};

export const buildMakeSlpProtocol = (
  options_: Partial<SlpProtocolOptions> = {},
) => {
  const options: SlpProtocolOptions = { ...defaultSlpOptions, ...options_ };
  const makeSlpProtocol = async () => {
    const signers = await viem.getWalletClients();
    signers.forEach((x) => ξ(x.account));
    const [owner_, ...users] = signers;
    const { address: owner } = owner_.account;
    const { decimals } = options;

    const accessManager = await viem.deployContract('AccessManager', [owner]);
    const poolManager = await viem.deployContract('PoolManager', [zeroAddress]);
    const swapRouter = await viem.deployContract('PoolSwapTest', [
      poolManager.address,
    ]);
    const { asset: usdc } = await ignition.deploy(TestAssetModule, {
      parameters: { TestAssetModule: { symbol: 'USDC', decimals, owner } },
    });
    const { asset: usdt } = await ignition.deploy(TestAssetModule, {
      parameters: { TestAssetModule: { symbol: 'USDT', decimals, owner } },
    });
    const oracle = await viem.deployContract('OracleHarness', [
      options.oraclePrice,
      options.oracleDecimals,
    ]);
    // per-asset USD feeds (M001), both at 1.00
    const usdcOracle = await viem.deployContract('OracleHarness', [
      100_000_000n,
      options.oracleDecimals,
    ]);
    const usdtOracle = await viem.deployContract('OracleHarness', [
      100_000_000n,
      options.oracleDecimals,
    ]);

    // SLP behind an ERC1967 proxy (house pattern)
    const slpImpl = await viem.deployContract('SLP');
    const slpInit = encodeFunctionData({
      abi: slpImpl.abi,
      functionName: 'initialize',
      args: [
        {
          name: 'Sivo Liquidity Provider',
          symbol: 'SLP',
          decimals,
          authority: accessManager.address,
        },
      ],
    });
    const slpProxy = await viem.deployContract('ERC1967Proxy', [
      slpImpl.address,
      slpInit,
    ]);
    const slp = await viem.getContractAt('SLP', slpProxy.address);

    // UniswapHook behind an ERC1967 proxy at a mined, flag-encoded address
    const hookImpl = await viem.deployContract('UniswapHookHarness', [
      poolManager.address,
    ]);
    const factory = await viem.deployContract('Create2Factory');
    const hookInit = encodeFunctionData({
      abi: hookImpl.abi,
      functionName: 'initialize',
      args: [
        {
          authority: accessManager.address,
          slp: slp.address,
          asset0: usdc.address,
          asset1: usdt.address,
          oracle: oracle.address,
          price_min: options.priceMin,
          price_max: options.priceMax,
          max_staleness: options.maxStaleness,
          min_request_shares: options.minRequestShares,
          asset0_oracle: {
            oracle: usdcOracle.address,
            peg_min: options.pegMin,
            peg_max: options.pegMax,
            max_staleness: options.assetMaxStaleness,
          },
          asset1_oracle: {
            oracle: usdtOracle.address,
            peg_min: options.pegMin,
            peg_max: options.pegMax,
            max_staleness: options.assetMaxStaleness,
          },
        },
      ],
    });
    const proxyArtifact = await hre.artifacts.readArtifact('ERC1967Proxy');
    const initCode = concatHex([
      proxyArtifact.bytecode as Hex,
      encodeAbiParameters(
        [{ type: 'address' }, { type: 'bytes' }],
        [hookImpl.address, hookInit],
      ),
    ]);
    const { salt, address: hookAddress } = mineHookSalt(
      factory.address,
      initCode,
    );
    await factory.write.deploy([salt, initCode]);
    const hook = await viem.getContractAt('UniswapHookHarness', hookAddress);

    // AccessManager wiring: function-role mappings and role grants (single
    // source of truth shared with the PoolInitModule deployment)
    const am = accessManager;
    for (const { role, selectors: sels } of SlpFunctionRoles) {
      await am.write.setTargetFunctionRole([slp.address, [...sels], role]);
    }
    for (const { role, selectors: sels } of HookFunctionRoles) {
      await am.write.setTargetFunctionRole([hook.address, [...sels], role]);
    }
    // upgradeToAndCall stays on the built-in ADMIN role (0), which `owner`
    // already holds via the AccessManager constructor
    await am.write.grantRole([Roles.MINTER, hook.address, 0]);
    await am.write.grantRole([Roles.MINTER, owner, 0]);
    await am.write.grantRole([Roles.MANAGER, owner, 0]);
    await am.write.grantRole([Roles.OPERATOR, owner, 0]);
    await am.write.grantRole([Roles.PAUSER, owner, 0]);

    // Initialize both sanctioned pools (init price is cosmetic)
    const keyFor = (asset: Address) => {
      const [c0, c1] =
        slp.address.toLowerCase() < asset.toLowerCase()
          ? [slp.address, asset]
          : [asset, slp.address];
      return {
        currency0: c0,
        currency1: c1,
        fee: 0,
        tickSpacing: 60,
        hooks: hookAddress,
      };
    };
    const keyUsdc = keyFor(usdc.address);
    const keyUsdt = keyFor(usdt.address);
    await poolManager.write.initialize([keyUsdc, SQRT_PRICE_1_1]);
    await poolManager.write.initialize([keyUsdt, SQRT_PRICE_1_1]);

    [
      usdc,
      usdt,
      oracle,
      usdcOracle,
      usdtOracle,
      slp,
      hook,
      poolManager,
      swapRouter,
      accessManager,
    ].forEach(ξ);
    return {
      owner: owner_,
      users,
      accessManager,
      poolManager,
      swapRouter,
      usdc,
      usdt,
      oracle,
      usdcOracle,
      usdtOracle,
      slp,
      slpImpl,
      hook,
      hookImpl,
      factory,
      keyUsdc,
      keyUsdt,
    };
  };
  return makeSlpProtocol;
};
