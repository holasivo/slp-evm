import type {
  arbitrum,
  arbitrumSepolia,
  base,
  baseSepolia,
  mainnet,
  polygon,
  polygonAmoy,
  sepolia,
} from 'viem/chains';

export declare const evmChainMap: {
  mainnet: typeof mainnet;
  sepolia: typeof sepolia;
  arbitrum: typeof arbitrum;
  arbitrumSepolia: typeof arbitrumSepolia;
  base: typeof base;
  baseSepolia: typeof baseSepolia;
  polygon: typeof polygon;
  polygonAmoy: typeof polygonAmoy;
};

export type EvmChainKey = keyof typeof evmChainMap;
export type EvmChainId = (typeof evmChainMap)[EvmChainKey]['id'];

export declare const isChainId: (x: number) => x is EvmChainId;
export declare const toChainKey: (chainId: number) => EvmChainKey | undefined;
export declare const alchemyRpcUrls: Record<EvmChainId, string>;
