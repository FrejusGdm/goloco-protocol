// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @dev Returns the canonical ERC-1271 magic value plus trailing ABI data.
/// Consumers accepting ABI-compatible ERC-1271 responses must accept it.
contract MockERC1271LongWallet {
    bytes4 internal constant MAGICVALUE = 0x1626ba7e;

    function isValidSignature(bytes32, bytes calldata) external pure returns (bytes4) {
        assembly {
            mstore(0x00, 0x1626ba7e00000000000000000000000000000000000000000000000000000000)
            mstore(0x20, 0x01)
            return(0x00, 0x40)
        }
    }
}
