// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

contract MockIdentityRegistry {
    mapping(uint256 => address) private _walletOf;

    function setWallet(uint256 agentId, address wallet) external {
        _walletOf[agentId] = wallet;
    }

    function walletOf(uint256 agentId) external view returns (address) {
        return _walletOf[agentId];
    }
}
