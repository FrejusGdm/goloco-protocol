// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { EscrowTree } from "../src/EscrowTree.sol";
import { EscrowTreeScenario } from "./support/EscrowTreeScenario.sol";
import { TestBase } from "./support/TestBase.sol";

/// @dev Foundry stateful handler: calls are intentionally allowed to revert when a
/// generated ordering is not in the transition matrix. Invariants observe every
/// successful ordering that the production state machine admits.
contract EscrowTreeHandler is TestBase {
    EscrowTree internal immutable tree;
    address internal immutable buyer;
    address internal immutable rootWorker;
    address internal immutable childWorker;
    uint64 internal immutable childId;
    uint256 public totalWithdrawn;
    mapping(address => uint256) public withdrawnBy;

    constructor(
        EscrowTree tree_,
        address buyer_,
        address rootWorker_,
        address childWorker_,
        uint64 childId_
    ) {
        tree = tree_;
        buyer = buyer_;
        rootWorker = rootWorker_;
        childWorker = childWorker_;
        childId = childId_;
    }

    function deliverRoot(bytes32 artifact) external {
        vm.prank(rootWorker);
        try tree.submitDelivery(1, artifact, "ipfs://root") { } catch { }
    }

    function deliverChild(bytes32 artifact) external {
        vm.prank(childWorker);
        try tree.submitDelivery(childId, artifact, "ipfs://child") { } catch { }
    }

    function acceptRoot() external {
        vm.prank(buyer);
        try tree.accept(1) { } catch { }
    }

    function rejectRoot() external {
        vm.prank(buyer);
        try tree.reject(1, keccak256("fuzz reject")) { } catch { }
    }

    function acceptChild() external {
        vm.prank(rootWorker);
        try tree.accept(childId) { } catch { }
    }

    function abandonChild() external {
        vm.prank(childWorker);
        try tree.abandon(childId) { } catch { }
    }

    function abandonRoot() external {
        vm.prank(rootWorker);
        try tree.abandon(1) { } catch { }
    }

    function expireRoot(uint40 afterDeadline) external {
        EscrowTree.Node memory root = tree.getNode(1);
        vm.warp(uint256(root.deliveryDeadline) + (uint256(afterDeadline) % 3) + 1);
        try tree.claimNonDelivery(1) { } catch { }
    }

    function expireChild(uint40 afterDeadline) external {
        EscrowTree.Node memory child = tree.getNode(childId);
        uint256 when = uint256(child.deliveryDeadline) + (uint256(afterDeadline) % 3) + 1;
        vm.warp(when);
        try tree.claimNonDelivery(childId) { } catch { }
    }

    function claimFinal() external {
        vm.prank(childWorker);
        try tree.claimFinal() { } catch { }
        vm.prank(rootWorker);
        try tree.claimFinal() { } catch { }
    }

    function withdraw(uint8 actor) external {
        address claimant = actor % 3 == 0 ? buyer : (actor % 3 == 1 ? rootWorker : childWorker);
        uint256 claim = tree.claimableOf(claimant);
        vm.prank(claimant);
        try tree.withdraw(
            address(uint160(uint256(keccak256(abi.encode(claimant, totalWithdrawn)))))
        ) {
            totalWithdrawn += claim;
            withdrawnBy[claimant] += claim;
        } catch { }
    }
}

contract EscrowTreeInvariantTest is EscrowTreeScenario {
    EscrowTree internal tree;
    EscrowTreeHandler internal handler;

    function setUp() public {
        _setUpScenario();
        tree = _fundedTree(bytes32("invariant"));
        uint64 childId = _subcontract(
            tree,
            1,
            ROOT_WORKER_KEY,
            childWorker,
            CHILD_WORKER_KEY,
            80e6,
            uint40(block.timestamp + 2 days),
            bytes32("invariant-child")
        );
        handler = new EscrowTreeHandler(tree, buyer, rootWorker, childWorker, childId);
    }

    /// @dev This Foundry distribution does not expose `targetContract`, so drive the
    /// handler with a bounded fuzz sequence while retaining the same state-machine
    /// assertions after every generated ordering.
    function testFuzz_handlerBackedI1I13I15I16(uint256 seed) public {
        for (uint256 step; step < 16; ++step) {
            uint256 action = seed % 11;
            seed = uint256(keccak256(abi.encode(seed, step)));
            if (action == 0) handler.deliverRoot(bytes32(seed));
            else if (action == 1) handler.deliverChild(bytes32(seed));
            else if (action == 2) handler.acceptRoot();
            else if (action == 3) handler.rejectRoot();
            else if (action == 4) handler.acceptChild();
            else if (action == 5) handler.abandonChild();
            else if (action == 6) handler.expireChild(uint40(seed));
            else if (action == 7) handler.claimFinal();
            else if (action == 8) handler.abandonRoot();
            else if (action == 9) handler.expireRoot(uint40(seed));
            else handler.withdraw(uint8(seed));

            _assertI1();
            _assertI13();
            _assertI15();
            _assertI16();
        }
    }

    function _assertI1() private view {
        uint64[] memory nodes = new uint64[](2);
        nodes[0] = 1;
        nodes[1] = 2;
        address[] memory accounts = new address[](3);
        accounts[0] = buyer;
        accounts[1] = rootWorker;
        accounts[2] = childWorker;
        uint256 ledger = _ledger(tree, nodes, accounts);
        assertEq(ledger, tree.rootAmount() - handler.totalWithdrawn());
        assertTrue(usdc.balanceOf(address(tree)) >= ledger);
    }

    function _assertI13() private view {
        if (tree.rootOutcome() == EscrowTree.RootOutcome.RefundedFinal) {
            assertEq(tree.claimableOf(buyer) + handler.withdrawnBy(buyer), tree.rootAmount());
        }
    }

    function _assertI15() private view {
        if (tree.rootOutcome() == EscrowTree.RootOutcome.Unresolved) {
            assertEq(tree.claimableOf(rootWorker), 0);
            assertEq(tree.claimableOf(childWorker), 0);
        }
    }

    function _assertI16() private view {
        bytes4[5] memory forbidden = [
            bytes4(keccak256("owner()")),
            bytes4(keccak256("pause()")),
            bytes4(keccak256("upgradeTo(address)")),
            bytes4(keccak256("sweep(address,address,uint256)")),
            bytes4(keccak256("setFeeRecipient(address)"))
        ];
        for (uint256 i; i < forbidden.length; ++i) {
            (bool found,) = address(tree).staticcall(abi.encodeWithSelector(forbidden[i]));
            assertEq(found, false);
            (found,) = address(factory).staticcall(abi.encodeWithSelector(forbidden[i]));
            assertEq(found, false);
        }
    }
}
