// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @custom:security-contact security@sivo.com
/// @notice Mimics the live Tether USD (USDT) token on Ethereum, which is
///         intentionally NOT fully ERC-20 compliant: transfer, transferFrom and
///         approve return no value, and approve enforces the "zero-first"
///         allowance rule. OpenZeppelin's ERC20 cannot be inherited here because
///         its public functions are fixed to `returns (bool)`.
contract TetherUSD is Pausable, Ownable {
    string public constant name = "Tether USD";
    string public constant symbol = "USDT";
    uint8 public constant decimals = 6;

    uint256 private _totalSupply;
    mapping(address account => uint256 balance) private _balances;
    mapping(address owner => mapping(address spender => uint256 value))
        private _allowances;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(
        address indexed owner,
        address indexed spender,
        uint256 value
    );

    constructor(address initialOwner) Ownable(initialOwner) {}

    function totalSupply() public view returns (uint256) {
        return _totalSupply;
    }

    function balanceOf(address account) public view returns (uint256) {
        return _balances[account];
    }

    function allowance(
        address owner,
        address spender
    ) public view returns (uint256) {
        return _allowances[owner][spender];
    }

    /// @dev Non-standard: returns no value, matching the live USDT contract.
    function transfer(address to, uint256 value) public whenNotPaused {
        _transfer(_msgSender(), to, value);
    }

    /// @dev Non-standard: returns no value, matching the live USDT contract.
    function transferFrom(
        address from,
        address to,
        uint256 value
    ) public whenNotPaused {
        _spendAllowance(from, _msgSender(), value);
        _transfer(from, to, value);
    }

    /// @dev Non-standard: returns no value and enforces the "zero-first" rule
    ///      (a non-zero allowance must be reset to zero before being changed to
    ///      another non-zero value), matching the live USDT contract.
    function approve(address spender, uint256 value) public {
        require(
            value == 0 || _allowances[_msgSender()][spender] == 0,
            "USDT: approve from non-zero to non-zero allowance"
        );
        _allowances[_msgSender()][spender] = value;
        emit Approval(_msgSender(), spender, value);
    }

    function pause() public onlyOwner {
        _pause();
    }

    function unpause() public onlyOwner {
        _unpause();
    }

    function mint(address to, uint256 amount) public onlyOwner {
        require(to != address(0), "USDT: mint to the zero address");
        _totalSupply += amount;
        unchecked {
            _balances[to] += amount;
        }
        emit Transfer(address(0), to, amount);
    }

    function burn(uint256 amount) public {
        _burn(_msgSender(), amount);
    }

    function burnFrom(address account, uint256 amount) public {
        _spendAllowance(account, _msgSender(), amount);
        _burn(account, amount);
    }

    function _transfer(address from, address to, uint256 value) internal {
        require(to != address(0), "USDT: transfer to the zero address");
        uint256 fromBalance = _balances[from];
        require(fromBalance >= value, "USDT: transfer amount exceeds balance");
        unchecked {
            _balances[from] = fromBalance - value;
            _balances[to] += value;
        }
        emit Transfer(from, to, value);
    }

    function _burn(address from, uint256 value) internal whenNotPaused {
        uint256 fromBalance = _balances[from];
        require(fromBalance >= value, "USDT: burn amount exceeds balance");
        unchecked {
            _balances[from] = fromBalance - value;
            _totalSupply -= value;
        }
        emit Transfer(from, address(0), value);
    }

    function _spendAllowance(
        address owner,
        address spender,
        uint256 value
    ) internal {
        uint256 currentAllowance = _allowances[owner][spender];
        if (currentAllowance < type(uint256).max) {
            require(currentAllowance >= value, "USDT: insufficient allowance");
            unchecked {
                _allowances[owner][spender] = currentAllowance - value;
            }
        }
    }
}
