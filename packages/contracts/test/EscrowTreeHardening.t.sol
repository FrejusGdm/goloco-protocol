// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { EscrowTree } from "../src/EscrowTree.sol";
import { EscrowTreeFactory } from "../src/EscrowTreeFactory.sol";
import { MockUSDC } from "./support/MockUSDC.sol";
import { EscrowTreeScenario } from "./support/EscrowTreeScenario.sol";

contract EscrowTreeHardeningTest is EscrowTreeScenario {
    address internal constant RELAYER = address(0xB0B);

    function setUp() public {
        _setUpScenarioWithFee(1);
    }

    function test_feeReserveRoundsUpAndSettlesExactlyOnceAcrossReleaseAndRefund() public {
        uint256 amount = 2_000_001;
        EscrowTree released = _fundedTreeWith(
            amount,
            bytes32("fee-release"),
            rootWorker,
            uint40(block.timestamp + 3 days),
            uint32(48 hours)
        );
        assertEq(released.feeReserve(), 201);
        uint64 childId = _subcontract(
            released,
            1,
            ROOT_WORKER_KEY,
            childWorker,
            CHILD_WORKER_KEY,
            1_000_000,
            uint40(block.timestamp + 2 days),
            bytes32("fee-child")
        );
        _deliver(released, childId, CHILD_WORKER_KEY, keccak256("fee child"));
        _accept(released, childId, ROOT_WORKER_KEY);
        _releaseRoot(released);
        vm.prank(childWorker);
        released.claimFinal();

        address rootDestination = address(0x101);
        address childDestination = address(0x102);
        address feeDestination = address(0x103);
        vm.prank(rootWorker);
        released.withdraw(rootDestination);
        vm.prank(childWorker);
        released.withdraw(childDestination);
        vm.prank(feeRecipient);
        released.withdraw(feeDestination);
        assertEq(usdc.balanceOf(rootDestination), 999_800);
        assertEq(usdc.balanceOf(childDestination), 1_000_000);
        assertEq(usdc.balanceOf(feeDestination), 201);
        assertEq(usdc.balanceOf(address(released)), 0);
        vm.prank(feeRecipient);
        (bool withdrewTwice,) =
            address(released).call(abi.encodeCall(EscrowTree.withdraw, (feeDestination)));
        assertEq(withdrewTwice, false);

        EscrowTree refunded = _fundedTreeWith(
            amount,
            bytes32("fee-refund"),
            rootWorker,
            uint40(block.timestamp + 3 days),
            uint32(48 hours)
        );
        assertEq(refunded.feeReserve(), 201);
        _rejectRoot(refunded);
        assertEq(refunded.claimableOf(buyer), amount);
        vm.prank(buyer);
        refunded.withdraw(address(0x104));
        assertEq(usdc.balanceOf(address(0x104)), amount);
        assertEq(usdc.balanceOf(address(refunded)), 0);
    }

    function test_factoryPinsTheSupportedBaseUSDCRailAndRequiresARecipientForFees() public {
        (bool arbitraryTokenAccepted,) = address(this)
            .call(
                abi.encodeCall(
                    this.deployFactory, (address(new MockUSDC()), uint16(0), feeRecipient)
                )
            );
        assertEq(arbitraryTokenAccepted, false);

        (bool missingFeeRecipientAccepted,) = address(this)
            .call(abi.encodeCall(this.deployFactory, (address(usdc), uint16(1), address(0))));
        assertEq(missingFeeRecipientAccepted, false);
    }

    function test_factoryBindsUSDCRailToBaseChainsAndEnforcesOneUsdcMinimum() public {
        vm.chainId(1);
        (bool unboundBaseSepoliaRailAccepted,) = address(this)
            .call(abi.encodeCall(this.deployFactory, (BASE_SEPOLIA_USDC, uint16(0), feeRecipient)));
        assertEq(unboundBaseSepoliaRailAccepted, false);

        vm.chainId(84532);
        (bool subUsdcMinimumAccepted,) = address(this)
            .call(
                abi.encodeCall(
                    this.deployFactoryWithMinimum,
                    (BASE_SEPOLIA_USDC, uint16(1), feeRecipient, 999_999)
                )
            );
        assertEq(subUsdcMinimumAccepted, false);

        address minimumCompatibleFactory =
            this.deployFactoryWithMinimum(BASE_SEPOLIA_USDC, uint16(1), feeRecipient, 1_000_000);
        assertTrue(minimumCompatibleFactory != address(0));
    }

    function test_eip3009CannotBeConsumedByARelayerBeforeThePredictedCloneExists() public {
        EscrowTreeFactory.RootParams memory params = _rootParams(
            1_000_000,
            bytes32("relayer-prefund"),
            rootWorker,
            uint40(block.timestamp + 3 days),
            uint32(48 hours)
        );
        address predicted = factory.predictTreeAddress(params);
        uint256 validBefore = block.timestamp + 1 days;
        bytes32 nonce = factory.authorizationNonce(params);
        bytes32 digest =
            usdc.authorizationDigest(buyer, predicted, params.amount, 0, validBefore, nonce);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(BUYER_KEY, digest);

        vm.prank(RELAYER);
        (bool prefunded,) = address(usdc)
            .call(
                abi.encodeCall(
                    MockUSDC.receiveWithAuthorization,
                    (buyer, predicted, params.amount, 0, validBefore, nonce, v, r, s)
                )
            );
        assertEq(prefunded, false);
        assertEq(usdc.authorizationState(buyer, nonce), false);
        assertEq(usdc.balanceOf(predicted), 0);
    }

    function deployFactory(address token, uint16 bps, address recipient)
        external
        returns (address)
    {
        return address(new EscrowTreeFactory(token, bps, recipient, 1e6, address(identityRegistry)));
    }

    function deployFactoryWithMinimum(address token, uint16 bps, address recipient, uint256 minimum)
        external
        returns (address)
    {
        return
            address(
                new EscrowTreeFactory(token, bps, recipient, minimum, address(identityRegistry))
            );
    }
}
