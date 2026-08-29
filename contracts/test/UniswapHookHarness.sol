// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import "../UniswapHook.sol";

contract UniswapHookHarness is UniswapHook {
    constructor(IPoolManager poolManager_) UniswapHook(poolManager_) {}

    /// @notice Exposes a raw queue entry for test assertions
    function requestAt(
        address asset,
        uint256 requestId
    ) external view returns (address controller, uint256 slpRemaining) {
        WithdrawRequest storage r = _getUniswapHookStorage()
            ._queues[asset]
            .requests[requestId];
        return (r.controller, r.slpRemaining);
    }

    /// @notice Exposes the queue head index for test assertions
    function queueHead(address asset) external view returns (uint256) {
        return _getUniswapHookStorage()._queues[asset].head;
    }

    /// @notice Exposes a controller's request id list for test assertions
    function requestIdsOf(
        address asset,
        address controller
    ) external view returns (uint256[] memory) {
        return _getUniswapHookStorage()._queues[asset].requestIdsOf[controller];
    }
}
