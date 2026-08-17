// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { EscrowTree } from "../src/EscrowTree.sol";
import { EscrowTreeScenario } from "./support/EscrowTreeScenario.sol";

/// @dev Bounded, pure Foundry-compatible proof harness. Halmos consumes the same
/// test shape; CI must run these two checks with Halmos before mainnet/audit.
contract EscrowTreeHalmosTest is EscrowTreeScenario {
    function setUp() public {
        _setUpScenario();
    }

    function check_I13_boundedBuyerRecoversGrossAfterEveryRootRefundCause(uint8 cause) public {
        EscrowTree tree = _fundedTree(bytes32(uint256(cause) + 1));
        if (cause % 3 == 0) {
            _rejectRoot(tree);
        } else if (cause % 3 == 1) {
            vm.prank(rootWorker);
            tree.abandon(1);
        } else {
            EscrowTree.Node memory root = tree.getNode(1);
            vm.warp(uint256(root.deliveryDeadline) + 1);
            tree.claimNonDelivery(1);
        }
        assertEq(uint256(tree.rootOutcome()), uint256(EscrowTree.RootOutcome.RefundedFinal));
        assertEq(tree.claimableOf(buyer), tree.rootAmount());
    }

    /// @dev Runs the same bounded predicate under Foundry when Halmos is not
    /// installed locally. Halmos still consumes the `check_` function directly.
    function testFuzz_I13_boundedBuyerRecoversGrossAfterEveryRootRefundCause(uint8 cause) public {
        check_I13_boundedBuyerRecoversGrossAfterEveryRootRefundCause(cause);
    }

    function check_I16_boundedNoPrivilegedActorCanSweep(uint160 arbitraryActor) public {
        EscrowTree tree = _fundedTree(bytes32("halmos-i16"));
        address actor = address(arbitraryActor);
        vm.prank(actor);
        (bool swept,) = address(tree)
            .call(
                abi.encodeWithSignature("sweep(address,address,uint256)", address(usdc), actor, 1)
            );
        assertEq(swept, false);
        (bool factorySwept,) = address(factory)
            .call(
                abi.encodeWithSignature("sweep(address,address,uint256)", address(usdc), actor, 1)
            );
        assertEq(factorySwept, false);
        assertEq(tree.claimableOf(actor), 0);
    }

    /// @dev Foundry execution companion for the Halmos I16 predicate above.
    function testFuzz_I16_boundedNoPrivilegedActorCanSweep(uint160 arbitraryActor) public {
        check_I16_boundedNoPrivilegedActorCanSweep(arbitraryActor);
    }
}
