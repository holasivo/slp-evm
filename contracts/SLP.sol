// SPDX-License-Identifier: BUSL-1.1
// Compatible with OpenZeppelin Contracts ^5.0.0
pragma solidity 0.8.35;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {ERC20BurnableUpgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20BurnableUpgradeable.sol";
import {ERC20PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PausableUpgradeable.sol";
import {ERC20PermitUpgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PermitUpgradeable.sol";
import {AccessManagedUpgradeable} from "@openzeppelin/contracts-upgradeable/access/manager/AccessManagedUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

/// @title SLP - Sivo Liquidity Provider Token
/// @author Sivo
/// @notice The SLP token represents a share of Sivo's liquidity. Its price is
/// reported by a Chainlink NAV feed and it trades against USDC/USDT in
/// Uniswap v4 pools whose swaps clear at the oracle price via the UniswapHook
/// contract. SLP replaces the legacy sivoUSDX Share token; unlike sivoUSDX it
/// carries no on-chain accrual logic — all value appreciation is reflected in
/// the oracle price.
/// @dev Minting is restricted through a central OpenZeppelin AccessManager
/// (Sivo operations and the UniswapHook, which mints on deposits and burns
/// from its own balance when filling the withdrawal queue).
/// @custom:security-contact security@sivo.com
contract SLP is
    Initializable,
    ERC20Upgradeable,
    ERC20BurnableUpgradeable,
    ERC20PausableUpgradeable,
    ERC20PermitUpgradeable,
    AccessManagedUpgradeable,
    UUPSUpgradeable
{
    /// @notice A zero address was provided where one is not allowed
    error SLPZeroAddress();

    struct Options {
        string name;
        string symbol;
        uint8 decimals;
        address authority;
    }

    /// @custom:storage-location erc7201:sivo.storage.SLP
    struct SLPStorage {
        uint8 _decimals;
    }

    // keccak256(abi.encode(uint256(keccak256("sivo.storage.SLP")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant SLPStorageLocation =
        0x855987eba058c86d649fbef78045a7a95eb134a837e35313270fc900632d3800;

    function _getSLPStorage() private pure returns (SLPStorage storage $) {
        assembly {
            $.slot := SLPStorageLocation
        }
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(Options memory options) public initializer {
        if (options.authority == address(0)) revert SLPZeroAddress();
        __ERC20_init(options.name, options.symbol);
        __ERC20Burnable_init();
        __ERC20Pausable_init();
        __ERC20Permit_init(options.name);
        __AccessManaged_init(options.authority);
        _getSLPStorage()._decimals = options.decimals;
    }

    /// @notice The number of decimals of the token
    /// @dev Matches the paired stablecoins (6) so hook conversions against the
    /// oracle price are a single mulDiv without extra scaling
    function decimals() public view override returns (uint8) {
        return _getSLPStorage()._decimals;
    }

    /// @notice Mints new SLP tokens
    /// @dev Restricted through the AccessManager (Sivo operations and the
    /// UniswapHook, which mints on oracle-priced deposits)
    /// @param to The recipient of the minted tokens
    /// @param amount The amount of tokens to mint
    function mint(address to, uint256 amount) external restricted {
        _mint(to, amount);
    }

    /// @notice Pauses all token transfers, mints, and burns
    /// @dev Restricted through the AccessManager
    function pause() external restricted {
        _pause();
    }

    /// @notice Unpauses token transfers, mints, and burns
    /// @dev Restricted through the AccessManager
    function unpause() external restricted {
        _unpause();
    }

    function _authorizeUpgrade(
        address newImplementation
    ) internal override restricted {}

    function _update(
        address from,
        address to,
        uint256 value
    ) internal override(ERC20Upgradeable, ERC20PausableUpgradeable) {
        super._update(from, to, value);
    }
}
