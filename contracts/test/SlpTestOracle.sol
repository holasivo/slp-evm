// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import {AggregatorV3Interface} from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title SlpTestOracle - Self-accruing Chainlink-compatible SLP/USD feed
/// @author Sivo
/// @notice Test-chain stand-in for the Chainlink SLP / USD NAV feed. Nothing
/// is published: the answer is computed on every read from a configurable
/// APY. The price is exactly 1 (10^decimals) at deployment and grows linearly
/// with the time elapsed since, so one year after deployment it reads
/// 1 + APY. Every read is a fresh round stamped with the current block
/// timestamp, so the consumers' staleness breaker never trips and no
/// off-chain publisher has to run.
/// @dev The APY is simple interest on the price checkpointed at the last
/// setApy (the base): price(t) = base * (1 + apyBps/1e4 * (t - anchor)/1yr).
/// setApy re-anchors at the current price so the curve stays continuous. It
/// is owner-only so a stray testnet account cannot halt the staging protocol
/// by pushing the price out of the consumers' band. Round ids are block
/// timestamps: getRoundData(t) returns the price reported at t for any t in
/// the current APY segment; earlier timestamps are not reconstructible once
/// the APY changed and revert.
contract SlpTestOracle is AggregatorV3Interface, Ownable {
    /// @notice Basis points in one unit (100%)
    uint256 public constant BPS = 10_000;

    /// @notice Accrual period the APY refers to
    uint256 public constant YEAR = 365 days;

    /// @notice Error thrown when querying a round (timestamp) before the
    /// current APY segment started
    /// @param roundId The unknown round identifier
    error SlpTestOracleNoData(uint80 roundId);

    /// @notice Emitted when the APY changes (including at deployment)
    /// @param apyBps The new APY in basis points
    /// @param basePrice The price the new segment accrues from
    /// @param anchor The timestamp the new segment accrues from
    event ApyUpdated(uint256 apyBps, int256 basePrice, uint256 anchor);

    uint8 private immutable _decimals;
    uint256 private _apyBps;
    uint256 private _base;
    uint256 private _anchor;

    /// @param decimals_ The feed decimals (8 for the SLP/USD NAV feed)
    /// @param apyBps_ The annual growth of the price in basis points
    /// (1_000 = 10% per year)
    constructor(uint8 decimals_, uint256 apyBps_) Ownable(msg.sender) {
        _decimals = decimals_;
        _setApy(apyBps_, 10 ** decimals_);
    }

    /// @notice Changes the APY, continuing from the current price
    /// @param apyBps_ The new APY in basis points; 0 freezes the price
    function setApy(uint256 apyBps_) external onlyOwner {
        _setApy(apyBps_, _priceAt(block.timestamp));
    }

    function _setApy(uint256 apyBps_, uint256 base) private {
        _apyBps = apyBps_;
        _base = base;
        _anchor = block.timestamp;
        emit ApyUpdated(apyBps_, int256(base), block.timestamp);
    }

    /// @notice Returns the APY in basis points
    function apyBps() external view returns (uint256) {
        return _apyBps;
    }

    /// @notice Returns the price the current APY segment accrues from
    function basePrice() external view returns (int256) {
        return int256(_base);
    }

    /// @notice Returns the timestamp the current APY segment accrues from
    function anchor() external view returns (uint256) {
        return _anchor;
    }

    /// @inheritdoc AggregatorV3Interface
    function decimals() external view returns (uint8) {
        return _decimals;
    }

    /// @inheritdoc AggregatorV3Interface
    function description() external pure returns (string memory) {
        return "SLP / USD";
    }

    /// @inheritdoc AggregatorV3Interface
    function version() external pure returns (uint256) {
        return 1;
    }

    /// @inheritdoc AggregatorV3Interface
    /// @dev roundId_ is a block timestamp within the current APY segment
    function getRoundData(
        uint80 roundId_
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
        if (roundId_ < _anchor) revert SlpTestOracleNoData(roundId_);
        return _roundData(roundId_);
    }

    /// @inheritdoc AggregatorV3Interface
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
        return _roundData(uint80(block.timestamp));
    }

    /// @dev Rounds are synthesized per timestamp, so startedAt == updatedAt
    /// == roundId and answeredInRound == roundId
    function _roundData(
        uint80 timestamp
    ) private view returns (uint80, int256, uint256, uint256, uint80) {
        return (
            timestamp,
            int256(_priceAt(timestamp)),
            timestamp,
            timestamp,
            timestamp
        );
    }

    /// @dev Simple interest from the segment base; exact at whole years
    function _priceAt(uint256 timestamp) private view returns (uint256) {
        uint256 base = _base;
        return base + (base * _apyBps * (timestamp - _anchor)) / (BPS * YEAR);
    }
}
