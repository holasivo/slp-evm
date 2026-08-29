import { buildModule } from '@nomicfoundation/hardhat-ignition/modules';
import { OracleFunctionRoles } from '../hook/roles.js';
import { AccessManagerModule } from '../slp/create.js';

/// Operator-published Chainlink-compatible SLP/USD NAV feed, used until the
/// dedicated Chainlink feed ships. setPrice is restricted through the central
/// AccessManager and mapped to the OPERATOR role here; the OPERATOR grant
/// itself comes from SlpRolesModule. After deployment, point the hook at the
/// feed via UniswapHook.setOracle (MANAGER).
export const SlpOracleModule = buildModule('SlpOracleModule', (m) => {
  const price = m.getParameter('price');
  const decimals = m.getParameter('decimals', 8);
  const description = m.getParameter('description', 'SLP / USD');
  const { accessManager } = m.useModule(AccessManagerModule);
  const oracle = m.contract('SlpOracle', [
    accessManager,
    decimals,
    description,
    price,
  ]);
  OracleFunctionRoles.forEach(({ role, selectors }, i) => {
    m.call(accessManager, 'setTargetFunctionRole', [oracle, selectors, role], {
      id: `oracleFunctionRole${i}`,
    });
  });
  return { oracle, accessManager };
});

export default SlpOracleModule;
