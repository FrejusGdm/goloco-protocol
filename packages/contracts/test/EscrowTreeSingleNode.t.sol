// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { EscrowTree } from "../src/EscrowTree.sol";
import { EscrowTreeFactory } from "../src/EscrowTreeFactory.sol";
import { MockUSDC } from "./support/MockUSDC.sol";
import { MockIdentityRegistry } from "./support/MockIdentityRegistry.sol";
import { TestBase } from "./support/TestBase.sol";

contract EscrowTreeSingleNodeTest is TestBase {
    address internal constant BASE_SEPOLIA_USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;
    uint256 internal constant BUYER_KEY = 0xA11CE;
    uint256 internal constant WORKER_KEY = 0xB0B;
    address internal buyer;
    address internal worker;
    address internal feeRecipient = address(0xFEE);
    MockUSDC internal usdc;
    MockIdentityRegistry internal identityRegistry;
    EscrowTreeFactory internal factory;

    function setUp() public {
        vm.chainId(84532);
        buyer = vm.addr(BUYER_KEY);
        worker = vm.addr(WORKER_KEY);
        MockUSDC implementation = new MockUSDC();
        vm.etch(BASE_SEPOLIA_USDC, address(implementation).code);
        usdc = MockUSDC(BASE_SEPOLIA_USDC);
        identityRegistry = new MockIdentityRegistry();
        factory =
            new EscrowTreeFactory(address(usdc), 0, feeRecipient, 1e6, address(identityRegistry));
        usdc.mint(buyer, 1_000e6);
        vm.prank(buyer);
        usdc.approve(address(factory), type(uint256).max);
    }

    function test_rootAcceptCreditsWorkerAndWithdraws() public {
        EscrowTree tree = _fundFromAllowance(100e6, bytes32("accept"));
        vm.prank(worker);
        tree.submitDelivery(1, keccak256("artifact"), "ipfs://artifact");
        vm.prank(buyer);
        tree.accept(1);

        assertEq(uint256(tree.rootOutcome()), uint256(EscrowTree.RootOutcome.ReleasedFinal));
        assertEq(tree.claimableOf(worker), 100e6);
        assertEq(usdc.balanceOf(address(tree)), 100e6);

        address destination = address(0xD15EA5E);
        vm.prank(worker);
        tree.withdraw(destination);
        assertEq(usdc.balanceOf(destination), 100e6);
        assertEq(usdc.balanceOf(address(tree)), 0);
    }

    function test_rootRejectReturnsGrossAmountToBuyer() public {
        EscrowTree tree = _fundFromAllowance(100e6, bytes32("reject"));
        vm.prank(worker);
        tree.submitDelivery(1, keccak256("artifact"), "ipfs://artifact");
        vm.prank(buyer);
        tree.reject(1, keccak256("not accepted"));

        assertEq(uint256(tree.rootOutcome()), uint256(EscrowTree.RootOutcome.RefundedFinal));
        assertEq(tree.claimableOf(buyer), 100e6);
        assertEq(tree.claimableOf(worker), 0);
    }

    function test_acceptTimeoutReleasesARealDelivery() public {
        EscrowTree tree = _fundFromAllowance(100e6, bytes32("timeout"));
        vm.prank(worker);
        tree.submitDelivery(1, keccak256("artifact"), "ipfs://artifact");
        EscrowTree.Node memory node = tree.getNode(1);
        vm.warp(uint256(node.firstDeliveredAt) + uint256(node.acceptWindow) + 1);

        tree.claimAcceptTimeout(1);
        assertEq(uint256(tree.rootOutcome()), uint256(EscrowTree.RootOutcome.ReleasedFinal));
        assertEq(tree.claimableOf(worker), 100e6);
    }

    function test_eip3009AuthorizationNonceBindsExactRootTerms() public {
        EscrowTreeFactory.RootParams memory params = _params(100e6, bytes32("bound"));
        EscrowTreeFactory.EIP3009Auth memory auth = _authorization(params);
        bytes memory acceptance = _rootAcceptance(params);

        factory.createAndFund(params, auth, acceptance);

        EscrowTreeFactory.RootParams memory altered = params;
        altered.termsHash = keccak256("altered terms");
        (bool ok,) = address(factory)
            .call(
                abi.encodeCall(
                    EscrowTreeFactory.createAndFund, (altered, auth, _rootAcceptance(altered))
                )
            );
        assertEq(ok, false);
    }

    function test_directUsdcSurplusHasNoSweepPath() public {
        EscrowTree tree = _fundFromAllowance(100e6, bytes32("surplus"));
        usdc.mint(address(tree), 7e6);

        (bool ok,) = address(tree)
            .call(
                abi.encodeWithSignature("sweep(address,address,uint256)", address(usdc), buyer, 7e6)
            );
        assertEq(ok, false);
        assertEq(usdc.balanceOf(address(tree)), 107e6);
    }

    function test_pausePreservesClaimUntilTransfersResume() public {
        EscrowTree tree = _releasedTree(bytes32("pause"));
        usdc.setPaused(true);
        vm.prank(worker);
        (bool pausedWithdrawal,) =
            address(tree).call(abi.encodeCall(EscrowTree.withdraw, (address(0xBEEF))));
        assertEq(pausedWithdrawal, false);
        assertEq(tree.claimableOf(worker), 100e6);

        usdc.setPaused(false);
        vm.prank(worker);
        tree.withdraw(address(0xBEEF));
        assertEq(usdc.balanceOf(address(0xBEEF)), 100e6);
    }

    function test_blacklistedWorkerCanWithdrawToFreshDestination() public {
        EscrowTree tree = _releasedTree(bytes32("worker blacklist"));
        usdc.setBlacklisted(worker, true);
        address freshDestination = address(0xCAFE);

        vm.prank(worker);
        tree.withdraw(freshDestination);
        assertEq(usdc.balanceOf(freshDestination), 100e6);
    }

    function test_blacklistedCloneTrapsOnlyItsOwnTree() public {
        EscrowTree trapped = _releasedTree(bytes32("trapped"));
        EscrowTree healthy = _releasedTree(bytes32("healthy"));
        usdc.setBlacklisted(address(trapped), true);

        vm.prank(worker);
        (bool trappedWithdrawal,) =
            address(trapped).call(abi.encodeCall(EscrowTree.withdraw, (address(0xA))));
        assertEq(trappedWithdrawal, false);
        vm.prank(worker);
        healthy.withdraw(address(0xB));

        assertEq(usdc.balanceOf(address(0xB)), 100e6);
        assertEq(trapped.claimableOf(worker), 100e6);
    }

    function _releasedTree(bytes32 salt) private returns (EscrowTree tree) {
        tree = _fundFromAllowance(100e6, salt);
        vm.prank(worker);
        tree.submitDelivery(1, keccak256("artifact"), "ipfs://artifact");
        vm.prank(buyer);
        tree.accept(1);
    }

    function _fundFromAllowance(uint256 amount, bytes32 salt) private returns (EscrowTree tree) {
        EscrowTreeFactory.RootParams memory params = _params(amount, salt);
        tree = EscrowTree(
            factory.createAndFundFrom(
                params, _fundingAuthorization(params), _rootAcceptance(params)
            )
        );
    }

    function _params(uint256 amount, bytes32 salt)
        private
        view
        returns (EscrowTreeFactory.RootParams memory)
    {
        return EscrowTreeFactory.RootParams({
            buyer: buyer,
            rootWorker: worker,
            amount: amount,
            deliveryDeadline: uint40(block.timestamp + 3 days),
            acceptWindow: uint32(48 hours),
            termsHash: keccak256("canonical terms"),
            workerAgentId: 0,
            expiry: block.timestamp + 1 days,
            salt: salt
        });
    }

    function _rootAcceptance(EscrowTreeFactory.RootParams memory params)
        private
        returns (bytes memory)
    {
        bytes32 digest = factory.rootAcceptanceDigest(params);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(WORKER_KEY, digest);
        return abi.encodePacked(r, s, v);
    }

    function _fundingAuthorization(EscrowTreeFactory.RootParams memory params)
        private
        returns (bytes memory)
    {
        bytes32 digest = factory.fundingAuthorizationDigest(params);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(BUYER_KEY, digest);
        return abi.encodePacked(r, s, v);
    }

    function _authorization(EscrowTreeFactory.RootParams memory params)
        private
        returns (EscrowTreeFactory.EIP3009Auth memory auth)
    {
        address predicted = factory.predictTreeAddress(params);
        uint256 validAfter = block.timestamp - 1;
        uint256 validBefore = block.timestamp + 1 days;
        bytes32 nonce = factory.authorizationNonce(params);
        bytes32 digest = usdc.authorizationDigest(
            buyer, predicted, params.amount, validAfter, validBefore, nonce
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(BUYER_KEY, digest);
        return EscrowTreeFactory.EIP3009Auth({
            validAfter: validAfter, validBefore: validBefore, nonce: nonce, v: v, r: r, s: s
        });
    }
}
