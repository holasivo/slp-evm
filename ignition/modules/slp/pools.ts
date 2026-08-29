import { buildModule } from '@nomicfoundation/hardhat-ignition/modules';
import { defaults as d } from '../helpers.js';
import { HookFunctionRoles, Roles, SlpFunctionRoles } from '../hook/roles.js';
import { SlpCreateModule } from './create.js';

/// Wires the AccessManager role mappings for the SLP protocol. Requires the
/// hook proxy to be deployed (scripts/deploy-hook-proxy.ts) and both pools
/// to be initialized (scripts/init-pools.ts) first.
///
/// Pool initialization itself lives in scripts/init-pools.ts: Ignition
/// cannot pass a struct-returning staticCall future (hook.poolKey) into
/// PoolManager.initialize, so the two initialize calls are made with viem
/// against the key read from the hook on-chain.
export const SlpRolesModule = buildModule('SlpRolesModule', (m) => {
  const hook = m.contractAt('UniswapHook', m.getParameter('hook'));
  const opsManager = m.getParameter('opsManager', d.owner);
  const opsOperator = m.getParameter('opsOperator', d.owner);
  const opsPauser = m.getParameter('opsPauser', d.owner);
  const opsMinter = m.getParameter('opsMinter', d.owner);
  const { proxy: slp, accessManager } = m.useModule(SlpCreateModule);

  // function-role mappings
  SlpFunctionRoles.forEach(({ role, selectors }, i) => {
    m.call(accessManager, 'setTargetFunctionRole', [slp, selectors, role], {
      id: `slpFunctionRole${i}`,
    });
  });
  HookFunctionRoles.forEach(({ role, selectors }, i) => {
    m.call(accessManager, 'setTargetFunctionRole', [hook, selectors, role], {
      id: `hookFunctionRole${i}`,
    });
  });

  // role grants: the hook mints on deposits; ops accounts run the day-to-day
  m.call(accessManager, 'grantRole', [Roles.MINTER, hook, 0], {
    id: 'grantMinterHook',
  });
  m.call(accessManager, 'grantRole', [Roles.MINTER, opsMinter, 0], {
    id: 'grantMinterOps',
  });
  m.call(accessManager, 'grantRole', [Roles.MANAGER, opsManager, 0], {
    id: 'grantManagerOps',
  });
  m.call(accessManager, 'grantRole', [Roles.OPERATOR, opsOperator, 0], {
    id: 'grantOperatorOps',
  });
  m.call(accessManager, 'grantRole', [Roles.PAUSER, opsPauser, 0], {
    id: 'grantPauserOps',
  });

  return { hook, slp, accessManager };
});

export default SlpRolesModule;
