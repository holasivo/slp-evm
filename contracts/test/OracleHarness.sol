// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";

contract OracleHarness is AggregatorV3Interface {
    int256 private _price;
    uint256 private _updatedAt;
    uint8 private _decimals;
    bool private _shouldRevert;

    constructor(int256 price_, uint8 decimals_) {
        _price = price_;
        _updatedAt = block.timestamp;
        _decimals = decimals_;
    }

    function setPrice(int256 price_) external {
        _price = price_;
        _updatedAt = block.timestamp;
    }

    function setUpdatedAt(uint256 updatedAt_) external {
        _updatedAt = updatedAt_;
    }

    /// @notice Simulates a reverting or sunset feed for testing the try/catch
    /// guard around the oracle read.
    function setShouldRevert(bool shouldRevert_) external {
        _shouldRevert = shouldRevert_;
    }

    /// @notice Exposes the stored oracle answer for Certora rules.
    /// @dev Certora reads `latestRoundData()` returns through a tuple
    /// which is awkward to unpack in CVL; this getter exposes the same
    /// slot as a single scalar.
    function priceAnswer() external view returns (int256) {
        return _price;
    }

    /// @notice Exposes the stored `updatedAt` timestamp for Certora rules.
    function priceUpdatedAt() external view returns (uint256) {
        return _updatedAt;
    }

    function decimals() external view returns (uint8) {
        return _decimals;
    }

    function description() external pure returns (string memory) {
        return "OracleHarness";
    }

    function version() external pure returns (uint256) {
        return 1;
    }

    function getRoundData(
        uint80
    )
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        )
    {
        if (_shouldRevert) revert("OracleHarness: feed down");
        return (1, _price, _updatedAt, _updatedAt, 1);
    }

    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        )
    {
        if (_shouldRevert) revert("OracleHarness: feed down");
        return (1, _price, _updatedAt, _updatedAt, 1);
    }
}
