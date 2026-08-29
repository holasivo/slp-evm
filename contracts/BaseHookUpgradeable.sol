// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";

/// @title BaseHookUpgradeable
/// @author Sivo
/// @notice Minimal proxy-safe base for Uniswap v4 hooks, derived from
/// v4-periphery's BaseHook. The PoolManager dispatches hook callbacks based on
/// permission flags encoded in the low 14 bits of the hook's address; behind
/// an ERC1967 proxy those flags live on the proxy address, so — unlike
/// BaseHook, which validates in its constructor — the flag validation here
/// runs in the initializer, where address(this) is the proxy.
/// @dev The PoolManager address is an immutable baked into the implementation
/// bytecode (immutables are visible through proxies), so it is set in the
/// implementation constructor and must be passed again on every upgrade.
abstract contract BaseHookUpgradeable {
    /// @notice The caller is not the canonical Uniswap v4 PoolManager
    error BaseHookNotPoolManager();

    /// @notice The Uniswap v4 PoolManager singleton
    /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
    IPoolManager public immutable poolManager;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor(IPoolManager poolManager_) {
        poolManager = poolManager_;
    }

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert BaseHookNotPoolManager();
        _;
    }

    /// @notice The permission flags this hook expects to be encoded in its
    /// (proxy) address
    /// @return The permissions struct
    function getHookPermissions()
        public
        pure
        virtual
        returns (Hooks.Permissions memory);

    /// @notice Validates that the proxy address carries exactly the expected
    /// permission flags
    /// @dev Must be called from the initializer (proxy context). Reverts with
    /// Hooks.HookAddressNotValid when the address was not mined correctly.
    function _validateHookAddress() internal view {
        Hooks.validateHookPermissions(
            IHooks(address(this)),
            getHookPermissions()
        );
    }
}
