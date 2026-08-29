import { buildModule } from '@nomicfoundation/hardhat-ignition/modules';
import { defaults as d } from '../helpers.js';

const SivoCreateImplModule = buildModule('SivoCreateImplModule', (m) => {
  const impl = m.contract('Sivo_', []);
  return { impl };
});

export const SivoCreateModule = buildModule('SivoCreateModule', (m) => {
  const owner = m.getParameter('owner', d.owner);
  const { impl } = m.useModule(SivoCreateImplModule);
  const init = m.encodeFunctionCall(impl, 'initialize', [owner, owner]);
  const id = { id: 'SivoProxy' };
  const proxy_ = m.contract('ERC1967Proxy', [impl, init], id);
  const proxy = m.contractAt('Sivo_', proxy_);
  return { proxy, impl };
});

export default SivoCreateModule;
