import { inspect } from 'util';
import { encodeFunctionData, getAddress, zeroAddress } from 'viem';
import { $ } from '../helpers.js';
import { MultiplierFunctionRoles } from '../ignition/modules/hook/roles.js';
import { buildMakeSlpProtocol, nh, toAddressMap, viem, Ξ } from './helpers.js';
inspect.defaultOptions.depth = 20;

const makeSlpProtocol = buildMakeSlpProtocol();

/** 80% liquidation loan-to-value (WAD) → max leverage 5x */
const LLTV = 800_000_000_000_000_000n;
/** Morpho oracle scale: 1 SLP = 1.00 USDC (equal decimals) */
const MORPHO_PRICE_1 = 10n ** 36n;

/// Extends the SLP protocol fixture with a Morpho Blue harness and the
/// Multiplier proxy, with the USDC market configured at 80% lltv and the
/// harness funded with borrow liquidity.
const makeMultiplyProtocol = async () => {
  const p = await makeSlpProtocol();
  const morphoOracle = await viem.deployContract('MorphoOracleHarness', [
    MORPHO_PRICE_1,
  ]);
  const morpho = await viem.deployContract('MorphoHarness');
  const impl = await viem.deployContract('Multiplier');
  const init = encodeFunctionData({
    abi: impl.abi,
    functionName: 'initialize',
    args: [
      {
        authority: p.accessManager.address,
        morpho: morpho.address,
        hook: p.hook.address,
      },
    ],
  });
  const proxy = await viem.deployContract('ERC1967Proxy', [impl.address, init]);
  const multiplier = await viem.getContractAt('Multiplier', proxy.address);
  for (const { role, selectors } of MultiplierFunctionRoles) {
    await p.accessManager.write.setTargetFunctionRole([
      multiplier.address,
      [...selectors],
      role,
    ]);
  }
  // apply checksum for test assertions (parity with the base fixture)
  for (const x of [morpho, morphoOracle, multiplier]) {
    x.address = getAddress(x.address);
  }
  const market = {
    loanToken: p.usdc.address,
    collateralToken: p.slp.address,
    oracle: morphoOracle.address,
    irm: zeroAddress,
    lltv: LLTV,
  };
  // owner holds MANAGER from the base fixture
  await multiplier.write.setMarket([p.usdc.address, market]);
  await p.usdc.write.mint([morpho.address, $(1_000_000)]);
  return { ...p, morpho, morphoOracle, multiplier, market };
};

