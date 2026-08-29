import { buildModule } from '@nomicfoundation/hardhat-ignition/modules';
import { SivoCreateModule } from './create.js';

const SivoUpgradeImplModule = buildModule('SivoUpgradeImplModule', (m) => {
  const impl = m.contract('Sivo', []);
  return { impl };
});

const SivoUpgradeModule = buildModule(`SivoUpgradeModule`, (m) => {
  const { proxy } = m.useModule(SivoCreateModule);
  const { impl } = m.useModule(SivoUpgradeImplModule);
  m.call(proxy, 'upgradeToAndCall', [impl, '0x']);
  return { impl };
});

export default SivoUpgradeModule;
