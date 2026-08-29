// SPDX-License-Identifier: BUSL-1.1
// Compatible with OpenZeppelin Contracts ^5.0.0
pragma solidity 0.8.35;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {AccessManagedUpgradeable} from "@openzeppelin/contracts-upgradeable/access/manager/AccessManagedUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {UniswapHookOptions} from "./UniswapHookOptions.sol";
import {IMorpho, IMorphoFlashLoanCallback, MarketParams} from "./interfaces/IMorpho.sol";
import {IMultiplier} from "./interfaces/IMultiplier.sol";
import {IUniswapHook} from "./interfaces/IUniswapHook.sol";

/// @title Multiplier - Leveraged SLP Deposits via Morpho Blue
/// @author Sivo
/// @notice Opens a leveraged SLP position in one transaction: flash loan the
/// stablecoin from Morpho Blue, buy SLP at the oracle price through the
/// UniswapHook, post the SLP as the user's Morpho collateral, and borrow the
/// flash-loaned amount back in the user's name to repay the loan. Morpho Blue
/// flash loans are fee-free, so the debt equals the flash-loaned amount
/// exactly.
/// @dev The position (collateral and debt) lives on Morpho under the user's
/// address; this contract is a stateless router that never retains funds
/// between transactions. Borrowing in the user's name requires the user to
/// have authorized this contract on Morpho via setAuthorization. Market
/// configuration is restricted through a central OpenZeppelin AccessManager.
/// @custom:security-contact security@sivo.com
contract Multiplier is
    Initializable,
    IMultiplier,
    IMorphoFlashLoanCallback,
    PausableUpgradeable,
    AccessManagedUpgradeable,
    ReentrancyGuardTransient,
    UUPSUpgradeable
{
    struct Options {
        address authority;
        address morpho;
        address hook;
    }

    /// @custom:storage-location erc7201:sivo.storage.Multiplier
    struct MultiplierStorage {
        address _morpho;
        address _hook;
        address _slp;
        mapping(address asset => MarketParams) _markets;
    }

    // keccak256(abi.encode(uint256(keccak256("sivo.storage.Multiplier")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant MultiplierStorageLocation =
        0x45f6d2a1017413c81cf8b7b8f2c652f799011ae8b82a7d59b44de454fc11e900;

    /// @dev Transient slot holding keccak256 of the in-flight flash loan
    /// data; doubles as the "a multiply is in progress" marker that gates
    /// onMorphoFlashLoan
    // keccak256("sivo.transient.Multiplier.flashTag")
    bytes32 private constant FlashTagSlot =
        0xe777d3fd9c3d6c08c0417f143d523f319c0c8613c1b03e4de76a1f434ab35c2a;

    /// @dev Transient slot carrying the minted SLP amount out of the flash
    /// loan callback so multiply can return it
    // keccak256("sivo.transient.Multiplier.flashShares")
    bytes32 private constant FlashSharesSlot =
        0xcb177c6da10a7de8ef00e58cb3aeba1cf41bbce6aa7e63db392e34bb814e3e73;

    function _getMultiplierStorage()
        private
        pure
        returns (MultiplierStorage storage $)
    {
        assembly {
            $.slot := MultiplierStorageLocation
        }
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(Options memory options) public initializer {
        if (
            options.authority == address(0) ||
            options.morpho == address(0) ||
            options.hook == address(0)
        ) {
            revert MultiplierZeroAddress();
        }
        __Pausable_init();
        __AccessManaged_init(options.authority);
        MultiplierStorage storage $ = _getMultiplierStorage();
        $._morpho = options.morpho;
        $._hook = options.hook;
        // The collateral token is dictated by the hook, not configuration
        $._slp = UniswapHookOptions(options.hook).slp();
    }

    /// @inheritdoc IMultiplier
    function multiply(
        address asset,
        uint256 principal,
        uint256 flashAssets,
        uint256 minShares
    ) external nonReentrant whenNotPaused returns (uint256 shares) {
        MultiplierStorage storage $ = _getMultiplierStorage();
        if ($._markets[asset].loanToken == address(0)) {
            revert MultiplierMarketNotSet(asset);
        }
        if (principal == 0 || flashAssets == 0) revert MultiplierZeroAmount();
        SafeERC20.safeTransferFrom(
            IERC20(asset),
            msg.sender,
            address(this),
            principal
        );
        bytes memory data = abi.encode(msg.sender, asset, principal, minShares);
        bytes32 tag = keccak256(data);
        assembly {
            tstore(FlashTagSlot, tag)
        }
        IMorpho($._morpho).flashLoan(asset, flashAssets, data);
        assembly {
            shares := tload(FlashSharesSlot)
            tstore(FlashSharesSlot, 0)
        }
    }

    /// @notice Morpho Blue flash loan callback: buys SLP with the combined
    /// principal + flash-loaned stablecoin, posts it as the user's collateral,
    /// and borrows the flash-loaned amount back in the user's name so Morpho
    /// can pull the repayment after this call returns
    /// @dev Only callable by Morpho, and only while a multiply initiated by
    /// this contract is in flight (the transient tag binds the callback to
    /// the exact data multiply encoded)
    function onMorphoFlashLoan(uint256 assets, bytes calldata data) external {
        MultiplierStorage storage $ = _getMultiplierStorage();
        bytes32 tag;
        assembly {
            tag := tload(FlashTagSlot)
        }
        if (
            msg.sender != $._morpho ||
            tag == bytes32(0) ||
            tag != keccak256(data)
        ) {
            revert MultiplierUnauthorizedCallback();
        }
        assembly {
            tstore(FlashTagSlot, 0)
        }
        (address user, address asset, uint256 principal, uint256 minShares) =
            abi.decode(data, (address, address, uint256, uint256));
        MarketParams memory market = $._markets[asset];

        uint256 total = principal + assets;
        SafeERC20.forceApprove(IERC20(asset), $._hook, total);
        uint256 shares = IUniswapHook($._hook).deposit(
            asset,
            total,
            address(this)
        );
        if (shares < minShares) revert MultiplierSlippage(shares, minShares);

        SafeERC20.forceApprove(IERC20($._slp), $._morpho, shares);
        IMorpho($._morpho).supplyCollateral(market, shares, user, "");
        // Reverts unless the user authorized this contract and the position
        // stays healthy under the market lltv
        IMorpho($._morpho).borrow(market, assets, 0, user, address(this));
        // Morpho pulls the repayment via transferFrom after this returns
        SafeERC20.forceApprove(IERC20(asset), $._morpho, assets);

        assembly {
            tstore(FlashSharesSlot, shares)
        }
        emit Multiply(user, asset, principal, assets, shares);
    }

    /// @notice Configures the Morpho market leveraged deposits in `asset` use
    /// @dev Restricted through the AccessManager. The market must lend the
    /// asset against SLP collateral; oracle, irm, and lltv identify the
    /// specific Morpho market (its id is keccak256 of the full params).
    /// @param asset The stablecoin the market lends
    /// @param market The full Morpho market params
    function setMarket(
        address asset,
        MarketParams calldata market
    ) external restricted {
        MultiplierStorage storage $ = _getMultiplierStorage();
        if (
            asset == address(0) ||
            market.loanToken != asset ||
            market.collateralToken != $._slp
        ) {
            revert MultiplierInvalidMarket();
        }
        $._markets[asset] = market;
        emit MultiplierMarketSet(asset, market.oracle, market.irm, market.lltv);
    }

    /// @notice Pauses leveraged deposits
    /// @dev Restricted through the AccessManager
    function pause() external restricted {
        _pause();
    }

    /// @notice Unpauses leveraged deposits
    /// @dev Restricted through the AccessManager
    function unpause() external restricted {
        _unpause();
    }

    function _authorizeUpgrade(
        address newImplementation
    ) internal override restricted {}

    /// @inheritdoc IMultiplier
    function marketOf(
        address asset
    ) external view returns (MarketParams memory) {
        return _getMultiplierStorage()._markets[asset];
    }

    /// @inheritdoc IMultiplier
    function morpho() external view returns (address) {
        return _getMultiplierStorage()._morpho;
    }

    /// @inheritdoc IMultiplier
    function hook() external view returns (address) {
        return _getMultiplierStorage()._hook;
    }

    /// @inheritdoc IMultiplier
    function slp() external view returns (address) {
        return _getMultiplierStorage()._slp;
    }
}
