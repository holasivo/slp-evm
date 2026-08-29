// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

/// @notice The configuration of a Morpho Blue market
/// @dev Mirrors the struct of the canonical Morpho Blue deployment; the
/// market id is keccak256(abi.encode(marketParams))
struct MarketParams {
    address loanToken;
    address collateralToken;
    address oracle;
    address irm;
    uint256 lltv;
}

/// @title IMorpho - Minimal Morpho Blue Interface
/// @author Sivo
/// @notice The subset of Morpho Blue used by the Multiplier: fee-free flash
/// loans, collateral supply, and borrowing on behalf of an authorized user
interface IMorpho {
    /// @notice Executes a fee-free flash loan of `assets` of `token`
    /// @dev Calls onMorphoFlashLoan on the caller, then pulls the same amount
    /// back via transferFrom (requires a prior approval)
    /// @param token The token to flash loan
    /// @param assets The amount to flash loan
    /// @param data Arbitrary data passed through to the callback
    function flashLoan(
        address token,
        uint256 assets,
        bytes calldata data
    ) external;

    /// @notice Supplies collateral on behalf of `onBehalf`
    /// @dev Pulls the collateral from the caller; supplying on behalf of any
    /// address requires no authorization
    /// @param marketParams The market to supply collateral to
    /// @param assets The amount of collateral to supply
    /// @param onBehalf The address that owns the resulting position
    /// @param data Arbitrary callback data (empty for a plain supply)
    function supplyCollateral(
        MarketParams calldata marketParams,
        uint256 assets,
        address onBehalf,
        bytes calldata data
    ) external;

    /// @notice Borrows against the collateral of `onBehalf`
    /// @dev The caller must be authorized by `onBehalf` via setAuthorization;
    /// reverts if the resulting position is not healthy under the market lltv
    /// @param marketParams The market to borrow from
    /// @param assets The exact loan amount to borrow (shares must be 0)
    /// @param shares The borrow shares to mint (assets must be 0)
    /// @param onBehalf The address that owes the resulting debt
    /// @param receiver The recipient of the borrowed tokens
    /// @return assetsBorrowed The loan amount transferred to the receiver
    /// @return sharesBorrowed The borrow shares minted to `onBehalf`
    function borrow(
        MarketParams calldata marketParams,
        uint256 assets,
        uint256 shares,
        address onBehalf,
        address receiver
    ) external returns (uint256 assetsBorrowed, uint256 sharesBorrowed);

    /// @notice Authorizes or revokes `authorized` to manage the caller's
    /// positions (borrow, withdraw, withdrawCollateral on their behalf)
    /// @param authorized The address to authorize or revoke
    /// @param newIsAuthorized True to authorize, false to revoke
    function setAuthorization(address authorized, bool newIsAuthorized) external;

    /// @notice Whether `authorized` may manage the positions of `authorizer`
    /// @param authorizer The position owner
    /// @param authorized The candidate manager
    function isAuthorized(
        address authorizer,
        address authorized
    ) external view returns (bool);

    /// @notice The position of `user` in the market identified by `id`
    /// @param id The market id (keccak256 of the abi-encoded MarketParams)
    /// @param user The position owner
    /// @return supplyShares The user's supply shares
    /// @return borrowShares The user's borrow shares
    /// @return collateral The user's collateral balance
    function position(
        bytes32 id,
        address user
    )
        external
        view
        returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral);
}

/// @title IMorphoFlashLoanCallback
/// @notice Interface a Morpho Blue flash loan borrower must implement
interface IMorphoFlashLoanCallback {
    /// @notice Called by Morpho Blue with the flash-loaned tokens already
    /// transferred to the callee
    /// @param assets The flash-loaned amount, which Morpho pulls back via
    /// transferFrom after this call returns
    /// @param data The data passed to flashLoan
    function onMorphoFlashLoan(uint256 assets, bytes calldata data) external;
}
