// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import {MarketParams} from "./IMorpho.sol";

/// @title IMultiplier - Leveraged SLP Deposit Interface
/// @author Sivo
/// @notice Opens a leveraged SLP position in one transaction: flash loan the
/// stablecoin from Morpho Blue, buy SLP at the oracle price through the
/// UniswapHook, post the SLP as collateral on Morpho on behalf of the user,
/// and borrow the flash-loaned amount back to repay the loan. The user ends
/// up owning a Morpho position of `principal * leverage` SLP collateral
/// against `principal * (leverage - 1)` stablecoin debt.
/// @dev The user must have authorized this contract on Morpho
/// (setAuthorization) before calling multiply, because the debt is opened in
/// the user's name. Collateral is likewise held by Morpho in the user's name;
/// this contract never retains funds between transactions.
interface IMultiplier {
    /// @notice Emitted when a leveraged position is opened
    /// @param sender The user the position was opened for
    /// @param asset The stablecoin deposited and borrowed
    /// @param principal The user's own stablecoin contribution
    /// @param flashAssets The flash-loaned amount borrowed back on Morpho
    /// @param shares The SLP posted as collateral for the user
    event Multiply(
        address indexed sender,
        address indexed asset,
        uint256 principal,
        uint256 flashAssets,
        uint256 shares
    );

    /// @notice Emitted when the Morpho market for an asset is configured
    /// @param asset The stablecoin the market lends
    /// @param oracle The Morpho market oracle
    /// @param irm The Morpho interest rate model
    /// @param lltv The Morpho liquidation loan-to-value (WAD)
    event MultiplierMarketSet(
        address indexed asset,
        address oracle,
        address irm,
        uint256 lltv
    );

    /// @notice A zero address was provided where one is not allowed
    error MultiplierZeroAddress();

    /// @notice A zero principal or flash-loan amount was provided
    error MultiplierZeroAmount();

    /// @notice No Morpho market is configured for the asset
    /// @param asset The unconfigured asset
    error MultiplierMarketNotSet(address asset);

    /// @notice The market params do not lend `asset` against SLP collateral
    error MultiplierInvalidMarket();

    /// @notice The SLP received is below the caller's minimum
    /// @param shares The SLP amount the deposit produced
    /// @param minShares The caller's minimum acceptable SLP amount
    error MultiplierSlippage(uint256 shares, uint256 minShares);

    /// @notice The flash loan callback was not invoked by Morpho within a
    /// multiply call
    error MultiplierUnauthorizedCallback();

    /// @notice Opens a leveraged SLP position for the caller
    /// @dev Pulls `principal` from the caller (requires a prior ERC-20
    /// approval), flash loans `flashAssets`, deposits the sum into the
    /// UniswapHook at the oracle price, posts the minted SLP as the caller's
    /// Morpho collateral, and borrows `flashAssets` in the caller's name to
    /// repay the flash loan. Reverts if the caller has not authorized this
    /// contract on Morpho or if the resulting position violates the market
    /// lltv.
    /// @param asset The stablecoin to deposit and borrow (USDC or USDT)
    /// @param principal The caller's own stablecoin contribution
    /// @param flashAssets The extra stablecoin to flash loan and leave as
    /// debt; principal * (leverage - 1)
    /// @param minShares The minimum SLP the combined deposit must produce
    /// @return shares The SLP posted as the caller's collateral
    function multiply(
        address asset,
        uint256 principal,
        uint256 flashAssets,
        uint256 minShares
    ) external returns (uint256 shares);

    /// @notice The Morpho market used for an asset
    /// @param asset The stablecoin
    /// @return marketParams The configured market params (zeroed when unset)
    function marketOf(
        address asset
    ) external view returns (MarketParams memory marketParams);

    /// @notice The Morpho Blue singleton
    function morpho() external view returns (address);

    /// @notice The UniswapHook the stablecoin is deposited through
    function hook() external view returns (address);

    /// @notice The SLP token posted as collateral
    function slp() external view returns (address);
}
