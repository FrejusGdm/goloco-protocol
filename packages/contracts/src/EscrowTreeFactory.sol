// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { EscrowTree, IERC1271, IUSDC } from "./EscrowTree.sol";

interface IIdentityRegistry {
    function walletOf(uint256 agentId) external view returns (address);
}

/// @notice Immutable discovery and CREATE2 deployment point for independent escrow trees.
contract EscrowTreeFactory {
    bytes32 private constant DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 private constant ROOT_ACCEPTANCE_TYPEHASH = keccak256(
        "RootAcceptance(address buyer,uint256 amount,uint40 deliveryDeadline,uint32 acceptWindow,bytes32 termsHash,uint256 workerAgentId,uint256 expiry,bytes32 salt)"
    );
    bytes32 private constant FUNDING_AUTHORIZATION_TYPEHASH = keccak256(
        "FundingAuthorization(address buyer,uint256 amount,bytes32 rootParamsHash,uint256 expiry,bytes32 salt)"
    );

    struct RootParams {
        address buyer;
        address rootWorker;
        uint256 amount;
        uint40 deliveryDeadline;
        uint32 acceptWindow;
        bytes32 termsHash;
        uint256 workerAgentId;
        uint256 expiry;
        bytes32 salt;
    }

    struct EIP3009Auth {
        uint256 validAfter;
        uint256 validBefore;
        bytes32 nonce;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    event TreeCreated(
        address indexed tree,
        address indexed buyer,
        address indexed rootWorker,
        uint256 amount,
        bytes32 termsHash,
        uint256 workerAgentId,
        uint16 feeBps
    );

    error InvalidTerms();
    error SignatureInvalid();
    error AuthorizationConsumed();
    error CloneFailed();
    error TransferFailed();

    uint8 public constant MAX_DEPTH = 8;
    uint32 public constant MIN_ACCEPT_WINDOW = 48 hours;
    uint40 public constant MIN_DELIVERY_WINDOW = 24 hours;
    /// @dev Circle-issued USDC addresses, pinned for Base mainnet and Base Sepolia only.
    address public constant BASE_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address public constant BASE_SEPOLIA_USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;
    uint256 public constant BASE_CHAIN_ID = 8453;
    uint256 public constant BASE_SEPOLIA_CHAIN_ID = 84532;
    uint256 public constant MINIMUM_COMPATIBLE_NODE_AMOUNT = 1e6;
    uint256 public immutable MIN_NODE_AMOUNT;
    address public immutable usdc;
    uint16 public immutable feeBps;
    address public immutable feeRecipient;
    address public immutable identityRegistry;
    address public immutable implementation;
    mapping(bytes32 => bool) public consumedFundingAuth;
    mapping(bytes32 => bool) public consumedRootAcceptance;

    constructor(
        address usdc_,
        uint16 feeBps_,
        address feeRecipient_,
        uint256 minNodeAmount_,
        address identityRegistry_
    ) {
        if (
            !_isSupportedUSDCRail(usdc_) || feeBps_ > 10_000
                || minNodeAmount_ < MINIMUM_COMPATIBLE_NODE_AMOUNT
                || identityRegistry_ == address(0) || (feeBps_ != 0 && feeRecipient_ == address(0))
        ) revert InvalidTerms();
        usdc = usdc_;
        feeBps = feeBps_;
        feeRecipient = feeRecipient_;
        MIN_NODE_AMOUNT = minNodeAmount_;
        identityRegistry = identityRegistry_;
        implementation = address(new EscrowTree(address(this)));
    }

    function createAndFund(
        RootParams calldata p,
        EIP3009Auth calldata auth,
        bytes calldata rootWorkerAcceptanceSig
    ) external returns (address tree) {
        _validateParams(p);
        _consumeRootAcceptance(p, rootWorkerAcceptanceSig);
        if (auth.nonce != authorizationNonce(p)) revert InvalidTerms();
        tree = _clone(_salt(p));
        EscrowTree(tree).initializeWithAuthorization(_initParams(p), _treeAuthorization(auth));
        emit TreeCreated(
            tree, p.buyer, p.rootWorker, p.amount, p.termsHash, p.workerAgentId, feeBps
        );
    }

    function createAndFundFrom(
        RootParams calldata p,
        bytes calldata buyerFundingAuthSig,
        bytes calldata rootWorkerAcceptanceSig
    ) external returns (address tree) {
        _validateParams(p);
        bytes32 fundingDigest = fundingAuthorizationDigest(p);
        if (consumedFundingAuth[fundingDigest]) revert AuthorizationConsumed();
        if (!_isValidSignature(p.buyer, fundingDigest, buyerFundingAuthSig)) {
            revert SignatureInvalid();
        }
        consumedFundingAuth[fundingDigest] = true;
        _consumeRootAcceptance(p, rootWorkerAcceptanceSig);
        tree = _clone(_salt(p));
        EscrowTree(tree).initializeFromAllowance(_initParams(p));
        if (!IUSDC(usdc).transferFrom(p.buyer, tree, p.amount)) revert TransferFailed();
        emit TreeCreated(
            tree, p.buyer, p.rootWorker, p.amount, p.termsHash, p.workerAgentId, feeBps
        );
    }

    function predictTreeAddress(RootParams calldata p) external view returns (address) {
        bytes32 codeHash = keccak256(_proxyCreationCode());
        return address(
            uint160(
                uint256(
                    keccak256(abi.encodePacked(bytes1(0xff), address(this), _salt(p), codeHash))
                )
            )
        );
    }

    function rootAcceptanceDigest(RootParams calldata p) public view returns (bytes32) {
        bytes32 structHash = keccak256(
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
        return _hashTypedData(structHash);
    }

    function fundingAuthorizationDigest(RootParams calldata p) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                FUNDING_AUTHORIZATION_TYPEHASH,
                p.buyer,
                p.amount,
                keccak256(abi.encode(p)),
                p.expiry,
                p.salt
            )
        );
        return _hashTypedData(structHash);
    }

    function authorizationNonce(RootParams calldata p) public pure returns (bytes32) {
        return keccak256(abi.encode(p));
    }

    function isValidWorkerAgent(address worker, uint256 agentId) external view returns (bool) {
        return _isValidWorkerAgent(worker, agentId);
    }

    function _validateParams(RootParams calldata p) private view {
        if (
            p.buyer == address(0) || p.rootWorker == address(0) || p.buyer == p.rootWorker
                || p.amount < MIN_NODE_AMOUNT || p.acceptWindow < MIN_ACCEPT_WINDOW
                || p.deliveryDeadline < block.timestamp + MIN_DELIVERY_WINDOW
                || p.expiry < block.timestamp || !_isValidWorkerAgent(p.rootWorker, p.workerAgentId)
        ) revert InvalidTerms();
    }

    function _isSupportedUSDCRail(address token) private view returns (bool) {
        return (block.chainid == BASE_CHAIN_ID && token == BASE_USDC)
            || (block.chainid == BASE_SEPOLIA_CHAIN_ID && token == BASE_SEPOLIA_USDC);
    }

    function _consumeRootAcceptance(RootParams calldata p, bytes calldata signature) private {
        bytes32 digest = rootAcceptanceDigest(p);
        if (consumedRootAcceptance[digest]) revert AuthorizationConsumed();
        if (!_isValidSignature(p.rootWorker, digest, signature)) revert SignatureInvalid();
        consumedRootAcceptance[digest] = true;
    }

    function _isValidWorkerAgent(address worker, uint256 agentId) private view returns (bool) {
        return agentId == 0 || IIdentityRegistry(identityRegistry).walletOf(agentId) == worker;
    }

    function _clone(bytes32 salt) private returns (address instance) {
        bytes memory creationCode = _proxyCreationCode();
        assembly {
            instance := create2(0, add(creationCode, 0x20), mload(creationCode), salt)
        }
        if (instance == address(0)) revert CloneFailed();
    }

    function _proxyCreationCode() private view returns (bytes memory) {
        return abi.encodePacked(
            hex"3d602d80600a3d3981f3",
            hex"363d3d373d3d3d363d73",
            implementation,
            hex"5af43d82803e903d91602b57fd5bf3"
        );
    }

    function _hashTypedData(bytes32 structHash) private view returns (bytes32) {
        bytes32 domain = keccak256(
            abi.encode(
                DOMAIN_TYPEHASH,
                keccak256("GolocoEscrow"),
                keccak256("1"),
                block.chainid,
                address(this)
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }

    function _initParams(RootParams calldata p)
        private
        view
        returns (EscrowTree.InitParams memory)
    {
        return EscrowTree.InitParams({
            usdc: usdc,
            buyer: p.buyer,
            worker: p.rootWorker,
            amount: p.amount,
            deliveryDeadline: p.deliveryDeadline,
            acceptWindow: p.acceptWindow,
            termsHash: p.termsHash,
            workerAgentId: p.workerAgentId,
            feeBps: feeBps,
            feeRecipient: feeRecipient
        });
    }

    function _treeAuthorization(EIP3009Auth calldata auth)
        private
        pure
        returns (EscrowTree.EIP3009Auth memory)
    {
        return EscrowTree.EIP3009Auth({
            validAfter: auth.validAfter,
            validBefore: auth.validBefore,
            nonce: auth.nonce,
            v: auth.v,
            r: auth.r,
            s: auth.s
        });
    }

    function _salt(RootParams calldata p) private pure returns (bytes32) {
        return keccak256(abi.encode(p));
    }

    function _isValidSignature(address signer, bytes32 digest, bytes calldata signature)
        private
        view
        returns (bool)
    {
        if (signer.code.length != 0) {
            (bool ok, bytes memory returned) =
                signer.staticcall(abi.encodeCall(IERC1271.isValidSignature, (digest, signature)));
            return ok && returned.length >= 32
                && abi.decode(returned, (bytes4)) == IERC1271.isValidSignature.selector;
        }
        if (signature.length != 65) return false;
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 0x20))
            v := byte(0, calldataload(add(signature.offset, 0x40)))
        }
        if (v < 27) v += 27;
        return ecrecover(digest, v, r, s) == signer;
    }
}
