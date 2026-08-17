// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { EscrowTree } from "../../src/EscrowTree.sol";
import { EscrowTreeFactory } from "../../src/EscrowTreeFactory.sol";
import { MockUSDC } from "./MockUSDC.sol";
import { MockIdentityRegistry } from "./MockIdentityRegistry.sol";
import { TestBase } from "./TestBase.sol";

abstract contract EscrowTreeScenario is TestBase {
    address internal constant BASE_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address internal constant BASE_SEPOLIA_USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;
    uint256 internal constant BUYER_KEY = 0xA11CE;
    uint256 internal constant ROOT_WORKER_KEY = 0xB0B;
    uint256 internal constant CHILD_WORKER_KEY = 0xC0C;
    uint256 internal constant GRANDCHILD_WORKER_KEY = 0xD0D;

    address internal buyer;
    address internal rootWorker;
    address internal childWorker;
    address internal grandchildWorker;
    address internal feeRecipient = address(0xFEE);
    MockUSDC internal usdc;
    MockIdentityRegistry internal identityRegistry;
    EscrowTreeFactory internal factory;

    function _setUpScenario() internal {
        _setUpScenarioWithFee(0);
    }

    function _setUpScenarioWithFee(uint16 feeBps_) internal {
        vm.chainId(84532);
        buyer = vm.addr(BUYER_KEY);
        rootWorker = vm.addr(ROOT_WORKER_KEY);
        childWorker = vm.addr(CHILD_WORKER_KEY);
        grandchildWorker = vm.addr(GRANDCHILD_WORKER_KEY);
        MockUSDC implementation = new MockUSDC();
        vm.etch(BASE_SEPOLIA_USDC, address(implementation).code);
        usdc = MockUSDC(BASE_SEPOLIA_USDC);
        identityRegistry = new MockIdentityRegistry();
        factory = new EscrowTreeFactory(
            address(usdc), feeBps_, feeRecipient, 1e6, address(identityRegistry)
        );
        usdc.mint(buyer, 10_000e6);
        vm.prank(buyer);
        usdc.approve(address(factory), type(uint256).max);
    }

    function _fundedTree(bytes32 salt) internal returns (EscrowTree tree) {
        return _fundedTreeWith(
            100e6, salt, rootWorker, uint40(block.timestamp + 3 days), uint32(48 hours)
        );
    }

    function _fundedTreeWith(
        uint256 amount,
        bytes32 salt,
        address worker,
        uint40 deadline,
        uint32 acceptWindow
    ) internal returns (EscrowTree tree) {
        EscrowTreeFactory.RootParams memory params =
            _rootParams(amount, salt, worker, deadline, acceptWindow);
        tree = EscrowTree(
            factory.createAndFundFrom(
                params, _fundingAuthorization(params), _rootAcceptance(params, worker)
            )
        );
    }

    function _rootParams(
        uint256 amount,
        bytes32 salt,
        address worker,
        uint40 deadline,
        uint32 acceptWindow
    ) internal view returns (EscrowTreeFactory.RootParams memory) {
        return EscrowTreeFactory.RootParams({
            buyer: buyer,
            rootWorker: worker,
            amount: amount,
            deliveryDeadline: deadline,
            acceptWindow: acceptWindow,
            termsHash: keccak256("canonical terms"),
            workerAgentId: 0,
            expiry: block.timestamp + 1 days,
            salt: salt
        });
    }

    function _fundingAuthorization(EscrowTreeFactory.RootParams memory params)
        internal
        returns (bytes memory)
    {
        bytes32 digest = factory.fundingAuthorizationDigest(params);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(BUYER_KEY, digest);
        return abi.encodePacked(r, s, v);
    }

    function _rootAcceptance(EscrowTreeFactory.RootParams memory params, address worker)
        internal
        returns (bytes memory)
    {
        uint256 key = worker == rootWorker ? ROOT_WORKER_KEY : CHILD_WORKER_KEY;
        bytes32 digest = factory.rootAcceptanceDigest(params);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _subcontract(
        EscrowTree tree,
        uint64 parentId,
        uint256 parentWorkerKey,
        address worker,
        uint256 workerKey,
        uint256 amount,
        uint40 deadline,
        bytes32 salt
    ) internal returns (uint64 nodeId) {
        EscrowTree.SubcontractParams memory params = EscrowTree.SubcontractParams({
            parentId: parentId,
            worker: worker,
            amount: amount,
            deliveryDeadline: deadline,
            acceptWindow: uint32(48 hours),
            termsHash: keccak256(abi.encodePacked("child terms", salt)),
            workerAgentId: 0,
            expiry: block.timestamp + 1 days,
            salt: salt
        });
        bytes32 digest = tree.quoteDigest(params);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(workerKey, digest);
        vm.prank(vm.addr(parentWorkerKey));
        nodeId = tree.subcontract(params, abi.encodePacked(r, s, v));
    }

    function _deliver(EscrowTree tree, uint64 nodeId, uint256 workerKey, bytes32 artifact)
        internal
    {
        vm.prank(vm.addr(workerKey));
        tree.submitDelivery(nodeId, artifact, "ipfs://artifact");
    }

    function _accept(EscrowTree tree, uint64 nodeId, uint256 hirerKey) internal {
        vm.prank(vm.addr(hirerKey));
        tree.accept(nodeId);
    }

    function _reject(EscrowTree tree, uint64 nodeId, uint256 hirerKey) internal {
        vm.prank(vm.addr(hirerKey));
        tree.reject(nodeId, keccak256("rejected"));
    }

    function _releaseRoot(EscrowTree tree) internal {
        _deliver(tree, 1, ROOT_WORKER_KEY, keccak256("root artifact"));
        vm.prank(buyer);
        tree.accept(1);
    }

    function _rejectRoot(EscrowTree tree) internal {
        _deliver(tree, 1, ROOT_WORKER_KEY, keccak256("root artifact"));
        vm.prank(buyer);
        tree.reject(1, keccak256("root rejected"));
    }

    function _ledger(EscrowTree tree, uint64[] memory nodeIds, address[] memory accounts)
        internal
        view
        returns (uint256 total)
    {
        if (tree.rootOutcome() == EscrowTree.RootOutcome.RefundedFinal) {
            for (uint256 i; i < accounts.length; ++i) {
                total += tree.claimableOf(accounts[i]);
            }
            return total;
        }
        for (uint256 i; i < nodeIds.length; ++i) {
            EscrowTree.Node memory node = tree.getNode(nodeIds[i]);
            if (
                node.state == EscrowTree.NodeState.Funded
                    || node.state == EscrowTree.NodeState.Delivered
            ) total += node.unallocated;
        }
        total += tree.totalPending();
        for (uint256 i; i < accounts.length; ++i) {
            total += tree.claimableOf(accounts[i]);
        }
        if (
            tree.getNode(1).state == EscrowTree.NodeState.Funded
                || tree.getNode(1).state == EscrowTree.NodeState.Delivered
        ) {
            total += tree.feeReserve();
        }
    }
}
