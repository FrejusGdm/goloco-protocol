// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { EscrowTree } from "../src/EscrowTree.sol";
import { EscrowTreeFactory } from "../src/EscrowTreeFactory.sol";
import { MockERC1271LongWallet } from "./support/MockERC1271LongWallet.sol";
import { MockReentrantUSDC } from "./support/MockReentrantUSDC.sol";
import { EscrowTreeScenario } from "./support/EscrowTreeScenario.sol";
import { Vm } from "./support/TestBase.sol";

contract EscrowTreeMutationRegressionsTest is EscrowTreeScenario {
    function setUp() public {
        _setUpScenario();
    }

    function test_initializeIsFactoryOnlySingleUseAndCopiesEveryEconomicTerm() public {
        EscrowTree.InitParams memory p = EscrowTree.InitParams({
            usdc: address(usdc),
            buyer: buyer,
            worker: rootWorker,
            amount: 2_000_001,
            deliveryDeadline: uint40(block.timestamp + 3 days),
            acceptWindow: uint32(48 hours),
            termsHash: bytes32("initialize-regression"),
            workerAgentId: 0,
            feeBps: 333,
            feeRecipient: feeRecipient
        });
        EscrowTree tree = new EscrowTree(address(this));
        tree.initializeFromAllowance(p);

        assertEq(tree.rootWorker(), rootWorker);
        assertEq(tree.rootAmount(), p.amount);
        assertEq(uint256(tree.feeBps()), 333);
        assertEq(tree.feeReserve(), 66_601);
        assertEq(uint256(tree.rootOutcome()), uint256(EscrowTree.RootOutcome.Unresolved));
        assertEq(tree.getNode(1).unallocated, p.amount - tree.feeReserve());

        (bool initializedTwice,) =
            address(tree).call(abi.encodeCall(EscrowTree.initializeFromAllowance, (p)));
        assertEq(initializedTwice, false);

        EscrowTree restricted = new EscrowTree(address(0xBEEF));
        (bool initializedByNonFactory,) =
            address(restricted).call(abi.encodeCall(EscrowTree.initializeFromAllowance, (p)));
        assertEq(initializedByNonFactory, false);
    }

    function test_subcontractRejectsInvalidCallerTermsAndReplayedQuote() public {
        EscrowTree tree = _fundedTree(bytes32("subcontract-guards"));
        EscrowTree.SubcontractParams memory p = _childParams(
            1,
            childWorker,
            1e6,
            uint40(block.timestamp + 2 days),
            uint32(48 hours),
            bytes32("guards")
        );
        bytes memory signature = _quoteSignature(tree, p, CHILD_WORKER_KEY);

        vm.prank(address(0xBAD));
        (bool wrongCaller,) =
            address(tree).call(abi.encodeCall(EscrowTree.subcontract, (p, signature)));
        assertEq(wrongCaller, false);

        EscrowTree.SubcontractParams memory tooSmall = _childParams(
            1,
            childWorker,
            1e6 - 1,
            uint40(block.timestamp + 2 days),
            uint32(48 hours),
            bytes32("too-small")
        );
        bytes memory tooSmallSignature = _quoteSignature(tree, tooSmall, CHILD_WORKER_KEY);
        vm.prank(rootWorker);
        (bool belowMinimum,) = address(tree)
            .call(abi.encodeCall(EscrowTree.subcontract, (tooSmall, tooSmallSignature)));
        assertEq(belowMinimum, false);

        EscrowTree.SubcontractParams memory shortWindow = _childParams(
            1,
            childWorker,
            1e6,
            uint40(block.timestamp + 2 days),
            uint32(48 hours - 1),
            bytes32("short-window-signed")
        );
        bytes memory shortWindowSignature = _quoteSignature(tree, shortWindow, CHILD_WORKER_KEY);
        vm.prank(rootWorker);
        (bool shortWindowAccepted,) = address(tree)
            .call(abi.encodeCall(EscrowTree.subcontract, (shortWindow, shortWindowSignature)));
        assertEq(shortWindowAccepted, false);

        EscrowTree.SubcontractParams memory shortDeadline = _childParams(
            1,
            childWorker,
            1e6,
            uint40(block.timestamp + 24 hours - 1),
            uint32(48 hours),
            bytes32("short-deadline-signed")
        );
        bytes memory shortDeadlineSignature = _quoteSignature(tree, shortDeadline, CHILD_WORKER_KEY);
        vm.prank(rootWorker);
        (bool shortDeadlineAccepted,) = address(tree)
            .call(abi.encodeCall(EscrowTree.subcontract, (shortDeadline, shortDeadlineSignature)));
        assertEq(shortDeadlineAccepted, false);

        vm.prank(rootWorker);
        uint64 childId = tree.subcontract(p, signature);
        assertEq(uint256(tree.getNode(childId).depth), 2);
        vm.prank(rootWorker);
        (bool replayedQuote,) =
            address(tree).call(abi.encodeCall(EscrowTree.subcontract, (p, signature)));
        assertEq(replayedQuote, false);
    }

    function test_subcontractRejectsAnyAncestorWorkerAcrossDeepChains() public {
        EscrowTree tree = _fundedTree(bytes32("ancestor-worker"));
        uint64 childId = _subcontract(
            tree,
            1,
            ROOT_WORKER_KEY,
            childWorker,
            CHILD_WORKER_KEY,
            80e6,
            uint40(block.timestamp + 2 days),
            bytes32("ancestor-child")
        );
        uint64 grandchildId = _subcontract(
            tree,
            childId,
            CHILD_WORKER_KEY,
            grandchildWorker,
            GRANDCHILD_WORKER_KEY,
            70e6,
            uint40(block.timestamp + 1 days),
            bytes32("ancestor-grandchild")
        );
        EscrowTree.SubcontractParams memory p = _childParams(
            grandchildId,
            rootWorker,
            1e6,
            uint40(block.timestamp + 1 days),
            uint32(48 hours),
            bytes32("repeat-root-worker")
        );
        bytes memory repeatedWorkerSignature = _quoteSignature(tree, p, ROOT_WORKER_KEY);
        vm.prank(grandchildWorker);
        (bool repeatedWorker,) =
            address(tree).call(abi.encodeCall(EscrowTree.subcontract, (p, repeatedWorkerSignature)));
        assertEq(repeatedWorker, false);
    }

    function test_deliveryAndDeadlineGuardsUseStoredFirstDeliveryTime() public {
        EscrowTree tree = _fundedTree(bytes32("delivery-guards"));
        vm.warp(100);
        _deliver(tree, 1, ROOT_WORKER_KEY, bytes32("first"));
        EscrowTree.Node memory delivered = tree.getNode(1);
        assertEq(uint256(delivered.firstDeliveredAt), 100);
        assertEq(uint256(delivered.deliveredAt), 100);

        EscrowTree beforeDelivery = _fundedTree(bytes32("accept-delivered-only"));
        vm.prank(buyer);
        (bool acceptsDeliveredOnly,) =
            address(beforeDelivery).call(abi.encodeCall(EscrowTree.accept, (uint64(1))));
        assertEq(acceptsDeliveredOnly, false);

        vm.warp(uint256(delivered.firstDeliveredAt) + delivered.acceptWindow);
        (bool timeoutAtBoundary,) =
            address(tree).call(abi.encodeCall(EscrowTree.claimAcceptTimeout, (uint64(1))));
        assertEq(timeoutAtBoundary, false);
        vm.warp(uint256(delivered.firstDeliveredAt) + delivered.acceptWindow + 1);
        vm.prank(buyer);
        (bool rejectAfterWindow,) = address(tree)
            .call(abi.encodeCall(EscrowTree.reject, (uint64(1), bytes32("late-reject"))));
        assertEq(rejectAfterWindow, false);
    }

    function test_claimAcceptTimeoutRejectsAnExpiredButUndeliveredNode() public {
        EscrowTree tree = _fundedTree(bytes32("timeout-needs-delivery"));
        vm.warp(uint256(tree.getNode(1).deliveryDeadline) + 1);
        (bool accepted,) =
            address(tree).call(abi.encodeCall(EscrowTree.claimAcceptTimeout, (uint64(1))));
        assertEq(accepted, false);
    }

    function test_nodeCreatedEventReportsTheStoredDepth() public {
        EscrowTree tree = _fundedTree(bytes32("node-created-depth"));
        EscrowTree.SubcontractParams memory p = _childParams(
            1,
            childWorker,
            1e6,
            uint40(block.timestamp + 2 days),
            uint32(48 hours),
            bytes32("node-created-depth-child")
        );
        bytes memory signature = _quoteSignature(tree, p, CHILD_WORKER_KEY);
        vm.recordLogs();
        vm.prank(rootWorker);
        tree.subcontract(p, signature);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 signatureHash = keccak256(
            "NodeCreated(uint64,uint64,address,address,uint256,uint8,uint40,uint32,bytes32,uint256)"
        );
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(tree) && logs[i].topics[0] == signatureHash) {
                (address hirer, uint256 amount, uint8 depth,,,,) = abi.decode(
                    logs[i].data, (address, uint256, uint8, uint40, uint32, bytes32, uint256)
                );
                assertEq(uint256(logs[i].topics[1]), 2);
                assertEq(uint256(logs[i].topics[2]), 1);
                assertEq(address(uint160(uint256(logs[i].topics[3]))), childWorker);
                assertEq(hirer, rootWorker);
                assertEq(amount, 1e6);
                assertEq(uint256(depth), 2);
                return;
            }
        }
        revert AssertionFailed();
    }

    function test_claimFinalRejectsZeroAndCannotBeReplayed() public {
        EscrowTree tree = _fundedTree(bytes32("claim-final-guards"));
        vm.prank(address(0xCAFE));
        (bool zeroClaim,) = address(tree).call(abi.encodeCall(EscrowTree.claimFinal, ()));
        assertEq(zeroClaim, false);

        uint64 childId = _subcontract(
            tree,
            1,
            ROOT_WORKER_KEY,
            childWorker,
            CHILD_WORKER_KEY,
            80e6,
            uint40(block.timestamp + 2 days),
            bytes32("claim-final-child")
        );
        _deliver(tree, childId, CHILD_WORKER_KEY, bytes32("child"));
        _accept(tree, childId, ROOT_WORKER_KEY);
        _releaseRoot(tree);
        vm.prank(childWorker);
        tree.claimFinal();
        assertEq(tree.pendingOf(childWorker), 0);
        vm.prank(childWorker);
        (bool replayed,) = address(tree).call(abi.encodeCall(EscrowTree.claimFinal, ()));
        assertEq(replayed, false);
    }

    function test_releaseAndRefundClearNodeLiabilityAndSetNodeState() public {
        EscrowTree released = _fundedTree(bytes32("release-liability"));
        _releaseRoot(released);
        EscrowTree.Node memory releasedRoot = released.getNode(1);
        assertEq(uint256(releasedRoot.state), uint256(EscrowTree.NodeState.Released));
        assertEq(releasedRoot.unallocated, 0);

        EscrowTree refunded = _fundedTree(bytes32("refund-liability"));
        _rejectRoot(refunded);
        EscrowTree.Node memory refundedRoot = refunded.getNode(1);
        assertEq(uint256(refundedRoot.state), uint256(EscrowTree.NodeState.Refunded));
        assertEq(refundedRoot.unallocated, 0);
    }

    function test_refundRoutingSkipsRefundedAncestorsAndReachesLiveRoot() public {
        EscrowTree tree = _fundedTree(bytes32("route-refunded-ancestors"));
        uint64 childId = _subcontract(
            tree,
            1,
            ROOT_WORKER_KEY,
            childWorker,
            CHILD_WORKER_KEY,
            80e6,
            uint40(block.timestamp + 2 days),
            bytes32("route-child")
        );
        uint64 grandchildId = _subcontract(
            tree,
            childId,
            CHILD_WORKER_KEY,
            grandchildWorker,
            GRANDCHILD_WORKER_KEY,
            70e6,
            uint40(block.timestamp + 1 days),
            bytes32("route-grandchild")
        );
        vm.prank(childWorker);
        tree.abandon(childId);
        vm.warp(uint256(tree.getNode(grandchildId).deliveryDeadline) + 1);
        tree.claimNonDelivery(grandchildId);

        assertEq(tree.getNode(childId).unallocated, 0);
        assertEq(tree.getNode(1).unallocated, 100e6);
    }

    function test_unknownNodeAlwaysReverts() public {
        EscrowTree tree = _fundedTree(bytes32("unknown-node"));
        (bool known,) = address(tree).staticcall(abi.encodeCall(EscrowTree.getNode, (uint64(99))));
        assertEq(known, false);
    }

    function test_treeAcceptsCanonicalLongERC1271ResponseAndNormalizedV() public {
        EscrowTree tree = _fundedTree(bytes32("long-erc1271"));
        MockERC1271LongWallet wallet = new MockERC1271LongWallet();
        EscrowTree.SubcontractParams memory p = _childParams(
            1,
            address(wallet),
            1e6,
            uint40(block.timestamp + 2 days),
            uint32(48 hours),
            bytes32("long-1271")
        );
        vm.prank(rootWorker);
        tree.subcontract(p, hex"01");

        EscrowTree signedTree = _fundedTree(bytes32("normalized-v"));
        EscrowTree.SubcontractParams memory signed = _childParams(
            1,
            childWorker,
            1e6,
            uint40(block.timestamp + 2 days),
            uint32(48 hours),
            bytes32("normalized-v-child")
        );
        bytes32 digest = signedTree.quoteDigest(signed);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(CHILD_WORKER_KEY, digest);
        vm.prank(rootWorker);
        signedTree.subcontract(signed, abi.encodePacked(r, s, v - 27));
    }

    function test_shortEcdsaSignatureNeverBecomesValid() public {
        EscrowTree tree = _fundedTree(bytes32("short-ecdsa"));
        EscrowTree.SubcontractParams memory p = _childParams(
            1,
            childWorker,
            1e6,
            uint40(block.timestamp + 2 days),
            uint32(48 hours),
            bytes32("short-ecdsa-0")
        );
        bytes memory truncated;
        for (uint256 i; i < 16; ++i) {
            p.salt = bytes32(i + 1);
            bytes32 digest = tree.quoteDigest(p);
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(CHILD_WORKER_KEY, digest);
            if (v == 27) {
                truncated = abi.encodePacked(r, s);
                break;
            }
        }
        assertTrue(truncated.length == 64);
        vm.prank(rootWorker);
        (bool accepted,) =
            address(tree).call(abi.encodeCall(EscrowTree.subcontract, (p, truncated)));
        assertEq(accepted, false);
    }

    function test_withdrawRejectsTokenReentry() public {
        EscrowTreeFactory reentrantFactory = new EscrowTreeFactory(
            address(usdc), 1, address(usdc), 1e6, address(identityRegistry)
        );
        vm.prank(buyer);
        usdc.approve(address(reentrantFactory), type(uint256).max);
        EscrowTreeFactory.RootParams memory p = EscrowTreeFactory.RootParams({
            buyer: buyer,
            rootWorker: rootWorker,
            amount: 2_000_001,
            deliveryDeadline: uint40(block.timestamp + 3 days),
            acceptWindow: uint32(48 hours),
            termsHash: bytes32("reentrancy"),
            workerAgentId: 0,
            expiry: block.timestamp + 1 days,
            salt: bytes32("reentrancy")
        });
        bytes32 fundingDigest = reentrantFactory.fundingAuthorizationDigest(p);
        bytes32 acceptanceDigest = reentrantFactory.rootAcceptanceDigest(p);
        (uint8 fv, bytes32 fr, bytes32 fs) = vm.sign(BUYER_KEY, fundingDigest);
        (uint8 av, bytes32 ar, bytes32 as_) = vm.sign(ROOT_WORKER_KEY, acceptanceDigest);
        EscrowTree tree = EscrowTree(
            reentrantFactory.createAndFundFrom(
                p, abi.encodePacked(fr, fs, fv), abi.encodePacked(ar, as_, av)
            )
        );
        _deliver(tree, 1, ROOT_WORKER_KEY, bytes32("reentrancy-delivery"));
        _accept(tree, 1, BUYER_KEY);

        MockReentrantUSDC replacement = new MockReentrantUSDC();
        vm.etch(address(usdc), address(replacement).code);
        MockReentrantUSDC reentrantToken = MockReentrantUSDC(address(usdc));
        reentrantToken.setReentry(address(tree), address(0xA11CE));
        vm.prank(rootWorker);
        tree.withdraw(address(0xB0B));

        assertEq(reentrantToken.reentryAttempted(), true);
        assertEq(reentrantToken.reentrySucceeded(), false);
        assertEq(tree.claimableOf(address(usdc)), 201);
    }

    function test_factoryPersistsMinimumNodeAmountAndEnforcesItInEveryTree() public {
        EscrowTreeFactory strictFactory =
            new EscrowTreeFactory(address(usdc), 0, feeRecipient, 2e6, address(identityRegistry));
        assertEq(strictFactory.MIN_NODE_AMOUNT(), 2e6);
        vm.prank(buyer);
        usdc.approve(address(strictFactory), type(uint256).max);
        EscrowTreeFactory.RootParams memory root = _rootParams(
            100e6,
            bytes32("strict-minimum"),
            rootWorker,
            uint40(block.timestamp + 3 days),
            uint32(48 hours)
        );
        EscrowTree tree = EscrowTree(
            strictFactory.createAndFundFrom(
                root,
                _fundingAuthorizationFor(strictFactory, root),
                _rootAcceptanceFor(strictFactory, root)
            )
        );
        EscrowTree.SubcontractParams memory p = _childParams(
            1,
            childWorker,
            1e6,
            uint40(block.timestamp + 2 days),
            uint32(48 hours),
            bytes32("strict-minimum-child")
        );
        bytes memory signature = _quoteSignature(tree, p, CHILD_WORKER_KEY);
        vm.prank(rootWorker);
        (bool accepted,) =
            address(tree).call(abi.encodeCall(EscrowTree.subcontract, (p, signature)));
        assertEq(accepted, false);
    }

    function test_factoryEIP3009FlowValidatesBeforeFundingAndInitializesTheClone() public {
        vm.warp(100);
        EscrowTreeFactory.RootParams memory tooSoon = _rootParams(
            100e6,
            bytes32("eip3009-short-deadline"),
            rootWorker,
            uint40(block.timestamp + 24 hours - 1),
            uint32(48 hours)
        );
        (bool invalidParams,) = address(factory)
            .call(
                abi.encodeCall(
                    EscrowTreeFactory.createAndFund,
                    (tooSoon, _eip3009Auth(factory, tooSoon), _rootAcceptanceFor(factory, tooSoon))
                )
            );
        assertEq(invalidParams, false);

        EscrowTreeFactory.RootParams memory wrongNonce = _rootParams(
            100e6,
            bytes32("eip3009-wrong-nonce"),
            rootWorker,
            uint40(block.timestamp + 3 days),
            uint32(48 hours)
        );
        EscrowTreeFactory.EIP3009Auth memory forgedNonce =
            _eip3009AuthForNonce(factory, wrongNonce, bytes32("not-derived"));
        (bool nonceAccepted,) = address(factory)
            .call(
                abi.encodeCall(
                    EscrowTreeFactory.createAndFund,
                    (wrongNonce, forgedNonce, _rootAcceptanceFor(factory, wrongNonce))
                )
            );
        assertEq(nonceAccepted, false);

        EscrowTreeFactory.RootParams memory missingAcceptance = _rootParams(
            100e6,
            bytes32("eip3009-missing-acceptance"),
            rootWorker,
            uint40(block.timestamp + 3 days),
            uint32(48 hours)
        );
        (bool missingAccepted,) = address(factory)
            .call(
                abi.encodeCall(
                    EscrowTreeFactory.createAndFund,
                    (missingAcceptance, _eip3009Auth(factory, missingAcceptance), bytes(""))
                )
            );
        assertEq(missingAccepted, false);

        EscrowTreeFactory.RootParams memory valid = _rootParams(
            100e6,
            bytes32("eip3009-initialized"),
            rootWorker,
            uint40(block.timestamp + 3 days),
            uint32(48 hours)
        );
        EscrowTree tree = EscrowTree(
            factory.createAndFund(
                valid, _eip3009Auth(factory, valid), _rootAcceptanceFor(factory, valid)
            )
        );
        assertEq(tree.getNode(1).worker, rootWorker);
        assertEq(usdc.balanceOf(address(tree)), valid.amount);
    }

    function test_factoryRecordsEachAuthorizationConsumption() public {
        EscrowTreeFactory.RootParams memory p = _rootParams(
            100e6,
            bytes32("factory-consumption"),
            rootWorker,
            uint40(block.timestamp + 3 days),
            uint32(48 hours)
        );
        bytes32 fundingDigest = factory.fundingAuthorizationDigest(p);
        bytes32 acceptanceDigest = factory.rootAcceptanceDigest(p);
        factory.createAndFundFrom(
            p, _fundingAuthorizationFor(factory, p), _rootAcceptanceFor(factory, p)
        );
        assertEq(factory.consumedFundingAuth(fundingDigest), true);
        assertEq(factory.consumedRootAcceptance(acceptanceDigest), true);
    }

    function test_factoryUsesTheMinimumDeadlineAndBothSignatureEncodings() public {
        vm.warp(100);
        EscrowTreeFactory.RootParams memory tooSoon = _rootParams(
            100e6,
            bytes32("factory-short-deadline"),
            rootWorker,
            uint40(block.timestamp + 24 hours - 1),
            uint32(48 hours)
        );
        (bool deadlineAccepted,) = address(factory)
            .call(
                abi.encodeCall(
                    EscrowTreeFactory.createAndFundFrom,
                    (
                        tooSoon,
                        _fundingAuthorizationFor(factory, tooSoon),
                        _rootAcceptanceFor(factory, tooSoon)
                    )
                )
            );
        assertEq(deadlineAccepted, false);

        EscrowTreeFactory.RootParams memory normalized = _rootParams(
            100e6,
            bytes32("factory-normalized-v"),
            rootWorker,
            uint40(block.timestamp + 3 days),
            uint32(48 hours)
        );
        (uint8 fv, bytes32 fr, bytes32 fs) =
            vm.sign(BUYER_KEY, factory.fundingAuthorizationDigest(normalized));
        (uint8 av, bytes32 ar, bytes32 as_) =
            vm.sign(ROOT_WORKER_KEY, factory.rootAcceptanceDigest(normalized));
        factory.createAndFundFrom(
            normalized, abi.encodePacked(fr, fs, fv - 27), abi.encodePacked(ar, as_, av - 27)
        );

        MockERC1271LongWallet longWallet = new MockERC1271LongWallet();
        EscrowTreeFactory.RootParams memory longResponse = _rootParams(
            100e6,
            bytes32("factory-long-1271"),
            address(longWallet),
            uint40(block.timestamp + 3 days),
            uint32(48 hours)
        );
        factory.createAndFundFrom(
            longResponse, _fundingAuthorizationFor(factory, longResponse), hex"01"
        );
    }

    function test_factoryRejectsA64ByteFundingSignature() public {
        EscrowTreeFactory.RootParams memory p;
        bytes memory truncated;
        for (uint256 i; i < 16; ++i) {
            p = _rootParams(
                100e6,
                bytes32(i + 1),
                rootWorker,
                uint40(block.timestamp + 3 days),
                uint32(48 hours)
            );
            bytes32 digest = factory.fundingAuthorizationDigest(p);
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(BUYER_KEY, digest);
            if (v == 27) {
                truncated = abi.encodePacked(r, s);
                break;
            }
        }
        assertTrue(truncated.length == 64);
        (bool accepted,) = address(factory)
            .call(
                abi.encodeCall(
                    EscrowTreeFactory.createAndFundFrom,
                    (p, truncated, _rootAcceptanceFor(factory, p))
                )
            );
        assertEq(accepted, false);
    }

    function _childParams(
        uint64 parentId,
        address worker,
        uint256 amount,
        uint40 deadline,
        uint32 acceptWindow,
        bytes32 salt
    ) private view returns (EscrowTree.SubcontractParams memory) {
        return EscrowTree.SubcontractParams({
            parentId: parentId,
            worker: worker,
            amount: amount,
            deliveryDeadline: deadline,
            acceptWindow: acceptWindow,
            termsHash: bytes32("mutation-regression"),
            workerAgentId: 0,
            expiry: block.timestamp + 1 days,
            salt: salt
        });
    }

    function _quoteSignature(EscrowTree tree, EscrowTree.SubcontractParams memory p, uint256 key)
        private
        returns (bytes memory)
    {
        bytes32 digest = tree.quoteDigest(p);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _fundingAuthorizationFor(
        EscrowTreeFactory target,
        EscrowTreeFactory.RootParams memory p
    ) private returns (bytes memory) {
        bytes32 digest = target.fundingAuthorizationDigest(p);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(BUYER_KEY, digest);
        return abi.encodePacked(r, s, v);
    }

    function _rootAcceptanceFor(EscrowTreeFactory target, EscrowTreeFactory.RootParams memory p)
        private
        returns (bytes memory)
    {
        bytes32 digest = target.rootAcceptanceDigest(p);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ROOT_WORKER_KEY, digest);
        return abi.encodePacked(r, s, v);
    }

    function _eip3009Auth(EscrowTreeFactory target, EscrowTreeFactory.RootParams memory p)
        private
        returns (EscrowTreeFactory.EIP3009Auth memory)
    {
        return _eip3009AuthForNonce(target, p, target.authorizationNonce(p));
    }

    function _eip3009AuthForNonce(
        EscrowTreeFactory target,
        EscrowTreeFactory.RootParams memory p,
        bytes32 nonce
    ) private returns (EscrowTreeFactory.EIP3009Auth memory auth) {
        uint256 validBefore = block.timestamp + 1 days;
        bytes32 digest = usdc.authorizationDigest(
            buyer, target.predictTreeAddress(p), p.amount, 0, validBefore, nonce
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(BUYER_KEY, digest);
        return EscrowTreeFactory.EIP3009Auth({
            validAfter: 0, validBefore: validBefore, nonce: nonce, v: v, r: r, s: s
        });
    }
}
