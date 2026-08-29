// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Asset} from "../test/Asset.sol";

/// @title CertoraAssetB
/// @notice Second ERC-20 instance for the Certora scene. The UniswapHook
/// serves two stablecoins (USDC and USDT); Certora instantiates one contract
/// per contract NAME, so pairing `Asset` with this subclass yields the two
/// distinct in-scene token instances the hook.spec rules bind to
/// `supportedAssets()`.
contract AssetB is Asset {
    constructor(
        string memory symbol_,
        uint8 decimals_,
        address initialOwner
    ) Asset(symbol_, decimals_, initialOwner) {}
}
