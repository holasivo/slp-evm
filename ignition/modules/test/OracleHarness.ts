import { buildModule } from '@nomicfoundation/hardhat-ignition/modules';

export const OracleHarnessModule = buildModule('OracleHarnessModule', (m) => {
  const price = m.getParameter('price');
  const decimals = m.getParameter('decimals');
  const oracle = m.contract('OracleHarness', [price, decimals]);
  return { oracle };
});

export default OracleHarnessModule;
