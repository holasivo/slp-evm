// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {IUniswapHook} from "./interfaces/IUniswapHook.sol";

/// @title UniswapHookOptions
/// @author Sivo
/// @notice Configuration storage for the UniswapHook: the SLP token, the two
/// supported stablecoins (with cached decimals and each stablecoin's own USD
/// feed plus peg band), and the minimum withdrawal request size
contract UniswapHookOptions is Initializable {
    struct AssetOracle {
        address oracle;
        int256 peg_min;
        int256 peg_max;
        uint256 max_staleness;
    }

    struct Options {
        address authority;
        address slp;
        address asset0;
        address asset1;
        address oracle;
        int256 price_min;
        int256 price_max;
        uint256 max_staleness;
        uint256 min_request_shares;
        AssetOracle asset0_oracle;
        AssetOracle asset1_oracle;
    }

    /// @dev The per-asset oracle fields (M001) are appended to the struct so
    /// existing mapping entries of already-deployed proxies read them as
    /// zero (unset) until setAssetOracle configures them — an unset feed
    /// blocks the asset's deposits and fills, never passes it as pegged
    struct AssetConfig {
        bool supported;
        uint8 decimals;
        address oracle;
        uint8 oracleDecimals;
        uint256 maxStaleness;
        int256 pegMin;
        int256 pegMax;
    }

    /// @custom:storage-location erc7201:sivo.storage.UniswapHookOptions
    struct UniswapHookOptionsStorage {
        address _slp;
        uint8 _slpDecimals;
        address _asset0;
        address _asset1;
        uint256 _minRequestShares;
        mapping(address asset => AssetConfig) _assetConfig;
    }

    // keccak256(abi.encode(uint256(keccak256("sivo.storage.UniswapHookOptions")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant UniswapHookOptionsStorageLocation =
        0x16f1c6c778eb598f1ce14e2b4d0de77e6af42f5ab24804faace9cc3b66ef9000;

    function _getUniswapHookOptionsStorage()
        internal
        pure
        returns (UniswapHookOptionsStorage storage $)
    {
        assembly {
            $.slot := UniswapHookOptionsStorageLocation
        }
    }

    /// @notice Returns the SLP token address
    function slp() public view returns (address) {
        return _getUniswapHookOptionsStorage()._slp;
    }

    /// @notice Returns the SLP token decimals (cached at initialization)
    function slpDecimals() public view returns (uint8) {
        return _getUniswapHookOptionsStorage()._slpDecimals;
    }

    /// @notice Returns the two supported stablecoin addresses
    function supportedAssets() public view returns (address, address) {
        UniswapHookOptionsStorage storage $ = _getUniswapHookOptionsStorage();
        return ($._asset0, $._asset1);
    }

    /// @notice Returns the minimum SLP amount per withdrawal request
    function minRequestShares() public view returns (uint256) {
        return _getUniswapHookOptionsStorage()._minRequestShares;
    }

    /// @notice Whether an asset is one of the configured stablecoins
    /// @dev Virtual so the Certora harness can substitute the provably
    /// equivalent `asset == _asset0 || asset == _asset1` form (the mapping is
    /// written only by __UniswapHookOptions_init, for exactly those two keys)
    /// @param asset The candidate asset address
    function isSupportedAsset(address asset) public view virtual returns (bool) {
        return
            _getUniswapHookOptionsStorage()._assetConfig[asset].supported;
    }

    /// @notice Returns a supported asset's decimals (cached at initialization)
    /// @param asset The supported asset address
    function assetDecimals(address asset) public view returns (uint8) {
        return _getUniswapHookOptionsStorage()._assetConfig[asset].decimals;
    }

    /// @notice Returns an asset's own USD feed configuration
    /// @dev A zero oracle address means the feed is unset, in which case the
    /// asset's peg cannot be checked and deposits and fills against it revert
    /// @param asset The supported asset address
    /// @return oracle_ The asset's Chainlink USD feed
    /// @return oracleDecimals_ The feed decimals (cached when the feed is set)
    /// @return maxStaleness_ The feed's maximum staleness in seconds
    /// @return pegMin_ The minimum acceptable asset price
    /// @return pegMax_ The maximum acceptable asset price
    function assetOracleConfig(
        address asset
    )
        public
        view
        returns (
            address oracle_,
            uint8 oracleDecimals_,
            uint256 maxStaleness_,
            int256 pegMin_,
            int256 pegMax_
        )
    {
        AssetConfig storage cfg = _getUniswapHookOptionsStorage()._assetConfig[
            asset
        ];
        return (
            cfg.oracle,
            cfg.oracleDecimals,
            cfg.maxStaleness,
            cfg.pegMin,
            cfg.pegMax
        );
    }

    function __UniswapHookOptions_init(
        address slp_,
        address asset0_,
        address asset1_,
        uint256 minRequestShares_
    ) internal onlyInitializing {
        if (
            slp_ == address(0) ||
            asset0_ == address(0) ||
            asset1_ == address(0)
        ) {
            revert IUniswapHook.UniswapHookZeroAddress();
        }
        // The SLP token must never be a supported (sweepable) asset, and the
        // two stablecoins must be distinct: a configuration where they
        // overlap would let sweep() move queued SLP or double-count queues
        if (slp_ == asset0_ || slp_ == asset1_ || asset0_ == asset1_) {
            revert IUniswapHook.UniswapHookInvalidAssetConfig();
        }
        UniswapHookOptionsStorage storage $ = _getUniswapHookOptionsStorage();
        $._slp = slp_;
        $._slpDecimals = IERC20Metadata(slp_).decimals();
        $._asset0 = asset0_;
        $._asset1 = asset1_;
        $._minRequestShares = minRequestShares_;
        // Field writes rather than struct constructors: the per-asset oracle
        // fields are configured separately (initialize's _setAssetOracle, or
        // setAssetOracle after an upgrade) and must not be zeroed here
        $._assetConfig[asset0_].supported = true;
        $._assetConfig[asset0_].decimals = IERC20Metadata(asset0_).decimals();
        $._assetConfig[asset1_].supported = true;
        $._assetConfig[asset1_].decimals = IERC20Metadata(asset1_).decimals();
    }

    /// @notice Reverts unless the asset is one of the configured stablecoins
    /// @param asset The candidate asset address
    function _requireSupportedAsset(address asset) internal view {
        if (!isSupportedAsset(asset)) {
            revert IUniswapHook.UniswapHookUnsupportedAsset(asset);
        }
    }
}
