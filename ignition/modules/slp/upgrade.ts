import { buildModule } from '@nomicfoundation/hardhat-ignition/modules';

/// Deploys a new SLP implementation for a Safe-proposed upgradeToAndCall on
/// the SLP proxy (see propose.ts).
export const SlpUpgradeImplModule = buildModule('SlpUpgradeImplModule', (m) => {
  const impl = m.contract('SLP', []);
  return { impl };
});

export default SlpUpgradeImplModule;
