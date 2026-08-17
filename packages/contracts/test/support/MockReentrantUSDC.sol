// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @dev Storage-compatible replacement for MockUSDC used only to prove that
/// EscrowTree's withdraw path rejects token-triggered re-entry.
contract MockReentrantUSDC {
    error Paused();
    error Blacklisted(address account);
    error InsufficientBalance();
    error InsufficientAllowance();
    error InvalidAuthorization();
    error AuthorizationUsed();

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => mapping(bytes32 => bool)) public authorizationState;
    mapping(address => bool) public blacklisted;
    bool public paused;

    address public reentryTarget;
    address public reentryDestination;
    bool public reentryAttempted;
    bool public reentrySucceeded;

    function setReentry(address target, address destination) external {
        reentryTarget = target;
        reentryDestination = destination;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (reentryTarget != address(0) && !reentryAttempted) {
            reentryAttempted = true;
            (reentrySucceeded,) = reentryTarget.call(
                abi.encodeWithSignature("withdraw(address)", reentryDestination)
            );
        }
        _transfer(msg.sender, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) private {
        if (paused) revert Paused();
        if (blacklisted[from]) revert Blacklisted(from);
        if (blacklisted[to]) revert Blacklisted(to);
        if (balanceOf[from] < amount) revert InsufficientBalance();
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}
