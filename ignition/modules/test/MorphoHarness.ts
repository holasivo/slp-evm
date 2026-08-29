import { buildModule } from '@nomicfoundation/hardhat-ignition/modules';

/// Testnet stand-in for Morpho Blue plus a Morpho-shaped market oracle
/// (price of 1 SLP in loan-token units, scaled by 1e36). Mirrors the
/// OracleHarness approach: sepolia runs against harnesses, mainnet against
/// the real Morpho singleton.
export const MorphoHarnessModule = buildModule('MorphoHarnessModule', (m) => {
  const price = m.getParameter('price');
  const morpho = m.contract('MorphoHarness', []);
  const morphoOracle = m.contract('MorphoOracleHarness', [price]);
  return { morpho, morphoOracle };
});

export default MorphoHarnessModule;
