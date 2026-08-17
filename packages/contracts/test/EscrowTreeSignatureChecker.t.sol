// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { EscrowTreeFactory } from "../src/EscrowTreeFactory.sol";
import { EscrowTreeScenario } from "./support/EscrowTreeScenario.sol";
import { MockERC1271Wallet } from "./support/MockERC1271Wallet.sol";

contract EscrowTreeSignatureCheckerTest is EscrowTreeScenario {
    function test_erc1271BuyerFundingAuthorizationIsCheckedAtConsumption() public {
        _setUpScenario();
        MockERC1271Wallet buyerWallet = new MockERC1271Wallet();
        usdc.mint(address(buyerWallet), 100e6);
        buyerWallet.approveToken(usdc, address(factory), type(uint256).max);

        EscrowTreeFactory.RootParams memory p = _rootParams(
            100e6,
            bytes32("1271-buyer"),
            rootWorker,
            uint40(block.timestamp + 3 days),
            uint32(48 hours)
        );
        p.buyer = address(buyerWallet);
        bytes32 digest = factory.fundingAuthorizationDigest(p);
        buyerWallet.setSignatureValid(digest, true);

        address tree = factory.createAndFundFrom(p, hex"01", _rootAcceptance(p, rootWorker));
        assertEq(usdc.balanceOf(tree), p.amount);

        EscrowTreeFactory.RootParams memory invalid = _rootParams(
            100e6,
            bytes32("1271-invalid"),
            rootWorker,
            uint40(block.timestamp + 3 days),
            uint32(48 hours)
        );
        invalid.buyer = address(buyerWallet);
        bytes32 invalidDigest = factory.fundingAuthorizationDigest(invalid);
        buyerWallet.setSignatureValid(invalidDigest, true);
        buyerWallet.setSignatureValid(invalidDigest, false);
        (bool ok,) = address(factory)
            .call(
                abi.encodeCall(
                    EscrowTreeFactory.createAndFundFrom,
                    (invalid, bytes("\x01"), _rootAcceptance(invalid, rootWorker))
                )
            );
        assertEq(ok, false);
    }

    function test_erc1271RootWorkerAcceptanceAuthorizesExactRootTerms() public {
        _setUpScenario();
        MockERC1271Wallet workerWallet = new MockERC1271Wallet();
        EscrowTreeFactory.RootParams memory p = _rootParams(
            100e6,
            bytes32("1271-worker"),
            address(workerWallet),
            uint40(block.timestamp + 3 days),
            uint32(48 hours)
        );
        workerWallet.setSignatureValid(factory.rootAcceptanceDigest(p), true);

        address tree = factory.createAndFundFrom(p, _fundingAuthorization(p), hex"02");
        assertEq(usdc.balanceOf(tree), p.amount);

        EscrowTreeFactory.RootParams memory altered = _rootParams(
            100e6,
            bytes32("1271-altered"),
            address(workerWallet),
            uint40(block.timestamp + 3 days),
            uint32(48 hours)
        );
        (bool ok,) = address(factory)
            .call(
                abi.encodeCall(
                    EscrowTreeFactory.createAndFundFrom,
                    (altered, _fundingAuthorization(altered), bytes("\x02"))
                )
            );
        assertEq(ok, false);
    }
}
