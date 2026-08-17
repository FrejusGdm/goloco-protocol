// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface Vm {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }

    function addr(uint256 privateKey) external returns (address keyAddr);
    function prank(address msgSender) external;
    function warp(uint256 newTimestamp) external;
    function sign(uint256 privateKey, bytes32 digest)
        external
        returns (uint8 v, bytes32 r, bytes32 s);
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory entries);
    function targetContract(address newTargetedContract_) external;
    function etch(address target, bytes calldata newRuntimeBytecode) external;
    function chainId(uint256 newChainId) external;
    function createSelectFork(string calldata urlOrAlias, uint256 blockNumber)
        external
        returns (uint256 forkId);
    function envOr(string calldata name, string calldata defaultValue)
        external
        returns (string memory value);
    function envOr(string calldata name, uint256 defaultValue) external returns (uint256 value);
    function expectRevert(bytes4 revertData) external;
}

abstract contract TestBase {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    error AssertionFailed();

    function assertEq(uint256 actual, uint256 expected) internal pure {
        if (actual != expected) revert AssertionFailed();
    }

    function assertEq(address actual, address expected) internal pure {
        if (actual != expected) revert AssertionFailed();
    }

    function assertEq(bool actual, bool expected) internal pure {
        if (actual != expected) revert AssertionFailed();
    }

    function assertEq(bytes32 actual, bytes32 expected) internal pure {
        if (actual != expected) revert AssertionFailed();
    }

    function assertTrue(bool condition) internal pure {
        if (!condition) revert AssertionFailed();
    }
}
