// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IUSDC {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

interface IERC1271 {
    function isValidSignature(bytes32 digest, bytes calldata signature)
        external
        view
        returns (bytes4);
}

/// @notice Per-task, clone-deployed escrow state machine. No admin or recovery path exists.
contract EscrowTree {
    bytes32 private constant DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 private constant QUOTE_TYPEHASH = keccak256(
        "Quote(address tree,uint64 parentId,address hirer,address worker,uint256 amount,uint40 deliveryDeadline,uint32 acceptWindow,bytes32 termsHash,uint256 workerAgentId,uint256 expiry,bytes32 salt)"
    );
    enum NodeState {
        None,
        Funded,
        Delivered,
        Released,
        Refunded,
        Disputed
    }
    enum RootOutcome {
        Unresolved,
        ReleasedFinal,
        RefundedFinal
    }

    struct Node {
        uint64 parentId;
        uint8 depth;
        NodeState state;
        address hirer;
        address worker;
        uint256 amount;
        uint256 unallocated;
        uint40 fundedAt;
        uint40 deliveryDeadline;
        uint32 acceptWindow;
        uint40 firstDeliveredAt;
        uint40 deliveredAt;
        bytes32 artifactHash;
        bytes32 termsHash;
        uint256 workerAgentId;
    }

    struct SubcontractParams {
        uint64 parentId;
        address worker;
        uint256 amount;
        uint40 deliveryDeadline;
        uint32 acceptWindow;
        bytes32 termsHash;
        uint256 workerAgentId;
        uint256 expiry;
        bytes32 salt;
    }

    struct InitParams {
        address usdc;
        address buyer;
        address worker;
        uint256 amount;
        uint40 deliveryDeadline;
        uint32 acceptWindow;
        bytes32 termsHash;
        uint256 workerAgentId;
        uint16 feeBps;
        address feeRecipient;
    }

    struct EIP3009Auth {
        uint256 validAfter;
        uint256 validBefore;
        bytes32 nonce;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    event NodeCreated(
        uint64 indexed nodeId,
        uint64 indexed parentId,
        address indexed worker,
        address hirer,
        uint256 amount,
        uint8 depth,
        uint40 deliveryDeadline,
        uint32 acceptWindow,
        bytes32 termsHash,
        uint256 workerAgentId
    );
    event Delivered(
        uint64 indexed nodeId,
        address indexed worker,
        bytes32 artifactHash,
        string artifactURI,
        bool isRedelivery
    );
    event Released(
        uint64 indexed nodeId, address indexed worker, uint256 amountCredited, uint8 via
    );
    event Rejected(uint64 indexed nodeId, address indexed hirer, bytes32 reasonHash);
    event Refunded(
        uint64 indexed nodeId,
        uint8 cause,
        uint64 routedToNodeId,
        address routedToClaimable,
        uint256 amount
    );
    event Withdrawn(address indexed claimant, address indexed to, uint256 amount);

    error Unauthorized();
    error InvalidState();
    error InvalidTerms();
    error Expired();
    error SignatureInvalid();
    error RefundedFinalized();
    error Reentrancy();
    error TransferFailed();
    error AlreadyInitialized();

    uint8 public constant MAX_DEPTH = 8;
    uint32 public constant MIN_ACCEPT_WINDOW = 48 hours;
    uint40 public constant MIN_DELIVERY_WINDOW = 24 hours;

    address public immutable factory;
    address public usdc;
    address public buyer;
    address public feeRecipient;
    address public rootWorker;
    uint16 public feeBps;
    uint256 public rootAmount;
    uint256 public feeReserve;
    uint64 public nextNodeId;
    uint256 public totalPending;
    RootOutcome public rootOutcome;

    mapping(uint64 => Node) private _nodes;
    mapping(address => uint256) private _claimable;
    mapping(address => uint256) private _pending;
    mapping(bytes32 => bool) public consumedQuote;
    bool private _initialized;
    bool private _entered;

    constructor(address factory_) {
        factory = factory_;
    }

    modifier onlyFactory() {
        if (msg.sender != factory) revert Unauthorized();
        _;
    }

    modifier activeTree() {
        if (rootOutcome == RootOutcome.RefundedFinal) revert RefundedFinalized();
        _;
    }

    modifier nonReentrant() {
        if (_entered) revert Reentrancy();
        _entered = true;
        _;
        _entered = false;
    }

    function initializeFromAllowance(InitParams calldata p) external onlyFactory {
        _initialize(p);
    }

    function initializeWithAuthorization(InitParams calldata p, EIP3009Auth calldata auth)
        external
        onlyFactory
    {
        _initialize(p);
        IUSDC(p.usdc)
            .receiveWithAuthorization(
                p.buyer,
                address(this),
                p.amount,
                auth.validAfter,
                auth.validBefore,
                auth.nonce,
                auth.v,
                auth.r,
                auth.s
            );
    }

    function subcontract(SubcontractParams calldata p, bytes calldata workerQuoteSig)
        external
        activeTree
        nonReentrant
        returns (uint64 nodeId)
    {
        Node storage parent = _node(p.parentId);
        if (parent.state != NodeState.Funded || parent.worker != msg.sender) revert Unauthorized();
        if (p.amount < _minimumNodeAmount() || p.amount > parent.unallocated) {
            revert InvalidTerms();
        }
        if (
            p.acceptWindow < MIN_ACCEPT_WINDOW
                || p.deliveryDeadline < block.timestamp + MIN_DELIVERY_WINDOW
        ) revert InvalidTerms();
        if (
            p.deliveryDeadline > parent.deliveryDeadline || p.worker == parent.hirer
                || p.worker == buyer || p.worker == address(0)
        ) revert InvalidTerms();
        if (
            parent.depth >= MAX_DEPTH || p.expiry < block.timestamp
                || !_isValidWorkerAgent(p.worker, p.workerAgentId)
        ) {
            revert InvalidTerms();
        }
        _assertNotAncestorWorker(p.parentId, p.worker);

        bytes32 digest = quoteDigest(p);
        if (consumedQuote[digest] || !_isValidSignature(p.worker, digest, workerQuoteSig)) {
            revert SignatureInvalid();
        }
        consumedQuote[digest] = true;

        parent.unallocated -= p.amount;
        nodeId = nextNodeId++;
        _nodes[nodeId] = Node({
            parentId: p.parentId,
            depth: parent.depth + 1,
            state: NodeState.Funded,
            hirer: parent.worker,
            worker: p.worker,
            amount: p.amount,
            unallocated: p.amount,
            fundedAt: uint40(block.timestamp),
            deliveryDeadline: p.deliveryDeadline,
            acceptWindow: p.acceptWindow,
            firstDeliveredAt: 0,
            deliveredAt: 0,
            artifactHash: bytes32(0),
            termsHash: p.termsHash,
            workerAgentId: p.workerAgentId
        });
        emit NodeCreated(
            nodeId,
            p.parentId,
            p.worker,
            parent.worker,
            p.amount,
            parent.depth + 1,
            p.deliveryDeadline,
            p.acceptWindow,
            p.termsHash,
            p.workerAgentId
        );
    }

    function submitDelivery(uint64 nodeId, bytes32 artifactHash, string calldata artifactURI)
        external
        activeTree
        nonReentrant
    {
        Node storage node = _node(nodeId);
        if (node.worker != msg.sender) revert Unauthorized();
        bool redelivery = node.state == NodeState.Delivered;
        if (!redelivery && node.state != NodeState.Funded) revert InvalidState();
        if (!redelivery && block.timestamp > node.deliveryDeadline) revert Expired();
        if (!redelivery) {
            node.state = NodeState.Delivered;
            node.firstDeliveredAt = uint40(block.timestamp);
        }
        node.deliveredAt = uint40(block.timestamp);
        node.artifactHash = artifactHash;
        emit Delivered(nodeId, msg.sender, artifactHash, artifactURI, redelivery);
    }

    function accept(uint64 nodeId) external activeTree nonReentrant {
        Node storage node = _node(nodeId);
        if (node.state != NodeState.Delivered || node.hirer != msg.sender) revert Unauthorized();
        _release(nodeId, node, 0);
    }

    function reject(uint64 nodeId, bytes32 reasonHash) external activeTree nonReentrant {
        Node storage node = _node(nodeId);
        if (node.state != NodeState.Delivered || node.hirer != msg.sender) revert Unauthorized();
        if (block.timestamp > uint256(node.firstDeliveredAt) + node.acceptWindow) revert Expired();
        emit Rejected(nodeId, msg.sender, reasonHash);
        _refund(nodeId, node, 1);
    }

    function claimNonDelivery(uint64 nodeId) external activeTree nonReentrant {
        Node storage node = _node(nodeId);
        if (node.state != NodeState.Funded || block.timestamp <= node.deliveryDeadline) {
            revert InvalidState();
        }
        _refund(nodeId, node, 0);
    }

    function claimAcceptTimeout(uint64 nodeId) external activeTree nonReentrant {
        Node storage node = _node(nodeId);
        if (node.state != NodeState.Delivered) revert InvalidState();
        if (block.timestamp <= uint256(node.firstDeliveredAt) + node.acceptWindow) {
            revert InvalidState();
        }
        _release(nodeId, node, 1);
    }

    function abandon(uint64 nodeId) external activeTree nonReentrant {
        Node storage node = _node(nodeId);
        if (node.state != NodeState.Funded || node.worker != msg.sender) revert Unauthorized();
        _refund(nodeId, node, 2);
    }

    function claimFinal() external activeTree nonReentrant {
        if (rootOutcome != RootOutcome.ReleasedFinal) revert InvalidState();
        uint256 amount = _pending[msg.sender];
        if (amount == 0) revert InvalidState();
        _pending[msg.sender] = 0;
        totalPending -= amount;
        _claimable[msg.sender] += amount;
    }

    function withdraw(address to) external nonReentrant {
        uint256 amount = _claimable[msg.sender];
        if (amount == 0 || to == address(0)) revert InvalidState();
        _claimable[msg.sender] = 0;
        if (!IUSDC(usdc).transfer(to, amount)) revert TransferFailed();
        emit Withdrawn(msg.sender, to, amount);
    }

    function getNode(uint64 nodeId) external view returns (Node memory) {
        return _node(nodeId);
    }

    function claimableOf(address who) external view returns (uint256) {
        return _claimable[who];
    }

    function pendingOf(address who) external view returns (uint256) {
        return _pending[who];
    }

    function quoteDigest(SubcontractParams calldata p) public view returns (bytes32) {
        Node storage parent = _node(p.parentId);
        bytes32 structHash = keccak256(
            abi.encode(
                QUOTE_TYPEHASH,
                address(this),
                p.parentId,
                parent.worker,
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
        return _hashTypedData(structHash);
    }

    function _initialize(InitParams calldata p) private {
        if (_initialized) revert AlreadyInitialized();
        _initialized = true;
        usdc = p.usdc;
        buyer = p.buyer;
        rootWorker = p.worker;
        rootAmount = p.amount;
        feeBps = p.feeBps;
        feeRecipient = p.feeRecipient;
        feeReserve = p.feeBps == 0 ? 0 : (p.amount * p.feeBps + 9_999) / 10_000;
        rootOutcome = RootOutcome.Unresolved;
        nextNodeId = 2;
        _nodes[1] = Node({
            parentId: 0,
            depth: 1,
            state: NodeState.Funded,
            hirer: p.buyer,
            worker: p.worker,
            amount: p.amount,
            unallocated: p.amount - feeReserve,
            fundedAt: uint40(block.timestamp),
            deliveryDeadline: p.deliveryDeadline,
            acceptWindow: p.acceptWindow,
            firstDeliveredAt: 0,
            deliveredAt: 0,
            artifactHash: bytes32(0),
            termsHash: p.termsHash,
            workerAgentId: p.workerAgentId
        });
        emit NodeCreated(
            1,
            0,
            p.worker,
            p.buyer,
            p.amount,
            1,
            p.deliveryDeadline,
            p.acceptWindow,
            p.termsHash,
            p.workerAgentId
        );
    }

    function _release(uint64 nodeId, Node storage node, uint8 via) private {
        node.state = NodeState.Released;
        uint256 amount = node.unallocated;
        node.unallocated = 0;
        if (nodeId == 1) {
            rootOutcome = RootOutcome.ReleasedFinal;
            _claimable[node.worker] += amount;
            if (feeReserve != 0) _claimable[feeRecipient] += feeReserve;
        } else {
            _pending[node.worker] += amount;
            totalPending += amount;
        }
        emit Released(nodeId, node.worker, amount, via);
    }

    function _refund(uint64 nodeId, Node storage node, uint8 cause) private {
        node.state = NodeState.Refunded;
        uint256 amount = node.unallocated;
        node.unallocated = 0;
        if (nodeId == 1) {
            rootOutcome = RootOutcome.RefundedFinal;
            _claimable[buyer] += rootAmount;
            emit Refunded(nodeId, cause, 0, buyer, rootAmount);
            return;
        }
        _routeRefund(node.parentId, amount, nodeId, cause);
    }

    function _routeRefund(uint64 ancestorId, uint256 amount, uint64 refundedNodeId, uint8 cause)
        private
    {
        while (ancestorId != 0) {
            Node storage ancestor = _nodes[ancestorId];
            if (ancestor.state == NodeState.Funded || ancestor.state == NodeState.Delivered) {
                ancestor.unallocated += amount;
                emit Refunded(refundedNodeId, cause, ancestorId, address(0), amount);
                return;
            }
            if (ancestor.state == NodeState.Released) {
                _pending[ancestor.worker] += amount;
                totalPending += amount;
                emit Refunded(refundedNodeId, cause, ancestorId, ancestor.worker, amount);
                return;
            }
            ancestorId = ancestor.parentId;
        }
        revert InvalidState();
    }

    function _assertNotAncestorWorker(uint64 parentId, address worker) private view {
        uint64 current = parentId;
        while (current != 0) {
            if (_nodes[current].worker == worker) revert InvalidTerms();
            current = _nodes[current].parentId;
        }
    }

    function _node(uint64 nodeId) private view returns (Node storage node) {
        node = _nodes[nodeId];
        if (node.state == NodeState.None) revert InvalidState();
    }

    function _minimumNodeAmount() private view returns (uint256 amount) {
        (bool ok, bytes memory data) =
            factory.staticcall(abi.encodeWithSignature("MIN_NODE_AMOUNT()"));
        if (!ok || data.length != 32) revert InvalidState();
        amount = abi.decode(data, (uint256));
    }

    function _isValidWorkerAgent(address worker, uint256 agentId) private view returns (bool) {
        (bool ok, bytes memory data) = factory.staticcall(
            abi.encodeWithSignature("isValidWorkerAgent(address,uint256)", worker, agentId)
        );
        return ok && data.length == 32 && abi.decode(data, (bool));
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

    function _isValidSignature(address signer, bytes32 digest, bytes memory signature)
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
            r := mload(add(signature, 0x20))
            s := mload(add(signature, 0x40))
            v := byte(0, mload(add(signature, 0x60)))
        }
        if (v < 27) v += 27;
        return ecrecover(digest, v, r, s) == signer;
    }
}
