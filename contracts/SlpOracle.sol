// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import {AggregatorV3Interface} from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";
import {AccessManaged} from "@openzeppelin/contracts/access/manager/AccessManaged.sol";

/// @title SlpOracle - Operator-published Chainlink-compatible feed
/// @author Sivo
/// @notice Chainlink AggregatorV3Interface feed whose answer is published
/// manually by protocol operators. Used as the SLP/USD NAV pricing source for
/// the initial mainnet release until the dedicated Chainlink feed ships, at
/// which point the consumers migrate via their setOracle/setMarket calls and
/// this feed is abandoned in place.
/// @dev Publishing is restricted through the central OpenZeppelin
/// AccessManager (setPrice maps to the OPERATOR role). Every update opens and
/// answers a new round, so consumers relying on Chainlink round semantics
/// (answeredInRound == roundId, updatedAt != 0, monotonic round ids) see a
/// well-formed feed, and past rounds stay queryable via getRoundData. The
/// answer must be positive; sanity-banding the price is intentionally left to
/// the consumers' OracleGate priceMin/priceMax so the limits live in one
/// place. Freshness is enforced by the consumers' maxStaleness, so operators
/// must republish within that window even when the NAV is unchanged.
/// @custom:security-contact security@sivo.com
contract SlpOracle is AggregatorV3Interface, AccessManaged {
    struct Round {
        int256 answer;
        uint64 updatedAt;
    }

    /// @notice Error thrown when publishing a zero or negative answer
    /// @param answer The rejected answer
    error SlpOracleNonPositiveAnswer(int256 answer);

    /// @notice Error thrown when querying a round that was never published
    /// @param roundId The unknown round identifier
    error SlpOracleNoData(uint80 roundId);

    /// @notice Emitted on every published answer
    /// @dev Signature-compatible with Chainlink's AggregatorInterface event
    /// so standard feed monitoring tooling picks up updates
    /// @param current The published answer
    /// @param roundId The round the answer was published in
    /// @param updatedAt The publication timestamp
    event AnswerUpdated(
        int256 indexed current,
        uint256 indexed roundId,
        uint256 updatedAt
    );

    uint8 private immutable _decimals;
    string private _description;
    uint80 private _latestRound;
    mapping(uint80 roundId => Round) private _rounds;

    /// @param authority_ The central AccessManager restricting setPrice
    /// @param decimals_ The feed decimals (8 for the SLP/USD NAV feed)
    /// @param description_ The feed description (e.g. "SLP / USD")
    /// @param initialAnswer The answer seeding round 1, so the feed is never
    /// empty between deployment and the first operator publication
    constructor(
        address authority_,
        uint8 decimals_,
        string memory description_,
        int256 initialAnswer
    ) AccessManaged(authority_) {
        _decimals = decimals_;
        _description = description_;
        _setPrice(initialAnswer);
    }

    /// @notice Publishes a new answer in a fresh round
    /// @dev Restricted through the AccessManager (OPERATOR role)
    /// @param answer The new answer, in the feed's decimals
    function setPrice(int256 answer) external restricted {
        _setPrice(answer);
    }

    function _setPrice(int256 answer) private {
        if (answer <= 0) revert SlpOracleNonPositiveAnswer(answer);
        uint80 roundId = ++_latestRound;
        _rounds[roundId] = Round(answer, uint64(block.timestamp));
        emit AnswerUpdated(answer, roundId, block.timestamp);
    }

    /// @inheritdoc AggregatorV3Interface
    function decimals() external view returns (uint8) {
        return _decimals;
    }

    /// @inheritdoc AggregatorV3Interface
    function description() external view returns (string memory) {
        return _description;
    }

    /// @inheritdoc AggregatorV3Interface
    function version() external pure returns (uint256) {
        return 1;
    }

    /// @inheritdoc AggregatorV3Interface
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
        return _roundData(_latestRound);
    }

    /// @dev Rounds are opened and answered atomically by setPrice, so
    /// startedAt == updatedAt and answeredInRound == roundId
    function _roundData(
        uint80 roundId_
    )
        private
        view
        returns (uint80, int256, uint256, uint256, uint80)
    {
        Round storage round = _rounds[roundId_];
        uint256 updatedAt = round.updatedAt;
        if (updatedAt == 0) revert SlpOracleNoData(roundId_);
        return (roundId_, round.answer, updatedAt, updatedAt, roundId_);
    }
}
