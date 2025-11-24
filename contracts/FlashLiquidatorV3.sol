// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

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
}

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
    function decimals() external view returns (uint8);
}

interface IUniswapV3Pool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function flash(address recipient, uint256 amount0, uint256 amount1, bytes calldata data) external;
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);
}

interface IUniswapV3FlashCallback {
    function uniswapV3FlashCallback(uint256 fee0, uint256 fee1, bytes calldata data) external;
}

interface IUniswapV3SwapCallback {
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external;
}

interface IMorpho {
    struct MarketParams {
        address loanToken;
        address collateralToken;
        address oracle;
        address irm;
        uint256 lltv;
    }

    function idToMarketParams(bytes32 id) external view returns (MarketParams memory);

    function market(bytes32 id)
        external
        view
        returns (
            uint128 totalSupplyAssets,
            uint128 totalSupplyShares,
            uint128 totalBorrowAssets,
            uint128 totalBorrowShares,
            uint128 lastUpdate,
            uint128 fee
        );

    function position(bytes32 id, address user)
        external
        view
        returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral);

    function liquidate(
        MarketParams calldata marketParams,
        address borrower,
        uint256 seizedAssets,
        uint256 repaidShares,
        bytes calldata data
    ) external returns (uint256 repaidAssets, uint256 repaidSharesOut);
}

library FullMath {
    function mulDiv(
        uint256 a,
        uint256 b,
        uint256 denominator
    ) internal pure returns (uint256 result) {
        unchecked {
            uint256 prod0;
            uint256 prod1;
            assembly {
                let mm := mulmod(a, b, not(0))
                prod0 := mul(a, b)
                prod1 := sub(sub(mm, prod0), lt(mm, prod0))
            }
            if (prod1 == 0) {
                require(denominator > 0);
                assembly {
                    result := div(prod0, denominator)
                }
                return result;
            }
            require(denominator > prod1, "overflow");
            uint256 remainder;
            assembly {
                remainder := mulmod(a, b, denominator)
                prod1 := sub(prod1, gt(remainder, prod0))
                prod0 := sub(prod0, remainder)
            }
            uint256 twos = denominator & (~denominator + 1);
            assembly {
                denominator := div(denominator, twos)
                prod0 := div(prod0, twos)
                twos := add(div(sub(0, twos), twos), 1)
            }
            prod0 |= prod1 * twos;
            uint256 inv = (3 * denominator) ^ 2;
            inv *= 2 - denominator * inv;
            inv *= 2 - denominator * inv;
            inv *= 2 - denominator * inv;
            inv *= 2 - denominator * inv;
            inv *= 2 - denominator * inv;
            inv *= 2 - denominator * inv;
            result = prod0 * inv;
            return result;
        }
    }
}

error NotAuthorized();
error RoundNotAdvanced(uint80 prev, uint80 curr);
error PositionHealthy();
error MinProfitNotMet();

