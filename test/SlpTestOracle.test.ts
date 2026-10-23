import { buildMakeSlpProtocol, nh, toAddressMap, viem, Ξ } from './helpers.js';

const DECIMALS = 8;
const ONE = 100_000_000n; // 1.00 in 8 decimals
const APY_BPS = 1_000n; // 10% per year
const DAY = 24n * 60n * 60n;
const YEAR = 365n * DAY;
/** The price the feed reports `t` seconds into its first APY segment. */
const priceAfter = (t: bigint) => ONE + (ONE * APY_BPS * t) / (10_000n * YEAR);

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
      expect(await feed.read.ROUND_LENGTH()).to.equal(DAY);
    });

    it('prices exactly 1 at the deployment timestamp', async () => {
      const { feed, anchor } = await nh.loadFixture(makeSlpTestOracle);
      expect(await feed.read.basePrice()).to.equal(ONE);
      const [roundId, answer, startedAt, updatedAt, answeredInRound] =
        await feed.read.latestRoundData();
      expect(roundId).to.equal(anchor / DAY);
      expect(answer).to.equal(ONE);
      expect(startedAt).to.equal(anchor);
      expect(updatedAt).to.equal(anchor);
      expect(answeredInRound).to.equal(anchor / DAY);
    });
  });

  describe('accrual', () => {
    it('grows linearly to 1 + APY after one year', async () => {
      const { feed, anchor } = await nh.loadFixture(makeSlpTestOracle);
      await nh.time.increaseTo(anchor + YEAR / 2n);
      expect((await feed.read.latestRoundData())[1]).to.equal(105_000_000n);
      await nh.time.increaseTo(anchor + YEAR);
      expect((await feed.read.latestRoundData())[1]).to.equal(110_000_000n);
      await nh.time.increaseTo(anchor + 3n * YEAR);
      expect((await feed.read.latestRoundData())[1]).to.equal(130_000_000n);
    });

    it("reports today's round, fresh and complete, at every read", async () => {
      const { feed, anchor } = await nh.loadFixture(makeSlpTestOracle);
      await nh.time.increase(Number(YEAR));
      const [roundId, answer, startedAt, updatedAt, answeredInRound] =
        await feed.read.latestRoundData();
      expect(updatedAt >= anchor + YEAR).to.equal(true);
      expect(roundId).to.equal(updatedAt / DAY);
      expect(startedAt).to.equal(updatedAt);
      expect(answeredInRound).to.equal(roundId);
      // the latest answer is the same curve getRoundData exposes
      expect(answer).to.equal((await feed.read.getRoundData([roundId]))[1]);
      expect(answer).to.equal(priceAfter(updatedAt - anchor));
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
      await nh.time.increaseTo(ts + YEAR);
      expect((await feed.read.latestRoundData())[1]).to.equal(132_000_000n);
    });

    it('freezes the price at zero APY', async () => {
      const { feed, anchor } = await nh.loadFixture(makeSlpTestOracle);
      const ts = anchor + YEAR;
      await nh.time.setNextBlockTimestamp(ts);
      await feed.write.setApy([0n]);
      await nh.time.increase(Number(10n * YEAR));
      expect((await feed.read.latestRoundData())[1]).to.equal(110_000_000n);
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
    // Consumers find the round for a date by walking back one round id at a
    // time from the latest, as on the daily Chainlink feed.
    it("walks back one day per round, to each day's last second", async () => {
      const { feed, anchor } = await nh.loadFixture(makeSlpTestOracle);
      const today = anchor / DAY + 3n;
      await nh.time.increaseTo(today * DAY + 22n);
      const [latest] = await feed.read.latestRoundData();
      expect(latest).to.equal(today);
      const yesterday = today * DAY - 1n;
      expect(await feed.read.getRoundData([latest - 1n])).to.deep.equal([
        today - 1n,
        priceAfter(yesterday - anchor),
        yesterday,
        yesterday,
        today - 1n,
      ]);
      // the deployment day ends after the anchor, so it is still served
      const first = await feed.read.getRoundData([anchor / DAY]);
      expect(first[3]).to.equal((anchor / DAY + 1n) * DAY - 1n);
    });

    it('reverts for days before the current APY segment', async () => {
      const { feed, anchor } = await nh.loadFixture(makeSlpTestOracle);
      const before = anchor / DAY - 1n;
      await viem.assertions.revertWithCustomErrorWithArgs(
        feed.read.getRoundData([before]),
        feed,
        'SlpTestOracleNoData',
        [before],
      );
    });

    it('reverts for days to come', async () => {
      const { feed, anchor } = await nh.loadFixture(makeSlpTestOracle);
      const tomorrow = anchor / DAY + 1n;
      await viem.assertions.revertWithCustomErrorWithArgs(
        feed.read.getRoundData([tomorrow]),
        feed,
        'SlpTestOracleNoData',
        [tomorrow],
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
