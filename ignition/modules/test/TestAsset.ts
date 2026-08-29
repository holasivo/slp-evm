import { buildModule } from '@nomicfoundation/hardhat-ignition/modules';

export const TestAssetModule = buildModule('TestAssetModule', (m) => {
  const symbol = m.getParameter('symbol');
  const decimals = m.getParameter('decimals');
  const owner = m.getParameter('owner');
  const asset = m.contract('Asset', [symbol, decimals, owner]);
  return { asset };
});

export default TestAssetModule;
