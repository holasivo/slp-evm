// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

/// @notice Test-only CREATE2 deployer standing in for the canonical
/// deterministic-deployment proxy, so local fixtures can deploy the
/// UniswapHook proxy at a mined, flag-encoded address.
contract Create2Factory {
    error Create2FactoryDeployFailed();

    function deploy(
        bytes32 salt,
        bytes memory code
    ) external returns (address addr) {
        assembly {
            addr := create2(0, add(code, 0x20), mload(code), salt)
        }
        if (addr == address(0)) revert Create2FactoryDeployFailed();
    }
}
