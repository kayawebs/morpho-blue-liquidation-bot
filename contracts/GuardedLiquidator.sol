// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

interface IAggregatorV3 {
    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        );

    function decimals() external view returns (uint8);
}

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
}

// Guarded liquidator wrapper that forwards to an Executor after on-chain gates.
// Gates: deadline, max price deviation (bps) vs Chainlink aggregator, max data age (seconds).
contract GuardedLiquidator {
    address public owner;
    address public aggregator;
    uint16 public defaultMaxDeviationBps; // e.g. 10 = 0.10%
    uint32 public defaultMaxAgeSec;       // e.g. 120 seconds
    uint8 public aggDecimals;             // sticky cache of aggregator decimals

    mapping(address => bool) public operators; // optional additional callers

    event OwnerUpdated(address indexed owner);
    event OperatorSet(address indexed operator, bool allowed);
    event ParamsUpdated(address executor, address aggregator, uint16 maxDevBps, uint32 maxAgeSec);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    modifier onlyOperator() {
        require(msg.sender == owner || operators[msg.sender], "not operator");
        _;
    }

    constructor(
        address _owner,
        address _aggregator,
        uint16 _maxDevBps,
        uint32 _maxAgeSec
    ) {
        require(_owner != address(0) && _aggregator != address(0), "zero");
        owner = _owner;
        aggregator = _aggregator;
        defaultMaxDeviationBps = _maxDevBps;
        defaultMaxAgeSec = _maxAgeSec;
        aggDecimals = IAggregatorV3(_aggregator).decimals();
        emit OwnerUpdated(_owner);
        emit ParamsUpdated(address(0), _aggregator, _maxDevBps, _maxAgeSec);
    }

    function setOwner(address _owner) external onlyOwner {
        require(_owner != address(0), "zero");
        owner = _owner;
        emit OwnerUpdated(_owner);
    }

    function setOperator(address op, bool allowed) external onlyOwner {
        operators[op] = allowed;
        emit OperatorSet(op, allowed);
    }

    function setParams(
        address _aggregator,
        uint16 _maxDevBps,
        uint32 _maxAgeSec
    ) external onlyOwner {
        if (_aggregator != address(0)) {
            aggregator = _aggregator;
            aggDecimals = IAggregatorV3(_aggregator).decimals();
        }
        if (_maxDevBps > 0) defaultMaxDeviationBps = _maxDevBps;
        if (_maxAgeSec > 0) defaultMaxAgeSec = _maxAgeSec;
        emit ParamsUpdated(address(0), aggregator, defaultMaxDeviationBps, defaultMaxAgeSec);
    }

    // priceHint must be scaled to aggregator decimals.
    // prevRoundId: require latest round strictly greater than this value (ensures update observed).
    // profitToken: ERC20 whose balance on the executor must increase by >= minProfit (address(0) for ETH).
    function exec(
        Call[] calldata calls,
        uint256 priceHint,
        uint16 maxDevBps,
        uint32 maxAgeSec,
        uint80 prevRoundId,
        address profitToken,
        uint256 minProfit,
        uint256 deadline
    ) external payable onlyOperator {
        require(block.timestamp <= deadline, "deadline");
        (uint80 roundId, int256 answer,, uint256 updatedAt,) = IAggregatorV3(aggregator).latestRoundData();
        require(answer > 0, "bad answer");
        require(roundId > prevRoundId, "round");

        uint256 onchain = uint256(answer);
        uint16 devBps = maxDevBps > 0 ? maxDevBps : defaultMaxDeviationBps;
        uint32 age = maxAgeSec > 0 ? maxAgeSec : defaultMaxAgeSec;

        require(block.timestamp - updatedAt <= age, "stale");

        uint256 base = onchain;
        uint256 diff = onchain > priceHint ? onchain - priceHint : priceHint - onchain;
        uint256 bps = base == 0 ? type(uint256).max : (diff * 10_000) / base;
        require(bps <= devBps, "deviation");
        // Pre-balance on executor
        uint256 preBal;
        if (profitToken == address(0)) {
            preBal = address(this).balance;
        } else {
            preBal = IERC20(profitToken).balanceOf(address(this));
        }
        // execute calls atomically; revert on first failure
        unchecked {
            for (uint256 i = 0; i < calls.length; i++) {
                (bool ok, bytes memory ret) = calls[i].target.call{ value: calls[i].value }(calls[i].data);
                if (!ok) {
                    // Bubble up the revert
                    assembly {
                        revert(add(ret, 0x20), mload(ret))
                    }
                }
            }
        }
        // Post-balance on executor and profit check
        uint256 postBal;
        if (profitToken == address(0)) {
            postBal = address(this).balance;
        } else {
            postBal = IERC20(profitToken).balanceOf(address(this));
        }
        require(postBal >= preBal + minProfit, "profit");
    }

    // Same gating as exec(), but accepts encoded Executor calls (bytes[]) and executes them internally.
    function execEncoded(
        bytes[] calldata data,
        uint256 priceHint,
        uint16 maxDevBps,
        uint32 maxAgeSec,
        uint80 prevRoundId,
        address profitToken,
        uint256 minProfit,
        uint256 deadline
    ) external payable onlyOperator {
        require(block.timestamp <= deadline, "deadline");
        (uint80 roundId, int256 answer,, uint256 updatedAt,) = IAggregatorV3(aggregator).latestRoundData();
        require(answer > 0, "bad answer");
        require(roundId > prevRoundId, "round");

        uint256 onchain = uint256(answer);
        uint16 devBps = maxDevBps > 0 ? maxDevBps : defaultMaxDeviationBps;
        uint32 age = maxAgeSec > 0 ? maxAgeSec : defaultMaxAgeSec;
        require(block.timestamp - updatedAt <= age, "stale");
        uint256 base = onchain;
        uint256 diff = onchain > priceHint ? onchain - priceHint : priceHint - onchain;
        uint256 bps = base == 0 ? type(uint256).max : (diff * 10_000) / base;
        require(bps <= devBps, "deviation");

        uint256 preBal;
        if (profitToken == address(0)) {
            preBal = address(this).balance;
        } else {
            preBal = IERC20(profitToken).balanceOf(address(this));
        }
        unchecked {
            for (uint256 i = 0; i < data.length; i++) {
                (bool ok, bytes memory ret) = address(this).call{ value: 0 }(data[i]);
                if (!ok) {
                    assembly { revert(add(ret, 0x20), mload(ret)) }
                }
            }
        }
        uint256 postBal;
        if (profitToken == address(0)) {
            postBal = address(this).balance;
        } else {
            postBal = IERC20(profitToken).balanceOf(address(this));
        }
        require(postBal >= preBal + minProfit, "profit");
    }

    // Minimal executor-compatible functions for venues that rely on callback execution
    function call_g0oyU7o(address target, uint256 value, bytes32 context, bytes calldata callData) external payable {
        // context packs: [12 bytes dataIndex][20 bytes sender]
        address expectedSender = address(uint160(uint256(context)));
        if (expectedSender != address(0)) {
            require(msg.sender == expectedSender, "sender");
        }
        (bool ok, bytes memory ret) = target.call{ value: value }(callData);
        if (!ok) {
            assembly { revert(add(ret, 0x20), mload(ret)) }
        }
    }

    // Owner sweep functions to collect profits
    function sweep(address token, address payable to, uint256 amount) external onlyOwner {
        require(to != address(0), "zero");
        if (token == address(0)) {
            (bool ok, ) = to.call{ value: amount }("");
            require(ok, "eth");
        } else {
            require(IERC20(token).balanceOf(address(this)) >= amount, "bal");
            // minimal ERC20 transfer
            (bool ok, bytes memory ret) = token.call(abi.encodeWithSignature("transfer(address,uint256)", to, amount));
            require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "erc20");
        }
    }

    receive() external payable {}
}
    struct Call { address target; uint256 value; bytes data; }
