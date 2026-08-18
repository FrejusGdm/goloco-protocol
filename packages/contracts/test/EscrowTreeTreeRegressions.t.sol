// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { EscrowTree } from "../src/EscrowTree.sol";
import { EscrowTreeFactory } from "../src/EscrowTreeFactory.sol";
import { EscrowTreeScenario } from "./support/EscrowTreeScenario.sol";
import { TestBase, Vm } from "./support/TestBase.sol";

contract EscrowTreeTreeRegressionsTest is EscrowTreeScenario {
    uint256 internal constant ROOT_AMOUNT = 100e6;

    function setUp() public {
        _setUpScenario();
    }

    function test_01_releasedAncestorRefundRemainsPendingUntilRootResolves() public {
        EscrowTree tree = _fundedTree(bytes32("m1-01"));
        uint64 childId = _subcontract(
            tree,
            1,
            ROOT_WORKER_KEY,
            childWorker,
            CHILD_WORKER_KEY,
            80e6,
            uint40(block.timestamp + 2 days),
            bytes32("m1-01-child")
        );
        uint64 grandchildId = _subcontract(
            tree,
            childId,
            CHILD_WORKER_KEY,
            grandchildWorker,
            GRANDCHILD_WORKER_KEY,
            70e6,
            uint40(block.timestamp + 1 days),
            bytes32("m1-01-grandchild")
        );
        _deliver(tree, childId, CHILD_WORKER_KEY, keccak256("child artifact"));
        _accept(tree, childId, ROOT_WORKER_KEY);

        vm.warp(block.timestamp + 1 days + 1);
        tree.claimNonDelivery(grandchildId);

        assertEq(tree.pendingOf(childWorker), 80e6);
        assertEq(tree.claimableOf(childWorker), 0);
        vm.prank(childWorker);
        (bool withdrawn,) = address(tree).call(abi.encodeCall(EscrowTree.withdraw, (childWorker)));
        assertEq(withdrawn, false);

        _rejectRoot(tree);
        assertEq(tree.claimableOf(buyer), ROOT_AMOUNT);
        vm.prank(buyer);
        tree.withdraw(address(0xA101));
        assertEq(usdc.balanceOf(address(0xA101)), ROOT_AMOUNT);
    }

    function test_02_rejectFreezesEveryDescendantActionAndLeavesBuyerWithdrawal() public {
        EscrowTree tree = _fundedTree(bytes32("m1-02-reject"));
        uint64 childId = _subcontract(
            tree,
            1,
            ROOT_WORKER_KEY,
            childWorker,
            CHILD_WORKER_KEY,
            80e6,
            uint40(block.timestamp + 2 days),
            bytes32("m1-02-child")
        );
        _rejectRoot(tree);
        _assertRefundFreeze(tree, childId);
        assertEq(tree.claimableOf(buyer), ROOT_AMOUNT);

        vm.prank(buyer);
        tree.withdraw(address(0xB0B0));
        assertEq(usdc.balanceOf(address(0xB0B0)), ROOT_AMOUNT);
    }

    function test_02_rootAbandonAndNonDeliveryAreSingleGrossRefunds() public {
        EscrowTree abandoned = _fundedTree(bytes32("m1-02-abandon"));
        uint64 abandonedChild = _subcontract(
            abandoned,
            1,
            ROOT_WORKER_KEY,
            childWorker,
            CHILD_WORKER_KEY,
            80e6,
            uint40(block.timestamp + 2 days),
            bytes32("m1-02-abandon-child")
        );
        vm.prank(rootWorker);
        abandoned.abandon(1);
        _assertRefundFreeze(abandoned, abandonedChild);
        assertEq(abandoned.claimableOf(buyer), ROOT_AMOUNT);

        EscrowTree timedOut = _fundedTree(bytes32("m1-02-timeout"));
        uint64 timedOutChild = _subcontract(
            timedOut,
            1,
            ROOT_WORKER_KEY,
            childWorker,
            CHILD_WORKER_KEY,
            80e6,
            uint40(block.timestamp + 2 days),
            bytes32("m1-02-timeout-child")
        );
        EscrowTree.Node memory root = timedOut.getNode(1);
        vm.warp(uint256(root.deliveryDeadline) + 1);
        timedOut.claimNonDelivery(1);
        _assertRefundFreeze(timedOut, timedOutChild);
        assertEq(timedOut.claimableOf(buyer), ROOT_AMOUNT);
    }

    function test_02_refundGuardBlocksAuthorizedChildActionsThatWereOtherwiseEnabled() public {
        EscrowTree acceptTree = _fundedTree(bytes32("freeze-accept"));
        uint64 acceptChild = _subcontract(
            acceptTree,
            1,
            ROOT_WORKER_KEY,
            childWorker,
            CHILD_WORKER_KEY,
            80e6,
            uint40(block.timestamp + 2 days),
            bytes32("freeze-accept-child")
        );
        _deliver(acceptTree, acceptChild, CHILD_WORKER_KEY, keccak256("child"));
        _rejectRoot(acceptTree);
        vm.prank(rootWorker);
        (bool accepted,) =
            address(acceptTree).call(abi.encodeCall(EscrowTree.accept, (acceptChild)));
        assertEq(accepted, false);
        vm.prank(rootWorker);
        (bool rejected,) = address(acceptTree)
            .call(abi.encodeCall(EscrowTree.reject, (acceptChild, keccak256("reason"))));
        assertEq(rejected, false);

        EscrowTree abandonTree = _fundedTree(bytes32("freeze-abandon"));
        uint64 abandonChild = _subcontract(
            abandonTree,
            1,
            ROOT_WORKER_KEY,
            childWorker,
            CHILD_WORKER_KEY,
            80e6,
            uint40(block.timestamp + 2 days),
            bytes32("freeze-abandon-child")
        );
        _rejectRoot(abandonTree);
        vm.prank(childWorker);
        (bool abandoned,) =
            address(abandonTree).call(abi.encodeCall(EscrowTree.abandon, (abandonChild)));
        assertEq(abandoned, false);
        vm.prank(childWorker);
        (bool subcontracted,) = address(abandonTree)
            .call(abi.encodeCall(EscrowTree.subcontract, (_childParams(abandonChild), bytes(""))));
        assertEq(subcontracted, false);

        EscrowTree timeoutTree = _fundedTree(bytes32("freeze-timeout"));
        uint64 timeoutChild = _subcontract(
            timeoutTree,
            1,
            ROOT_WORKER_KEY,
            childWorker,
            CHILD_WORKER_KEY,
            80e6,
            uint40(block.timestamp + 1 days),
            bytes32("freeze-timeout-child")
        );
        vm.warp(block.timestamp + 1 days + 1);
        _rejectRoot(timeoutTree);
        (bool timedOut,) =
            address(timeoutTree).call(abi.encodeCall(EscrowTree.claimNonDelivery, (timeoutChild)));
        assertEq(timedOut, false);
    }

    function test_P0_a_claimFinalAtomicallyMovesPendingToClaimable() public {
        EscrowTree tree = _fundedTree(bytes32("p0-a"));
        uint64 childId = _subcontract(
            tree,
            1,
            ROOT_WORKER_KEY,
            childWorker,
            CHILD_WORKER_KEY,
            80e6,
            uint40(block.timestamp + 2 days),
            bytes32("p0-a-child")
        );
        _deliver(tree, childId, CHILD_WORKER_KEY, keccak256("child artifact"));
        _accept(tree, childId, ROOT_WORKER_KEY);
        assertEq(tree.totalPending(), 80e6);

        _releaseRoot(tree);
        vm.prank(childWorker);
        tree.claimFinal();

        assertEq(tree.totalPending(), 0);
        assertEq(tree.claimableOf(childWorker), 80e6);
        assertEq(tree.claimableOf(rootWorker), 20e6);
        assertEq(_ledger(tree, _nodeIds(2), _accounts()), ROOT_AMOUNT);
        vm.prank(childWorker);
        tree.withdraw(address(0xA201));
        vm.prank(rootWorker);
        tree.withdraw(address(0xA202));
        assertEq(usdc.balanceOf(address(0xA201)) + usdc.balanceOf(address(0xA202)), ROOT_AMOUNT);
    }

    function test_P0_b_surplusNeverSweptOnReleasedFinal() public {
        EscrowTree tree = _fundedTree(bytes32("p0-b-release"));
        usdc.mint(address(tree), 7e6);
        _releaseRoot(tree);

        assertEq(_ledger(tree, _nodeIds(1), _accounts()), ROOT_AMOUNT);
        vm.prank(rootWorker);
        tree.withdraw(rootWorker);
        assertEq(usdc.balanceOf(address(tree)), 7e6);
        assertEq(tree.claimableOf(rootWorker), 0);
    }

    function test_P0_b_surplusNeverSweptOnRefundedFinal() public {
        EscrowTree tree = _fundedTree(bytes32("p0-b-refund"));
        usdc.mint(address(tree), 7e6);
        _rejectRoot(tree);

        assertEq(tree.claimableOf(buyer), ROOT_AMOUNT);
        assertEq(_ledger(tree, _nodeIds(1), _accounts()), ROOT_AMOUNT);
        vm.prank(buyer);
        tree.withdraw(buyer);
        assertEq(usdc.balanceOf(address(tree)), 7e6);
    }

    function test_P0_c_earlyRootRefundExcludesFrozenLiveChildFromLedger() public {
        EscrowTree tree = _fundedTree(bytes32("p0-c"));
        uint64 childId = _subcontract(
            tree,
            1,
            ROOT_WORKER_KEY,
            childWorker,
            CHILD_WORKER_KEY,
            80e6,
            uint40(block.timestamp + 2 days),
            bytes32("p0-c-child")
        );
        _rejectRoot(tree);

        assertEq(uint256(tree.rootOutcome()), uint256(EscrowTree.RootOutcome.RefundedFinal));
        assertEq(tree.getNode(childId).unallocated, 80e6);
        assertEq(tree.claimableOf(buyer), ROOT_AMOUNT);
        assertEq(_ledger(tree, _nodeIds(2), _accounts()), ROOT_AMOUNT);
        vm.prank(childWorker);
        (bool childCanAct,) = address(tree).call(abi.encodeCall(EscrowTree.abandon, (childId)));
        assertEq(childCanAct, false);
        vm.prank(buyer);
        tree.withdraw(address(0xA301));
        assertEq(usdc.balanceOf(address(0xA301)), ROOT_AMOUNT);
    }

    function test_P1_childRefundAfterRootReleaseRoutesToRootWorkerPending() public {
        EscrowTree tree = _fundedTree(bytes32("released-routing"));
        uint64 childId = _subcontract(
            tree,
            1,
            ROOT_WORKER_KEY,
            childWorker,
            CHILD_WORKER_KEY,
            80e6,
            uint40(block.timestamp + 1 days),
            bytes32("released-routing-child")
        );
        _releaseRoot(tree);

        vm.warp(block.timestamp + 1 days + 1);
        tree.claimNonDelivery(childId);
        assertEq(tree.pendingOf(rootWorker), 80e6);
        assertEq(tree.claimableOf(rootWorker), 20e6);
        vm.prank(rootWorker);
        tree.claimFinal();
        assertEq(tree.claimableOf(rootWorker), ROOT_AMOUNT);
        assertEq(_ledger(tree, _nodeIds(2), _accounts()), ROOT_AMOUNT);
    }

    function test_refundRoutingPrefersNearestReleasedAncestorAfterARefundedParent() public {
        EscrowTree tree = _fundedTree(bytes32("released-ancestor-routing"));
        uint64 releasedAncestorId = _subcontract(
            tree,
            1,
            ROOT_WORKER_KEY,
            childWorker,
            CHILD_WORKER_KEY,
            80e6,
            uint40(block.timestamp + 3 days),
            bytes32("released-ancestor")
        );
        uint64 refundedParentId = _subcontract(
            tree,
            releasedAncestorId,
            CHILD_WORKER_KEY,
            grandchildWorker,
            GRANDCHILD_WORKER_KEY,
            70e6,
            uint40(block.timestamp + 3 days),
            bytes32("refunded-parent")
        );
        uint256 leafWorkerKey = 0xE0E;
        address leafWorker = vm.addr(leafWorkerKey);
        uint64 leafId = _subcontract(
            tree,
            refundedParentId,
            GRANDCHILD_WORKER_KEY,
            leafWorker,
            leafWorkerKey,
            60e6,
            uint40(block.timestamp + 1 days),
            bytes32("live-leaf")
        );

        _deliver(tree, releasedAncestorId, CHILD_WORKER_KEY, keccak256("released ancestor"));
        _accept(tree, releasedAncestorId, ROOT_WORKER_KEY);
        vm.prank(grandchildWorker);
        tree.abandon(refundedParentId);
        assertEq(tree.pendingOf(childWorker), 20e6);
        assertEq(tree.getNode(1).unallocated, 20e6);

        vm.warp(block.timestamp + 1 days + 1);
        tree.claimNonDelivery(leafId);

        assertEq(tree.pendingOf(childWorker), 80e6);
        assertEq(tree.getNode(1).unallocated, 20e6);
        assertEq(tree.pendingOf(rootWorker), 0);
    }

    function test_07_routesOnlyUnallocatedAndPaysExactlyOneRootAmountAfterRelease() public {
        EscrowTree tree = _fundedTree(bytes32("m1-07-release"));
        uint64 childId = _subcontract(
            tree,
            1,
            ROOT_WORKER_KEY,
            childWorker,
            CHILD_WORKER_KEY,
            80e6,
            uint40(block.timestamp + 2 days),
            bytes32("m1-07-c")
        );
        uint64 grandchildId = _subcontract(
            tree,
            childId,
            CHILD_WORKER_KEY,
            grandchildWorker,
            GRANDCHILD_WORKER_KEY,
            70e6,
            uint40(block.timestamp + 1 days),
            bytes32("m1-07-d")
        );
        _deliver(tree, grandchildId, GRANDCHILD_WORKER_KEY, keccak256("d artifact"));
        _accept(tree, grandchildId, CHILD_WORKER_KEY);
        _deliver(tree, childId, CHILD_WORKER_KEY, keccak256("c artifact"));
        _reject(tree, childId, ROOT_WORKER_KEY);

        assertEq(tree.getNode(1).unallocated, 30e6);
        assertEq(tree.pendingOf(grandchildWorker), 70e6);
        assertEq(_ledger(tree, _nodeIds(3), _accounts()), ROOT_AMOUNT);

        _releaseRoot(tree);
        vm.prank(grandchildWorker);
        tree.claimFinal();
        assertEq(tree.claimableOf(grandchildWorker), 70e6);
        assertEq(tree.claimableOf(rootWorker), 30e6);
        vm.prank(grandchildWorker);
        tree.withdraw(address(0xA401));
        vm.prank(rootWorker);
        tree.withdraw(address(0xA402));
        assertEq(usdc.balanceOf(address(0xA401)) + usdc.balanceOf(address(0xA402)), ROOT_AMOUNT);
    }

    function test_07_pendingIsVoidedWhenRootRefunds() public {
        EscrowTree tree = _fundedTree(bytes32("m1-07-refund"));
        uint64 childId = _subcontract(
            tree,
            1,
            ROOT_WORKER_KEY,
            childWorker,
            CHILD_WORKER_KEY,
            80e6,
            uint40(block.timestamp + 2 days),
            bytes32("m1-07-refund-c")
        );
        uint64 grandchildId = _subcontract(
            tree,
            childId,
            CHILD_WORKER_KEY,
            grandchildWorker,
            GRANDCHILD_WORKER_KEY,
            70e6,
            uint40(block.timestamp + 1 days),
            bytes32("m1-07-refund-d")
        );
        _deliver(tree, grandchildId, GRANDCHILD_WORKER_KEY, keccak256("d artifact"));
        _accept(tree, grandchildId, CHILD_WORKER_KEY);
        _deliver(tree, childId, CHILD_WORKER_KEY, keccak256("c artifact"));
        _reject(tree, childId, ROOT_WORKER_KEY);
        _rejectRoot(tree);

        assertEq(tree.claimableOf(buyer), ROOT_AMOUNT);
        assertEq(tree.pendingOf(grandchildWorker), 70e6);
        assertEq(_ledger(tree, _nodeIds(3), _accounts()), ROOT_AMOUNT);
        vm.prank(grandchildWorker);
        (bool claimed,) = address(tree).call(abi.encodeCall(EscrowTree.claimFinal, ()));
        assertEq(claimed, false);
        vm.prank(buyer);
        tree.withdraw(address(0xA501));
        assertEq(usdc.balanceOf(address(0xA501)), ROOT_AMOUNT);
    }

    function test_refundedEventsSplitRootAmountFromNonRootUnallocated() public {
        EscrowTree tree = _fundedTree(bytes32("event-split"));
        uint64 childId = _subcontract(
            tree,
            1,
            ROOT_WORKER_KEY,
            childWorker,
            CHILD_WORKER_KEY,
            80e6,
            uint40(block.timestamp + 2 days),
            bytes32("event-split-child")
        );
        _deliver(tree, childId, CHILD_WORKER_KEY, keccak256("child artifact"));

        vm.recordLogs();
        _reject(tree, childId, ROOT_WORKER_KEY);
        Vm.Log[] memory nonRootLogs = vm.getRecordedLogs();
        (uint8 cause, uint64 routedTo, address claimableTo, uint256 nonRootAmount) =
            _refundedData(nonRootLogs, address(tree));
        assertEq(uint256(cause), 1);
        assertEq(routedTo, 1);
        assertEq(claimableTo, address(0));
        assertEq(nonRootAmount, 80e6);

        vm.recordLogs();
        _rejectRoot(tree);
        Vm.Log[] memory rootLogs = vm.getRecordedLogs();
        (, uint64 rootRoute, address rootClaimable, uint256 rootAmount) =
            _refundedData(rootLogs, address(tree));
        assertEq(rootRoute, 0);
        assertEq(rootClaimable, buyer);
        assertEq(rootAmount, ROOT_AMOUNT);
    }

    function test_fundingAuthorizationCannotReplayOrSubstituteRootTerms() public {
        EscrowTreeFactory.RootParams memory params = _rootParams(
            ROOT_AMOUNT,
            bytes32("funding-auth"),
            rootWorker,
            uint40(block.timestamp + 3 days),
            uint32(48 hours)
        );
        bytes memory fundingSig = _fundingAuthorization(params);
        bytes memory acceptance = _rootAcceptance(params, rootWorker);
        factory.createAndFundFrom(params, fundingSig, acceptance);

        (bool replayed,) = address(factory)
            .call(
                abi.encodeCall(
                    EscrowTreeFactory.createAndFundFrom, (params, fundingSig, acceptance)
                )
            );
        assertEq(replayed, false);

        EscrowTreeFactory.RootParams memory changed = params;
        changed.termsHash = keccak256("substituted terms");
        changed.salt = bytes32("different-clone");
        (bool substituted,) = address(factory)
            .call(
                abi.encodeCall(
                    EscrowTreeFactory.createAndFundFrom,
                    (changed, fundingSig, _rootAcceptance(changed, rootWorker))
                )
            );
        assertEq(substituted, false);
    }

    function _assertRefundFreeze(EscrowTree tree, uint64 childId) private {
        (bool nonDelivery,) =
            address(tree).call(abi.encodeCall(EscrowTree.claimNonDelivery, (childId)));
        (bool acceptCall,) = address(tree).call(abi.encodeCall(EscrowTree.accept, (childId)));
        (bool rejectCall,) =
            address(tree).call(abi.encodeCall(EscrowTree.reject, (childId, keccak256("again"))));
        (bool abandonCall,) = address(tree).call(abi.encodeCall(EscrowTree.abandon, (childId)));
        (bool finalCall,) = address(tree).call(abi.encodeCall(EscrowTree.claimFinal, ()));
        EscrowTree.SubcontractParams memory params = EscrowTree.SubcontractParams({
            parentId: childId,
            worker: grandchildWorker,
            amount: 1e6,
            deliveryDeadline: uint40(block.timestamp + 1 days),
            acceptWindow: uint32(48 hours),
            termsHash: bytes32(0),
            workerAgentId: 0,
            expiry: block.timestamp + 1 days,
            salt: bytes32("frozen")
        });
        (bool subcontractCall,) =
            address(tree).call(abi.encodeCall(EscrowTree.subcontract, (params, bytes(""))));
        assertEq(nonDelivery, false);
        assertEq(acceptCall, false);
        assertEq(rejectCall, false);
        assertEq(abandonCall, false);
        assertEq(finalCall, false);
        assertEq(subcontractCall, false);
    }

    function _childParams(uint64 parentId)
        private
        view
        returns (EscrowTree.SubcontractParams memory)
    {
        return EscrowTree.SubcontractParams({
            parentId: parentId,
            worker: grandchildWorker,
            amount: 1e6,
            deliveryDeadline: uint40(block.timestamp + 1 days),
            acceptWindow: uint32(48 hours),
            termsHash: bytes32("frozen-child"),
            workerAgentId: 0,
            expiry: block.timestamp + 1 days,
            salt: bytes32("frozen-child")
        });
    }

    function _refundedData(Vm.Log[] memory logs, address tree)
        private
        pure
        returns (uint8 cause, uint64 routedTo, address claimableTo, uint256 amount)
    {
        bytes32 signature = keccak256("Refunded(uint64,uint8,uint64,address,uint256)");
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == tree && logs[i].topics[0] == signature) {
                return abi.decode(logs[i].data, (uint8, uint64, address, uint256));
            }
        }
        revert AssertionFailed();
    }

    function _nodeIds(uint256 length) private pure returns (uint64[] memory ids) {
        ids = new uint64[](length);
        for (uint64 i = 0; i < length; ++i) {
            ids[i] = i + 1;
        }
    }

    function _accounts() private view returns (address[] memory accounts) {
        accounts = new address[](4);
        accounts[0] = buyer;
        accounts[1] = rootWorker;
        accounts[2] = childWorker;
        accounts[3] = grandchildWorker;
    }
}
