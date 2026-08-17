// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { EscrowTree } from "../src/EscrowTree.sol";
import { EscrowTreeFactory } from "../src/EscrowTreeFactory.sol";
import { EscrowTreeScenario } from "./support/EscrowTreeScenario.sol";

contract EscrowTreeTransitionMatrixTest is EscrowTreeScenario {
    function setUp() public {
        _setUpScenario();
    }

    function test_transitionMatrixRejectsUnlistedRootActions() public {
        EscrowTree tree = _fundedTree(bytes32("matrix-root"));

        (bool acceptBeforeDelivery,) =
            address(tree).call(abi.encodeCall(EscrowTree.accept, (uint64(1))));
        (bool rejectBeforeDelivery,) =
            address(tree).call(abi.encodeCall(EscrowTree.reject, (uint64(1), bytes32("reason"))));
        (bool timeoutBeforeDelivery,) =
            address(tree).call(abi.encodeCall(EscrowTree.claimAcceptTimeout, (uint64(1))));
        (bool finalBeforeRelease,) = address(tree).call(abi.encodeCall(EscrowTree.claimFinal, ()));
        assertEq(acceptBeforeDelivery, false);
        assertEq(rejectBeforeDelivery, false);
        assertEq(timeoutBeforeDelivery, false);
        assertEq(finalBeforeRelease, false);

        _deliver(tree, 1, ROOT_WORKER_KEY, keccak256("first"));
        (bool wrongWorkerRedelivery,) = address(tree)
            .call(
                abi.encodeCall(
                    EscrowTree.submitDelivery, (uint64(1), keccak256("wrong"), "ipfs://wrong")
                )
            );
        assertEq(wrongWorkerRedelivery, false);
    }

    function test_deliveryAndAcceptanceBoundariesUseTheSpecifiedInclusiveAndExclusiveEdges()
        public
    {
        uint40 deadline = uint40(block.timestamp + 1 days);
        EscrowTree atDeadline = _fundedTreeWith(
            100e6, bytes32("delivery-boundary"), rootWorker, deadline, uint32(48 hours)
        );
        vm.warp(deadline);
        _deliver(atDeadline, 1, ROOT_WORKER_KEY, keccak256("at deadline"));
        EscrowTree.Node memory node = atDeadline.getNode(1);
        vm.warp(uint256(node.firstDeliveredAt) + uint256(node.acceptWindow));
        vm.prank(buyer);
        atDeadline.reject(1, keccak256("at accept deadline"));

        EscrowTree afterDeadline = _fundedTree(bytes32("after-delivery-deadline"));
        EscrowTree.Node memory second = afterDeadline.getNode(1);
        vm.warp(uint256(second.deliveryDeadline) + 1);
        vm.prank(rootWorker);
        (bool deliveredLate,) = address(afterDeadline)
            .call(
                abi.encodeCall(
                    EscrowTree.submitDelivery, (uint64(1), keccak256("late"), "ipfs://late")
                )
            );
        assertEq(deliveredLate, false);

        EscrowTree timeoutWins = _fundedTree(bytes32("accept-timeout"));
        _deliver(timeoutWins, 1, ROOT_WORKER_KEY, keccak256("timeout artifact"));
        EscrowTree.Node memory delivered = timeoutWins.getNode(1);
        vm.warp(uint256(delivered.firstDeliveredAt) + uint256(delivered.acceptWindow) + 1);
        timeoutWins.claimAcceptTimeout(1);
        assertEq(uint256(timeoutWins.rootOutcome()), uint256(EscrowTree.RootOutcome.ReleasedFinal));
    }

    function test_redeliveryPreservesFirstDeliveryClock() public {
        EscrowTree tree = _fundedTree(bytes32("redelivery"));
        _deliver(tree, 1, ROOT_WORKER_KEY, keccak256("first"));
        EscrowTree.Node memory first = tree.getNode(1);
        vm.warp(block.timestamp + 1 hours);
        _deliver(tree, 1, ROOT_WORKER_KEY, keccak256("replacement"));
        EscrowTree.Node memory replacement = tree.getNode(1);

        assertEq(uint256(replacement.firstDeliveredAt), uint256(first.firstDeliveredAt));
        assertEq(replacement.artifactHash, keccak256("replacement"));
    }

    function test_releasedNodeRejectsFurtherDeliveryFromItsAuthorizedWorker() public {
        EscrowTree tree = _fundedTree(bytes32("released-cannot-deliver"));
        _deliver(tree, 1, ROOT_WORKER_KEY, keccak256("first"));
        vm.prank(buyer);
        tree.accept(1);

        vm.prank(rootWorker);
        (bool accepted,) = address(tree)
            .call(
                abi.encodeCall(
                    EscrowTree.submitDelivery,
                    (uint64(1), keccak256("after-release"), "ipfs://after-release")
                )
            );
        assertEq(accepted, false);
    }

    function test_rootMinimumWindowsRejectBelowAndAcceptExactBoundary() public {
        EscrowTreeFactory.RootParams memory atBoundary = _rootParams(
            1e6,
            bytes32("root-boundary"),
            rootWorker,
            uint40(block.timestamp + 24 hours),
            uint32(48 hours)
        );
        factory.createAndFundFrom(
            atBoundary, _fundingAuthorization(atBoundary), _rootAcceptance(atBoundary, rootWorker)
        );

        EscrowTreeFactory.RootParams memory shortAccept = atBoundary;
        shortAccept.salt = bytes32("short-accept");
        shortAccept.acceptWindow = uint32(48 hours - 1);
        (bool acceptedShort,) = address(factory)
            .call(
                abi.encodeCall(
                    EscrowTreeFactory.createAndFundFrom,
                    (
                        shortAccept,
                        _fundingAuthorization(shortAccept),
                        _rootAcceptance(shortAccept, rootWorker)
                    )
                )
            );
        assertEq(acceptedShort, false);

        EscrowTreeFactory.RootParams memory shortDelivery = atBoundary;
        shortDelivery.salt = bytes32("short-delivery");
        shortDelivery.deliveryDeadline = uint40(block.timestamp + 24 hours - 1);
        (bool acceptedDeadline,) = address(factory)
            .call(
                abi.encodeCall(
                    EscrowTreeFactory.createAndFundFrom,
                    (
                        shortDelivery,
                        _fundingAuthorization(shortDelivery),
                        _rootAcceptance(shortDelivery, rootWorker)
                    )
                )
            );
        assertEq(acceptedDeadline, false);
    }

    function test_childMinimumWindowsAndDeadlineNestingAreEnforced() public {
        EscrowTree tree = _fundedTree(bytes32("child-boundary"));
        EscrowTree.SubcontractParams memory invalidWindow = EscrowTree.SubcontractParams({
            parentId: 1,
            worker: childWorker,
            amount: 1e6,
            deliveryDeadline: uint40(block.timestamp + 1 days),
            acceptWindow: uint32(48 hours - 1),
            termsHash: bytes32("short-window"),
            workerAgentId: 0,
            expiry: block.timestamp + 1 days,
            salt: bytes32("short-window")
        });
        vm.prank(rootWorker);
        (bool acceptedShortWindow,) =
            address(tree).call(abi.encodeCall(EscrowTree.subcontract, (invalidWindow, bytes(""))));
        assertEq(acceptedShortWindow, false);

        EscrowTree.SubcontractParams memory pastParent = invalidWindow;
        pastParent.acceptWindow = uint32(48 hours);
        pastParent.deliveryDeadline = uint40(block.timestamp + 4 days);
        pastParent.salt = bytes32("past-parent");
        vm.prank(rootWorker);
        (bool acceptedPastParent,) =
            address(tree).call(abi.encodeCall(EscrowTree.subcontract, (pastParent, bytes(""))));
        assertEq(acceptedPastParent, false);
    }

    function test_subcontractRejectsTheRootBuyerAsAWorker() public {
        EscrowTree tree = _fundedTree(bytes32("buyer-cannot-be-child-worker"));
        uint64 childId = _subcontract(
            tree,
            1,
            ROOT_WORKER_KEY,
            childWorker,
            CHILD_WORKER_KEY,
            80e6,
            uint40(block.timestamp + 2 days),
            bytes32("valid-child")
        );
        EscrowTree.SubcontractParams memory p = EscrowTree.SubcontractParams({
            parentId: childId,
            worker: buyer,
            amount: 70e6,
            deliveryDeadline: uint40(block.timestamp + 1 days),
            acceptWindow: uint32(48 hours),
            termsHash: bytes32("buyer-worker"),
            workerAgentId: 0,
            expiry: block.timestamp + 1 days,
            salt: bytes32("buyer-worker")
        });
        bytes32 digest = tree.quoteDigest(p);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(BUYER_KEY, digest);
        vm.prank(childWorker);
        (bool allowed,) = address(tree)
            .call(abi.encodeCall(EscrowTree.subcontract, (p, abi.encodePacked(r, s, v))));
        assertEq(allowed, false);
    }

    function test_nonzeroWorkerAgentIdsMustMatchTheImmutableRegistryWallet() public {
        EscrowTree tree = _fundedTree(bytes32("agent-id"));
        identityRegistry.setWallet(7, childWorker);
        EscrowTree.SubcontractParams memory valid = EscrowTree.SubcontractParams({
            parentId: 1,
            worker: childWorker,
            amount: 80e6,
            deliveryDeadline: uint40(block.timestamp + 2 days),
            acceptWindow: uint32(48 hours),
            termsHash: bytes32("agent-id-valid"),
            workerAgentId: 7,
            expiry: block.timestamp + 1 days,
            salt: bytes32("agent-id-valid")
        });
        bytes32 digest = tree.quoteDigest(valid);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(CHILD_WORKER_KEY, digest);
        vm.prank(rootWorker);
        uint64 childId = tree.subcontract(valid, abi.encodePacked(r, s, v));
        assertEq(tree.getNode(childId).workerAgentId, 7);

        EscrowTree.SubcontractParams memory mismatched = valid;
        mismatched.salt = bytes32("agent-id-mismatch");
        mismatched.workerAgentId = 8;
        bytes32 mismatchDigest = tree.quoteDigest(mismatched);
        (v, r, s) = vm.sign(CHILD_WORKER_KEY, mismatchDigest);
        vm.prank(rootWorker);
        (bool accepted,) = address(tree)
            .call(abi.encodeCall(EscrowTree.subcontract, (mismatched, abi.encodePacked(r, s, v))));
        assertEq(accepted, false);
    }

    function test_rootWorkerAgentIdMustMatchTheImmutableRegistryWallet() public {
        identityRegistry.setWallet(9, rootWorker);
        EscrowTreeFactory.RootParams memory valid = _rootParams(
            100e6,
            bytes32("root-agent-valid"),
            rootWorker,
            uint40(block.timestamp + 3 days),
            uint32(48 hours)
        );
        valid.workerAgentId = 9;
        factory.createAndFundFrom(
            valid, _fundingAuthorization(valid), _rootAcceptance(valid, rootWorker)
        );

        EscrowTreeFactory.RootParams memory mismatched = valid;
        mismatched.salt = bytes32("root-agent-mismatch");
        mismatched.workerAgentId = 10;
        (bool accepted,) = address(factory)
            .call(
                abi.encodeCall(
                    EscrowTreeFactory.createAndFundFrom,
                    (
                        mismatched,
                        _fundingAuthorization(mismatched),
                        _rootAcceptance(mismatched, rootWorker)
                    )
                )
            );
        assertEq(accepted, false);
    }

    function test_treeCanReachDepthEightAndCannotCreateANinthNode() public {
        EscrowTree tree = _fundedTreeWith(
            8e6,
            bytes32("depth-eight"),
            rootWorker,
            uint40(block.timestamp + 3 days),
            uint32(48 hours)
        );
        uint256 parentKey = ROOT_WORKER_KEY;
        uint64 parentId = 1;
        for (uint256 depth = 2; depth <= 8; ++depth) {
            uint256 workerKey = 0xE000 + depth;
            parentId = _subcontract(
                tree,
                parentId,
                parentKey,
                vm.addr(workerKey),
                workerKey,
                (9 - depth) * 1e6,
                uint40(block.timestamp + 2 days),
                bytes32(depth)
            );
            parentKey = workerKey;
        }
        assertEq(uint256(tree.getNode(parentId).depth), 8);
        EscrowTree.SubcontractParams memory ninth = EscrowTree.SubcontractParams({
            parentId: parentId,
            worker: vm.addr(0xE009),
            amount: 1e6,
            deliveryDeadline: uint40(block.timestamp + 2 days),
            acceptWindow: uint32(48 hours),
            termsHash: bytes32("ninth"),
            workerAgentId: 0,
            expiry: block.timestamp + 1 days,
            salt: bytes32("ninth")
        });
        bytes32 digest = tree.quoteDigest(ninth);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xE009, digest);
        vm.prank(vm.addr(parentKey));
        (bool created,) = address(tree)
            .call(abi.encodeCall(EscrowTree.subcontract, (ninth, abi.encodePacked(r, s, v))));
        assertEq(created, false);
    }
}
