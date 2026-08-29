import { buildModule } from '@nomicfoundation/hardhat-ignition/modules';
import { defaults as d } from '../helpers.js';

export const USDTCreateModule = buildModule('USDTCreateModule', (m) => {
  const owner = m.getParameter('owner', d.owner);
  const token = m.contract('TetherUSD', [owner]);
  return { token };
});

export default USDTCreateModule;
