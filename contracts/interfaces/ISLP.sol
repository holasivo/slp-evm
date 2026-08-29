// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/// @title ISLP - Sivo Liquidity Provider Token Interface
/// @author Sivo
/// @notice Interface for the SLP token, a mintable/burnable ERC-20 whose price
/// is reported by a Chainlink NAV feed and which trades against stablecoins in
/// Uniswap v4 pools managed by the UniswapHook contract
interface ISLP is IERC20Metadata {
    /// @notice Mints new SLP tokens
    /// @dev Restricted through the AccessManager (Sivo operations and the
    /// UniswapHook, which mints on oracle-priced deposits)
    /// @param to The recipient of the minted tokens
    /// @param amount The amount of tokens to mint
    function mint(address to, uint256 amount) external;

    /// @notice Burns tokens from the caller's own balance
    /// @param amount The amount of tokens to burn
    function burn(uint256 amount) external;

    /// @notice Burns tokens from an account the caller has allowance for
    /// @param account The account whose tokens are burned
    /// @param amount The amount of tokens to burn
    function burnFrom(address account, uint256 amount) external;

    /// @notice Pauses all token transfers, mints, and burns
    function pause() external;

    /// @notice Unpauses token transfers, mints, and burns
    function unpause() external;
}
