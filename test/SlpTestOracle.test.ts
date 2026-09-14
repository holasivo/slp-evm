import { buildMakeSlpProtocol, nh, toAddressMap, viem, Ξ } from './helpers.js';

const DECIMALS = 8;
const ONE = 100_000_000n; // 1.00 in 8 decimals
const APY_BPS = 1_000n; // 10% per year
const YEAR = 365n * 24n * 60n * 60n;

const makeSlpTestOracle = async () => {
  const [owner, ...users] = await viem.getWalletClients();
  const feed = await viem.deployContract('SlpTestOracle', [DECIMALS, APY_BPS]);
  const anchor = await feed.read.anchor();
  return { owner, users, feed, anchor };
};

describe('SlpTestOracle', () => {
  describe('deployment', () => {
    it('sets the feed metadata and owner', async () => {
      const { feed, owner } = await nh.loadFixture(makeSlpTestOracle);
      const a = toAddressMap({ owner });
      expect(await feed.read.decimals()).to.equal(DECIMALS);
      expect(await feed.read.description()).to.equal('SLP / USD');
      expect(await feed.read.version()).to.equal(1n);
      expect((await feed.read.owner()).toLowerCase()).to.equal(
        a.owner.toLowerCase(),
      );
      expect(await feed.read.apyBps()).to.equal(APY_BPS);
      expect(await feed.read.YEAR()).to.equal(YEAR);
    });

    it('prices exactly 1 at the deployment timestamp', async () => {
      const { feed, anchor } = await nh.loadFixture(makeSlpTestOracle);
      expect(await feed.read.basePrice()).to.equal(ONE);
      const [roundId, answer, startedAt, updatedAt, answeredInRound] =
        await feed.read.getRoundData([anchor]);
      expect(roundId).to.equal(anchor);
      expect(answer).to.equal(ONE);
      expect(startedAt).to.equal(anchor);
      expect(updatedAt).to.equal(anchor);
      expect(answeredInRound).to.equal(anchor);
    });
  });

  describe('accrual', () => {
    it('grows linearly to 1 + APY after one year', async () => {
      const { feed, anchor } = await nh.loadFixture(makeSlpTestOracle);
      expect((await feed.read.getRoundData([anchor + YEAR / 2n]))[1]).to.equal(
        105_000_000n,
      );
      expect((await feed.read.getRoundData([anchor + YEAR]))[1]).to.equal(
        110_000_000n,
      );
      expect((await feed.read.getRoundData([anchor + 3n * YEAR]))[1]).to.equal(
        130_000_000n,
      );
    });

    it('reports every read as a fresh, complete round', async () => {
      const { feed, anchor } = await nh.loadFixture(makeSlpTestOracle);
      await nh.time.increase(Number(YEAR));
      const [roundId, answer, startedAt, updatedAt, answeredInRound] =
        await feed.read.latestRoundData();
      expect(updatedAt >= anchor + YEAR).to.equal(true);
      expect(roundId).to.equal(updatedAt);
      expect(startedAt).to.equal(updatedAt);
      expect(answeredInRound).to.equal(roundId);
      // the latest answer is the same curve getRoundData exposes
      expect(answer).to.equal((await feed.read.getRoundData([updatedAt]))[1]);
      expect(answer >= 110_000_000n).to.equal(true);
    });
  });

  describe('setApy', () => {
    it('re-anchors at the current price so the curve stays continuous', async () => {
      const { feed, anchor } = await nh.loadFixture(makeSlpTestOracle);
      const ts = anchor + YEAR;
      await nh.time.setNextBlockTimestamp(ts);
      await viem.assertions.emitWithArgs(
        feed.write.setApy([2_000n]),
        feed,
        'ApyUpdated',
        [2_000n, 110_000_000n, ts],
      );
      expect(await feed.read.apyBps()).to.equal(2_000n);
      expect(await feed.read.basePrice()).to.equal(110_000_000n);
      expect(await feed.read.anchor()).to.equal(ts);
      // 1.10 growing at 20%: 1.32 one year later
      expect((await feed.read.getRoundData([ts + YEAR]))[1]).to.equal(
        132_000_000n,
      );
    });

    it('freezes the price at zero APY', async () => {
      const { feed, anchor } = await nh.loadFixture(makeSlpTestOracle);
      const ts = anchor + YEAR;
      await nh.time.setNextBlockTimestamp(ts);
      await feed.write.setApy([0n]);
      expect((await feed.read.getRoundData([ts + 10n * YEAR]))[1]).to.equal(
        110_000_000n,
      );
    });

    it('reverts for non-owners', async () => {
      const { feed, users } = await nh.loadFixture(makeSlpTestOracle);
      const [amy] = users;
      const a = toAddressMap({ amy });
      await viem.assertions.revertWithCustomErrorWithArgs(
        Ξ(amy, feed).write.setApy([0n]),
        feed,
        'OwnableUnauthorizedAccount',
        [a.amy],
      );
    });
  });

  describe('getRoundData', () => {
    it('reverts for timestamps before the current APY segment', async () => {
      const { feed, anchor } = await nh.loadFixture(makeSlpTestOracle);
      await viem.assertions.revertWithCustomErrorWithArgs(
        feed.read.getRoundData([anchor - 1n]),
        feed,
        'SlpTestOracleNoData',
        [anchor - 1n],
      );
    });
  });

  describe('hook integration', () => {
    // The testnet path: deploy the feed and point the hook at it via
    // setOracle (MANAGER). The feed is never stale, so the mainnet staleness
    // configuration can be kept on test chains without a publisher.
    it('the hook prices off the feed and never sees it stale', async () => {
      const makeSlpProtocol = buildMakeSlpProtocol();
      const p = await nh.loadFixture(makeSlpProtocol);
      const feed = await viem.deployContract('SlpTestOracle', [
        DECIMALS,
        APY_BPS,
      ]);
      await p.hook.write.setOracle([
        feed.address,
        86_400n,
        50_000_000n,
        200_000_000n,
      ]);
      expect((await p.hook.read.oracle()).toLowerCase()).to.equal(
        feed.address.toLowerCase(),
      );
      expect(await p.hook.read.oracleDecimals()).to.equal(DECIMALS);
      // InRange
      expect(await p.hook.read.priceStatus()).to.equal(0);
      // two years without anyone touching the feed: still fresh, ~1.20
      await nh.time.increase(Number(2n * YEAR));
      expect(await p.hook.read.priceStatus()).to.equal(0);
      // 1000% APY for a year pushes the price above priceMax
      await feed.write.setApy([100_000n]);
      await nh.time.increase(Number(YEAR));
      // OutOfRange
      expect(await p.hook.read.priceStatus()).to.equal(3);
    });
  });
});
