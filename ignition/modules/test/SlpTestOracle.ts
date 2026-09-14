import { buildModule } from '@nomicfoundation/hardhat-ignition/modules';

/// Self-accruing SLP/USD NAV feed for test chains: reads 1.00 at deployment
/// and grows linearly at `apy_bps` per year, always fresh. Mirrors the
/// OracleHarness approach: sepolia runs against test feeds, mainnet against
/// the Chainlink SLP / USD feed. The deployer owns the feed (setApy). After
/// deployment, point the hook at it via UniswapHook.setOracle (MANAGER), e.g.
/// with scripts/set-oracle.ts.
export const SlpTestOracleModule = buildModule('SlpTestOracleModule', (m) => {
  const decimals = m.getParameter('decimals', 8);
  const apyBps = m.getParameter('apy_bps');
  const oracle = m.contract('SlpTestOracle', [decimals, apyBps]);
  return { oracle };
});

export default SlpTestOracleModule;
