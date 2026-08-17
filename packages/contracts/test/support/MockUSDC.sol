// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @dev Test rail with the relevant Circle semantics: six decimals, EIP-3009,
/// pause, and address blacklist. It is intentionally not production USDC code.
contract MockUSDC {
    error Paused();
    error Blacklisted(address account);
    error InsufficientBalance();
    error InsufficientAllowance();
    error InvalidAuthorization();
    error AuthorizationUsed();

    string public constant name = "Mock USD Coin";
    string public constant version = "2";
    uint8 public constant decimals = 6;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => mapping(bytes32 => bool)) public authorizationState;
    mapping(address => bool) public blacklisted;
    bool public paused;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function setPaused(bool value) external {
        paused = value;
    }

    function setBlacklisted(address account, bool value) external {
        blacklisted[account] = value;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 remaining = allowance[from][msg.sender];
        if (remaining < amount) revert InsufficientAllowance();
        allowance[from][msg.sender] = remaining - amount;
        _transfer(from, to, amount);
        return true;
    }

    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        if (msg.sender != to) revert InvalidAuthorization();
        if (block.timestamp <= validAfter || block.timestamp >= validBefore) {
            revert InvalidAuthorization();
        }
        if (authorizationState[from][nonce]) revert AuthorizationUsed();
        bytes32 digest = authorizationDigest(from, to, value, validAfter, validBefore, nonce);
        if (ecrecover(digest, v, r, s) != from) revert InvalidAuthorization();
        authorizationState[from][nonce] = true;
        _transfer(from, to, value);
    }

    function authorizationDigest(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce
    ) public view returns (bytes32) {
        bytes32 domain = keccak256(abi.encode(block.chainid, address(this)));
        return keccak256(
            abi.encodePacked(
                "\\x19\\x01",
                domain,
                keccak256(abi.encode(from, to, value, validAfter, validBefore, nonce))
            )
        );
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
