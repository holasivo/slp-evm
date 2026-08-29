import dotenvx from '@dotenvx/dotenvx';
import { alchemyRpcUrls, evmChainMap } from './config/chains.js';
import hardhatToolboxViem from '@nomicfoundation/hardhat-toolbox-viem';
import env from 'env-var';
import type { HardhatUserConfig } from 'hardhat/config';
import type { NetworkUserConfig } from 'hardhat/types/config';
dotenvx.config({ convention: 'flow' });

const ETHERSCAN_API_KEY = env.get('ETHERSCAN_API_KEY').default('').asString();
const _COINMARKETCAP_API_KEY = env.get('COINMARKETCAP_API_KEY').asString();
const ALCHEMY_API_KEY = env.get('ALCHEMY_API_KEY').asString();
const _REPORT_GAS = env.get('REPORT_GAS').default('false').asBool();
const SIVO_WALLET_PRIVATE_KEY = env
  .get('SIVO_WALLET_PRIVATE_KEY')
  .default('')
  .asString();

const networks = SIVO_WALLET_PRIVATE_KEY
  ? Object.entries(evmChainMap).reduce(
      (prev, [k, chain]) => {
        // RPC_URL_<NETWORK> (e.g. RPC_URL_SEPOLIA) overrides the Alchemy URL,
        // for environments where the dotenvx-encrypted ALCHEMY_API_KEY is
        // unavailable
        const override = env.get(`RPC_URL_${k.toUpperCase()}`).asString();
        const url =
          override ?? `${alchemyRpcUrls[chain.id]}/${ALCHEMY_API_KEY}`;
        const accounts = [SIVO_WALLET_PRIVATE_KEY];
        prev[k] = { type: 'http', url, accounts, chainId: chain.id };
        return prev;
      },
      {} as Record<string, NetworkUserConfig>,
    )
  : {};

const config: HardhatUserConfig = {
  plugins: [hardhatToolboxViem],
  solidity: {
    compilers: [
      {
        version: '0.8.35',
        settings: { optimizer: { enabled: true, runs: 200 } },
      },
      // v4-core's PoolManager pins 0.8.26; compiled only for local tests
      // (fixture pools) and Ignition's `contractAt` ABI — never deployed by us.
      {
        version: '0.8.26',
        settings: {
          optimizer: { enabled: true, runs: 200 },
          evmVersion: 'cancun',
        },
      },
    ],
    npmFilesToBuild: [
      '@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol',
      '@openzeppelin/contracts/access/manager/AccessManager.sol',
      '@uniswap/v4-core/src/PoolManager.sol',
      '@uniswap/v4-core/src/test/PoolSwapTest.sol',
      '@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol',
      '@uniswap/v4-core/src/test/PoolDonateTest.sol',
    ],
  },
  networks,
  verify: { etherscan: { apiKey: ETHERSCAN_API_KEY } },
};

export default config;
