import { inspect } from 'util';
import {
  Address,
  encodeFunctionData,
  getAddress,
  maxUint256,
  parseEther,
  zeroAddress,
} from 'viem';
import { $ } from '../helpers.js';
import { HOOK_FLAG_MASK, HOOK_FLAGS } from '../ignition/modules/hook/mine.js';
import {
  buildMakeSlpProtocol,
  nh,
  Roles,
  SQRT_PRICE_1_1,
  toAddressMap,
  viem,
  Ξ,
} from './helpers.js';
inspect.defaultOptions.depth = 20;

const hour = 60 * 60;
const day = 24 * hour;

const makeSlpProtocol = buildMakeSlpProtocol();
const makeSlpProtocolWithMinRequest = buildMakeSlpProtocol({
  minRequestShares: $(10),
});

/** default PoolSwapTest settings: real tokens on both legs */
const settings = { takeClaims: false, settleUsingBurn: false };

const exactIn = (amount: bigint, zeroForOne: boolean) => ({
  zeroForOne,
  amountSpecified: -amount,
  sqrtPriceLimitX96: zeroForOne ? 4295128740n : SQRT_PRICE_1_1 * 100n,
});

describe('UniswapHook', () => {
  describe('deployment', () => {
    it('encodes the permission flags in the proxy address', async () => {
      const { hook } = await nh.loadFixture(makeSlpProtocol);
      expect(BigInt(hook.address) & HOOK_FLAG_MASK).to.equal(HOOK_FLAGS);
    });

    it('sets the right config', async () => {
      const {
        hook,
        slp,
        usdc,
        usdt,
        oracle,
        usdcOracle,
        usdtOracle,
        accessManager,
      } = await nh.loadFixture(makeSlpProtocol);
      expect(await hook.read.slp()).to.equal(slp.address);
      expect(await hook.read.slpDecimals()).to.equal(6);
      expect(await hook.read.supportedAssets()).to.deep.equal([
        usdc.address,
        usdt.address,
      ]);
      expect(await hook.read.oracle()).to.equal(oracle.address);
      expect(await hook.read.oracleDecimals()).to.equal(8);
      expect(await hook.read.authority()).to.equal(accessManager.address);
      expect(await hook.read.assetDecimals([usdc.address])).to.equal(6);
      expect(await hook.read.minRequestShares()).to.equal(0n);
      expect(await hook.read.assetOracleConfig([usdc.address])).to.deep.equal([
        usdcOracle.address,
        8,
        86_400n,
        99_500_000n,
        100_500_000n,
      ]);
      expect(await hook.read.assetOracleConfig([usdt.address])).to.deep.equal([
        usdtOracle.address,
        8,
        86_400n,
        99_500_000n,
        100_500_000n,
      ]);
    });

    it('builds sorted pool keys', async () => {
      const { hook, usdc, keyUsdc } = await nh.loadFixture(makeSlpProtocol);
      const key = await hook.read.poolKey([usdc.address]);
      expect(key.currency0.toLowerCase()).to.equal(
        keyUsdc.currency0.toLowerCase(),
      );
      expect(key.fee).to.equal(0);
      expect(key.tickSpacing).to.equal(60);
    });

    it('rejects initialization of unsanctioned pools', async () => {
      const { poolManager, hook, slp, usdc, owner } =
        await nh.loadFixture(makeSlpProtocol);
      const a = toAddressMap({ owner });
      // wrong fee
      const [c0, c1] =
        slp.address.toLowerCase() < usdc.address.toLowerCase()
          ? [slp.address, usdc.address]
          : [usdc.address, slp.address];
      await expect(
        poolManager.write.initialize([
          {
            currency0: c0,
            currency1: c1,
            fee: 100,
            tickSpacing: 60,
            hooks: hook.address,
          },
          SQRT_PRICE_1_1,
        ]),
      ).rejects.toThrow();
      // unsupported asset
      const rogue = await viem.deployContract('Asset', ['DAI', 6, a.owner]);
      const [r0, r1] =
        slp.address.toLowerCase() < rogue.address.toLowerCase()
          ? [slp.address, rogue.address]
          : [rogue.address, slp.address];
      await expect(
        poolManager.write.initialize([
          {
            currency0: r0,
            currency1: r1,
            fee: 0,
            tickSpacing: 60,
            hooks: hook.address,
          },
          SQRT_PRICE_1_1,
        ]),
      ).rejects.toThrow();
    });

    it('rejects overlapping slp/asset configuration', async () => {
      const {
        poolManager,
        slp,
        usdc,
        usdt,
        oracle,
        usdcOracle,
        usdtOracle,
        accessManager,
      } = await nh.loadFixture(makeSlpProtocol);
      const impl = await viem.deployContract('UniswapHookHarness', [
        poolManager.address,
      ]);
      const init = (asset0: Address, asset1: Address, asset0Oracle?: Address) =>
        encodeFunctionData({
          abi: impl.abi,
          functionName: 'initialize',
          args: [
            {
              authority: accessManager.address,
              slp: slp.address,
              asset0,
              asset1,
              oracle: oracle.address,
              price_min: 1n,
              price_max: 2n,
              max_staleness: 0n,
              min_request_shares: 0n,
              asset0_oracle: {
                oracle: asset0Oracle ?? usdcOracle.address,
                peg_min: 1n,
                peg_max: 2n,
                max_staleness: 0n,
              },
              asset1_oracle: {
                oracle: usdtOracle.address,
                peg_min: 1n,
                peg_max: 2n,
                max_staleness: 0n,
              },
            },
          ],
        });
      const overlapping: [Address, Address][] = [
        [slp.address, usdt.address], // slp doubles as asset0
        [usdc.address, slp.address], // slp doubles as asset1
        [usdc.address, usdc.address], // duplicate stablecoin
      ];
      for (const [asset0, asset1] of overlapping) {
        await viem.assertions.revertWithCustomError(
          viem.deployContract('ERC1967Proxy', [
            impl.address,
            init(asset0, asset1),
          ]),
          impl,
          'UniswapHookInvalidAssetConfig',
        );
      }
      // an unset asset feed is rejected: the asset's peg could not be checked
      await viem.assertions.revertWithCustomError(
        viem.deployContract('ERC1967Proxy', [
          impl.address,
          init(usdc.address, usdt.address, zeroAddress),
        ]),
        impl,
        'UniswapHookZeroAddress',
      );
    });

    it('cannot be initialized twice', async () => {
      const {
        hook,
        slp,
        usdc,
        usdt,
        oracle,
        usdcOracle,
        usdtOracle,
        accessManager,
      } = await nh.loadFixture(makeSlpProtocol);
      await viem.assertions.revertWithCustomError(
        hook.write.initialize([
          {
            authority: accessManager.address,
            slp: slp.address,
            asset0: usdc.address,
            asset1: usdt.address,
            oracle: oracle.address,
            price_min: 1n,
            price_max: 2n,
            max_staleness: 0n,
            min_request_shares: 0n,
            asset0_oracle: {
              oracle: usdcOracle.address,
              peg_min: 1n,
              peg_max: 2n,
              max_staleness: 0n,
            },
            asset1_oracle: {
              oracle: usdtOracle.address,
              peg_min: 1n,
              peg_max: 2n,
              max_staleness: 0n,
            },
          },
        ]),
        hook,
        'InvalidInitialization',
      );
    });
  });

  describe('liquidity and donations', () => {
    it('blocks adding liquidity', async () => {
      const { poolManager, keyUsdc, usdc, slp, owner } =
        await nh.loadFixture(makeSlpProtocol);
      const a = toAddressMap({ owner });
      const lpRouter = await viem.deployContract('PoolModifyLiquidityTest', [
        poolManager.address,
      ]);
      await usdc.write.mint([a.owner, $(1000)]);
      await slp.write.mint([a.owner, $(1000)]);
      await usdc.write.approve([lpRouter.address, maxUint256]);
      await slp.write.approve([lpRouter.address, maxUint256]);
      await expect(
        lpRouter.write.modifyLiquidity([
          keyUsdc,
          {
            tickLower: -60,
            tickUpper: 60,
            liquidityDelta: parseEther('1'),
            salt: `0x${'00'.repeat(32)}`,
          },
          '0x',
        ]),
      ).rejects.toThrow();
    });

    it('blocks donations', async () => {
      const { poolManager, keyUsdc, usdc, slp, owner } =
        await nh.loadFixture(makeSlpProtocol);
      const a = toAddressMap({ owner });
      const donateRouter = await viem.deployContract('PoolDonateTest', [
        poolManager.address,
      ]);
      await usdc.write.mint([a.owner, $(1000)]);
      await slp.write.mint([a.owner, $(1000)]);
      await usdc.write.approve([donateRouter.address, maxUint256]);
      await slp.write.approve([donateRouter.address, maxUint256]);
      await expect(
        donateRouter.write.donate([keyUsdc, $(1), $(1), '0x']),
      ).rejects.toThrow();
    });
  });

  describe('deposit', () => {
    it('swaps stablecoin for freshly minted SLP at price 1.00', async () => {
      const { hook, usdc, slp, users } = await nh.loadFixture(makeSlpProtocol);
      const [amy] = users;
      const a = toAddressMap({ amy, hook });
      await usdc.write.mint([a.amy, $(100)]);
      await Ξ(amy, usdc).write.approve([a.hook, $(100)]);
      await viem.assertions.emitWithArgs(
        Ξ(amy, hook).write.deposit([usdc.address, $(100), a.amy]),
        hook,
        'Deposit',
        [a.amy, a.amy, usdc.address, $(100), $(100)],
      );
      expect(await slp.read.balanceOf([a.amy])).to.equal($(100));
      expect(await slp.read.totalSupply()).to.equal($(100));
      expect(await usdc.read.balanceOf([a.hook])).to.equal($(100));
      expect(await hook.read.sweepable([usdc.address])).to.equal($(100));
    });

    it('prices deposits at the oracle price', async () => {
      const { hook, usdc, slp, oracle, users } =
        await nh.loadFixture(makeSlpProtocol);
      const [amy] = users;
      const a = toAddressMap({ amy, hook });
      await oracle.write.setPrice([125_000_000n]); // 1.25
      await usdc.write.mint([a.amy, $(100)]);
      await Ξ(amy, usdc).write.approve([a.hook, $(100)]);
      await Ξ(amy, hook).write.deposit([usdc.address, $(100), a.amy]);
      expect(await slp.read.balanceOf([a.amy])).to.equal($(80));
    });

    it('rounds SLP output down', async () => {
      const { hook, usdc, slp, oracle, users } =
        await nh.loadFixture(makeSlpProtocol);
      const [amy] = users;
      const a = toAddressMap({ amy, hook });
      await oracle.write.setPrice([150_000_000n]); // 1.50
      await usdc.write.mint([a.amy, 100n]);
      await Ξ(amy, usdc).write.approve([a.hook, 100n]);
      await Ξ(amy, hook).write.deposit([usdc.address, 100n, a.amy]);
      // 100 * 1e8 / 1.5e8 = 66.67 → 66
      expect(await slp.read.balanceOf([a.amy])).to.equal(66n);
    });

    it('supports USDT with the same flow', async () => {
      const { hook, usdt, slp, users } = await nh.loadFixture(makeSlpProtocol);
      const [amy] = users;
      const a = toAddressMap({ amy, hook });
      await usdt.write.mint([a.amy, $(50)]);
      await Ξ(amy, usdt).write.approve([a.hook, $(50)]);
      await Ξ(amy, hook).write.deposit([usdt.address, $(50), a.amy]);
      expect(await slp.read.balanceOf([a.amy])).to.equal($(50));
    });

    it('works through an external swap router (exact input)', async () => {
      const { hook, poolManager, swapRouter, keyUsdc, usdc, slp, users } =
        await nh.loadFixture(makeSlpProtocol);
      const [amy] = users;
      const a = toAddressMap({ amy, hook, poolManager });
      // router flow settles after the swap, so beforeSwap's take relies on
      // the PoolManager holding float (plentiful on mainnet, empty in a
      // fresh fixture) — pre-fund it
      await usdc.write.mint([a.poolManager, $(100)]);
      await usdc.write.mint([a.amy, $(100)]);
      await Ξ(amy, usdc).write.approve([swapRouter.address, $(100)]);
      const zeroForOne =
        keyUsdc.currency0.toLowerCase() === usdc.address.toLowerCase();
      await Ξ(amy, swapRouter).write.swap([
        keyUsdc,
        exactIn($(100), zeroForOne),
        settings,
        '0x',
      ]);
      expect(await slp.read.balanceOf([a.amy])).to.equal($(100));
    });

    it('works through an external swap router (exact output)', async () => {
      const {
        hook,
        poolManager,
        swapRouter,
        keyUsdc,
        usdc,
        slp,
        oracle,
        users,
      } = await nh.loadFixture(makeSlpProtocol);
      const [amy] = users;
      const a = toAddressMap({ amy, hook, poolManager });
      await oracle.write.setPrice([125_000_000n]); // 1.25
      await usdc.write.mint([a.poolManager, $(1000)]);
      await usdc.write.mint([a.amy, $(1000)]);
      await Ξ(amy, usdc).write.approve([swapRouter.address, $(1000)]);
      const zeroForOne =
        keyUsdc.currency0.toLowerCase() === usdc.address.toLowerCase();
      await Ξ(amy, swapRouter).write.swap([
        keyUsdc,
        {
          zeroForOne,
          amountSpecified: $(80), // exact output: 80 SLP
          sqrtPriceLimitX96: zeroForOne ? 4295128740n : SQRT_PRICE_1_1 * 100n,
        },
        settings,
        '0x',
      ]);
      expect(await slp.read.balanceOf([a.amy])).to.equal($(80));
      // paid 80 * 1.25 = 100
      expect(await usdc.read.balanceOf([a.amy])).to.equal($(900));
    });

    it('rejects the SLP-to-stable swap direction', async () => {
      const { poolManager, swapRouter, keyUsdc, usdc, slp, users } =
        await nh.loadFixture(makeSlpProtocol);
      const [amy] = users;
      const a = toAddressMap({ amy, poolManager });
      await slp.write.mint([a.amy, $(100)]);
      await usdc.write.mint([a.poolManager, $(100)]);
      await Ξ(amy, slp).write.approve([swapRouter.address, $(100)]);
      const slpForStable =
        keyUsdc.currency0.toLowerCase() === slp.address.toLowerCase();
      await expect(
        Ξ(amy, swapRouter).write.swap([
          keyUsdc,
          exactIn($(100), slpForStable),
          settings,
          '0x',
        ]),
      ).rejects.toThrow();
    });

    it('rejects deposits of unsupported assets and zero amounts', async () => {
      const { hook, usdc, users, owner } =
        await nh.loadFixture(makeSlpProtocol);
      const [amy] = users;
      const a = toAddressMap({ amy, owner });
      const rogue = await viem.deployContract('Asset', ['DAI', 6, a.owner]);
      await viem.assertions.revertWithCustomErrorWithArgs(
        Ξ(amy, hook).write.deposit([rogue.address, $(1), a.amy]),
        hook,
        'UniswapHookUnsupportedAsset',
        [rogue.address],
      );
      await viem.assertions.revertWithCustomError(
        Ξ(amy, hook).write.deposit([usdc.address, 0n, a.amy]),
        hook,
        'UniswapHookZeroAmount',
      );
      await viem.assertions.revertWithCustomError(
        Ξ(amy, hook).write.deposit([usdc.address, $(1), zeroAddress]),
        hook,
        'UniswapHookZeroAddress',
      );
    });

    it('is blocked while paused', async () => {
      const { hook, usdc, users } = await nh.loadFixture(makeSlpProtocol);
      const [amy] = users;
      const a = toAddressMap({ amy, hook });
      await usdc.write.mint([a.amy, $(100)]);
      await Ξ(amy, usdc).write.approve([a.hook, $(100)]);
      await hook.write.pause();
      await viem.assertions.revertWithCustomError(
        Ξ(amy, hook).write.deposit([usdc.address, $(100), a.amy]),
        hook,
        'EnforcedPause',
      );
      await hook.write.unpause();
      await Ξ(amy, hook).write.deposit([usdc.address, $(100), a.amy]);
    });

    it('is blocked when the oracle is stale, out of range, or reverting', async () => {
      const { hook, usdc, oracle, usdcOracle, users } =
        await nh.loadFixture(makeSlpProtocol);
      const [amy] = users;
      const a = toAddressMap({ amy, hook });
      await usdc.write.mint([a.amy, $(300)]);
      await Ξ(amy, usdc).write.approve([a.hook, $(300)]);
      // stale (maxStaleness = 1 day)
      await nh.time.increase(2 * day);
      // keep the asset's own feed fresh so only the NAV feed is under test
      await usdcOracle.write.setPrice([100_000_000n]);
      await expect(
        Ξ(amy, hook).write.deposit([usdc.address, $(100), a.amy]),
      ).rejects.toThrow(/OracleGateStale/);
      // out of range (band is [0.50, 2.00])
      await oracle.write.setPrice([300_000_000n]);
      await expect(
        Ξ(amy, hook).write.deposit([usdc.address, $(100), a.amy]),
      ).rejects.toThrow(/OracleGatePriceOutOfRange/);
      // reverting feed
      await oracle.write.setShouldRevert([true]);
      await expect(
        Ξ(amy, hook).write.deposit([usdc.address, $(100), a.amy]),
      ).rejects.toThrow(/OracleGateCallFailed/);
      // healthy again
      await oracle.write.setShouldRevert([false]);
      await oracle.write.setPrice([100_000_000n]);
      await Ξ(amy, hook).write.deposit([usdc.address, $(100), a.amy]);
    });
  });

  describe('asset USD feeds (M001)', () => {
    it('keeps deposits NAV-priced while the stablecoin holds its peg', async () => {
      const { hook, usdc, usdcOracle, slp, users } =
        await nh.loadFixture(makeSlpProtocol);
      const [amy] = users;
      const a = toAddressMap({ amy, hook });
      // 0.996 is inside the [0.995, 1.005] band: the feed only gates, so the
      // conversion still values the stablecoin at par
      await usdcOracle.write.setPrice([99_600_000n]);
      await usdc.write.mint([a.amy, $(100)]);
      await Ξ(amy, usdc).write.approve([a.hook, $(100)]);
      await Ξ(amy, hook).write.deposit([usdc.address, $(100), a.amy]);
      expect(await slp.read.balanceOf([a.amy])).to.equal($(100));
    });

    it('blocks the cross-asset depeg extraction at the mint leg', async () => {
      const p = await nh.loadFixture(makeSlpProtocol);
      const { hook, usdc, usdt, usdcOracle, users } = p;
      const [mallory] = users;
      const a = toAddressMap({ mallory, hook });
      // USDC trades at 0.98; mallory buys discounted USDC hoping to deposit
      // it at par and queue the SLP against the healthy USDT reserve
      await usdcOracle.write.setPrice([98_000_000n]);
      await usdc.write.mint([a.mallory, $(100)]);
      await Ξ(mallory, usdc).write.approve([a.hook, $(100)]);
      await expect(
        Ξ(mallory, hook).write.deposit([usdc.address, $(100), a.mallory]),
      ).rejects.toThrow(/OracleGatePriceOutOfRange/);
      // the healthy stablecoin keeps operating normally throughout
      await usdt.write.mint([a.mallory, $(100)]);
      await Ξ(mallory, usdt).write.approve([a.hook, $(100)]);
      await Ξ(mallory, hook).write.deposit([usdt.address, $(100), a.mallory]);
    });

    it('blocks deposits while the asset feed is out of band, stale, or reverting', async () => {
      const { hook, usdc, usdt, usdcOracle, users } =
        await nh.loadFixture(makeSlpProtocol);
      const [amy] = users;
      const a = toAddressMap({ amy, hook });
      await usdc.write.mint([a.amy, $(300)]);
      await usdt.write.mint([a.amy, $(100)]);
      await Ξ(amy, usdc).write.approve([a.hook, $(300)]);
      await Ξ(amy, usdt).write.approve([a.hook, $(100)]);
      // out of the peg band (band is [0.995, 1.005])
      await usdcOracle.write.setPrice([95_000_000n]);
      await expect(
        Ξ(amy, hook).write.deposit([usdc.address, $(100), a.amy]),
      ).rejects.toThrow(/OracleGatePriceOutOfRange/);
      // the other stablecoin's feed is unaffected
      await Ξ(amy, hook).write.deposit([usdt.address, $(100), a.amy]);
      // stale
      await usdcOracle.write.setPrice([100_000_000n]);
      await usdcOracle.write.setUpdatedAt([1n]);
      await expect(
        Ξ(amy, hook).write.deposit([usdc.address, $(100), a.amy]),
      ).rejects.toThrow(/OracleGateStale/);
      // reverting feed
      await usdcOracle.write.setShouldRevert([true]);
      await expect(
        Ξ(amy, hook).write.deposit([usdc.address, $(100), a.amy]),
      ).rejects.toThrow(/OracleGateCallFailed/);
      // healthy again
      await usdcOracle.write.setShouldRevert([false]);
      await usdcOracle.write.setPrice([100_000_000n]);
      await Ξ(amy, hook).write.deposit([usdc.address, $(100), a.amy]);
    });

    it('blocks fills while the asset feed is out of the peg band', async () => {
      const p = await nh.loadFixture(makeSlpProtocol);
      const { hook, slp, usdc, usdcOracle, users } = p;
      const [amy] = users;
      const a = toAddressMap({ amy, hook });
      await usdc.write.mint([a.amy, $(100)]);
      await Ξ(amy, usdc).write.approve([a.hook, $(100)]);
      await Ξ(amy, hook).write.deposit([usdc.address, $(100), a.amy]);
      await Ξ(amy, slp).write.approve([a.hook, $(50)]);
      await Ξ(amy, hook).write.requestWithdraw([usdc.address, $(50)]);
      await usdcOracle.write.setPrice([95_000_000n]);
      await expect(hook.write.fill([usdc.address, 10n])).rejects.toThrow(
        /OracleGatePriceOutOfRange/,
      );
      await usdcOracle.write.setPrice([100_000_000n]);
      await hook.write.fill([usdc.address, 10n]);
      expect(await hook.read.claimableWithdraw([usdc.address, a.amy])).to.equal(
        $(50),
      );
    });

    it('maxDeposit reflects asset feed health', async () => {
      const { hook, usdc, usdt, usdcOracle } =
        await nh.loadFixture(makeSlpProtocol);
      expect(await hook.read.maxDeposit([usdc.address])).to.equal(maxUint256);
      await usdcOracle.write.setPrice([95_000_000n]);
      expect(await hook.read.maxDeposit([usdc.address])).to.equal(0n);
      expect(await hook.read.maxDeposit([usdt.address])).to.equal(maxUint256);
      await usdcOracle.write.setPrice([100_000_000n]);
      expect(await hook.read.maxDeposit([usdc.address])).to.equal(maxUint256);
    });

    it('oracleStatus reports every feed for monitoring', async () => {
      const { hook, usdc, usdt, oracle, usdcOracle, usdtOracle } =
        await nh.loadFixture(makeSlpProtocol);
      // PriceStatus: 0 InRange, 1 IncompleteRound, 2 Stale, 3 OutOfRange,
      // 4 OracleError
      expect(await hook.read.oracleStatus()).to.deep.equal([0, 0, 0]);
      // USDC depegs below the band
      await usdcOracle.write.setPrice([98_000_000n]);
      expect(await hook.read.oracleStatus()).to.deep.equal([0, 3, 0]);
      expect(await hook.read.assetPriceStatus([usdc.address])).to.equal(3);
      expect(await hook.read.assetPriceStatus([usdt.address])).to.equal(0);
      // USDT feed goes stale, the NAV feed goes down
      await usdtOracle.write.setUpdatedAt([1n]);
      await oracle.write.setShouldRevert([true]);
      expect(await hook.read.oracleStatus()).to.deep.equal([4, 3, 2]);
      expect(await hook.read.priceStatus()).to.equal(4);
      // everything recovers
      await oracle.write.setShouldRevert([false]);
      await oracle.write.setPrice([100_000_000n]);
      await usdcOracle.write.setPrice([100_000_000n]);
      await usdtOracle.write.setPrice([100_000_000n]);
      expect(await hook.read.oracleStatus()).to.deep.equal([0, 0, 0]);
    });

    it('setAssetOracle validates, updates, and emits', async () => {
      const { hook, slp, usdc, usdcOracle, users, owner } =
        await nh.loadFixture(makeSlpProtocol);
      const [amy] = users;
      const a = toAddressMap({ amy, owner });
      const rogue = await viem.deployContract('Asset', ['DAI', 6, a.owner]);
      await viem.assertions.revertWithCustomErrorWithArgs(
        hook.write.setAssetOracle([
          rogue.address,
          usdcOracle.address,
          0n,
          1n,
          2n,
        ]),
        hook,
        'UniswapHookUnsupportedAsset',
        [rogue.address],
      );
      await viem.assertions.revertWithCustomError(
        hook.write.setAssetOracle([usdc.address, zeroAddress, 0n, 1n, 2n]),
        hook,
        'UniswapHookZeroAddress',
      );
      await viem.assertions.revertWithCustomErrorWithArgs(
        hook.write.setAssetOracle([
          usdc.address,
          usdcOracle.address,
          0n,
          2n,
          1n,
        ]),
        hook,
        'OracleGateInvalidPriceRange',
        [2n, 1n],
      );
      await viem.assertions.revertWithCustomErrorWithArgs(
        hook.write.setAssetOracle([
          usdc.address,
          usdcOracle.address,
          0n,
          0n,
          1n,
        ]),
        hook,
        'OracleGateNonPositivePriceMin',
        [0n],
      );
      // migrating to a feed with different decimals re-caches them
      const feed18 = await viem.deployContract('OracleHarness', [
        10n ** 18n,
        18,
      ]);
      await viem.assertions.emitWithArgs(
        hook.write.setAssetOracle([
          usdc.address,
          feed18.address,
          3_600n,
          98n * 10n ** 16n,
          102n * 10n ** 16n,
        ]),
        hook,
        'UniswapHookAssetOracleChange',
        [
          usdc.address,
          feed18.address,
          3_600n,
          98n * 10n ** 16n,
          102n * 10n ** 16n,
        ],
      );
      expect(await hook.read.assetOracleConfig([usdc.address])).to.deep.equal([
        getAddress(feed18.address),
        18,
        3_600n,
        98n * 10n ** 16n,
        102n * 10n ** 16n,
      ]);
      // pricing works unchanged on the new decimal basis
      await usdc.write.mint([a.amy, $(100)]);
      await Ξ(amy, usdc).write.approve([hook.address, $(100)]);
      await Ξ(amy, hook).write.deposit([usdc.address, $(100), a.amy]);
      expect(await slp.read.balanceOf([a.amy])).to.equal($(100));
    });
  });

  describe('withdrawal queue', () => {
    /** amy deposits, giving the hook free stablecoin and amy SLP */
    const depositAs = async (
      p: Awaited<ReturnType<ReturnType<typeof buildMakeSlpProtocol>>>,
      user: (typeof p.users)[number],
      amount: bigint,
    ) => {
      const { address } = user.account;
      await p.usdc.write.mint([address, amount]);
      await Ξ(user, p.usdc).write.approve([p.hook.address, amount]);
      await Ξ(user, p.hook).write.deposit([p.usdc.address, amount, address]);
    };

    it('queues SLP and tracks pending state', async () => {
      const p = await nh.loadFixture(makeSlpProtocol);
      const { hook, slp, usdc, users } = p;
      const [amy] = users;
      const a = toAddressMap({ amy, hook });
      await depositAs(p, amy, $(100));
      // sweep so the queue is not auto-filled by the deposit float
      await hook.write.sweep([usdc.address, p.owner.account.address]);
      await Ξ(amy, slp).write.approve([a.hook, $(100)]);
      await viem.assertions.emitWithArgs(
        Ξ(amy, hook).write.requestWithdraw([usdc.address, $(60)]),
        hook,
        'RedeemRequest',
        [a.amy, usdc.address, 0n, a.amy, $(60)],
      );
      expect(await hook.read.pendingWithdraw([usdc.address, a.amy])).to.equal(
        $(60),
      );
      expect(await hook.read.totalPendingShares([usdc.address])).to.equal(
        $(60),
      );
      expect(await slp.read.balanceOf([a.hook])).to.equal($(60));
      expect(await slp.read.balanceOf([a.amy])).to.equal($(40));
      expect(await hook.read.queueLength([usdc.address])).to.equal(1n);
    });

    it('enforces the minimum request size', async () => {
      const p = await nh.loadFixture(makeSlpProtocolWithMinRequest);
      const { hook, slp, usdc, users } = p;
      const [amy] = users;
      const a = toAddressMap({ amy, hook });
      await depositAs(p, amy, $(100));
      await Ξ(amy, slp).write.approve([a.hook, $(100)]);
      await viem.assertions.revertWithCustomErrorWithArgs(
        Ξ(amy, hook).write.requestWithdraw([usdc.address, $(5)]),
        hook,
        'UniswapHookRequestTooSmall',
        [$(5), $(10)],
      );
      await Ξ(amy, hook).write.requestWithdraw([usdc.address, $(10)]);
    });

    it('cancel cannot leave a live request below the minimum (M002)', async () => {
      const p = await nh.loadFixture(makeSlpProtocolWithMinRequest);
      const { hook, slp, usdc, users, owner } = p;
      const [amy] = users;
      const a = toAddressMap({ amy, hook, owner });
      await depositAs(p, amy, $(100));
      await hook.write.sweep([usdc.address, a.owner]);
      await Ξ(amy, slp).write.approve([a.hook, $(100)]);
      await Ξ(amy, hook).write.requestWithdraw([usdc.address, $(15)]);
      // cancelling 6 of 15 would leave 9, below the minimum of 10
      await viem.assertions.revertWithCustomErrorWithArgs(
        Ξ(amy, hook).write.cancelWithdraw([usdc.address, $(6)]),
        hook,
        'UniswapHookResidualTooSmall',
        [$(9), $(10)],
      );
      // leaving exactly the minimum is allowed
      await Ξ(amy, hook).write.cancelWithdraw([usdc.address, $(5)]);
      expect(await hook.read.pendingWithdraw([usdc.address, a.amy])).to.equal(
        $(10),
      );
      // fully draining the request (tombstone) is allowed
      await Ξ(amy, hook).write.cancelWithdraw([usdc.address, $(10)]);
      expect(await hook.read.pendingWithdraw([usdc.address, a.amy])).to.equal(
        0n,
      );
      expect(await slp.read.balanceOf([a.amy])).to.equal($(100));
    });

    it('cancel walk enforces the floor on the last touched request (M002)', async () => {
      const p = await nh.loadFixture(makeSlpProtocolWithMinRequest);
      const { hook, slp, usdc, users, owner } = p;
      const [amy] = users;
      const a = toAddressMap({ amy, hook, owner });
      await depositAs(p, amy, $(100));
      await hook.write.sweep([usdc.address, a.owner]);
      await Ξ(amy, slp).write.approve([a.hook, $(100)]);
      await Ξ(amy, hook).write.requestWithdraw([usdc.address, $(15)]);
      await Ξ(amy, hook).write.requestWithdraw([usdc.address, $(15)]);
      // 21 drains the newest request (15) and leaves the older at 9 < 10
      await viem.assertions.revertWithCustomErrorWithArgs(
        Ξ(amy, hook).write.cancelWithdraw([usdc.address, $(21)]),
        hook,
        'UniswapHookResidualTooSmall',
        [$(9), $(10)],
      );
      // 20 drains the newest and leaves the older exactly at the minimum
      await Ξ(amy, hook).write.cancelWithdraw([usdc.address, $(20)]);
      expect(await hook.read.pendingWithdraw([usdc.address, a.amy])).to.equal(
        $(10),
      );
      expect(await slp.read.balanceOf([a.amy])).to.equal($(90));
    });

    it('deposits auto-fill the queue FIFO', async () => {
      const p = await nh.loadFixture(makeSlpProtocol);
      const { hook, slp, usdc, users, owner } = p;
      const [amy, bob] = users;
      const a = toAddressMap({ amy, bob, hook, owner });
      await depositAs(p, amy, $(100));
      await hook.write.sweep([usdc.address, a.owner]);
      await Ξ(amy, slp).write.approve([a.hook, $(100)]);
      await Ξ(amy, hook).write.requestWithdraw([usdc.address, $(100)]);
      // bob's deposit fills amy's request
      await depositAs(p, bob, $(100));
      expect(await hook.read.pendingWithdraw([usdc.address, a.amy])).to.equal(
        0n,
      );
      expect(await hook.read.claimableWithdraw([usdc.address, a.amy])).to.equal(
        $(100),
      );
      expect(await hook.read.totalClaimableAssets([usdc.address])).to.equal(
        $(100),
      );
      // the filled SLP was burned: only bob's 100 remain
      expect(await slp.read.totalSupply()).to.equal($(100));
      // reserved stablecoin is not sweepable
      expect(await hook.read.sweepable([usdc.address])).to.equal(0n);
    });

    it('locks the price at fill time, not request time', async () => {
      const p = await nh.loadFixture(makeSlpProtocol);
      const { hook, slp, usdc, oracle, users, owner } = p;
      const [amy] = users;
      const a = toAddressMap({ amy, hook, owner });
      await depositAs(p, amy, $(100));
      await hook.write.sweep([usdc.address, a.owner]);
      await Ξ(amy, slp).write.approve([a.hook, $(100)]);
      await Ξ(amy, hook).write.requestWithdraw([usdc.address, $(100)]);
      // price moves up after the request
      await oracle.write.setPrice([125_000_000n]);
      // operator replenishes and fills at the new price
      await usdc.write.mint([a.owner, $(125)]);
      await usdc.write.approve([a.hook, $(125)]);
      await hook.write.replenish([usdc.address, $(125), 10n]);
      expect(await hook.read.claimableWithdraw([usdc.address, a.amy])).to.equal(
        $(125),
      );
      // a later price move does not change the locked amount
      await oracle.write.setPrice([200_000_000n]);
      expect(await hook.read.claimableWithdraw([usdc.address, a.amy])).to.equal(
        $(125),
      );
    });

    it('supports partial fills across the budget boundary', async () => {
      const p = await nh.loadFixture(makeSlpProtocol);
      const { hook, slp, usdc, users, owner } = p;
      const [amy] = users;
      const a = toAddressMap({ amy, hook, owner });
      await depositAs(p, amy, $(100));
      await hook.write.sweep([usdc.address, a.owner]);
      await Ξ(amy, slp).write.approve([a.hook, $(100)]);
      await Ξ(amy, hook).write.requestWithdraw([usdc.address, $(100)]);
      // replenish only 40 of the 100 owed
      await usdc.write.mint([a.owner, $(40)]);
      await usdc.write.approve([a.hook, $(40)]);
      await hook.write.replenish([usdc.address, $(40), 10n]);
      expect(await hook.read.claimableWithdraw([usdc.address, a.amy])).to.equal(
        $(40),
      );
      expect(await hook.read.pendingWithdraw([usdc.address, a.amy])).to.equal(
        $(60),
      );
      // top up the rest
      await usdc.write.mint([a.owner, $(60)]);
      await usdc.write.approve([a.hook, $(60)]);
      await hook.write.replenish([usdc.address, $(60), 10n]);
      expect(await hook.read.claimableWithdraw([usdc.address, a.amy])).to.equal(
        $(100),
      );
      expect(await hook.read.pendingWithdraw([usdc.address, a.amy])).to.equal(
        0n,
      );
    });

    it('bounds the auto-fill pass and lets fill() finish the job', async () => {
      const p = await nh.loadFixture(makeSlpProtocol);
      const { hook, slp, usdc, users, owner } = p;
      const [amy, bob] = users;
      const a = toAddressMap({ amy, bob, hook, owner });
      await depositAs(p, amy, $(120));
      await hook.write.sweep([usdc.address, a.owner]);
      await Ξ(amy, slp).write.approve([a.hook, $(120)]);
      // six requests of 10 each
      for (let i = 0; i < 6; i++) {
        await Ξ(amy, hook).write.requestWithdraw([usdc.address, $(10)]);
      }
      // bob's deposit covers all 60 owed but AUTO_FILL_MAX = 5 bounds the pass
      await depositAs(p, bob, $(100));
      expect(await hook.read.claimableWithdraw([usdc.address, a.amy])).to.equal(
        $(50),
      );
      expect(await hook.read.pendingWithdraw([usdc.address, a.amy])).to.equal(
        $(10),
      );
      // the operator's fill completes the queue
      await hook.write.fill([usdc.address, 10n]);
      expect(await hook.read.claimableWithdraw([usdc.address, a.amy])).to.equal(
        $(60),
      );
    });

    it('restricts fill to the operator role (L002)', async () => {
      const p = await nh.loadFixture(makeSlpProtocol);
      const { hook, slp, usdc, users, owner } = p;
      const [amy, bob] = users;
      const a = toAddressMap({ amy, bob, hook, owner });
      await depositAs(p, amy, $(100));
      await Ξ(amy, slp).write.approve([a.hook, $(100)]);
      await Ξ(amy, hook).write.requestWithdraw([usdc.address, $(100)]);
      // a third party cannot pick the settlement moment for queued redeemers
      await viem.assertions.revertWithCustomErrorWithArgs(
        Ξ(bob, hook).write.fill([usdc.address, 10n]),
        hook,
        'AccessManagedUnauthorized',
        [a.bob],
      );
      // the redeemer themselves cannot either
      await viem.assertions.revertWithCustomErrorWithArgs(
        Ξ(amy, hook).write.fill([usdc.address, 10n]),
        hook,
        'AccessManagedUnauthorized',
        [a.amy],
      );
      // the operator can
      await hook.write.fill([usdc.address, 10n]);
      expect(await hook.read.claimableWithdraw([usdc.address, a.amy])).to.equal(
        $(100),
      );
    });

    it('claims pay the receiver and clear the reserve', async () => {
      const p = await nh.loadFixture(makeSlpProtocol);
      const { hook, slp, usdc, users, owner } = p;
      const [amy, bob] = users;
      const a = toAddressMap({ amy, bob, hook, owner });
      await depositAs(p, amy, $(100));
      await Ξ(amy, slp).write.approve([a.hook, $(100)]);
      await Ξ(amy, hook).write.requestWithdraw([usdc.address, $(100)]);
      await hook.write.fill([usdc.address, 10n]);
      await viem.assertions.emitWithArgs(
        Ξ(amy, hook).write.claimWithdraw([usdc.address, a.bob]),
        hook,
        'Withdraw',
        [a.amy, a.bob, usdc.address, $(100), 0n],
      );
      expect(await usdc.read.balanceOf([a.bob])).to.equal($(100));
      expect(await hook.read.totalClaimableAssets([usdc.address])).to.equal(0n);
      await viem.assertions.revertWithCustomErrorWithArgs(
        Ξ(amy, hook).write.claimWithdraw([usdc.address, a.bob]),
        hook,
        'UniswapHookNothingToClaim',
        [a.amy, usdc.address],
      );
    });

    it('claims survive an oracle outage (M003 parity)', async () => {
      const p = await nh.loadFixture(makeSlpProtocol);
      const { hook, slp, usdc, oracle, users } = p;
      const [amy] = users;
      const a = toAddressMap({ amy, hook });
      await depositAs(p, amy, $(100));
      await Ξ(amy, slp).write.approve([a.hook, $(100)]);
      await Ξ(amy, hook).write.requestWithdraw([usdc.address, $(100)]);
      await hook.write.fill([usdc.address, 10n]);
      await oracle.write.setShouldRevert([true]);
      await Ξ(amy, hook).write.claimWithdraw([usdc.address, a.amy]);
      expect(await usdc.read.balanceOf([a.amy])).to.equal($(100));
    });

    it('supports operator-delegated claims and cancels', async () => {
      const p = await nh.loadFixture(makeSlpProtocol);
      const { hook, slp, usdc, users, owner } = p;
      const [amy, bob] = users;
      const a = toAddressMap({ amy, bob, hook, owner });
      await depositAs(p, amy, $(100));
      await hook.write.sweep([usdc.address, a.owner]);
      await Ξ(amy, slp).write.approve([a.hook, $(100)]);
      await Ξ(amy, hook).write.requestWithdraw([usdc.address, $(100)]);
      // bob is not an operator yet
      await viem.assertions.revertWithCustomErrorWithArgs(
        Ξ(bob, hook).write.cancelWithdraw([usdc.address, $(50), a.amy]),
        hook,
        'UniswapHookUnauthorizedSender',
        [a.bob, a.amy],
      );
      await Ξ(amy, hook).write.setOperator([a.bob, true]);
      expect(await hook.read.isOperator([a.amy, a.bob])).to.equal(true);
      await Ξ(bob, hook).write.cancelWithdraw([usdc.address, $(50), a.amy]);
      // the cancelled SLP goes to the controller, not the operator
      expect(await slp.read.balanceOf([a.amy])).to.equal($(50));
    });

    it('cancel returns only unfilled SLP, newest requests first', async () => {
      const p = await nh.loadFixture(makeSlpProtocol);
      const { hook, slp, usdc, users, owner } = p;
      const [amy] = users;
      const a = toAddressMap({ amy, hook, owner });
      await depositAs(p, amy, $(100));
      await hook.write.sweep([usdc.address, a.owner]);
      await Ξ(amy, slp).write.approve([a.hook, $(100)]);
      await Ξ(amy, hook).write.requestWithdraw([usdc.address, $(60)]);
      await Ξ(amy, hook).write.requestWithdraw([usdc.address, $(40)]);
      // fill the first request only
      await usdc.write.mint([a.owner, $(60)]);
      await usdc.write.approve([a.hook, $(60)]);
      await hook.write.replenish([usdc.address, $(60), 1n]);
      // only 40 remain pending; cancelling more reverts
      await viem.assertions.revertWithCustomErrorWithArgs(
        Ξ(amy, hook).write.cancelWithdraw([usdc.address, $(50)]),
        hook,
        'UniswapHookInsufficientPending',
        [$(50), $(40)],
      );
      await viem.assertions.emitWithArgs(
        Ξ(amy, hook).write.cancelWithdraw([usdc.address, $(40)]),
        hook,
        'RedeemCancel',
        [a.amy, usdc.address, a.amy, $(40)],
      );
      expect(await slp.read.balanceOf([a.amy])).to.equal($(40));
      expect(await hook.read.pendingWithdraw([usdc.address, a.amy])).to.equal(
        0n,
      );
      // claimable from the filled request is untouched
      expect(await hook.read.claimableWithdraw([usdc.address, a.amy])).to.equal(
        $(60),
      );
    });

    it('fill skips cancelled (tombstoned) queue entries', async () => {
      const p = await nh.loadFixture(makeSlpProtocol);
      const { hook, slp, usdc, users, owner } = p;
      const [amy, bob] = users;
      const a = toAddressMap({ amy, bob, hook, owner });
      await depositAs(p, amy, $(50));
      await depositAs(p, bob, $(50));
      await hook.write.sweep([usdc.address, a.owner]);
      await Ξ(amy, slp).write.approve([a.hook, $(50)]);
      await Ξ(bob, slp).write.approve([a.hook, $(50)]);
      await Ξ(amy, hook).write.requestWithdraw([usdc.address, $(50)]);
      await Ξ(bob, hook).write.requestWithdraw([usdc.address, $(50)]);
      // amy cancels the head request
      await Ξ(amy, hook).write.cancelWithdraw([usdc.address, $(50)]);
      // filling skips the tombstone and fills bob
      await usdc.write.mint([a.owner, $(50)]);
      await usdc.write.approve([a.hook, $(50)]);
      await hook.write.replenish([usdc.address, $(50), 10n]);
      expect(await hook.read.claimableWithdraw([usdc.address, a.bob])).to.equal(
        $(50),
      );
      expect(await hook.read.queueHead([usdc.address])).to.equal(2n);
    });

    it('cancellation pops its own tombstones at the head (L003)', async () => {
      const p = await nh.loadFixture(makeSlpProtocol);
      const { hook, slp, usdc, users, owner } = p;
      const [amy] = users;
      const a = toAddressMap({ amy, hook, owner });
      await depositAs(p, amy, $(30));
      await hook.write.sweep([usdc.address, a.owner]);
      await Ξ(amy, slp).write.approve([a.hook, $(30)]);
      for (let i = 0; i < 3; i++) {
        await Ξ(amy, hook).write.requestWithdraw([usdc.address, $(10)]);
      }
      // draining all three requests leaves no tombstones behind: the cancel
      // advances the head past its own dead entries
      await Ξ(amy, hook).write.cancelWithdraw([usdc.address, $(30)]);
      expect(await hook.read.queueHead([usdc.address])).to.equal(3n);
      expect(await slp.read.balanceOf([a.amy])).to.equal($(30));
    });

    it('a tombstone wall does not starve the auto-fill pass (L003)', async () => {
      const p = await nh.loadFixture(makeSlpProtocol);
      const { hook, slp, usdc, users, owner } = p;
      const [amy, bob, carol] = users;
      const a = toAddressMap({ amy, bob, carol, hook, owner });
      await depositAs(p, carol, $(10));
      await depositAs(p, amy, $(60));
      await depositAs(p, bob, $(10));
      await hook.write.sweep([usdc.address, a.owner]);
      await Ξ(carol, slp).write.approve([a.hook, $(10)]);
      await Ξ(amy, slp).write.approve([a.hook, $(60)]);
      await Ξ(bob, slp).write.approve([a.hook, $(10)]);
      // carol's live request blocks the head so amy's cancellations behind
      // it cannot be swept and become a six-entry tombstone wall
      await Ξ(carol, hook).write.requestWithdraw([usdc.address, $(10)]);
      for (let i = 0; i < 6; i++) {
        await Ξ(amy, hook).write.requestWithdraw([usdc.address, $(10)]);
      }
      await Ξ(amy, hook).write.cancelWithdraw([usdc.address, $(60)]);
      expect(await hook.read.queueHead([usdc.address])).to.equal(0n);
      await Ξ(bob, hook).write.requestWithdraw([usdc.address, $(10)]);
      // the wall exceeds AUTO_FILL_MAX = 5, yet a single deposit's auto-fill
      // still reaches both live requests: skips draw on a separate budget
      await depositAs(p, amy, $(100));
      expect(
        await hook.read.claimableWithdraw([usdc.address, a.carol]),
      ).to.equal($(10));
      expect(await hook.read.claimableWithdraw([usdc.address, a.bob])).to.equal(
        $(10),
      );
      expect(await hook.read.queueHead([usdc.address])).to.equal(8n);
    });

    it('the skip budget bounds a fill pass but head still advances (L003)', async () => {
      const p = await nh.loadFixture(makeSlpProtocol);
      const { hook, slp, usdc, users, owner } = p;
      const [amy, bob, carol] = users;
      const a = toAddressMap({ amy, bob, carol, hook, owner });
      await depositAs(p, carol, $(10));
      await depositAs(p, amy, $(30));
      await depositAs(p, bob, $(10));
      await hook.write.sweep([usdc.address, a.owner]);
      await Ξ(carol, slp).write.approve([a.hook, $(10)]);
      await Ξ(amy, slp).write.approve([a.hook, $(30)]);
      await Ξ(bob, slp).write.approve([a.hook, $(10)]);
      // a 30-entry wall behind carol's live blocker, one entry beyond the
      // FILL_SKIP_MAX = 25 skip budget
      await Ξ(carol, hook).write.requestWithdraw([usdc.address, $(10)]);
      for (let i = 0; i < 30; i++) {
        await Ξ(amy, hook).write.requestWithdraw([usdc.address, $(1)]);
      }
      await Ξ(amy, hook).write.cancelWithdraw([usdc.address, $(30)]);
      await Ξ(bob, hook).write.requestWithdraw([usdc.address, $(10)]);
      await usdc.write.mint([a.owner, $(20)]);
      await usdc.write.approve([a.hook, $(20)]);
      // the pass fills carol, then exhausts its 25 skips mid-wall; the head
      // persists so the walked tombstones are never visited again
      await hook.write.replenish([usdc.address, $(20), 5n]);
      expect(
        await hook.read.claimableWithdraw([usdc.address, a.carol]),
      ).to.equal($(10));
      expect(await hook.read.claimableWithdraw([usdc.address, a.bob])).to.equal(
        0n,
      );
      expect(await hook.read.queueHead([usdc.address])).to.equal(26n);
      // a caller-sized budget clears the rest in one call
      await hook.write.fill([usdc.address, 10n]);
      expect(await hook.read.claimableWithdraw([usdc.address, a.bob])).to.equal(
        $(10),
      );
      expect(await hook.read.queueHead([usdc.address])).to.equal(32n);
    });

    it('request/cancel cycles do not grow the request id list (L004)', async () => {
      const p = await nh.loadFixture(makeSlpProtocol);
      const { hook, slp, usdc, users, owner } = p;
      const [amy] = users;
      const a = toAddressMap({ amy, hook, owner });
      await depositAs(p, amy, $(40));
      await hook.write.sweep([usdc.address, a.owner]);
      await Ξ(amy, slp).write.approve([a.hook, $(40)]);
      // before the fix every cycle left a retired id behind, so the cancel
      // walk grew with lifetime request count until it could no longer fit
      // in a block; each cancel now pops the ids it retires
      for (let i = 0; i < 4; i++) {
        await Ξ(amy, hook).write.requestWithdraw([usdc.address, $(10)]);
        await Ξ(amy, hook).write.cancelWithdraw([usdc.address, $(10)]);
        expect(
          await hook.read.requestIdsOf([usdc.address, a.amy]),
        ).to.deep.equal([]);
      }
      expect(await hook.read.queueHead([usdc.address])).to.equal(4n);
      expect(await slp.read.balanceOf([a.amy])).to.equal($(40));
    });

    it('the cancel walk prunes ids retired by fills and id-based cancels (L004)', async () => {
      const p = await nh.loadFixture(makeSlpProtocol);
      const { hook, slp, usdc, users, owner } = p;
      const [amy] = users;
      const a = toAddressMap({ amy, hook, owner });
      await depositAs(p, amy, $(30));
      await hook.write.sweep([usdc.address, a.owner]);
      await Ξ(amy, slp).write.approve([a.hook, $(30)]);
      for (let i = 0; i < 3; i++) {
        await Ξ(amy, hook).write.requestWithdraw([usdc.address, $(10)]);
      }
      // retire the middle request by id: its entry stays listed because its
      // position is unknown to the id-based path
      await Ξ(amy, hook).write.cancelWithdrawByIds([usdc.address, [1n]]);
      expect(await hook.read.requestIdsOf([usdc.address, a.amy])).to.deep.equal(
        [0n, 1n, 2n],
      );
      // the amount-based walk drains 2, prunes the dead 1, and drains 0
      await Ξ(amy, hook).write.cancelWithdraw([usdc.address, $(20)]);
      expect(await hook.read.requestIdsOf([usdc.address, a.amy])).to.deep.equal(
        [],
      );
      expect(await slp.read.balanceOf([a.amy])).to.equal($(30));
      expect(await hook.read.pendingWithdraw([usdc.address, a.amy])).to.equal(
        0n,
      );
    });

    it('cancelWithdrawByIds cancels exactly the listed requests (L004)', async () => {
      const p = await nh.loadFixture(makeSlpProtocol);
      const { hook, slp, usdc, users, owner } = p;
      const [amy] = users;
      const a = toAddressMap({ amy, hook, owner });
      await depositAs(p, amy, $(30));
      await hook.write.sweep([usdc.address, a.owner]);
      await Ξ(amy, slp).write.approve([a.hook, $(30)]);
      for (let i = 0; i < 3; i++) {
        await Ξ(amy, hook).write.requestWithdraw([usdc.address, $(10)]);
      }
      await viem.assertions.emitWithArgs(
        Ξ(amy, hook).write.cancelWithdrawByIds([usdc.address, [0n, 2n]]),
        hook,
        'RedeemCancel',
        [a.amy, usdc.address, a.amy, $(20)],
      );
      expect(await slp.read.balanceOf([a.amy])).to.equal($(20));
      expect(await hook.read.pendingWithdraw([usdc.address, a.amy])).to.equal(
        $(10),
      );
      // the drained head entry is swept; the live request 1 blocks further
      expect(await hook.read.queueHead([usdc.address])).to.equal(1n);
      // the untouched request is still fillable
      await usdc.write.mint([a.owner, $(10)]);
      await usdc.write.approve([a.hook, $(10)]);
      await hook.write.replenish([usdc.address, $(10), 10n]);
      expect(await hook.read.claimableWithdraw([usdc.address, a.amy])).to.equal(
        $(10),
      );
    });

    it('cancelWithdrawByIds rejects foreign, retired, and duplicate ids (L004)', async () => {
      const p = await nh.loadFixture(makeSlpProtocol);
      const { hook, slp, usdc, users, owner } = p;
      const [amy, bob] = users;
      const a = toAddressMap({ amy, bob, hook, owner });
      await depositAs(p, amy, $(20));
      await depositAs(p, bob, $(10));
      await hook.write.sweep([usdc.address, a.owner]);
      await Ξ(amy, slp).write.approve([a.hook, $(20)]);
      await Ξ(bob, slp).write.approve([a.hook, $(10)]);
      await Ξ(amy, hook).write.requestWithdraw([usdc.address, $(20)]);
      await Ξ(bob, hook).write.requestWithdraw([usdc.address, $(10)]);
      // someone else's request
      await viem.assertions.revertWithCustomErrorWithArgs(
        Ξ(bob, hook).write.cancelWithdrawByIds([usdc.address, [0n]]),
        hook,
        'UniswapHookRequestNotCancellable',
        [0n, a.bob],
      );
      // a request that was never made
      await viem.assertions.revertWithCustomErrorWithArgs(
        Ξ(amy, hook).write.cancelWithdrawByIds([usdc.address, [9n]]),
        hook,
        'UniswapHookRequestNotCancellable',
        [9n, a.amy],
      );
      // the same id twice in one call must not double-count
      await viem.assertions.revertWithCustomErrorWithArgs(
        Ξ(amy, hook).write.cancelWithdrawByIds([usdc.address, [0n, 0n]]),
        hook,
        'UniswapHookRequestNotCancellable',
        [0n, a.amy],
      );
      // an empty list is a zero-amount cancel
      await viem.assertions.revertWithCustomError(
        Ξ(amy, hook).write.cancelWithdrawByIds([usdc.address, []]),
        hook,
        'UniswapHookZeroAmount',
      );
      // an already-cancelled request cannot be cancelled again
      await Ξ(amy, hook).write.cancelWithdrawByIds([usdc.address, [0n]]);
      await viem.assertions.revertWithCustomErrorWithArgs(
        Ξ(amy, hook).write.cancelWithdrawByIds([usdc.address, [0n]]),
        hook,
        'UniswapHookRequestNotCancellable',
        [0n, a.amy],
      );
    });

    it('cancelWithdrawByIds supports operator delegation (L004)', async () => {
      const p = await nh.loadFixture(makeSlpProtocol);
      const { hook, slp, usdc, users, owner } = p;
      const [amy, bob] = users;
      const a = toAddressMap({ amy, bob, hook, owner });
      await depositAs(p, amy, $(10));
      await hook.write.sweep([usdc.address, a.owner]);
      await Ξ(amy, slp).write.approve([a.hook, $(10)]);
      await Ξ(amy, hook).write.requestWithdraw([usdc.address, $(10)]);
      await viem.assertions.revertWithCustomErrorWithArgs(
        Ξ(bob, hook).write.cancelWithdrawByIds([usdc.address, [0n], a.amy]),
        hook,
        'UniswapHookUnauthorizedSender',
        [a.bob, a.amy],
      );
      await Ξ(amy, hook).write.setOperator([a.bob, true]);
      await Ξ(bob, hook).write.cancelWithdrawByIds([usdc.address, [0n], a.amy]);
      // the cancelled SLP goes to the controller, not the operator
      expect(await slp.read.balanceOf([a.amy])).to.equal($(10));
      expect(await slp.read.balanceOf([a.bob])).to.equal(0n);
    });

    it('queue operations are blocked while paused', async () => {
      const p = await nh.loadFixture(makeSlpProtocol);
      const { hook, slp, usdc, users } = p;
      const [amy] = users;
      const a = toAddressMap({ amy, hook });
      await depositAs(p, amy, $(100));
      await Ξ(amy, slp).write.approve([a.hook, $(100)]);
      await Ξ(amy, hook).write.requestWithdraw([usdc.address, $(50)]);
      await hook.write.fill([usdc.address, 10n]);
      await hook.write.pause();
      const calls = [
        () => Ξ(amy, hook).write.requestWithdraw([usdc.address, $(10)]),
        () => Ξ(amy, hook).write.cancelWithdraw([usdc.address, $(10)]),
        () => Ξ(amy, hook).write.cancelWithdrawByIds([usdc.address, [0n]]),
        () => Ξ(amy, hook).write.claimWithdraw([usdc.address, a.amy]),
        () => hook.write.fill([usdc.address, 10n]),
      ];
      for (const call of calls) {
        await viem.assertions.revertWithCustomError(
          call(),
          hook,
          'EnforcedPause',
        );
      }
    });

    it('fill requires an in-range oracle price', async () => {
      const p = await nh.loadFixture(makeSlpProtocol);
      const { hook, slp, usdc, oracle, users } = p;
      const [amy] = users;
      const a = toAddressMap({ amy, hook });
      await depositAs(p, amy, $(100));
      await Ξ(amy, slp).write.approve([a.hook, $(100)]);
      await Ξ(amy, hook).write.requestWithdraw([usdc.address, $(50)]);
      await oracle.write.setShouldRevert([true]);
      await expect(hook.write.fill([usdc.address, 10n])).rejects.toThrow(
        /OracleGateCallFailed/,
      );
    });
  });

  describe('operations', () => {
    it('sweep moves only the free balance', async () => {
      const p = await nh.loadFixture(makeSlpProtocol);
      const { hook, slp, usdc, users, owner } = p;
      const [amy, bob] = users;
      const a = toAddressMap({ amy, bob, hook, owner });
      // amy deposits 100, requests 40 back, fill reserves 40
      await usdc.write.mint([a.amy, $(100)]);
      await Ξ(amy, usdc).write.approve([a.hook, $(100)]);
      await Ξ(amy, hook).write.deposit([usdc.address, $(100), a.amy]);
      await Ξ(amy, slp).write.approve([a.hook, $(40)]);
      await Ξ(amy, hook).write.requestWithdraw([usdc.address, $(40)]);
      await hook.write.fill([usdc.address, 10n]);
      expect(await hook.read.sweepable([usdc.address])).to.equal($(60));
      await viem.assertions.emitWithArgs(
        hook.write.sweep([usdc.address, a.bob]),
        hook,
        'UniswapHookSweep',
        [usdc.address, a.bob, $(60)],
      );
      expect(await usdc.read.balanceOf([a.bob])).to.equal($(60));
      // the reserve is intact and claimable
      await Ξ(amy, hook).write.claimWithdraw([usdc.address, a.amy]);
      expect(await usdc.read.balanceOf([a.amy])).to.equal($(40));
    });

    it('restricted functions reject unauthorized callers', async () => {
      const { hook, usdc, users } = await nh.loadFixture(makeSlpProtocol);
      const [amy] = users;
      const a = toAddressMap({ amy });
      const calls = [
        () => Ξ(amy, hook).write.sweep([usdc.address, a.amy]),
        () => Ξ(amy, hook).write.replenish([usdc.address, $(1), 1n]),
        () => Ξ(amy, hook).write.setOracle([a.amy, 0n, 1n, 2n]),
        () =>
          Ξ(amy, hook).write.setAssetOracle([usdc.address, a.amy, 0n, 1n, 2n]),
        () => Ξ(amy, hook).write.setMinRequestShares([$(1)]),
        () => Ξ(amy, hook).write.pause(),
      ];
      for (const call of calls) {
        await viem.assertions.revertWithCustomErrorWithArgs(
          call(),
          hook,
          'AccessManagedUnauthorized',
          [a.amy],
        );
      }
    });

    it('sweep is an operator function, not a manager function', async () => {
      const { hook, usdc, accessManager, users } =
        await nh.loadFixture(makeSlpProtocol);
      const [amy, bob] = users;
      const a = toAddressMap({ amy, bob });
      await accessManager.write.grantRole([Roles.OPERATOR, a.amy, 0]);
      await accessManager.write.grantRole([Roles.MANAGER, a.bob, 0]);
      const free = await hook.read.sweepable([usdc.address]);
      await viem.assertions.emitWithArgs(
        Ξ(amy, hook).write.sweep([usdc.address, a.amy]),
        hook,
        'UniswapHookSweep',
        [usdc.address, a.amy, free],
      );
      await viem.assertions.revertWithCustomErrorWithArgs(
        Ξ(bob, hook).write.sweep([usdc.address, a.bob]),
        hook,
        'AccessManagedUnauthorized',
        [a.bob],
      );
    });

    it('setOracle validates its configuration', async () => {
      const { hook, oracle } = await nh.loadFixture(makeSlpProtocol);
      await viem.assertions.revertWithCustomError(
        hook.write.setOracle([zeroAddress, 0n, 1n, 2n]),
        hook,
        'UniswapHookZeroAddress',
      );
      await viem.assertions.revertWithCustomErrorWithArgs(
        hook.write.setOracle([oracle.address, 0n, 2n, 1n]),
        hook,
        'OracleGateInvalidPriceRange',
        [2n, 1n],
      );
      await viem.assertions.revertWithCustomErrorWithArgs(
        hook.write.setOracle([oracle.address, 0n, 0n, 1n]),
        hook,
        'OracleGateNonPositivePriceMin',
        [0n],
      );
      // a valid band away from parity is accepted (no straddle rule)
      await hook.write.setOracle([
        oracle.address,
        86_400n,
        150_000_000n,
        400_000_000n,
      ]);
      expect(await hook.read.priceMin()).to.equal(150_000_000n);
      expect(await hook.read.priceMax()).to.equal(400_000_000n);
    });

    it('setMinRequestShares updates and emits', async () => {
      const { hook } = await nh.loadFixture(makeSlpProtocol);
      await viem.assertions.emitWithArgs(
        hook.write.setMinRequestShares([$(25)]),
        hook,
        'UniswapHookMinRequestChange',
        [$(25)],
      );
      expect(await hook.read.minRequestShares()).to.equal($(25));
    });

    it('maxDeposit reflects pause and oracle health', async () => {
      const { hook, usdc, oracle, owner } =
        await nh.loadFixture(makeSlpProtocol);
      const a = toAddressMap({ owner });
      expect(await hook.read.maxDeposit([usdc.address])).to.equal(maxUint256);
      const rogue = await viem.deployContract('Asset', ['DAI', 6, a.owner]);
      expect(await hook.read.maxDeposit([rogue.address])).to.equal(0n);
      await hook.write.pause();
      expect(await hook.read.maxDeposit([usdc.address])).to.equal(0n);
      await hook.write.unpause();
      await oracle.write.setShouldRevert([true]);
      expect(await hook.read.maxDeposit([usdc.address])).to.equal(0n);
    });
  });

  describe('solvency invariants', () => {
    it('hold across a randomized operation sequence', async () => {
      const p = await nh.loadFixture(makeSlpProtocol);
      const {
        hook,
        slp,
        usdc,
        usdt,
        oracle,
        usdcOracle,
        usdtOracle,
        users,
        owner,
      } = p;
      const [amy, bob, carol] = users;
      const a = toAddressMap({ amy, bob, carol, hook, owner });
      const actors = [amy, bob, carol];
      const assets = [usdc, usdt];
      // deterministic pseudo-random sequence
      let seed = 42;
      const rnd = (n: number) => {
        seed = (seed * 1103515245 + 12345) % 2 ** 31;
        return seed % n;
      };
      for (const u of actors) {
        await usdc.write.mint([u.account.address, $(1000)]);
        await usdt.write.mint([u.account.address, $(1000)]);
        await Ξ(u, usdc).write.approve([a.hook, maxUint256]);
        await Ξ(u, usdt).write.approve([a.hook, maxUint256]);
        await Ξ(u, slp).write.approve([a.hook, maxUint256]);
      }
      for (let i = 0; i < 60; i++) {
        const user = actors[rnd(3)];
        const asset = assets[rnd(2)];
        const action = rnd(6);
        const addr = user.account.address;
        try {
          if (action === 0) {
            await Ξ(user, hook).write.deposit([
              asset.address,
              $(1 + rnd(50)),
              addr,
            ]);
          } else if (action === 1) {
            const bal = await slp.read.balanceOf([addr]);
            if (bal > 0n) {
              await Ξ(user, hook).write.requestWithdraw([
                asset.address,
                bal / 2n + 1n,
              ]);
            }
          } else if (action === 2) {
            // fill is operator-only (L002); the owner holds OPERATOR here
            await hook.write.fill([asset.address, 3n]);
          } else if (action === 3) {
            await Ξ(user, hook).write.claimWithdraw([asset.address, addr]);
          } else if (action === 4) {
            const pending = await hook.read.pendingWithdraw([
              asset.address,
              addr,
            ]);
            if (pending > 0n) {
              await Ξ(user, hook).write.cancelWithdraw([
                asset.address,
                pending / 2n + 1n,
              ]);
            }
          } else {
            await hook.write.sweep([asset.address, a.owner]);
            await oracle.write.setPrice([
              BigInt(80_000_000 + rnd(100_000_000)),
            ]);
            // wiggle the asset feeds within the peg band [0.995, 1.005]
            await usdcOracle.write.setPrice([
              BigInt(99_500_000 + rnd(1_000_001)),
            ]);
            await usdtOracle.write.setPrice([
              BigInt(99_500_000 + rnd(1_000_001)),
            ]);
          }
        } catch {
          // reverts (nothing to claim, zero amounts, …) are fine — we only
          // care that the invariants below hold after every state change
        }
        // invariant 1: hook SLP balance backs all pending requests exactly
        const pendingTotal =
          (await hook.read.totalPendingShares([usdc.address])) +
          (await hook.read.totalPendingShares([usdt.address]));
        expect(await slp.read.balanceOf([a.hook])).to.equal(pendingTotal);
        // invariant 2: claim reserves are always physically backed
        for (const asset_ of assets) {
          const reserved = await hook.read.totalClaimableAssets([
            asset_.address,
          ]);
          const balance = await asset_.read.balanceOf([a.hook]);
          expect(balance >= reserved).to.equal(true);
        }
      }
    });
  });

  describe('upgrade', () => {
    it('upgrades in place and keeps queue state', async () => {
      const p = await nh.loadFixture(makeSlpProtocol);
      const { hook, slp, usdc, poolManager, users, owner } = p;
      const [amy] = users;
      const a = toAddressMap({ amy, hook, owner });
      await usdc.write.mint([a.amy, $(100)]);
      await Ξ(amy, usdc).write.approve([a.hook, $(100)]);
      await Ξ(amy, hook).write.deposit([usdc.address, $(100), a.amy]);
      await hook.write.sweep([usdc.address, a.owner]);
      await Ξ(amy, slp).write.approve([a.hook, $(100)]);
      await Ξ(amy, hook).write.requestWithdraw([usdc.address, $(70)]);
      const newImpl = await viem.deployContract('UniswapHookHarness', [
        poolManager.address,
      ]);
      await hook.write.upgradeToAndCall([newImpl.address, '0x']);
      expect(await hook.read.pendingWithdraw([usdc.address, a.amy])).to.equal(
        $(70),
      );
      expect(await hook.read.slp()).to.equal(slp.address);
      // still functional after upgrade
      await usdc.write.mint([a.owner, $(70)]);
      await usdc.write.approve([a.hook, $(70)]);
      await hook.write.replenish([usdc.address, $(70), 10n]);
      await Ξ(amy, hook).write.claimWithdraw([usdc.address, a.amy]);
      expect(await usdc.read.balanceOf([a.amy])).to.equal($(70));
    });

    it('rejects upgrades from non-admin callers', async () => {
      const { hook, poolManager, users } =
        await nh.loadFixture(makeSlpProtocol);
      const [amy] = users;
      const a = toAddressMap({ amy });
      const newImpl = await viem.deployContract('UniswapHookHarness', [
        poolManager.address,
      ]);
      await viem.assertions.revertWithCustomErrorWithArgs(
        Ξ(amy, hook).write.upgradeToAndCall([newImpl.address, '0x']),
        hook,
        'AccessManagedUnauthorized',
        [a.amy],
      );
    });
  });
});
