// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
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
        returns (uint256 supplyShares, uint128 borrowShares, uint256 collateral);

    function isAuthorized(address authorizer, address authorized) external view returns (bool);
}

interface IPreLiquidation {
    function preLiquidate(
        address borrower,
        uint256 seizedAssets,
        uint256 repaidShares,
        bytes calldata data
    ) external returns (uint256 repaidAssets, uint256 repaidSharesOut);
}

/// @title PreLiqLiquidatorV1
/// @notice Minimal pre-liquidation executor using Uniswap V3 flash to source loan token, then
///         calling a pre-liquidation contract. Price/round/age gating is expected to be enforced
///         by an outer Guarded executor (e.g., GuardedLiquidator.execEncoded).
contract PreLiqLiquidatorV1 is IUniswapV3FlashCallback {
    struct Config {
        uint256 closeFactorBps; // max fraction of borrower debt to repay (bps)
        uint256 minProfit;      // minimum profit in loan token units
    }

    struct FlashContext {
        address preLiq;
        address borrower;
        uint256 repayAmount;
        uint256 minProfit;
        uint128 borrowerShares;
        uint128 totalBorrowAssets;
        uint128 totalBorrowShares;
    }

    event PreLiqExecuted(address indexed borrower, address indexed preLiq, uint256 repayAssets, uint256 profit);
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
        require(msg.sender == owner || msg.sender == authorizedCaller, "not auth");
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
        address _pool,
        address _loanToken,
        address _collateralToken,
        address _authorizedCaller
    ) {
        owner = msg.sender;
        morpho = IMorpho(_morpho);
        marketId = _marketId;
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
        config = Config({ closeFactorBps: 5_000, minProfit: 1e5 });

        _safeApprove(loanToken, address(pool), type(uint256).max);
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

    /// @notice Flash loan loanToken, call preLiquidation, convert collateral to loanToken, repay flash + keep profit.
    function flashPreLiquidate(
        address preLiq,
        address borrower,
        uint256 requestedRepay,
        uint256 minProfitOverride
    ) external onlyAuthorized nonReentrant {
        require(preLiq != address(0) && borrower != address(0), "args");
        require(morpho.isAuthorized(borrower, preLiq), "not authorized");
        FlashContext memory ctx = _buildContext(preLiq, borrower, requestedRepay, minProfitOverride);
        bytes memory data = abi.encode(ctx);
        if (loanIsToken0) {
            pool.flash(address(this), ctx.repayAmount, 0, data);
        } else {
            pool.flash(address(this), 0, ctx.repayAmount, data);
        }
    }

    // Debug: only test flash capability (no Morpho/preLiq, no swap). Requires the contract to
    // hold enough loanToken to pay the Uniswap V3 fee.
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

    function uniswapV3FlashCallback(uint256 fee0, uint256 fee1, bytes calldata data) external override {
        require(msg.sender == address(pool), "pool");

        // Debug branch: repay principal + fee immediately, no preLiq calls
        if (_dbgActive == 1) {
            uint256 fee = loanIsToken0 ? fee0 : fee1;
            uint256 owe = _dbgBorrowed + fee;
            require(loanToken.balanceOf(address(this)) >= owe, "dbg insufficient");
            _safeTransfer(loanToken, msg.sender, owe);
            emit Dbg("flash_ok", fee, loanToken.balanceOf(address(this)));
            return;
        }

        FlashContext memory ctx = abi.decode(data, (FlashContext));

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

        emit Dbg("pre_before", repayShares, 0);
        (uint256 repaidAssets, ) = IPreLiquidation(ctx.preLiq).preLiquidate(
            ctx.borrower,
            0,
            repayShares,
            ""
        );
        emit Dbg("pre_after", repaidAssets, 0);
        require(repaidAssets >= ctx.repayAmount, "repaid < target");

        uint256 collateralBalance = collateralToken.balanceOf(address(this));
        if (collateralBalance > 0) {
            _swapCollateral(collateralBalance);
        }

        uint256 uniswapFee = loanIsToken0 ? fee0 : fee1;
        uint256 amountOwed = ctx.repayAmount + uniswapFee;
        uint256 balanceAfter = loanToken.balanceOf(address(this));
        require(
            balanceAfter >= storedProfitBefore + amountOwed + ctx.minProfit,
            "min profit"
        );

        _safeTransfer(loanToken, msg.sender, amountOwed);
        uint256 finalBalance = loanToken.balanceOf(address(this));
        uint256 profit = finalBalance > storedProfitBefore ? (finalBalance - storedProfitBefore) : 0;
        emit PreLiqExecuted(ctx.borrower, ctx.preLiq, ctx.repayAmount, profit);
    }

    function _buildContext(
        address preLiq,
        address borrower,
        uint256 requestedRepay,
        uint256 minProfitOverride
    ) internal view returns (FlashContext memory ctx) {
        (
            ,
            ,
            uint128 totalBorrowAssets,
            uint128 totalBorrowShares,
            ,
        ) = morpho.market(marketId);
        require(totalBorrowShares > 0, "no borrows");
        (, uint128 borrowerShares,) = morpho.position(marketId, borrower);
        require(borrowerShares > 0, "no debt");

        uint256 borrowerDebt = _sharesToAssets(totalBorrowAssets, totalBorrowShares, borrowerShares);
        uint256 maxRepay = (borrowerDebt * config.closeFactorBps) / BPS;
        if (maxRepay == 0) maxRepay = borrowerDebt;

        uint256 repayAmount = requestedRepay;
        if (repayAmount == 0 || repayAmount > maxRepay) repayAmount = maxRepay;
        require(repayAmount > 0, "repay zero");

        ctx = FlashContext({
            preLiq: preLiq,
            borrower: borrower,
            repayAmount: repayAmount,
            minProfit: minProfitOverride == 0 ? config.minProfit : minProfitOverride,
            borrowerShares: borrowerShares,
            totalBorrowAssets: totalBorrowAssets,
            totalBorrowShares: totalBorrowShares
        });
    }

    function _swapCollateral(uint256 amountIn) internal {
        bool zeroForOne = (address(collateralToken) == pool.token0());
        int256 amountSpecified = int256(amountIn);
        uint160 limit = zeroForOne ? MIN_SQRT_RATIO_PLUS : MAX_SQRT_RATIO_MINUS;
        pool.swap(address(this), zeroForOne, amountSpecified, limit, "");
    }

    function _assetsToShares(
        uint256 assets,
        uint128 totalAssets,
        uint128 totalShares
    ) internal pure returns (uint256) {
        if (totalShares == 0) return 0;
        unchecked {
            return (assets * uint256(totalShares)) / uint256(totalAssets);
        }
    }

    function _sharesToAssets(
        uint128 totalAssets,
        uint128 totalShares,
        uint128 shares
    ) internal pure returns (uint256) {
        if (totalShares == 0) return 0;
        unchecked {
            return (uint256(shares) * uint256(totalAssets)) / uint256(totalShares);
        }
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

