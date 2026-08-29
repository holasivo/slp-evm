// SPDX-License-Identifier: BUSL-1.1
// EVM chain registry, vendored from the private @holasivo/evm package so this
// repository builds without access to Sivo's internal npm registry. Plain
// JavaScript (typed via chains.d.ts) because hardhat.config.ts is loaded by
// Node's native ESM resolver in some contexts (e.g. under vitest), which
// cannot map a .js specifier onto a .ts source file.
import {
  arbitrum,
  arbitrumSepolia,
  base,
  baseSepolia,
  mainnet,
  polygon,
  polygonAmoy,
  sepolia,
} from 'viem/chains';

export const evmChainMap = {
  mainnet,
  sepolia,
  arbitrum,
  arbitrumSepolia,
  base,
  baseSepolia,
  polygon,
  polygonAmoy,
};

const chainIds = Object.values(evmChainMap).map((x) => x.id);

export const isChainId = (x) => chainIds.includes(x);

export const toChainKey = (chainId) =>
  Object.entries(evmChainMap).find(([, v]) => v.id === chainId)?.[0];

// https://www.alchemy.com/docs/reference/node-supported-chains
export const alchemyRpcUrls = {
  [mainnet.id]: 'https://eth-mainnet.g.alchemy.com/v2',
  [sepolia.id]: 'https://eth-sepolia.g.alchemy.com/v2',
  [arbitrum.id]: 'https://arb-mainnet.g.alchemy.com/v2',
  [arbitrumSepolia.id]: 'https://arb-sepolia.g.alchemy.com/v2',
  [base.id]: 'https://base-mainnet.g.alchemy.com/v2',
  [baseSepolia.id]: 'https://base-sepolia.g.alchemy.com/v2',
  [polygon.id]: 'https://polygon-mainnet.g.alchemy.com/v2',
  [polygonAmoy.id]: 'https://polygon-amoy.g.alchemy.com/v2',
};
