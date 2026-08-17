// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { EscrowTree } from "../src/EscrowTree.sol";
import { EscrowTreeFactory } from "../src/EscrowTreeFactory.sol";
import { EscrowTreeScenario } from "./support/EscrowTreeScenario.sol";

contract EscrowTreeEip712Test is EscrowTreeScenario {
    bytes32 private constant DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 private constant ROOT_ACCEPTANCE_TYPEHASH = keccak256(
        "RootAcceptance(address buyer,uint256 amount,uint40 deliveryDeadline,uint32 acceptWindow,bytes32 termsHash,uint256 workerAgentId,uint256 expiry,bytes32 salt)"
    );
    bytes32 private constant FUNDING_AUTHORIZATION_TYPEHASH = keccak256(
        "FundingAuthorization(address buyer,uint256 amount,bytes32 rootParamsHash,uint256 expiry,bytes32 salt)"
    );
    bytes32 private constant QUOTE_TYPEHASH = keccak256(
        "Quote(address tree,uint64 parentId,address hirer,address worker,uint256 amount,uint40 deliveryDeadline,uint32 acceptWindow,bytes32 termsHash,uint256 workerAgentId,uint256 expiry,bytes32 salt)"
    );

    function test_factoryDigestsUseTheEip712DomainAndTypedStructs() public {
        _setUpScenario();
        EscrowTreeFactory.RootParams memory p = _rootParams(
            100e6,
            bytes32("typed-root"),
            rootWorker,
            uint40(block.timestamp + 3 days),
            uint32(48 hours)
        );
        bytes32 domain = _domain(address(factory));
        bytes32 rootStructHash = keccak256(
            abi.encode(
                ROOT_ACCEPTANCE_TYPEHASH,
                p.buyer,
                p.amount,
                p.deliveryDeadline,
                p.acceptWindow,
                p.termsHash,
                p.workerAgentId,
                p.expiry,
                p.salt
            )
        );
        bytes32 fundingStructHash = keccak256(
            abi.encode(
                FUNDING_AUTHORIZATION_TYPEHASH,
                p.buyer,
                p.amount,
                keccak256(abi.encode(p)),
                p.expiry,
                p.salt
            )
        );
        assertEq(factory.rootAcceptanceDigest(p), _typed(domain, rootStructHash));
        assertEq(factory.fundingAuthorizationDigest(p), _typed(domain, fundingStructHash));
    }

    function test_quoteDigestUsesTheCloneEip712DomainAndHirerBinding() public {
        _setUpScenario();
        EscrowTree tree = _fundedTree(bytes32("typed-quote"));
        EscrowTree.SubcontractParams memory p = EscrowTree.SubcontractParams({
            parentId: 1,
            worker: childWorker,
            amount: 80e6,
            deliveryDeadline: uint40(block.timestamp + 2 days),
            acceptWindow: uint32(48 hours),
            termsHash: keccak256("typed-child"),
            workerAgentId: 0,
            expiry: block.timestamp + 1 days,
            salt: bytes32("typed-child")
        });
        bytes32 structHash = keccak256(
            abi.encode(
                QUOTE_TYPEHASH,
                address(tree),
                p.parentId,
                rootWorker,
                p.worker,
                p.amount,
                p.deliveryDeadline,
                p.acceptWindow,
                p.termsHash,
                p.workerAgentId,
                p.expiry,
                p.salt
            )
        );
        assertEq(tree.quoteDigest(p), _typed(_domain(address(tree)), structHash));
    }

    function _domain(address verifyingContract) private view returns (bytes32) {
        return keccak256(
            abi.encode(
                DOMAIN_TYPEHASH,
                keccak256("GolocoEscrow"),
                keccak256("1"),
                block.chainid,
                verifyingContract
            )
        );
    }

    function _typed(bytes32 domain, bytes32 structHash) private pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }
}
