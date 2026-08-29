// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IMorpho, IMorphoFlashLoanCallback, MarketParams} from "../interfaces/IMorpho.sol";

/// @notice Morpho Blue market oracle stub: price of 1 collateral unit in loan
/// token units, scaled by 1e36 (times the loan/collateral decimals ratio).
contract MorphoOracleHarness {
    uint256 private _price;

    constructor(uint256 price_) {
        _price = price_;
    }

    function setPrice(uint256 price_) external {
        _price = price_;
    }

    function price() external view returns (uint256) {
        return _price;
    }
}

/// @notice Minimal Morpho Blue stand-in for Multiplier tests: fee-free flash
/// loans repaid via transferFrom, collateral supply, authorized borrowing
/// with an lltv health check, and position views. Borrow shares equal borrow
/// assets (no interest accrual).
contract MorphoHarness is IMorpho {
    uint256 internal constant ORACLE_PRICE_SCALE = 1e36;
    uint256 internal constant WAD = 1e18;

    struct Position {
        uint128 borrowShares;
        uint128 collateral;
    }

    mapping(bytes32 id => mapping(address user => Position)) private _positions;
    mapping(address authorizer => mapping(address authorized => bool))
        private _isAuthorized;

    error MorphoHarnessUnauthorized();
    error MorphoHarnessUnhealthyPosition();
    error MorphoHarnessInconsistentInput();

    function id(MarketParams memory marketParams) public pure returns (bytes32) {
        return keccak256(abi.encode(marketParams));
    }

    function flashLoan(
        address token,
        uint256 assets,
        bytes calldata data
    ) external {
        SafeERC20.safeTransfer(IERC20(token), msg.sender, assets);
        IMorphoFlashLoanCallback(msg.sender).onMorphoFlashLoan(assets, data);
        SafeERC20.safeTransferFrom(
            IERC20(token),
            msg.sender,
            address(this),
            assets
        );
    }

    function supplyCollateral(
        MarketParams calldata marketParams,
        uint256 assets,
        address onBehalf,
        bytes calldata
    ) external {
        _positions[id(marketParams)][onBehalf].collateral += uint128(assets);
        SafeERC20.safeTransferFrom(
            IERC20(marketParams.collateralToken),
            msg.sender,
            address(this),
            assets
        );
    }

    function borrow(
        MarketParams calldata marketParams,
        uint256 assets,
        uint256 shares,
        address onBehalf,
        address receiver
    ) external returns (uint256, uint256) {
        if (assets == 0 || shares != 0) revert MorphoHarnessInconsistentInput();
        if (msg.sender != onBehalf && !_isAuthorized[onBehalf][msg.sender]) {
            revert MorphoHarnessUnauthorized();
        }
        Position storage p = _positions[id(marketParams)][onBehalf];
        p.borrowShares += uint128(assets);
        uint256 collateralValue = (uint256(p.collateral) *
            MorphoOracleHarness(marketParams.oracle).price()) /
            ORACLE_PRICE_SCALE;
        uint256 maxBorrow = (collateralValue * marketParams.lltv) / WAD;
        if (p.borrowShares > maxBorrow) revert MorphoHarnessUnhealthyPosition();
        SafeERC20.safeTransfer(IERC20(marketParams.loanToken), receiver, assets);
        return (assets, assets);
    }

    function setAuthorization(
        address authorized,
        bool newIsAuthorized
    ) external {
        _isAuthorized[msg.sender][authorized] = newIsAuthorized;
    }

    function isAuthorized(
        address authorizer,
        address authorized
    ) external view returns (bool) {
        return _isAuthorized[authorizer][authorized];
    }

    function position(
        bytes32 id_,
        address user
    ) external view returns (uint256, uint128, uint128) {
        Position storage p = _positions[id_][user];
        return (0, p.borrowShares, p.collateral);
    }
}
