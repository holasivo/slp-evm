import { inspect } from 'util';
import { encodeFunctionData } from 'viem';
import { $ } from '../helpers.js';
import {
  buildMakeSlpProtocol,
  nh,
  Roles,
  toAddressMap,
  viem,
  Ξ,
} from './helpers.js';
inspect.defaultOptions.depth = 20;

const makeSlpProtocol = buildMakeSlpProtocol();

describe('SLP', () => {
  describe('deployment', () => {
    it('sets the right metadata', async () => {
      const { slp } = await nh.loadFixture(makeSlpProtocol);
      expect(await slp.read.name()).to.equal('Sivo Liquidity Provider');
      expect(await slp.read.symbol()).to.equal('SLP');
      expect(await slp.read.decimals()).to.equal(6);
      expect(await slp.read.totalSupply()).to.equal(0n);
    });

    it('sets the AccessManager as authority', async () => {
      const { slp, accessManager } = await nh.loadFixture(makeSlpProtocol);
      expect(await slp.read.authority()).to.equal(accessManager.address);
    });

    it('cannot be initialized twice', async () => {
      const { slp, accessManager } = await nh.loadFixture(makeSlpProtocol);
      await viem.assertions.revertWithCustomError(
        slp.write.initialize([
          {
            name: 'x',
            symbol: 'x',
            decimals: 6,
            authority: accessManager.address,
          },
        ]),
        slp,
        'InvalidInitialization',
      );
    });
  });

  describe('mint', () => {
    it('mints when the caller holds MINTER via the AccessManager', async () => {
      const { slp, users } = await nh.loadFixture(makeSlpProtocol);
      const [amy] = users;
      const a = toAddressMap({ amy });
      await slp.write.mint([a.amy, $(100)]);
      expect(await slp.read.balanceOf([a.amy])).to.equal($(100));
      expect(await slp.read.totalSupply()).to.equal($(100));
    });

    it('reverts for callers without MINTER', async () => {
      const { slp, users } = await nh.loadFixture(makeSlpProtocol);
      const [amy] = users;
      const a = toAddressMap({ amy });
      await viem.assertions.revertWithCustomErrorWithArgs(
        Ξ(amy, slp).write.mint([a.amy, $(100)]),
        slp,
        'AccessManagedUnauthorized',
        [a.amy],
      );
    });

    it('mints when the hook calls (hook holds MINTER)', async () => {
      const { accessManager, hook } = await nh.loadFixture(makeSlpProtocol);
      const [isMember] = await accessManager.read.hasRole([
        Roles.MINTER,
        hook.address,
      ]);
      expect(isMember).to.equal(true);
    });
  });

  describe('burn', () => {
    it('burns from own balance', async () => {
      const { slp, users } = await nh.loadFixture(makeSlpProtocol);
      const [amy] = users;
      const a = toAddressMap({ amy });
      await slp.write.mint([a.amy, $(100)]);
      await Ξ(amy, slp).write.burn([$(40)]);
      expect(await slp.read.balanceOf([a.amy])).to.equal($(60));
      expect(await slp.read.totalSupply()).to.equal($(60));
    });

    it('burnFrom respects allowance', async () => {
      const { slp, users } = await nh.loadFixture(makeSlpProtocol);
      const [amy, bob] = users;
      const a = toAddressMap({ amy, bob });
      await slp.write.mint([a.amy, $(100)]);
      await Ξ(amy, slp).write.approve([a.bob, $(30)]);
      await Ξ(bob, slp).write.burnFrom([a.amy, $(30)]);
      expect(await slp.read.balanceOf([a.amy])).to.equal($(70));
      await viem.assertions.revertWithCustomError(
        Ξ(bob, slp).write.burnFrom([a.amy, $(1)]),
        slp,
        'ERC20InsufficientAllowance',
      );
    });
  });

  describe('pause', () => {
    it('pause blocks transfers, mints, and burns', async () => {
      const { slp, users } = await nh.loadFixture(makeSlpProtocol);
      const [amy, bob] = users;
      const a = toAddressMap({ amy, bob });
      await slp.write.mint([a.amy, $(100)]);
      await slp.write.pause();
      await viem.assertions.revertWithCustomError(
        Ξ(amy, slp).write.transfer([a.bob, $(1)]),
        slp,
        'EnforcedPause',
      );
      await viem.assertions.revertWithCustomError(
        slp.write.mint([a.amy, $(1)]),
        slp,
        'EnforcedPause',
      );
      await viem.assertions.revertWithCustomError(
        Ξ(amy, slp).write.burn([$(1)]),
        slp,
        'EnforcedPause',
      );
      await slp.write.unpause();
      await Ξ(amy, slp).write.transfer([a.bob, $(1)]);
      expect(await slp.read.balanceOf([a.bob])).to.equal($(1));
    });

    it('pause is restricted to PAUSER via the AccessManager', async () => {
      const { slp, users } = await nh.loadFixture(makeSlpProtocol);
      const [amy] = users;
      const a = toAddressMap({ amy });
      await viem.assertions.revertWithCustomErrorWithArgs(
        Ξ(amy, slp).write.pause(),
        slp,
        'AccessManagedUnauthorized',
        [a.amy],
      );
    });
  });

  describe('permit', () => {
    it('exposes EIP-2612 domain', async () => {
      const { slp } = await nh.loadFixture(makeSlpProtocol);
      const [, name] = await slp.read.eip712Domain();
      expect(name).to.equal('Sivo Liquidity Provider');
      expect(await slp.read.nonces([slp.address])).to.equal(0n);
    });
  });

  describe('upgrade', () => {
    it('upgrades via the AccessManager admin and keeps state', async () => {
      const { slp, users } = await nh.loadFixture(makeSlpProtocol);
      const [amy] = users;
      const a = toAddressMap({ amy });
      await slp.write.mint([a.amy, $(123)]);
      const newImpl = await viem.deployContract('SLP');
      await slp.write.upgradeToAndCall([newImpl.address, '0x']);
      expect(await slp.read.balanceOf([a.amy])).to.equal($(123));
      expect(await slp.read.symbol()).to.equal('SLP');
    });

    it('rejects upgrades from non-admin callers', async () => {
      const { slp, users } = await nh.loadFixture(makeSlpProtocol);
      const [amy] = users;
      const a = toAddressMap({ amy });
      const newImpl = await viem.deployContract('SLP');
      await viem.assertions.revertWithCustomErrorWithArgs(
        Ξ(amy, slp).write.upgradeToAndCall([newImpl.address, '0x']),
        slp,
        'AccessManagedUnauthorized',
        [a.amy],
      );
    });
  });

  describe('initialize validation', () => {
    it('rejects a zero authority', async () => {
      const impl = await viem.deployContract('SLP');
      const init = encodeFunctionData({
        abi: impl.abi,
        functionName: 'initialize',
        args: [
          {
            name: 'x',
            symbol: 'x',
            decimals: 6,
            authority: '0x0000000000000000000000000000000000000000',
          },
        ],
      });
      await viem.assertions.revertWithCustomError(
        viem.deployContract('ERC1967Proxy', [impl.address, init]),
        impl,
        'SLPZeroAddress',
      );
    });
  });
});
