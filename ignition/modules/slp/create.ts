import { buildModule } from '@nomicfoundation/hardhat-ignition/modules';
import { defaults as d } from '../helpers.js';

/// Central OpenZeppelin AccessManager holding all roles for the SLP protocol
/// contracts. The admin should be the Sivo Safe on mainnet.
export const AccessManagerModule = buildModule('AccessManagerModule', (m) => {
  const admin = m.getParameter('admin', d.owner);
  const accessManager = m.contract('AccessManager', [admin]);
  return { accessManager };
});

const SlpCreateImplModule = buildModule('SlpCreateImplModule', (m) => {
  const impl = m.contract('SLP', []);
  return { impl };
});

export const SlpCreateModule = buildModule('SlpCreateModule', (m) => {
  const name = m.getParameter('name', 'Sivo Liquidity Provider');
  const symbol = m.getParameter('symbol', 'SLP');
  const decimals = m.getParameter('decimals', 6);
  const { accessManager } = m.useModule(AccessManagerModule);
  const { impl } = m.useModule(SlpCreateImplModule);
  const opts = { name, symbol, decimals, authority: accessManager };
  const init = m.encodeFunctionCall(impl, 'initialize', [opts]);
  const proxy_ = m.contract('ERC1967Proxy', [impl, init], { id: 'SlpProxy' });
  const proxy = m.contractAt('SLP', proxy_);
  return { proxy, impl, accessManager };
});

/// The UniswapHook implementation. The proxy is NOT deployed here: its
/// address must encode the hook permission flags, so it is deployed at a
/// CREATE2-mined address by scripts/deploy-hook-proxy.ts after this module.
export const HookCreateImplModule = buildModule('HookCreateImplModule', (m) => {
  const poolManager = m.getParameter('poolManager');
  const impl = m.contract('UniswapHook', [poolManager]);
  return { impl };
});

/// Everything deployable before the mined hook proxy: AccessManager, SLP
/// (impl + proxy), and the hook implementation.
export const SlpProtocolModule = buildModule('SlpProtocolModule', (m) => {
  const slpModule = m.useModule(SlpCreateModule);
  const { impl: hookImpl } = m.useModule(HookCreateImplModule);
  return {
    accessManager: slpModule.accessManager,
    slp: slpModule.proxy,
    slpImpl: slpModule.impl,
    hookImpl,
  };
});

export default SlpProtocolModule;
