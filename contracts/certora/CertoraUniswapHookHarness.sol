// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import {UniswapHook} from "../UniswapHook.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";

/// @title CertoraUniswapHookHarness
/// @notice Certora-only harness over `UniswapHook`. Referenced exclusively by
/// `certora/conf/hook.conf`; the unit-test harness lives at
/// `contracts/test/UniswapHookHarness.sol` under a distinct contract name to
/// avoid Hardhat artifact-name ambiguity.
contract CertoraUniswapHookHarness is UniswapHook {
    constructor(IPoolManager poolManager_) UniswapHook(poolManager_) {}

    /// @notice Replaces the `_assetConfig[asset].supported` mapping lookup
    /// with the address-equality form `asset == _asset0 || asset == _asset1`.
    /// @dev Soundness: the two representations coincide in every reachable
    /// state — `__UniswapHookOptions_init` is the mapping's only writer, it
    /// marks exactly `asset0_` and `asset1_` as supported (three distinct
    /// addresses, enforced by UniswapHookInvalidAssetConfig), and no other
    /// method touches `_assetConfig[..].supported`. The Prover, however,
    /// starts rules from arbitrary storage where the mapping and the
    /// `_asset0`/`_asset1` slots are independent symbols; a symbolic state
    /// with a third "supported" asset would admit queue and sweep flows that
    /// no reachable state permits. Substituting the equivalent equality form
    /// removes exactly that unreachable-state noise without weakening any
    /// gate: `_requireSupportedAsset` and `maxDeposit` route through this
    /// (virtual) getter, so the gating under verification is unchanged.
    function isSupportedAsset(
        address asset
    ) public view override returns (bool) {
        UniswapHookOptionsStorage storage $ = _getUniswapHookOptionsStorage();
        return asset == $._asset0 || asset == $._asset1;
    }

    /// @notice Exposes a raw queue entry so rules can bind witnesses
    function requestAt(
        address asset,
        uint256 requestId
    ) external view returns (address controller, uint256 slpRemaining) {
        WithdrawRequest storage r = _getUniswapHookStorage()
            ._queues[asset]
            .requests[requestId];
        return (r.controller, r.slpRemaining);
    }
}