contract FlashLiquidatorV3 is IUniswapV3FlashCallback, IUniswapV3SwapCallback {
    struct Config {
        uint256 closeFactorBps;
        uint256 minProfit;
        uint256 maxOracleDelay;
    }

    struct FlashContext {
        address borrower;
        uint80 prevRoundId;
        uint256 repayAmount;
        uint256 minProfit;
        uint128 borrowerShares;
        uint128 totalBorrowAssets;
        uint128 totalBorrowShares;
    }

    event LiquidationExecuted(address indexed borrower, uint256 repayAssets, uint256 profit);
    event Dbg(string tag, uint256 a, uint256 b);

    uint256 private constant BPS = 10_000;
    uint160 private constant MIN_SQRT_RATIO_PLUS = 4295128739 + 1;
    uint160 private constant MAX_SQRT_RATIO_MINUS =
        1461446703485210103287273052203988822378723970342 - 1;

    address public immutable owner;
    bytes32 public immutable marketId;
    IMorpho public immutable morpho;
    IMorpho.MarketParams public marketParams;
    IERC20 public immutable loanToken;
    IERC20 public immutable collateralToken;
    IAggregatorV3 public immutable oracle;
    IUniswapV3Pool public pool;
    bool public immutable loanIsToken0;
    bool public immutable collateralIsToken0;

    address public authorizedCaller;
    Config public config;

    uint256 private _locked = 1;
    // Debug helpers
    uint8 private _dbgActive; // 1 when dbgFlash is in-flight
    uint256 private _dbgBorrowed; // principal borrowed in dbgFlash

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    modifier onlyAuthorized() {
        if (msg.sender != owner && msg.sender != authorizedCaller) revert NotAuthorized();
        _;
    }

    modifier nonReentrant() {
        require(_locked == 1, "reentrant");
        _locked = 2;
        _;
        _locked = 1;
    }

    constructor(
        address _morpho,
        bytes32 _marketId,
        address _oracle,
        address _pool,
        address _loanToken,
        address _collateralToken,
        address _authorizedCaller
    ) {
        owner = msg.sender;
        morpho = IMorpho(_morpho);
        marketId = _marketId;
        oracle = IAggregatorV3(_oracle);
        pool = IUniswapV3Pool(_pool);
        loanToken = IERC20(_loanToken);
        collateralToken = IERC20(_collateralToken);
        marketParams = morpho.idToMarketParams(_marketId);
        require(marketParams.loanToken == _loanToken, "loan mismatch");
        require(marketParams.collateralToken == _collateralToken, "coll mismatch");

        loanIsToken0 = (pool.token0() == _loanToken);
        collateralIsToken0 = (pool.token0() == _collateralToken);
        require(loanIsToken0 || pool.token1() == _loanToken, "pool loan");
        require(collateralIsToken0 || pool.token1() == _collateralToken, "pool coll");

        authorizedCaller = _authorizedCaller;
        config = Config({ closeFactorBps: 5_000, minProfit: 1e5, maxOracleDelay: 600 });

        _safeApprove(loanToken, _morpho, type(uint256).max);
    }

    receive() external payable {}

    function setAuthorizedCaller(address caller) external onlyOwner {
        authorizedCaller = caller;
    }

    function setPool(address newPool) external onlyOwner {
        pool = IUniswapV3Pool(newPool);
    }

    function setConfig(Config calldata newConfig) external onlyOwner {
        require(newConfig.closeFactorBps > 0 && newConfig.closeFactorBps <= BPS, "cf");
        require(newConfig.minProfit > 0, "profit");
        config = newConfig;
    }

    function withdraw(address token, address to, uint256 amount) external onlyOwner {
        if (token == address(0)) {
            (bool ok, ) = to.call{ value: amount }("");
            require(ok, "eth send");
        } else {
            _safeTransfer(IERC20(token), to, amount);
        }
    }

    function flashLiquidate(
        address borrower,
        uint256 requestedRepay,
        uint80 prevRoundId,
        uint256 minProfitOverride
    ) external onlyAuthorized nonReentrant {
        // Early oracle gate (fail fast before flash)
        _enforceOracle(prevRoundId);
        FlashContext memory ctx = _buildContext(borrower, requestedRepay, prevRoundId, minProfitOverride);
        bytes memory data = abi.encode(ctx);
        if (loanIsToken0) {
            pool.flash(address(this), ctx.repayAmount, 0, data);
        } else {
            pool.flash(address(this), 0, ctx.repayAmount, data);
        }
    }

    // Debug: only test flash capability (no Morpho, no swap). Requires the contract to hold enough
    // loanToken to pay the Uniswap V3 fee.
    function dbgFlash(uint256 amount) external onlyAuthorized nonReentrant {
        require(amount > 0, "amt");
        _dbgBorrowed = amount;
        _dbgActive = 1;
        if (loanIsToken0) {
            pool.flash(address(this), amount, 0, "");
        } else {
            pool.flash(address(this), 0, amount, "");
        }
        _dbgActive = 0;
    }

    // Debug: only test oracle gate
    function dbgOracle(uint80 prevRoundId) external onlyAuthorized {
        _enforceOracle(prevRoundId);
        emit Dbg("oracle_ok", 0, 0);
    }

    function uniswapV3FlashCallback(uint256 fee0, uint256 fee1, bytes calldata data) external override {
        require(msg.sender == address(pool), "pool");

        // Debug branch: repay principal + fee immediately, no oracle or Morpho calls
        if (_dbgActive == 1) {
            uint256 fee = loanIsToken0 ? fee0 : fee1;
            uint256 owe = _dbgBorrowed + fee;
            require(loanToken.balanceOf(address(this)) >= owe, "dbg insufficient");
            _safeTransfer(loanToken, msg.sender, owe);
            emit Dbg("flash_ok", fee, loanToken.balanceOf(address(this)));
            return;
        }

        FlashContext memory ctx = abi.decode(data, (FlashContext));
        // Oracle already enforced at entry; keep here as safety (in case of callback-only entry)
        _enforceOracle(ctx.prevRoundId);

        uint256 balanceBefore = loanToken.balanceOf(address(this));
        require(balanceBefore >= ctx.repayAmount, "flash missing");
        uint256 storedProfitBefore = balanceBefore - ctx.repayAmount;

        uint256 repayShares = _assetsToShares(
            ctx.repayAmount,
            ctx.totalBorrowAssets,
            ctx.totalBorrowShares
        );
        if (repayShares == 0) repayShares = 1;
        if (repayShares > ctx.borrowerShares) repayShares = ctx.borrowerShares;
        require(repayShares > 0, "no shares");

        emit Dbg("liq_before", repayShares, 0);
        (uint256 repaidAssets,) = morpho.liquidate(
            marketParams,
            ctx.borrower,
            0,
            repayShares,
            ""
        );
        emit Dbg("liq_after", repaidAssets, 0);
        require(repaidAssets >= ctx.repayAmount, "repaid < target");

        uint256 collateralBalance = collateralToken.balanceOf(address(this));
        if (collateralBalance > 0) {
            _swapCollateral(collateralBalance);
        }

        uint256 uniswapFee = loanIsToken0 ? fee0 : fee1;
        uint256 amountOwed = ctx.repayAmount + uniswapFee;
        uint256 balanceAfter = loanToken.balanceOf(address(this));
        if (!(balanceAfter >= storedProfitBefore + amountOwed + ctx.minProfit)) revert MinProfitNotMet();

        _safeTransfer(loanToken, msg.sender, amountOwed);
        uint256 finalBalance = loanToken.balanceOf(address(this));
        uint256 profit = finalBalance > storedProfitBefore
            ? finalBalance - storedProfitBefore
            : 0;
        emit LiquidationExecuted(ctx.borrower, ctx.repayAmount, profit);
    }

    function uniswapV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata
    ) external override {
        require(msg.sender == address(pool), "pool swap");
        if (amount0Delta > 0) {
            _safeTransfer(IERC20(pool.token0()), msg.sender, uint256(amount0Delta));
        }
        if (amount1Delta > 0) {
            _safeTransfer(IERC20(pool.token1()), msg.sender, uint256(amount1Delta));
        }
    }

    function _buildContext(
        address borrower,
        uint256 requestedRepay,
        uint80 prevRoundId,
        uint256 minProfitOverride
    ) internal view returns (FlashContext memory ctx) {
        (
            ,
            ,
            uint128 totalBorrowAssets,
            uint128 totalBorrowShares,
            uint128 _lastUpdate,
            uint128 _fee
        ) = morpho.market(marketId);
        require(totalBorrowShares > 0, "no borrows");
        (, uint128 borrowerShares,) = morpho.position(marketId, borrower);
        require(borrowerShares > 0, "no debt");

        uint256 borrowerDebt = _sharesToAssets(totalBorrowAssets, totalBorrowShares, borrowerShares);
        uint256 maxRepay = (borrowerDebt * config.closeFactorBps) / BPS;
        if (maxRepay == 0) {
            maxRepay = borrowerDebt;
        }

        uint256 repayAmount = requestedRepay;
        if (repayAmount == 0 || repayAmount > maxRepay) {
            repayAmount = maxRepay;
        }
        require(repayAmount > 0, "repay zero");

        ctx = FlashContext({
            borrower: borrower,
            prevRoundId: prevRoundId,
            repayAmount: repayAmount,
            minProfit: minProfitOverride == 0 ? config.minProfit : minProfitOverride,
            borrowerShares: borrowerShares,
            totalBorrowAssets: totalBorrowAssets,
            totalBorrowShares: totalBorrowShares
        });
    }

    function _swapCollateral(uint256 amountIn) internal {
        bool zeroForOne = collateralIsToken0;
        int256 amountSpecified = int256(amountIn);
        uint160 limit = zeroForOne ? MIN_SQRT_RATIO_PLUS : MAX_SQRT_RATIO_MINUS;
        pool.swap(address(this), zeroForOne, amountSpecified, limit, "");
    }

    function _enforceOracle(uint80 prevRoundId) internal view {
        (
            uint80 roundId,
            int256 answer,
            ,
            uint256 updatedAt,
        ) = oracle.latestRoundData();
        if (roundId <= prevRoundId) revert RoundNotAdvanced(prevRoundId, roundId);
        require(answer > 0, "bad price");
        require(block.timestamp <= updatedAt + config.maxOracleDelay, "oracle stale");
    }

    function _assetsToShares(
        uint256 assets,
        uint128 totalAssets,
        uint128 totalShares
    ) internal pure returns (uint256) {
        if (totalShares == 0) return 0;
        return FullMath.mulDiv(assets, totalShares, totalAssets);
    }

    function _sharesToAssets(
        uint128 totalAssets,
        uint128 totalShares,
        uint128 shares
    ) internal pure returns (uint256) {
        if (totalShares == 0) return 0;
        return FullMath.mulDiv(shares, totalAssets, totalShares);
    }

    function _safeTransfer(IERC20 token, address to, uint256 value) internal {
        (bool success, bytes memory data) =
            address(token).call(abi.encodeWithSelector(token.transfer.selector, to, value));
        require(success && (data.length == 0 || abi.decode(data, (bool))), "transfer");
    }

    function _safeApprove(IERC20 token, address spender, uint256 value) internal {
        (bool success, bytes memory data) =
            address(token).call(abi.encodeWithSelector(token.approve.selector, spender, value));
        require(success && (data.length == 0 || abi.decode(data, (bool))), "approve");
    }
}
