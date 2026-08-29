import { toFunctionSelector } from 'viem';

/// Central AccessManager role ids shared by deployment and tests.
/// Role 0 is AccessManager's built-in ADMIN_ROLE; unmapped functions
/// (e.g. upgradeToAndCall) require it by default.
export const Roles = {
  ADMIN: 0n,
  MANAGER: 1n,
  OPERATOR: 2n,
  PAUSER: 3n,
  MINTER: 4n,
} as const;

const sel = (signatures: string[]) => signatures.map(toFunctionSelector);

/// Function-role mappings applied to the SLP token
export const SlpFunctionRoles = [
  { role: Roles.MINTER, selectors: sel(['function mint(address,uint256)']) },
  {
    role: Roles.PAUSER,
    selectors: sel(['function pause()', 'function unpause()']),
  },
] as const;

/// Function-role mappings applied to the Multiplier
export const MultiplierFunctionRoles = [
  {
    role: Roles.MANAGER,
    selectors: sel([
      'function setMarket(address,(address,address,address,address,uint256))',
    ]),
  },
  {
    role: Roles.PAUSER,
    selectors: sel(['function pause()', 'function unpause()']),
  },
] as const;

/// Function-role mappings applied to the SlpOracle
export const OracleFunctionRoles = [
  {
    role: Roles.OPERATOR,
    selectors: sel(['function setPrice(int256)']),
  },
] as const;

/// Function-role mappings applied to the UniswapHook
export const HookFunctionRoles = [
  {
    role: Roles.OPERATOR,
    selectors: sel([
      'function fill(address,uint256)',
      'function replenish(address,uint256,uint256)',
      'function sweep(address,address)',
    ]),
  },
  {
    role: Roles.MANAGER,
    selectors: sel([
      'function setOracle(address,uint256,int256,int256)',
      'function setAssetOracle(address,address,uint256,int256,int256)',
      'function setMinRequestShares(uint256)',
    ]),
  },
  {
    role: Roles.PAUSER,
    selectors: sel(['function pause()', 'function unpause()']),
  },
] as const;
