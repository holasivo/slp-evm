import { Address, Hex, getCreate2Address, keccak256, pad, toHex } from 'viem';

/// The permission flags the UniswapHook proxy address must encode:
/// BEFORE_INITIALIZE (1<<13) | BEFORE_ADD_LIQUIDITY (1<<11) |
/// BEFORE_SWAP (1<<7) | BEFORE_DONATE (1<<5) | BEFORE_SWAP_RETURNS_DELTA (1<<3)
export const HOOK_FLAGS = 0x28a8n;

/// The low 14 bits of a hook address carry its permission flags
export const HOOK_FLAG_MASK = 0x3fffn;

export type MinedSalt = { salt: Hex; address: Address; iterations: number };

/**
 * Mines a CREATE2 salt such that the deployed address's low 14 bits encode
 * exactly the UniswapHook permission flags.
 *
 * @param deployer The CREATE2 deployer address (canonical deterministic
 * deployment proxy on live networks, Create2Factory in tests)
 * @param initCode The full creation code: ERC1967Proxy creation bytecode ++
 * abi.encode(implementation, initializeCalldata). The initialize options must
 * be final before mining — any change to them changes the address.
 */
export const mineHookSalt = (
  deployer: Address,
  initCode: Hex,
  flags: bigint = HOOK_FLAGS,
): MinedSalt => {
  const bytecodeHash = keccak256(initCode);
  // E[iterations] = 2^14 ≈ 16k; 10M is a generous safety bound
  for (let i = 0; i < 10_000_000; i++) {
    const salt = pad(toHex(i), { size: 32 });
    const address = getCreate2Address({ from: deployer, salt, bytecodeHash });
    if ((BigInt(address) & HOOK_FLAG_MASK) === flags) {
      return { salt, address, iterations: i + 1 };
    }
  }
  throw new Error('mineHookSalt: no salt found within 10M iterations');
};
