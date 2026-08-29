import { buildModule } from '@nomicfoundation/hardhat-ignition/modules';
import { MultiplierFunctionRoles } from '../hook/roles.js';
import { AccessManagerModule } from '../slp/create.js';

const MultiplierCreateImplModule = buildModule(
  'MultiplierCreateImplModule',
  (m) => {
    const impl = m.contract('Multiplier', []);
    return { impl };
  },
);

/// The Multiplier (leveraged SLP deposits via Morpho Blue) behind an ERC1967
/// proxy, wired to the central AccessManager. After deployment the MANAGER
/// must call setMarket per stablecoin with the Morpho market params (loan
/// token, SLP collateral, Morpho-shaped oracle, irm, lltv).
export const MultiplierCreateModule = buildModule(
  'MultiplierCreateModule',
  (m) => {
    const morpho = m.getParameter('morpho');
    const hook = m.getParameter('hook');
    const { accessManager } = m.useModule(AccessManagerModule);
    const { impl } = m.useModule(MultiplierCreateImplModule);
    const opts = { authority: accessManager, morpho, hook };
    const init = m.encodeFunctionCall(impl, 'initialize', [opts]);
    const proxy_ = m.contract('ERC1967Proxy', [impl, init], {
      id: 'MultiplierProxy',
    });
    const proxy = m.contractAt('Multiplier', proxy_);

    // function-role mappings (role grants are handled by SlpRolesModule; the
    // Multiplier needs no roles of its own — it holds positions for users,
    // never for itself)
    MultiplierFunctionRoles.forEach(({ role, selectors }, i) => {
      m.call(accessManager, 'setTargetFunctionRole', [proxy, selectors, role], {
        id: `multiplierFunctionRole${i}`,
      });
    });

    return { proxy, impl, accessManager };
  },
);

export default MultiplierCreateModule;
