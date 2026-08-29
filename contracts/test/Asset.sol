// SPDX-License-Identifier: MIT
// Compatible with OpenZeppelin Contracts ^5.0.0
pragma solidity 0.8.35;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract Asset is ERC20, Ownable {
    uint8 private _decimals;

    constructor(
        string memory symbol_,
        uint8 decimals_,
        address initialOwner
    ) ERC20(symbol_, symbol_) Ownable(initialOwner) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) public onlyOwner {
        _mint(to, amount);
    }
}
