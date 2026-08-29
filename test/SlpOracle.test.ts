import { OracleFunctionRoles } from '../ignition/modules/hook/roles.js';
import {
  buildMakeSlpProtocol,
  nh,
  Roles,
  toAddressMap,
  viem,
  Ξ,
} from './helpers.js';

const DECIMALS = 8;
const DESCRIPTION = 'SLP / USD';
const PRICE = 100_000_000n; // 1.00 in 8 decimals

const makeSlpOracle = async () => {
  const [owner_, operator, ...users] = await viem.getWalletClients();
  const { address: owner } = owner_.account;
  const accessManager = await viem.deployContract('AccessManager', [owner]);
  const feed = await viem.deployContract('SlpOracle', [
    accessManager.address,
    DECIMALS,
    DESCRIPTION,
    PRICE,
  ]);
  for (const { role, selectors } of OracleFunctionRoles) {
    await accessManager.write.setTargetFunctionRole([
      feed.address,
      [...selectors],
      role,
    ]);
  }
  await accessManager.write.grantRole([
    Roles.OPERATOR,
    operator.account.address,
    0,
  ]);
  return { owner: owner_, operator, users, accessManager, feed };
};

describe('SlpOracle', () => {
  describe('deployment', () => {
    it('sets the feed metadata', async () => {
      const { feed, accessManager } = await nh.loadFixture(makeSlpOracle);
      expect(await feed.read.decimals()).to.equal(DECIMALS);
      expect(await feed.read.description()).to.equal(DESCRIPTION);
      expect(await feed.read.version()).to.equal(1n);
      expect((await feed.read.authority()).toLowerCase()).to.equal(
        accessManager.address.toLowerCase(),
      );
    });

    it('seeds a complete round 1 with the initial answer', async () => {
      const { feed } = await nh.loadFixture(makeSlpOracle);
      const [roundId, answer, startedAt, updatedAt, answeredInRound] =
        await feed.read.latestRoundData();
      expect(roundId).to.equal(1n);
      expect(answer).to.equal(PRICE);
      expect(updatedAt > 0n).to.equal(true);
      expect(startedAt).to.equal(updatedAt);
      expect(answeredInRound).to.equal(roundId);
    });

    it('rejects a non-positive initial answer', async () => {
      const { accessManager } = await nh.loadFixture(makeSlpOracle);
      await expect(
        viem.deployContract('SlpOracle', [
          accessManager.address,
          DECIMALS,
          DESCRIPTION,
          0n,
        ]),
      ).rejects.toThrow();
    });
  });

  describe('setPrice', () => {
    it('publishes a new round when the caller holds OPERATOR', async () => {
      const { feed, operator } = await nh.loadFixture(makeSlpOracle);
      const ts = BigInt((await nh.time.latest()) + 1000);
      await nh.time.setNextBlockTimestamp(ts);
      await viem.assertions.emitWithArgs(
        Ξ(operator, feed).write.setPrice([110_000_000n]),
        feed,
        'AnswerUpdated',
        [110_000_000n, 2n, ts],
      );
      const [roundId, answer, , updatedAt] = await feed.read.latestRoundData();
      expect(roundId).to.equal(2n);
      expect(answer).to.equal(110_000_000n);
      expect(updatedAt).to.equal(ts);
    });

    it('keeps past rounds queryable via getRoundData', async () => {
      const { feed, operator } = await nh.loadFixture(makeSlpOracle);
      await Ξ(operator, feed).write.setPrice([110_000_000n]);
      await Ξ(operator, feed).write.setPrice([120_000_000n]);
      const [roundId, answer, , , answeredInRound] =
        await feed.read.getRoundData([2n]);
      expect(roundId).to.equal(2n);
      expect(answer).to.equal(110_000_000n);
      expect(answeredInRound).to.equal(2n);
      expect((await feed.read.getRoundData([1n]))[1]).to.equal(PRICE);
    });

    it('reverts for callers without OPERATOR', async () => {
      const { feed, users } = await nh.loadFixture(makeSlpOracle);
      const [amy] = users;
      const a = toAddressMap({ amy });
      await viem.assertions.revertWithCustomErrorWithArgs(
        Ξ(amy, feed).write.setPrice([PRICE]),
        feed,
        'AccessManagedUnauthorized',
        [a.amy],
      );
    });

    it('reverts even for the AccessManager admin without OPERATOR', async () => {
      const { feed, owner } = await nh.loadFixture(makeSlpOracle);
      const a = toAddressMap({ owner });
      await viem.assertions.revertWithCustomErrorWithArgs(
        Ξ(owner, feed).write.setPrice([PRICE]),
        feed,
        'AccessManagedUnauthorized',
        [a.owner],
      );
    });

    it('rejects zero and negative answers', async () => {
      const { feed, operator } = await nh.loadFixture(makeSlpOracle);
      for (const answer of [0n, -1n]) {
        await viem.assertions.revertWithCustomErrorWithArgs(
          Ξ(operator, feed).write.setPrice([answer]),
          feed,
          'SlpOracleNonPositiveAnswer',
          [answer],
        );
      }
    });
  });

  describe('getRoundData', () => {
    it('reverts for rounds that were never published', async () => {
      const { feed } = await nh.loadFixture(makeSlpOracle);
      for (const roundId of [0n, 2n]) {
        await viem.assertions.revertWithCustomErrorWithArgs(
          feed.read.getRoundData([roundId]),
          feed,
          'SlpOracleNoData',
          [roundId],
        );
      }
    });
  });

  describe('hook migration', () => {
    // The mainnet cutover path: deploy the feed against the protocol's
    // AccessManager and point the hook at it via setOracle (MANAGER)
    it('the hook prices off the feed after setOracle', async () => {
      const makeSlpProtocol = buildMakeSlpProtocol();
      const p = await nh.loadFixture(makeSlpProtocol);
      const feed = await viem.deployContract('SlpOracle', [
        p.accessManager.address,
        DECIMALS,
        DESCRIPTION,
        PRICE,
      ]);
      for (const { role, selectors } of OracleFunctionRoles) {
        await p.accessManager.write.setTargetFunctionRole([
          feed.address,
          [...selectors],
          role,
        ]);
      }
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
      // owner holds OPERATOR in the fixture: publishing moves the hook price
      await feed.write.setPrice([210_000_000n]);
      // OutOfRange (above priceMax)
      expect(await p.hook.read.priceStatus()).to.equal(3);
    });
  });
});