describe('Multiplier', () => {
  describe('deployment', () => {
    it('sets the right config', async () => {
      const { multiplier, morpho, hook, slp, accessManager, usdc, market } =
        await nh.loadFixture(makeMultiplyProtocol);
      expect(await multiplier.read.morpho()).to.equal(morpho.address);
      expect(await multiplier.read.hook()).to.equal(hook.address);
      expect(await multiplier.read.slp()).to.equal(slp.address);
      expect(await multiplier.read.authority()).to.equal(accessManager.address);
      expect(await multiplier.read.marketOf([usdc.address])).to.deep.equal(
        market,
      );
    });

    it('rejects zero addresses at initialization', async () => {
      const { morpho, hook } = await nh.loadFixture(makeMultiplyProtocol);
      const impl = await viem.deployContract('Multiplier');
      const init = (morpho_: string, hook_: string, authority: string) =>
        encodeFunctionData({
          abi: impl.abi,
          functionName: 'initialize',
          args: [
            {
              authority: authority as `0x${string}`,
              morpho: morpho_ as `0x${string}`,
              hook: hook_ as `0x${string}`,
            },
          ],
        });
      for (const args of [
        [zeroAddress, hook.address, morpho.address],
        [morpho.address, zeroAddress, morpho.address],
        [morpho.address, hook.address, zeroAddress],
      ] as const) {
        await viem.assertions.revertWithCustomError(
          viem.deployContract('ERC1967Proxy', [
            impl.address,
            init(args[0], args[1], args[2]),
          ]),
          impl,
          'MultiplierZeroAddress',
        );
      }
    });
  });

  describe('setMarket', () => {
    it('configures a second market for USDT', async () => {
      const { multiplier, usdt, slp, morphoOracle } =
        await nh.loadFixture(makeMultiplyProtocol);
      const market = {
        loanToken: usdt.address,
        collateralToken: slp.address,
        oracle: morphoOracle.address,
        irm: zeroAddress,
        lltv: LLTV,
      };
      await viem.assertions.emitWithArgs(
        multiplier.write.setMarket([usdt.address, market]),
        multiplier,
        'MultiplierMarketSet',
        [usdt.address, morphoOracle.address, zeroAddress, LLTV],
      );
      expect(await multiplier.read.marketOf([usdt.address])).to.deep.equal(
        market,
      );
    });

    it('rejects markets that do not lend the asset against SLP', async () => {
      const { multiplier, usdc, usdt, slp, morphoOracle, market } =
        await nh.loadFixture(makeMultiplyProtocol);
      // loan token mismatch
      await viem.assertions.revertWithCustomError(
        multiplier.write.setMarket([usdt.address, market]),
        multiplier,
        'MultiplierInvalidMarket',
      );
      // collateral is not SLP
      await viem.assertions.revertWithCustomError(
        multiplier.write.setMarket([
          usdc.address,
          { ...market, collateralToken: usdc.address },
        ]),
        multiplier,
        'MultiplierInvalidMarket',
      );
      void slp;
      void morphoOracle;
    });

    it('is restricted to the MANAGER role', async () => {
      const { multiplier, usdc, market, users } =
        await nh.loadFixture(makeMultiplyProtocol);
      const [amy] = users;
      await viem.assertions.revertWithCustomError(
        Ξ(amy, multiplier).write.setMarket([usdc.address, market]),
        multiplier,
        'AccessManagedUnauthorized',
      );
    });
  });

  describe('multiply', () => {
    /// Funds `user` with `principal` USDC, approves the multiplier, and
    /// authorizes it on Morpho — the three prerequisites of a leveraged
    /// deposit.
    const prepare = async (
      p: Awaited<ReturnType<typeof makeMultiplyProtocol>>,
      user: (typeof p.users)[number],
      principal: bigint,
    ) => {
      const a = toAddressMap({ user, multiplier: p.multiplier });
      await p.usdc.write.mint([a.user, principal]);
      await Ξ(user, p.usdc).write.approve([a.multiplier, principal]);
      await Ξ(user, p.morpho).write.setAuthorization([a.multiplier, true]);
    };

    it('opens a 2x position: flash loan, buy SLP, collateralize, borrow', async () => {
      const p = await nh.loadFixture(makeMultiplyProtocol);
      const [amy] = p.users;
      const a = toAddressMap({ amy, multiplier: p.multiplier });
      await prepare(p, amy, $(1000));
      await viem.assertions.emitWithArgs(
        Ξ(amy, p.multiplier).write.multiply([
          p.usdc.address,
          $(1000),
          $(1000),
          $(2000),
        ]),
        p.multiplier,
        'Multiply',
        [a.amy, p.usdc.address, $(1000), $(1000), $(2000)],
      );
      // the position lives on Morpho in the user's name
      const marketId = await p.morpho.read.id([p.market]);
      const [, borrowShares, collateral] = await p.morpho.read.position([
        marketId,
        a.amy,
      ]);
      expect(collateral).to.equal($(2000));
      expect(borrowShares).to.equal($(1000));
      // the SLP sits with Morpho as collateral, not with the user
      expect(await p.slp.read.balanceOf([p.morpho.address])).to.equal($(2000));
      expect(await p.slp.read.balanceOf([a.amy])).to.equal(0n);
      // the hook received the full stablecoin (principal + flash loan)
      expect(await p.usdc.read.balanceOf([p.hook.address])).to.equal($(2000));
      // the router retains nothing
      expect(await p.usdc.read.balanceOf([a.multiplier])).to.equal(0n);
      expect(await p.slp.read.balanceOf([a.multiplier])).to.equal(0n);
      expect(
        await p.usdc.read.allowance([a.multiplier, p.hook.address]),
      ).to.equal(0n);
      expect(
        await p.usdc.read.allowance([a.multiplier, p.morpho.address]),
      ).to.equal(0n);
      expect(
        await p.slp.read.allowance([a.multiplier, p.morpho.address]),
      ).to.equal(0n);
    });

    it('returns the minted shares', async () => {
      const p = await nh.loadFixture(makeMultiplyProtocol);
      const [amy] = p.users;
      await prepare(p, amy, $(1000));
      // Ξ binds the contract to amy's wallet client, so the simulation
      // already runs with amy as the sender
      const { result } = await Ξ(amy, p.multiplier).simulate.multiply([
        p.usdc.address,
        $(1000),
        $(3000),
        0n,
      ]);
      expect(result).to.equal($(4000));
    });

    it('prices the whole deposit at the oracle price', async () => {
      const p = await nh.loadFixture(makeMultiplyProtocol);
      const [amy] = p.users;
      const a = toAddressMap({ amy });
      // NAV 1.25: the hook mints 2000/1.25 = 1600 SLP, each worth 1.25 USDC
      await p.oracle.write.setPrice([125_000_000n]);
      await p.morphoOracle.write.setPrice([(MORPHO_PRICE_1 * 125n) / 100n]);
      await prepare(p, amy, $(1000));
      await Ξ(amy, p.multiplier).write.multiply([
        p.usdc.address,
        $(1000),
        $(1000),
        $(1600),
      ]);
      const marketId = await p.morpho.read.id([p.market]);
      const [, borrowShares, collateral] = await p.morpho.read.position([
        marketId,
        a.amy,
      ]);
      expect(collateral).to.equal($(1600));
      expect(borrowShares).to.equal($(1000));
    });

    it('reverts when the user has not authorized the multiplier on Morpho', async () => {
      const p = await nh.loadFixture(makeMultiplyProtocol);
      const [amy] = p.users;
      const a = toAddressMap({ amy, multiplier: p.multiplier });
      await p.usdc.write.mint([a.amy, $(1000)]);
      await Ξ(amy, p.usdc).write.approve([a.multiplier, $(1000)]);
      await viem.assertions.revertWithCustomError(
        Ξ(amy, p.multiplier).write.multiply([
          p.usdc.address,
          $(1000),
          $(1000),
          0n,
        ]),
        p.morpho,
        'MorphoHarnessUnauthorized',
      );
    });

    it('enforces the caller minimum SLP output', async () => {
      const p = await nh.loadFixture(makeMultiplyProtocol);
      const [amy] = p.users;
      await prepare(p, amy, $(1000));
      await viem.assertions.revertWithCustomErrorWithArgs(
        Ξ(amy, p.multiplier).write.multiply([
          p.usdc.address,
          $(1000),
          $(1000),
          $(2000) + 1n,
        ]),
        p.multiplier,
        'MultiplierSlippage',
        [$(2000), $(2000) + 1n],
      );
    });

    it('reverts above the market lltv', async () => {
      const p = await nh.loadFixture(makeMultiplyProtocol);
      const [amy] = p.users;
      await prepare(p, amy, $(1000));
      // 5.5x: debt 4500 > 80% of 5500 collateral
      await viem.assertions.revertWithCustomError(
        Ξ(amy, p.multiplier).write.multiply([
          p.usdc.address,
          $(1000),
          $(4500),
          0n,
        ]),
        p.morpho,
        'MorphoHarnessUnhealthyPosition',
      );
    });

    it('reverts when no market is configured for the asset', async () => {
      const p = await nh.loadFixture(makeMultiplyProtocol);
      const [amy] = p.users;
      await viem.assertions.revertWithCustomErrorWithArgs(
        Ξ(amy, p.multiplier).write.multiply([
          p.usdt.address,
          $(1000),
          $(1000),
          0n,
        ]),
        p.multiplier,
        'MultiplierMarketNotSet',
        [p.usdt.address],
      );
    });

    it('rejects zero principal and zero flash amounts', async () => {
      const p = await nh.loadFixture(makeMultiplyProtocol);
      const [amy] = p.users;
      await prepare(p, amy, $(1000));
      for (const [principal, flash] of [
        [0n, $(1000)],
        [$(1000), 0n],
      ] as const) {
        await viem.assertions.revertWithCustomError(
          Ξ(amy, p.multiplier).write.multiply([
            p.usdc.address,
            principal,
            flash,
            0n,
          ]),
          p.multiplier,
          'MultiplierZeroAmount',
        );
      }
    });

    it('rejects unsolicited flash loan callbacks', async () => {
      const p = await nh.loadFixture(makeMultiplyProtocol);
      const [amy] = p.users;
      await viem.assertions.revertWithCustomError(
        Ξ(amy, p.multiplier).write.onMorphoFlashLoan([$(1000), '0x']),
        p.multiplier,
        'MultiplierUnauthorizedCallback',
      );
    });

    it('is blocked while paused', async () => {
      const p = await nh.loadFixture(makeMultiplyProtocol);
      const [amy] = p.users;
      await prepare(p, amy, $(1000));
      await p.multiplier.write.pause();
      await viem.assertions.revertWithCustomError(
        Ξ(amy, p.multiplier).write.multiply([
          p.usdc.address,
          $(1000),
          $(1000),
          0n,
        ]),
        p.multiplier,
        'EnforcedPause',
      );
      await p.multiplier.write.unpause();
      await Ξ(amy, p.multiplier).write.multiply([
        p.usdc.address,
        $(1000),
        $(1000),
        0n,
      ]);
    });

    it('supports USDT once its market is configured', async () => {
      const p = await nh.loadFixture(makeMultiplyProtocol);
      const [amy] = p.users;
      const a = toAddressMap({ amy, multiplier: p.multiplier });
      const usdtMarket = { ...p.market, loanToken: p.usdt.address };
      await p.multiplier.write.setMarket([p.usdt.address, usdtMarket]);
      await p.usdt.write.mint([p.morpho.address, $(100_000)]);
      await p.usdt.write.mint([a.amy, $(500)]);
      await Ξ(amy, p.usdt).write.approve([a.multiplier, $(500)]);
      await Ξ(amy, p.morpho).write.setAuthorization([a.multiplier, true]);
      await Ξ(amy, p.multiplier).write.multiply([
        p.usdt.address,
        $(500),
        $(1500),
        $(2000),
      ]);
      const marketId = await p.morpho.read.id([usdtMarket]);
      const [, borrowShares, collateral] = await p.morpho.read.position([
        marketId,
        a.amy,
      ]);
      expect(collateral).to.equal($(2000));
      expect(borrowShares).to.equal($(1500));
    });
  });
});
