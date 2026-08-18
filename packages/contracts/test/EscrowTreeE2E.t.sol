// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { EscrowTree } from "../src/EscrowTree.sol";
import { EscrowTreeFactory } from "../src/EscrowTreeFactory.sol";
import { MockIdentityRegistry } from "./support/MockIdentityRegistry.sol";
import { TestBase } from "./support/TestBase.sol";

interface ICircleUSDC {
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 value) external returns (bool);
    function transfer(address recipient, uint256 amount) external returns (bool);
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

/// @notice Real-Circle-USDC fork proof pinned to the audited contract revision.
/// @dev Set BASE_SEPOLIA_RPC to run this suite at the hard-coded finalized block.
///      It deliberately never imports EscrowTreeScenario or invokes vm.etch/mint.
contract EscrowTreeE2ETest is TestBase {
    bytes32 private constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    address private constant BASE_SEPOLIA_USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;
    uint256 private constant BASE_SEPOLIA_CHAIN_ID = 84532;
    uint256 private constant PINNED_BASE_SEPOLIA_BLOCK = 45_552_959;
    /// @dev USDC holder verified at PINNED_BASE_SEPOLIA_BLOCK; used only on the local fork.
    address private constant FORK_USDC_HOLDER = 0x572bf0fC198f0482bf55a789CEdDfF4f3b61F76B;
    uint256 private constant BUYER_KEY = 0xA11CE;
    uint256 private constant ROOT_WORKER_KEY = 0xB0B;
    uint256 private constant CHILD_WORKER_KEY = 0xC0C;
    uint256 private constant GRANDCHILD_WORKER_KEY = 0xD0D;
    address private constant RELAYER = address(0xA11CE0);
    address private constant OUTSIDER = address(0xBADC0DE);
    uint256 private constant ROOT_AMOUNT = 100e6;
    uint256 private constant CHILD_AMOUNT = 80e6;
    uint256 private constant GRANDCHILD_AMOUNT = 70e6;

    bool private forkConfigured;
    address private buyer;
    address private rootWorker;
    address private childWorker;
    address private grandchildWorker;
    address private feeRecipient;
    ICircleUSDC private usdc;
    MockIdentityRegistry private identityRegistry;
    EscrowTreeFactory private factory;

    function setUp() public {
        string memory rpcUrl = vm.envOr("BASE_SEPOLIA_RPC", string(""));
        if (bytes(rpcUrl).length == 0) return;

        vm.createSelectFork(rpcUrl, PINNED_BASE_SEPOLIA_BLOCK);
        assertEq(block.chainid, BASE_SEPOLIA_CHAIN_ID);
        assertEq(block.number, PINNED_BASE_SEPOLIA_BLOCK);
        assertTrue(BASE_SEPOLIA_USDC.code.length != 0);

        forkConfigured = true;
        buyer = vm.addr(BUYER_KEY);
        rootWorker = vm.addr(ROOT_WORKER_KEY);
        childWorker = vm.addr(CHILD_WORKER_KEY);
        grandchildWorker = vm.addr(GRANDCHILD_WORKER_KEY);
        feeRecipient = address(0xFEE);
        usdc = ICircleUSDC(BASE_SEPOLIA_USDC);
        identityRegistry = new MockIdentityRegistry();
    }

    modifier whenForkConfigured() {
        if (!forkConfigured) return;
        _;
    }

    function test_realEip3009FundingIsRelayableAndSingleUse() public whenForkConfigured {
        _deployFactory(0);
        _fundBuyer(1_000e6);
        EscrowTreeFactory.RootParams memory p = _rootParams(bytes32("e2e-eip3009"));
        EscrowTreeFactory.EIP3009Auth memory auth = _eip3009Authorization(p);
        bytes memory acceptance = _rootAcceptance(p);
        address predicted = factory.predictTreeAddress(p);
        assertTrue(usdc.DOMAIN_SEPARATOR() != bytes32(0));

        EscrowTreeFactory.EIP3009Auth memory invalid = EscrowTreeFactory.EIP3009Auth({
            validAfter: auth.validAfter,
            validBefore: auth.validBefore,
            nonce: auth.nonce,
            v: auth.v,
            r: bytes32(0),
            s: auth.s
        });
        vm.prank(RELAYER);
        (bool unauthorizedFunding,) = address(factory)
            .call(abi.encodeCall(EscrowTreeFactory.createAndFund, (p, invalid, acceptance)));
        assertEq(unauthorizedFunding, false);

        vm.prank(RELAYER);
        address created = factory.createAndFund(p, auth, acceptance);
        assertEq(created, predicted);
        EscrowTree tree = EscrowTree(created);
        _assertLedger(tree, _nodes(1), _accounts(), ROOT_AMOUNT);
        assertEq(usdc.balanceOf(created), ROOT_AMOUNT);

        EscrowTreeFactory alternateFactory = _newFactory(0);
        bytes memory alternateAcceptance = _rootAcceptanceFor(alternateFactory, p);
        address alternatePredicted = alternateFactory.predictTreeAddress(p);
        assertTrue(alternatePredicted != predicted);
        uint256 buyerBalanceBeforeReplay = usdc.balanceOf(buyer);
        vm.prank(RELAYER);
        (bool replayed,) = address(alternateFactory)
            .call(abi.encodeCall(EscrowTreeFactory.createAndFund, (p, auth, alternateAcceptance)));
        assertEq(replayed, false);
        assertEq(alternatePredicted.code.length, 0);
        assertEq(usdc.balanceOf(buyer), buyerBalanceBeforeReplay);
    }

    function test_realAllowanceFundingUsesSameInitialLedger() public whenForkConfigured {
        _deployFactory(0);
        _fundBuyer(1_000e6);
        EscrowTreeFactory.RootParams memory p = _rootParams(bytes32("e2e-allowance"));
        bytes memory fundingAuthorization = _fundingAuthorization(p);
        bytes memory acceptance = _rootAcceptance(p);
        vm.prank(buyer);
        assertEq(usdc.approve(address(factory), ROOT_AMOUNT), true);
        vm.prank(RELAYER);
        EscrowTree tree = EscrowTree(factory.createAndFundFrom(p, fundingAuthorization, acceptance));
        _assertLedger(tree, _nodes(1), _accounts(), ROOT_AMOUNT);
        assertEq(usdc.balanceOf(address(tree)), ROOT_AMOUNT);

        EscrowTreeFactory.RootParams memory altered = _rootParams(bytes32("e2e-allowance-altered"));
        bytes memory alteredAcceptance = _rootAcceptance(altered);
        address alteredPredicted = factory.predictTreeAddress(altered);
        uint256 buyerBalanceBeforeReplay = usdc.balanceOf(buyer);
        vm.prank(RELAYER);
        (bool replayed,) = address(factory)
            .call(
                abi.encodeCall(
                    EscrowTreeFactory.createAndFundFrom,
                    (altered, fundingAuthorization, alteredAcceptance)
                )
            );
        assertEq(replayed, false);
        assertEq(alteredPredicted.code.length, 0);
        assertEq(usdc.balanceOf(buyer), buyerBalanceBeforeReplay);
    }

    function test_happyPathConservesAndWithdrawsRealUsdc() public whenForkConfigured {
        EscrowTree tree = _fundFromAllowance(bytes32("e2e-happy"), 0);
        _subcontract(
            tree, 1, ROOT_WORKER_KEY, childWorker, CHILD_WORKER_KEY, CHILD_AMOUNT, bytes32("child")
        );
        _assertLedger(tree, _nodes(2), _accounts(), ROOT_AMOUNT);

        _deliver(tree, 2, CHILD_WORKER_KEY);
        _assertLedger(tree, _nodes(2), _accounts(), ROOT_AMOUNT);
        _accept(tree, 2, ROOT_WORKER_KEY);
        assertEq(tree.pendingOf(childWorker), CHILD_AMOUNT);
        _assertLedger(tree, _nodes(2), _accounts(), ROOT_AMOUNT);

        _deliver(tree, 1, ROOT_WORKER_KEY);
        _assertLedger(tree, _nodes(2), _accounts(), ROOT_AMOUNT);
        _accept(tree, 1, BUYER_KEY);
        assertEq(tree.claimableOf(rootWorker), ROOT_AMOUNT - CHILD_AMOUNT);
        _assertLedger(tree, _nodes(2), _accounts(), ROOT_AMOUNT);

        vm.prank(childWorker);
        tree.claimFinal();
        assertEq(tree.totalPending(), 0);
        assertEq(tree.claimableOf(childWorker), CHILD_AMOUNT);
        _assertLedger(tree, _nodes(2), _accounts(), ROOT_AMOUNT);

        uint256 rootBefore = usdc.balanceOf(rootWorker);
        uint256 childBefore = usdc.balanceOf(childWorker);
        vm.prank(rootWorker);
        tree.withdraw(rootWorker);
        vm.prank(childWorker);
        tree.withdraw(childWorker);
        assertEq(usdc.balanceOf(rootWorker), rootBefore + ROOT_AMOUNT - CHILD_AMOUNT);
        assertEq(usdc.balanceOf(childWorker), childBefore + CHILD_AMOUNT);
        _assertLedger(tree, _nodes(2), _accounts(), 0);
        assertEq(usdc.balanceOf(address(tree)), 0);
    }

    function test_rejectRefundRestoresBuyerAndFreezesTree() public whenForkConfigured {
        EscrowTree tree = _treeWithAcceptedChild(bytes32("e2e-reject"));
        _deliver(tree, 1, ROOT_WORKER_KEY);
        uint256 buyerBeforeWithdrawal = usdc.balanceOf(buyer);
        vm.prank(buyer);
        tree.reject(1, keccak256("reject"));

        assertEq(uint256(tree.rootOutcome()), uint256(EscrowTree.RootOutcome.RefundedFinal));
        assertEq(tree.claimableOf(buyer), ROOT_AMOUNT);
        _assertLedger(tree, _nodes(2), _accounts(), ROOT_AMOUNT);
        _assertRefundedFinalGuard(tree);

        vm.prank(buyer);
        tree.withdraw(buyer);
        assertEq(usdc.balanceOf(buyer), buyerBeforeWithdrawal + ROOT_AMOUNT);
        assertEq(tree.claimableOf(childWorker), 0);
        _assertLedger(tree, _nodes(2), _accounts(), 0);
    }

    function test_abandonRefundExcludesLiveChildFromLedger() public whenForkConfigured {
        EscrowTree tree = _fundFromAllowance(bytes32("e2e-abandon"), 0);
        _subcontract(
            tree,
            1,
            ROOT_WORKER_KEY,
            childWorker,
            CHILD_WORKER_KEY,
            CHILD_AMOUNT,
            bytes32("live-child")
        );
        uint256 buyerBeforeWithdrawal = usdc.balanceOf(buyer);
        vm.prank(rootWorker);
        tree.abandon(1);

        assertEq(uint256(tree.rootOutcome()), uint256(EscrowTree.RootOutcome.RefundedFinal));
        assertEq(tree.claimableOf(buyer), ROOT_AMOUNT);
        _assertLedger(tree, _nodes(2), _accounts(), ROOT_AMOUNT);
        _assertRefundedFinalNodeActionReverts(tree, 1, ROOT_WORKER_KEY);
        vm.prank(buyer);
        tree.withdraw(buyer);
        assertEq(usdc.balanceOf(buyer), buyerBeforeWithdrawal + ROOT_AMOUNT);
        _assertLedger(tree, _nodes(2), _accounts(), 0);
    }

    function test_claimNonDeliveryIsPermissionlessAndRefundsBuyer() public whenForkConfigured {
        EscrowTree tree = _fundFromAllowance(bytes32("e2e-non-delivery"), 0);
        (bool beforeDeadline,) =
            address(tree).call(abi.encodeCall(EscrowTree.claimNonDelivery, (uint64(1))));
        assertEq(beforeDeadline, false);

        EscrowTree.Node memory root = tree.getNode(1);
        vm.warp(uint256(root.deliveryDeadline) + 1);
        vm.prank(OUTSIDER);
        tree.claimNonDelivery(1);
        assertEq(uint256(tree.rootOutcome()), uint256(EscrowTree.RootOutcome.RefundedFinal));
        assertEq(tree.claimableOf(buyer), ROOT_AMOUNT);
        _assertLedger(tree, _nodes(1), _accounts(), ROOT_AMOUNT);
        _assertRefundedFinalNodeActionReverts(tree, 1, ROOT_WORKER_KEY);
        uint256 buyerBeforeWithdrawal = usdc.balanceOf(buyer);
        vm.prank(buyer);
        tree.withdraw(buyer);
        assertEq(usdc.balanceOf(buyer), buyerBeforeWithdrawal + ROOT_AMOUNT);
        _assertLedger(tree, _nodes(1), _accounts(), 0);
    }

    function test_claimAcceptTimeoutIsPermissionlessAndReleasesWorker() public whenForkConfigured {
        EscrowTree tree = _fundFromAllowance(bytes32("e2e-accept-timeout"), 0);
        _deliver(tree, 1, ROOT_WORKER_KEY);
        EscrowTree.Node memory root = tree.getNode(1);
        vm.warp(uint256(root.firstDeliveredAt) + root.acceptWindow + 1);
        vm.prank(OUTSIDER);
        tree.claimAcceptTimeout(1);
        assertEq(tree.claimableOf(rootWorker), ROOT_AMOUNT);
        _assertLedger(tree, _nodes(1), _accounts(), ROOT_AMOUNT);
        uint256 workerBeforeWithdrawal = usdc.balanceOf(rootWorker);
        vm.prank(rootWorker);
        tree.withdraw(rootWorker);
        assertEq(usdc.balanceOf(rootWorker), workerBeforeWithdrawal + ROOT_AMOUNT);
        _assertLedger(tree, _nodes(1), _accounts(), 0);
    }

    function test_surplusIsStuckOnBothTerminalPaths() public whenForkConfigured {
        EscrowTree released = _fundFromAllowance(bytes32("e2e-surplus-release"), 0);
        _transferFromForkHolder(address(released), 7e6);
        assertEq(usdc.balanceOf(address(released)), ROOT_AMOUNT + 7e6);
        _deliver(released, 1, ROOT_WORKER_KEY);
        _accept(released, 1, BUYER_KEY);
        vm.prank(rootWorker);
        released.withdraw(rootWorker);
        assertEq(usdc.balanceOf(address(released)), 7e6);
        _assertLedger(released, _nodes(1), _accounts(), 0);

        EscrowTree refunded = _fundFromAllowance(bytes32("e2e-surplus-refund"), 0);
        _transferFromForkHolder(address(refunded), 7e6);
        _deliver(refunded, 1, ROOT_WORKER_KEY);
        _reject(refunded, 1, BUYER_KEY);
        assertEq(refunded.claimableOf(buyer), ROOT_AMOUNT);
        _assertLedger(refunded, _nodes(1), _accounts(), ROOT_AMOUNT);
        vm.prank(buyer);
        refunded.withdraw(buyer);
        assertEq(usdc.balanceOf(address(refunded)), 7e6);
    }

    function test_releasedAncestorRefundRoutesToPending() public whenForkConfigured {
        EscrowTree tree = _fundFromAllowance(bytes32("e2e-released-ancestor"), 0);
        _subcontract(
            tree, 1, ROOT_WORKER_KEY, childWorker, CHILD_WORKER_KEY, CHILD_AMOUNT, bytes32("child")
        );
        _subcontract(
            tree,
            2,
            CHILD_WORKER_KEY,
            grandchildWorker,
            GRANDCHILD_WORKER_KEY,
            GRANDCHILD_AMOUNT,
            bytes32("grandchild")
        );
        _deliver(tree, 2, CHILD_WORKER_KEY);
        _accept(tree, 2, ROOT_WORKER_KEY);
        vm.warp(uint256(tree.getNode(3).deliveryDeadline) + 1);
        tree.claimNonDelivery(3);

        assertEq(tree.pendingOf(childWorker), CHILD_AMOUNT);
        assertEq(tree.claimableOf(childWorker), 0);
        vm.prank(childWorker);
        (bool earlyWithdrawal,) =
            address(tree).call(abi.encodeCall(EscrowTree.withdraw, (childWorker)));
        assertEq(earlyWithdrawal, false);
        _assertLedger(tree, _nodes(3), _accounts(), ROOT_AMOUNT);
    }

    function test_m107CurrentUnallocatedRoutesOnReleasedTerminal() public whenForkConfigured {
        EscrowTree tree = _m107PreState(bytes32("e2e-m107-release"));
        _deliver(tree, 1, ROOT_WORKER_KEY);
        _accept(tree, 1, BUYER_KEY);
        vm.prank(grandchildWorker);
        tree.claimFinal();

        assertEq(tree.claimableOf(rootWorker), 30e6);
        assertEq(tree.claimableOf(grandchildWorker), GRANDCHILD_AMOUNT);
        _assertLedger(tree, _nodes(3), _accounts(), ROOT_AMOUNT);
        vm.prank(rootWorker);
        tree.withdraw(rootWorker);
        vm.prank(grandchildWorker);
        tree.withdraw(grandchildWorker);
        _assertLedger(tree, _nodes(3), _accounts(), 0);
    }

    function test_m107CurrentUnallocatedRoutesOnRefundedTerminal() public whenForkConfigured {
        EscrowTree tree = _m107PreState(bytes32("e2e-m107-refund"));
        _deliver(tree, 1, ROOT_WORKER_KEY);
        _reject(tree, 1, BUYER_KEY);

        assertEq(tree.claimableOf(buyer), ROOT_AMOUNT);
        assertEq(tree.pendingOf(grandchildWorker), GRANDCHILD_AMOUNT);
        _assertLedger(tree, _nodes(3), _accounts(), ROOT_AMOUNT);
        vm.prank(grandchildWorker);
        (bool claimFinalAfterRefund,) =
            address(tree).call(abi.encodeCall(EscrowTree.claimFinal, ()));
        assertEq(claimFinalAfterRefund, false);
        vm.prank(buyer);
        tree.withdraw(buyer);
        _assertLedger(tree, _nodes(3), _accounts(), 0);
    }

    function test_feePassUsesCeilingReserveAndReturnsGrossOnRefund() public whenForkConfigured {
        EscrowTree released = _fundFromAllowance(bytes32("e2e-fee-release"), 250);
        uint256 expectedFee = 2_500_000;
        assertEq(released.feeReserve(), expectedFee);
        _subcontract(
            released,
            1,
            ROOT_WORKER_KEY,
            childWorker,
            CHILD_WORKER_KEY,
            CHILD_AMOUNT,
            bytes32("fee-child")
        );
        _deliver(released, 2, CHILD_WORKER_KEY);
        _accept(released, 2, ROOT_WORKER_KEY);
        _deliver(released, 1, ROOT_WORKER_KEY);
        _accept(released, 1, BUYER_KEY);
        assertEq(released.claimableOf(rootWorker), ROOT_AMOUNT - CHILD_AMOUNT - expectedFee);
        assertEq(released.claimableOf(feeRecipient), expectedFee);
        vm.prank(childWorker);
        released.claimFinal();
        assertEq(released.claimableOf(childWorker), CHILD_AMOUNT);
        _assertLedger(released, _nodes(2), _accounts(), ROOT_AMOUNT);

        EscrowTree refunded = _fundFromAllowance(bytes32("e2e-fee-refund"), 250);
        _subcontract(
            refunded,
            1,
            ROOT_WORKER_KEY,
            childWorker,
            CHILD_WORKER_KEY,
            CHILD_AMOUNT,
            bytes32("fee-child-refund")
        );
        _deliver(refunded, 2, CHILD_WORKER_KEY);
        _accept(refunded, 2, ROOT_WORKER_KEY);
        _deliver(refunded, 1, ROOT_WORKER_KEY);
        _reject(refunded, 1, BUYER_KEY);
        assertEq(refunded.claimableOf(buyer), ROOT_AMOUNT);
        assertEq(refunded.claimableOf(feeRecipient), 0);
        assertEq(refunded.pendingOf(childWorker), CHILD_AMOUNT);
        _assertLedger(refunded, _nodes(2), _accounts(), ROOT_AMOUNT);
    }

    function test_noAdministrativeSelectorMovesFunds() public whenForkConfigured {
        EscrowTree tree = _fundFromAllowance(bytes32("e2e-selector-sweep"), 0);
        bytes4[6] memory selectors = [
            bytes4(keccak256("owner()")),
            bytes4(keccak256("admin()")),
            bytes4(keccak256("pause()")),
            bytes4(keccak256("sweep(address,address,uint256)")),
            bytes4(keccak256("upgradeToAndCall(address,bytes)")),
            bytes4(keccak256("selfdestruct(address)"))
        ];
        for (uint256 i; i < selectors.length; ++i) {
            (bool ok,) = address(tree).call(abi.encodeWithSelector(selectors[i]));
            assertEq(ok, false);
        }
        assertEq(usdc.balanceOf(address(tree)), ROOT_AMOUNT);
    }

    function _deployFactory(uint16 feeBps) private {
        factory = _newFactory(feeBps);
    }

    function _newFactory(uint16 feeBps) private returns (EscrowTreeFactory) {
        return new EscrowTreeFactory(
            BASE_SEPOLIA_USDC,
            feeBps,
            feeBps == 0 ? address(0) : feeRecipient,
            1e6,
            address(identityRegistry)
        );
    }

    function _fundBuyer(uint256 amount) private {
        uint256 balanceBefore = usdc.balanceOf(buyer);
        _transferFromForkHolder(buyer, amount);
        assertEq(usdc.balanceOf(buyer), balanceBefore + amount);
    }

    function _transferFromForkHolder(address recipient, uint256 amount) private {
        vm.prank(FORK_USDC_HOLDER);
        assertEq(usdc.transfer(recipient, amount), true);
    }

    function _fundFromAllowance(bytes32 salt, uint16 feeBps) private returns (EscrowTree tree) {
        _deployFactory(feeBps);
        _fundBuyer(1_000e6);
        EscrowTreeFactory.RootParams memory p = _rootParams(salt);
        vm.prank(buyer);
        assertEq(usdc.approve(address(factory), ROOT_AMOUNT), true);
        vm.prank(RELAYER);
        tree = EscrowTree(
            factory.createAndFundFrom(p, _fundingAuthorization(p), _rootAcceptance(p))
        );
    }

    function _rootParams(bytes32 salt) private view returns (EscrowTreeFactory.RootParams memory) {
        return EscrowTreeFactory.RootParams({
            buyer: buyer,
            rootWorker: rootWorker,
            amount: ROOT_AMOUNT,
            deliveryDeadline: uint40(block.timestamp + 3 days),
            acceptWindow: uint32(48 hours),
            termsHash: keccak256("e2e terms"),
            workerAgentId: 0,
            expiry: block.timestamp + 1 days,
            salt: salt
        });
    }

    function _fundingAuthorization(EscrowTreeFactory.RootParams memory p)
        private
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(BUYER_KEY, factory.fundingAuthorizationDigest(p));
        return abi.encodePacked(r, s, v);
    }

    function _rootAcceptance(EscrowTreeFactory.RootParams memory p) private returns (bytes memory) {
        return _rootAcceptanceFor(factory, p);
    }

    function _rootAcceptanceFor(
        EscrowTreeFactory targetFactory,
        EscrowTreeFactory.RootParams memory p
    ) private returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            ROOT_WORKER_KEY, targetFactory.rootAcceptanceDigest(p)
        );
        return abi.encodePacked(r, s, v);
    }

    function _eip3009Authorization(EscrowTreeFactory.RootParams memory p)
        private
        returns (EscrowTreeFactory.EIP3009Auth memory auth)
    {
        uint256 validAfter = block.timestamp - 1;
        uint256 validBefore = block.timestamp + 1 days;
        bytes32 nonce = factory.authorizationNonce(p);
        bytes32 structHash = keccak256(
            abi.encode(
                RECEIVE_WITH_AUTHORIZATION_TYPEHASH,
                buyer,
                factory.predictTreeAddress(p),
                p.amount,
                validAfter,
                validBefore,
                nonce
            )
        );
        bytes32 digest =
            keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(BUYER_KEY, digest);
        return EscrowTreeFactory.EIP3009Auth({
            validAfter: validAfter, validBefore: validBefore, nonce: nonce, v: v, r: r, s: s
        });
    }

    function _subcontract(
        EscrowTree tree,
        uint64 parentId,
        uint256 parentKey,
        address worker,
        uint256 workerKey,
        uint256 amount,
        bytes32 salt
    ) private {
        EscrowTree.SubcontractParams memory p = EscrowTree.SubcontractParams({
            parentId: parentId,
            worker: worker,
            amount: amount,
            deliveryDeadline: uint40(block.timestamp + 2 days),
            acceptWindow: uint32(48 hours),
            termsHash: keccak256(abi.encodePacked("e2e child terms", salt)),
            workerAgentId: 0,
            expiry: block.timestamp + 1 days,
            salt: salt
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(workerKey, tree.quoteDigest(p));
        vm.prank(vm.addr(parentKey));
        tree.subcontract(p, abi.encodePacked(r, s, v));
    }

    function _deliver(EscrowTree tree, uint64 nodeId, uint256 workerKey) private {
        vm.prank(vm.addr(workerKey));
        tree.submitDelivery(nodeId, keccak256(abi.encodePacked("artifact", nodeId)), "ipfs://e2e");
    }

    function _accept(EscrowTree tree, uint64 nodeId, uint256 hirerKey) private {
        vm.prank(vm.addr(hirerKey));
        tree.accept(nodeId);
    }

    function _reject(EscrowTree tree, uint64 nodeId, uint256 hirerKey) private {
        vm.prank(vm.addr(hirerKey));
        tree.reject(nodeId, keccak256("e2e rejected"));
    }

    function _treeWithAcceptedChild(bytes32 salt) private returns (EscrowTree tree) {
        tree = _fundFromAllowance(salt, 0);
        _subcontract(
            tree, 1, ROOT_WORKER_KEY, childWorker, CHILD_WORKER_KEY, CHILD_AMOUNT, bytes32("child")
        );
        _deliver(tree, 2, CHILD_WORKER_KEY);
        _accept(tree, 2, ROOT_WORKER_KEY);
    }

    function _m107PreState(bytes32 salt) private returns (EscrowTree tree) {
        tree = _fundFromAllowance(salt, 0);
        _subcontract(
            tree,
            1,
            ROOT_WORKER_KEY,
            childWorker,
            CHILD_WORKER_KEY,
            CHILD_AMOUNT,
            bytes32("m107-child")
        );
        _subcontract(
            tree,
            2,
            CHILD_WORKER_KEY,
            grandchildWorker,
            GRANDCHILD_WORKER_KEY,
            GRANDCHILD_AMOUNT,
            bytes32("m107-grandchild")
        );
        _deliver(tree, 3, GRANDCHILD_WORKER_KEY);
        _accept(tree, 3, CHILD_WORKER_KEY);
        _deliver(tree, 2, CHILD_WORKER_KEY);
        _reject(tree, 2, ROOT_WORKER_KEY);
        assertEq(tree.getNode(1).unallocated, 30e6);
        assertEq(tree.totalPending(), GRANDCHILD_AMOUNT);
        _assertLedger(tree, _nodes(3), _accounts(), ROOT_AMOUNT);
    }

    function _assertRefundedFinalGuard(EscrowTree tree) private {
        vm.expectRevert(EscrowTree.RefundedFinalized.selector);
        vm.prank(childWorker);
        tree.submitDelivery(2, keccak256("late"), "ipfs://late");
        vm.expectRevert(EscrowTree.RefundedFinalized.selector);
        vm.prank(childWorker);
        tree.accept(2);
        vm.expectRevert(EscrowTree.RefundedFinalized.selector);
        vm.prank(buyer);
        tree.reject(1, keccak256("late reject"));
        vm.expectRevert(EscrowTree.RefundedFinalized.selector);
        vm.prank(rootWorker);
        tree.abandon(1);
        vm.expectRevert(EscrowTree.RefundedFinalized.selector);
        tree.claimAcceptTimeout(1);
        vm.expectRevert(EscrowTree.RefundedFinalized.selector);
        tree.claimNonDelivery(2);
        vm.expectRevert(EscrowTree.RefundedFinalized.selector);
        EscrowTree.SubcontractParams memory p = EscrowTree.SubcontractParams({
            parentId: 1,
            worker: childWorker,
            amount: 1e6,
            deliveryDeadline: uint40(block.timestamp + 2 days),
            acceptWindow: uint32(48 hours),
            termsHash: keccak256("late subcontract"),
            workerAgentId: 0,
            expiry: block.timestamp + 1 days,
            salt: bytes32("late subcontract")
        });
        vm.prank(rootWorker);
        tree.subcontract(p, "");
        vm.expectRevert(EscrowTree.RefundedFinalized.selector);
        vm.prank(childWorker);
        tree.claimFinal();
    }

    function _assertRefundedFinalNodeActionReverts(
        EscrowTree tree,
        uint64 nodeId,
        uint256 workerKey
    ) private {
        vm.expectRevert(EscrowTree.RefundedFinalized.selector);
        vm.prank(vm.addr(workerKey));
        tree.abandon(nodeId);
    }

    function _assertLedger(
        EscrowTree tree,
        uint64[] memory nodeIds,
        address[] memory accounts,
        uint256 expected
    ) private view {
        uint256 ledger;
        if (tree.rootOutcome() == EscrowTree.RootOutcome.RefundedFinal) {
            for (uint256 i; i < accounts.length; ++i) {
                ledger += tree.claimableOf(accounts[i]);
            }
        } else {
            for (uint256 i; i < nodeIds.length; ++i) {
                EscrowTree.Node memory node = tree.getNode(nodeIds[i]);
                if (
                    node.state == EscrowTree.NodeState.Funded
                        || node.state == EscrowTree.NodeState.Delivered
                ) {
                    ledger += node.unallocated;
                }
            }
            ledger += tree.totalPending();
            for (uint256 i; i < accounts.length; ++i) {
                ledger += tree.claimableOf(accounts[i]);
            }
            EscrowTree.Node memory root = tree.getNode(1);
            if (
                root.state == EscrowTree.NodeState.Funded
                    || root.state == EscrowTree.NodeState.Delivered
            ) {
                ledger += tree.feeReserve();
            }
        }
        assertEq(ledger, expected);
        assertTrue(usdc.balanceOf(address(tree)) >= ledger);
    }

    function _nodes(uint256 count) private pure returns (uint64[] memory ids) {
        ids = new uint64[](count);
        for (uint64 i = 1; i <= count; ++i) {
            ids[i - 1] = i;
        }
    }

    function _accounts() private view returns (address[] memory accounts) {
        accounts = new address[](5);
        accounts[0] = buyer;
        accounts[1] = rootWorker;
        accounts[2] = childWorker;
        accounts[3] = grandchildWorker;
        accounts[4] = feeRecipient;
    }
}
