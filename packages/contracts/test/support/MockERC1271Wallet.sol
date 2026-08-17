// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { MockUSDC } from "./MockUSDC.sol";

/// @dev Deliberately small smart-account signature double. Tests can flip its
/// policy after a signature has been issued to exercise validation at consume time.
contract MockERC1271Wallet {
    bytes4 internal constant MAGICVALUE = 0x1626ba7e;

    mapping(bytes32 => bool) private _approved;

    function setSignatureValid(bytes32 digest, bool valid) external {
        _approved[digest] = valid;
    }

    function approveToken(MockUSDC token, address spender, uint256 amount) external {
        token.approve(spender, amount);
    }

    function isValidSignature(bytes32 digest, bytes calldata) external view returns (bytes4) {
        return _approved[digest] ? MAGICVALUE : bytes4(0xffffffff);
    }
}
