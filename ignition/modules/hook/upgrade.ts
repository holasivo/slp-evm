import { buildModule } from '@nomicfoundation/hardhat-ignition/modules';

/// Deploys a new UniswapHook implementation for a Safe-proposed
/// upgradeToAndCall on the mined proxy (see propose.ts). The PoolManager
/// address is an implementation immutable and must be passed again.
export const HookUpgradeImplModule = buildModule(
  'HookUpgradeImplModule',
  (m) => {
    const poolManager = m.getParameter('poolManager');
    const impl = m.contract('UniswapHook', [poolManager]);
    return { impl };
  },
);

export default HookUpgradeImplModule;
