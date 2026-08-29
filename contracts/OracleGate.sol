// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import {AggregatorV3Interface} from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/// @title OracleGate
/// @author Sivo
/// @notice Abstract Chainlink oracle circuit breaker with a configurable
/// staleness limit and acceptable price band. Extracted from the price gating
/// logic of the legacy Vault contract so the UniswapHook can reuse the same
/// audited semantics both as a circuit breaker and as its pricing source.
/// @dev Unlike the Vault's variant, the band is not required to straddle
/// parity: the SLP/USD NAV fluctuates and trends upward over time, so the
/// band only requires 0 < priceMin <= priceMax and is ratcheted around the
/// current NAV operationally via setOracle.
abstract contract OracleGate is Initializable {
    /// @notice Result of evaluating the oracle price against its constraints
    enum PriceStatus {
        InRange,
        IncompleteRound,
        Stale,
        OutOfRange,
        OracleError
    }

    /// @notice Error thrown when the price range is invalid (min > max)
    /// @param priceMin The minimum price provided
    /// @param priceMax The maximum price provided
    error OracleGateInvalidPriceRange(int256 priceMin, int256 priceMax);

    /// @notice Error thrown when an active price band has a non-positive minimum
    /// @param priceMin The minimum price provided
    error OracleGateNonPositivePriceMin(int256 priceMin);

    /// @notice Error thrown when the oracle round is incomplete
    /// @param roundId The oracle round identifier
    /// @param answeredInRound The round the answer was computed in
    error OracleGateIncompleteRound(uint80 roundId, uint80 answeredInRound);

    /// @notice Error thrown when the oracle data is older than maxStaleness
    /// @param updatedAt The timestamp the round was last updated
    /// @param maxStaleness The maximum allowed staleness in seconds
    error OracleGateStale(uint256 updatedAt, uint256 maxStaleness);

    /// @notice Error thrown when the oracle price is outside the allowed band
    /// @param price The reported price
    /// @param priceMin The minimum acceptable price
    /// @param priceMax The maximum acceptable price
    error OracleGatePriceOutOfRange(
        int256 price,
        int256 priceMin,
        int256 priceMax
    );

    /// @notice Error thrown when the oracle call reverts
    error OracleGateCallFailed();

    /// @notice Error thrown when a usable price is required but the oracle is
    /// unset or its answer cannot be used for pricing
    error OracleGateUnusablePrice();

    /// @notice Emitted when the oracle or staleness configuration changes
    /// @param oracle The new oracle address
    /// @param maxStaleness The new maximum staleness in seconds
    event OracleGateOracleChange(address indexed oracle, uint256 maxStaleness);

    /// @notice Emitted when the acceptable price band changes
    /// @param priceMin The new minimum acceptable price
    /// @param priceMax The new maximum acceptable price
    event OracleGatePriceRangeChange(int256 priceMin, int256 priceMax);

    /// @custom:storage-location erc7201:sivo.storage.OracleGate
    struct OracleGateStorage {
        address _oracle;
        uint8 _oracleDecimals;
        int256 _priceMin;
        int256 _priceMax;
        uint256 _maxStaleness;
    }

    // keccak256(abi.encode(uint256(keccak256("sivo.storage.OracleGate")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant OracleGateStorageLocation =
        0x56fe333641b1997048fee6d65043ded4b919fe58b6c120bfa16be936f5985e00;

    function _getOracleGateStorage()
        internal
        pure
        returns (OracleGateStorage storage $)
    {
        assembly {
            $.slot := OracleGateStorageLocation
        }
    }

    /// @notice Returns the Chainlink oracle address used for pricing and gating
    function oracle() public view returns (address) {
        return _getOracleGateStorage()._oracle;
    }

    /// @notice Returns the decimals of the configured oracle feed
    /// @dev Cached when the oracle is set so pricing math never issues an
    /// extra external call
    function oracleDecimals() public view returns (uint8) {
        return _getOracleGateStorage()._oracleDecimals;
    }

    /// @notice Returns the minimum acceptable oracle price
    function priceMin() public view returns (int256) {
        return _getOracleGateStorage()._priceMin;
    }

    /// @notice Returns the maximum acceptable oracle price
    function priceMax() public view returns (int256) {
        return _getOracleGateStorage()._priceMax;
    }

    /// @notice Returns the maximum allowed staleness for oracle data (in seconds)
    /// @dev 0 means no staleness check is enforced
    function maxStaleness() public view returns (uint256) {
        return _getOracleGateStorage()._maxStaleness;
    }

    /// @notice Evaluates the configured oracle price against its constraints
    /// @dev External, non-reverting view exposing the result of _checkPrice
    /// for off-chain monitoring; mirrors the logic gating deposits and fills
    /// @return status The outcome of the price evaluation
    function priceStatus() external view returns (PriceStatus status) {
        (status, , , , ) = _checkPrice();
    }

    function __OracleGate_init(
        address oracle_,
        int256 priceMin_,
        int256 priceMax_,
        uint256 maxStaleness_
    ) internal onlyInitializing {
        _setOracle(oracle_, maxStaleness_, priceMin_, priceMax_);
    }

    /// @notice Atomically updates the oracle, staleness duration, and price band
    /// @dev Setting the oracle and its band together is required so that
    /// migrating to a feed with different decimals always revalidates the band
    /// against the new feed's decimal basis, closing the desync footgun of
    /// independent setters. Set maxStaleness_ to 0 to disable the staleness
    /// check. Set oracle_ to the zero address to disable the breaker, in which
    /// case the band is dormant and may be (0, 0).
    /// @param oracle_ The new Chainlink oracle address
    /// @param maxStaleness_ The new maximum staleness in seconds
    /// @param priceMin_ The new minimum acceptable price
    /// @param priceMax_ The new maximum acceptable price
    function _setOracle(
        address oracle_,
        uint256 maxStaleness_,
        int256 priceMin_,
        int256 priceMax_
    ) internal {
        _validateOracle(oracle_, priceMin_, priceMax_);
        OracleGateStorage storage $ = _getOracleGateStorage();
        $._oracle = oracle_;
        $._oracleDecimals = oracle_ == address(0)
            ? 0
            : AggregatorV3Interface(oracle_).decimals();
        $._maxStaleness = maxStaleness_;
        $._priceMin = priceMin_;
        $._priceMax = priceMax_;
        emit OracleGateOracleChange(oracle_, maxStaleness_);
        emit OracleGatePriceRangeChange(priceMin_, priceMax_);
    }

    /// @notice Validates the oracle configuration and its price band
    /// @dev Always requires priceMin <= priceMax. When an oracle is configured
    /// it additionally requires a positive minimum (which also excludes zero
    /// and negative reported prices from ever passing the band check). The
    /// legacy Vault additionally forced the band to straddle parity; that rule
    /// is intentionally dropped here because the SLP NAV drifts away from
    /// parity over time. Internal so inheritors can validate additional feeds
    /// (e.g. the UniswapHook's per-asset stablecoin feeds) with the same
    /// rules.
    /// @param oracle_ The oracle address the band is validated against
    /// @param priceMin_ The candidate minimum acceptable price
    /// @param priceMax_ The candidate maximum acceptable price
    function _validateOracle(
        address oracle_,
        int256 priceMin_,
        int256 priceMax_
    ) internal pure {
        if (priceMin_ > priceMax_) {
            revert OracleGateInvalidPriceRange(priceMin_, priceMax_);
        }
        if (oracle_ == address(0)) return;
        if (priceMin_ <= 0) {
            revert OracleGateNonPositivePriceMin(priceMin_);
        }
    }

    /// @notice Reverts unless the oracle price is fresh and in range
    function _requirePriceInRange() internal view {
        OracleGateStorage storage $ = _getOracleGateStorage();
        (
            PriceStatus status,
            uint80 roundId,
            int256 price,
            uint256 updatedAt,
            uint80 answeredInRound
        ) = _checkPrice();
        _requireInRange(
            status,
            roundId,
            price,
            updatedAt,
            answeredInRound,
            $._maxStaleness,
            $._priceMin,
            $._priceMax
        );
    }

    /// @notice Maps a non-InRange price status to its specific revert
    /// @dev The feed constraints are passed in (rather than read from this
    /// contract's storage) so the same revert mapping serves any feed checked
    /// through _checkFeed, not just the primary oracle
    function _requireInRange(
        PriceStatus status,
        uint80 roundId,
        int256 price,
        uint256 updatedAt,
        uint80 answeredInRound,
        uint256 maxStaleness_,
        int256 priceMin_,
        int256 priceMax_
    ) internal pure {
        if (status == PriceStatus.InRange) return;
        if (status == PriceStatus.IncompleteRound) {
            revert OracleGateIncompleteRound(roundId, answeredInRound);
        }
        if (status == PriceStatus.OracleError) {
            revert OracleGateCallFailed();
        }
        if (status == PriceStatus.Stale) {
            revert OracleGateStale(updatedAt, maxStaleness_);
        }
        revert OracleGatePriceOutOfRange(price, priceMin_, priceMax_);
    }

    /// @notice Non-reverting variant of the oracle price check
    /// @return True when no oracle is set, or the latest round is complete,
    /// fresh, and within the configured min/max price range
    function _priceInRange() internal view returns (bool) {
        (PriceStatus status, , , , ) = _checkPrice();
        return status == PriceStatus.InRange;
    }

    /// @notice Returns a fresh, in-range price usable for settlement pricing
    /// @dev Unlike the gating helpers, a configured oracle is mandatory here:
    /// callers use the returned value to price swaps and queue fills, so a
    /// disabled breaker (oracle == address(0)) is unusable rather than a pass
    /// @return price The latest in-range oracle price
    /// @return decimals_ The oracle feed decimals
    function _freshPrice()
        internal
        view
        returns (uint256 price, uint8 decimals_)
    {
        OracleGateStorage storage $ = _getOracleGateStorage();
        if ($._oracle == address(0)) revert OracleGateUnusablePrice();
        (
            PriceStatus status,
            uint80 roundId,
            int256 answer,
            uint256 updatedAt,
            uint80 answeredInRound
        ) = _checkPrice();
        _requireInRange(
            status,
            roundId,
            answer,
            updatedAt,
            answeredInRound,
            $._maxStaleness,
            $._priceMin,
            $._priceMax
        );
        // priceMin > 0 is enforced whenever an oracle is set, so an in-range
        // answer is strictly positive
        return (uint256(answer), $._oracleDecimals);
    }

    /// @notice Evaluates the oracle price against the configured constraints
    /// @dev Single source of truth shared by _requirePriceInRange (which maps
    /// the status to a specific revert) and _priceInRange (which maps it to a
    /// boolean). Returns InRange when no oracle is configured.
    /// @return status The outcome of the price evaluation
    /// @return roundId The oracle round identifier
    /// @return price The latest reported price
    /// @return updatedAt The timestamp the round was last updated
    /// @return answeredInRound The round the answer was computed in
    function _checkPrice()
        internal
        view
        returns (
            PriceStatus status,
            uint80 roundId,
            int256 price,
            uint256 updatedAt,
            uint80 answeredInRound
        )
    {
        OracleGateStorage storage $ = _getOracleGateStorage();
        address oracle_ = $._oracle;
        if (oracle_ == address(0)) return (PriceStatus.InRange, 0, 0, 0, 0);
        return _checkFeed(oracle_, $._maxStaleness, $._priceMin, $._priceMax);
    }

    /// @notice Evaluates an arbitrary Chainlink feed against the given
    /// constraints
    /// @dev Storage-free core of _checkPrice, reusable by inheritors that
    /// gate additional feeds (e.g. the UniswapHook's per-asset stablecoin
    /// feeds). The caller is responsible for handling an unset feed; the
    /// oracle address passed here must be non-zero.
    /// @param oracle_ The Chainlink feed to evaluate
    /// @param maxStaleness_ The maximum allowed staleness in seconds (0
    /// disables the staleness check)
    /// @param priceMin_ The minimum acceptable price
    /// @param priceMax_ The maximum acceptable price
    /// @return status The outcome of the price evaluation
    /// @return roundId The feed round identifier
    /// @return price The latest reported price
    /// @return updatedAt The timestamp the round was last updated
    /// @return answeredInRound The round the answer was computed in
    function _checkFeed(
        address oracle_,
        uint256 maxStaleness_,
        int256 priceMin_,
        int256 priceMax_
    )
        internal
        view
        returns (
            PriceStatus status,
            uint80 roundId,
            int256 price,
            uint256 updatedAt,
            uint80 answeredInRound
        )
    {
        try AggregatorV3Interface(oracle_).latestRoundData() returns (
            uint80 roundId_,
            int256 price_,
            uint256,
            uint256 updatedAt_,
            uint80 answeredInRound_
        ) {
            roundId = roundId_;
            price = price_;
            updatedAt = updatedAt_;
            answeredInRound = answeredInRound_;
        } catch {
            return (PriceStatus.OracleError, 0, 0, 0, 0);
        }
        if (updatedAt == 0 || answeredInRound < roundId) {
            return (
                PriceStatus.IncompleteRound,
                roundId,
                price,
                updatedAt,
                answeredInRound
            );
        }
        if (
            maxStaleness_ != 0 &&
            updatedAt <= block.timestamp &&
            block.timestamp - updatedAt > maxStaleness_
        ) {
            return (
                PriceStatus.Stale,
                roundId,
                price,
                updatedAt,
                answeredInRound
            );
        }
        if (price < priceMin_ || price > priceMax_) {
            return (
                PriceStatus.OutOfRange,
                roundId,
                price,
                updatedAt,
                answeredInRound
            );
        }
        return (
            PriceStatus.InRange,
            roundId,
            price,
            updatedAt,
            answeredInRound
        );
    }
}
