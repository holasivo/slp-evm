// SPDX-License-Identifier: BUSL-1.1
// Compatible with OpenZeppelin Contracts ^5.0.0
pragma solidity 0.8.35;

import {AggregatorV3Interface} from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";
import {IERC20Metadata as IERC20} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {AccessManagedUpgradeable} from "@openzeppelin/contracts-upgradeable/access/manager/AccessManagedUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BeforeSwapDelta, toBeforeSwapDelta} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BaseHookUpgradeable} from "./BaseHookUpgradeable.sol";
import {OracleGate} from "./OracleGate.sol";
import {UniswapHookOptions} from "./UniswapHookOptions.sol";
import {ISLP} from "./interfaces/ISLP.sol";
import {IUniswapHook} from "./interfaces/IUniswapHook.sol";

/// @title UniswapHook - Oracle-Priced Uniswap v4 Hook
/// @author Sivo
/// @notice One hook serving both SLP pools (SLP/USDC and SLP/USDT). Deposits
/// swap a stablecoin for freshly minted SLP at the exact Chainlink NAV price;
/// exits queue SLP for asynchronous redemption, filled FIFO by inbound
/// deposits and operator replenishment at the oracle price current at fill
/// time. Conversions value the stablecoin at par, so deposits and fills are
/// additionally gated on the stablecoin's own Chainlink USD feed sitting
/// inside a tight peg band — a depegged stablecoin can neither mint SLP at
/// par nor drain the other stablecoin's reserve at par (M001). Stablecoin
/// received from deposits is sweepable by Sivo for RWA deployment, except
/// the portion reserved for filled-but-unclaimed withdrawals.
/// @dev The pools hold zero curve liquidity: beforeSwap fully absorbs every
/// swap via BeforeSwapDelta custom accounting, so the AMM curve never prices
/// anything. Third-party liquidity and donations are blocked. Only the
/// stable-to-SLP direction swaps; SLP exits must use requestWithdraw.
/// Privileged operations are restricted through a central OpenZeppelin
/// AccessManager.
/// @custom:security-contact security@sivo.com
contract UniswapHook is
    Initializable,
    BaseHookUpgradeable,
    OracleGate,
    UniswapHookOptions,
    IUniswapHook,
    PausableUpgradeable,
    AccessManagedUpgradeable,
    ReentrancyGuardTransient,
    UUPSUpgradeable
{
    /// @notice Tick spacing of the sanctioned pools; never used for pricing
    /// because the pools hold no curve liquidity
    int24 public constant TICK_SPACING = 60;

    /// @notice Maximum queue entries visited by the auto-fill pass that runs
    /// inside deposit swaps, keeping router gas estimates bounded
    uint256 public constant AUTO_FILL_MAX = 5;

    /// @notice Minimum cancelled (tombstoned) entries a fill pass may skip,
    /// on a budget separate from the live-fill iteration bound so a wall of
    /// dead entries cannot starve the pass while its gas stays bounded (L003)
    uint256 public constant FILL_SKIP_MAX = 25;

    struct WithdrawRequest {
        address controller;
        uint96 slpRemaining;
    }

    struct AssetQueue {
        uint128 head;
        uint128 tail;
        uint256 totalPendingShares;
        uint256 totalClaimableAssets;
        mapping(uint256 requestId => WithdrawRequest) requests;
        mapping(address controller => uint256) pendingOf;
        mapping(address controller => uint256) claimableOf;
        mapping(address controller => uint256[]) requestIdsOf;
    }

    /// @custom:storage-location erc7201:sivo.storage.UniswapHook
    struct UniswapHookStorage {
        mapping(address asset => AssetQueue) _queues;
        mapping(address controller => mapping(address operator => bool)) _isOperator;
    }

    // keccak256(abi.encode(uint256(keccak256("sivo.storage.UniswapHook")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant UniswapHookStorageLocation =
        0x49786923c3f05b3ea89d37306ef6cb11cceac91528777e1b30898ba7ac79f800;

    function _getUniswapHookStorage()
        internal
        pure
        returns (UniswapHookStorage storage $)
    {
        assembly {
            $.slot := UniswapHookStorageLocation
        }
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor(
        IPoolManager poolManager_
    ) BaseHookUpgradeable(poolManager_) {
        _disableInitializers();
    }

    function initialize(Options memory options) public initializer {
        if (options.authority == address(0) || options.oracle == address(0)) {
            revert UniswapHookZeroAddress();
        }
        __Pausable_init();
        __AccessManaged_init(options.authority);
        __OracleGate_init(
            options.oracle,
            options.price_min,
            options.price_max,
            options.max_staleness
        );
        __UniswapHookOptions_init(
            options.slp,
            options.asset0,
            options.asset1,
            options.min_request_shares
        );
        _setAssetOracle(options.asset0, options.asset0_oracle);
        _setAssetOracle(options.asset1, options.asset1_oracle);
        _validateHookAddress();
    }

    /// @inheritdoc BaseHookUpgradeable
    function getHookPermissions()
        public
        pure
        override
        returns (Hooks.Permissions memory)
    {
        return
            Hooks.Permissions({
                beforeInitialize: true,
                afterInitialize: false,
                beforeAddLiquidity: true,
                afterAddLiquidity: false,
                beforeRemoveLiquidity: false,
                afterRemoveLiquidity: false,
                beforeSwap: true,
                afterSwap: false,
                beforeDonate: true,
                afterDonate: false,
                beforeSwapReturnDelta: true,
                afterSwapReturnDelta: false,
                afterAddLiquidityReturnDelta: false,
                afterRemoveLiquidityReturnDelta: false
            });
    }

    /// @notice The sanctioned pool key pairing SLP with a supported stablecoin
    /// @param asset The supported stablecoin
    /// @return key The pool key (currencies sorted by address, fee 0)
    function poolKey(address asset) public view returns (PoolKey memory key) {
        _requireSupportedAsset(asset);
        address slp_ = slp();
        (address c0, address c1) = slp_ < asset ? (slp_, asset) : (asset, slp_);
        return
            PoolKey({
                currency0: Currency.wrap(c0),
                currency1: Currency.wrap(c1),
                fee: 0,
                tickSpacing: TICK_SPACING,
                hooks: IHooks(address(this))
            });
    }

    // ---------------------------------------------------------------------
    // Uniswap v4 hook callbacks
    // ---------------------------------------------------------------------

    /// @notice Rejects initialization of any pool other than the two
    /// sanctioned SLP/stablecoin pools
    function beforeInitialize(
        address,
        PoolKey calldata key,
        uint160
    ) external view onlyPoolManager returns (bytes4) {
        address c0 = Currency.unwrap(key.currency0);
        address c1 = Currency.unwrap(key.currency1);
        address slp_ = slp();
        address other = c0 == slp_ ? c1 : c0;
        bool pairsSlp = c0 == slp_ || c1 == slp_;
        if (
            !pairsSlp ||
            !isSupportedAsset(other) ||
            key.fee != 0 ||
            key.tickSpacing != TICK_SPACING
        ) {
            revert UniswapHookUnsupportedPool();
        }
        return IHooks.beforeInitialize.selector;
    }

    /// @notice Liquidity can never be added: the pools are custom-accounted
    /// and hold zero curve liquidity by construction
    function beforeAddLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        bytes calldata
    ) external view onlyPoolManager returns (bytes4) {
        revert UniswapHookLiquidityNotAllowed();
    }

    /// @notice Donations are blocked (they would revert on a zero-liquidity
    /// pool anyway; explicit is better)
    function beforeDonate(
        address,
        PoolKey calldata,
        uint256,
        uint256,
        bytes calldata
    ) external view onlyPoolManager returns (bytes4) {
        revert UniswapHookDonateNotAllowed();
    }

    /// @notice Clears a stable-to-SLP swap at the exact oracle price via
    /// custom accounting, then runs a bounded withdrawal-queue fill pass with
    /// the stablecoin just received
    /// @dev The hook takes the input stablecoin as real ERC-20 (sweepable),
    /// mints fresh SLP, and settles it to the PoolManager. The returned
    /// BeforeSwapDelta consumes the entire swap so the curve is bypassed.
    /// hookData may carry abi.encode(depositor, receiver) (set by this
    /// contract's own deposit()) for precise event attribution; router swaps
    /// leave it empty.
    function beforeSwap(
        address sender,
        PoolKey calldata key,
        SwapParams calldata params,
        bytes calldata hookData
    )
        external
        onlyPoolManager
        whenNotPaused
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        (Currency input, Currency output) = params.zeroForOne
            ? (key.currency0, key.currency1)
            : (key.currency1, key.currency0);
        if (Currency.unwrap(input) == slp()) revert UniswapHookExitViaQueue();
        // Defense in depth: beforeInitialize already rejects unsanctioned
        // pool keys, but re-validate here so a swap can never move anything
        // other than freshly minted SLP against a supported stablecoin, even
        // if a pool were somehow created around that gate
        if (Currency.unwrap(output) != slp()) revert UniswapHookUnsupportedPool();
        _requireSupportedAsset(Currency.unwrap(input));
        BeforeSwapDelta delta = _depositSwap(sender, input, output, params, hookData);
        return (IHooks.beforeSwap.selector, delta, 0);
    }

    /// @notice Executes the oracle-priced deposit leg of beforeSwap
    function _depositSwap(
        address sender,
        Currency input,
        Currency output,
        SwapParams calldata params,
        bytes calldata hookData
    ) private returns (BeforeSwapDelta) {
        address asset = Currency.unwrap(input);
        _requireAssetPegged(asset);
        (uint256 price, uint8 priceDecimals) = _freshPrice();
        (uint256 assetsIn, uint256 sharesOut) = _quote(
            asset,
            price,
            priceDecimals,
            params.amountSpecified
        );
        if (assetsIn == 0 || sharesOut == 0) revert UniswapHookZeroAmount();

        poolManager.take(input, address(this), assetsIn);
        ISLP(slp()).mint(address(this), sharesOut);
        _settleCurrency(output, sharesOut);

        _emitDeposit(sender, asset, assetsIn, sharesOut, hookData);
        _fill(asset, price, priceDecimals, AUTO_FILL_MAX);

        int128 unspecifiedDelta = params.amountSpecified < 0
            ? -SafeCast.toInt128(int256(sharesOut))
            : SafeCast.toInt128(int256(assetsIn));
        return
            toBeforeSwapDelta(
                SafeCast.toInt128(-params.amountSpecified),
                unspecifiedDelta
            );
    }

    /// @notice Emits the Deposit event, attributing depositor and receiver
    /// from hookData when this contract's own deposit() supplied them
    function _emitDeposit(
        address sender,
        address asset,
        uint256 assetsIn,
        uint256 sharesOut,
        bytes calldata hookData
    ) private {
        (address depositor, address receiver) = hookData.length == 64
            ? abi.decode(hookData, (address, address))
            : (sender, address(0));
        emit Deposit(depositor, receiver, asset, assetsIn, sharesOut);
    }

    /// @notice Converts between stablecoin and SLP amounts at the oracle price
    /// @dev Rounding always favors the protocol: SLP out rounds down, stable
    /// in rounds up. The stablecoin is valued at par: callers gate on
    /// _requireAssetPegged first, so the par assumption is only ever applied
    /// while the stablecoin's own USD feed sits inside its peg band (M001).
    function _quote(
        address asset,
        uint256 price,
        uint8 priceDecimals,
        int256 amountSpecified
    ) private view returns (uint256 assetsIn, uint256 sharesOut) {
        uint256 shareBasis = 10 ** uint256(priceDecimals) *
            10 ** uint256(slpDecimals());
        uint256 assetBasis = price * 10 ** uint256(assetDecimals(asset));
        if (amountSpecified < 0) {
            // exact input: specified is the stablecoin paid in
            assetsIn = uint256(-amountSpecified);
            sharesOut = Math.mulDiv(assetsIn, shareBasis, assetBasis);
        } else {
            // exact output: specified is the SLP received
            sharesOut = uint256(amountSpecified);
            assetsIn = Math.mulDiv(
                sharesOut,
                assetBasis,
                shareBasis,
                Math.Rounding.Ceil
            );
        }
    }

    // ---------------------------------------------------------------------
    // Deposit
    // ---------------------------------------------------------------------

    /// @inheritdoc IUniswapHook
    /// @dev Economically identical to a pool swap — the pool's custom curve
    /// prices at the same oracle read — but executed directly: the
    /// PoolManager skips beforeSwap when a hook swaps its own pool, so this
    /// convenience entrypoint mints at the oracle price without routing
    /// through the pool. Router and aggregator flow still swaps through the
    /// pool via beforeSwap.
    function deposit(
        address asset,
        uint256 assets,
        address receiver
    ) external nonReentrant whenNotPaused returns (uint256 shares) {
        _requireSupportedAsset(asset);
        if (receiver == address(0)) revert UniswapHookZeroAddress();
        _requireAssetPegged(asset);
        (uint256 price, uint8 priceDecimals) = _freshPrice();
        (, shares) = _quote(asset, price, priceDecimals, -SafeCast.toInt256(assets));
        if (assets == 0 || shares == 0) revert UniswapHookZeroAmount();
        SafeERC20.safeTransferFrom(
            IERC20(asset),
            msg.sender,
            address(this),
            assets
        );
        ISLP(slp()).mint(receiver, shares);
        emit Deposit(msg.sender, receiver, asset, assets, shares);
        _fill(asset, price, priceDecimals, AUTO_FILL_MAX);
    }

    // ---------------------------------------------------------------------
    // Withdrawal queue
    // ---------------------------------------------------------------------

    /// @inheritdoc IUniswapHook
    function requestWithdraw(
        address asset,
        uint256 shares
    ) external nonReentrant whenNotPaused returns (uint256 requestId) {
        _requireSupportedAsset(asset);
        uint256 minShares = minRequestShares();
        if (shares < minShares || shares == 0) {
            revert UniswapHookRequestTooSmall(shares, minShares);
        }
        SafeERC20.safeTransferFrom(
            IERC20(slp()),
            msg.sender,
            address(this),
            shares
        );
        AssetQueue storage q = _getUniswapHookStorage()._queues[asset];
        requestId = q.tail++;
        q.requests[requestId] = WithdrawRequest({
            controller: msg.sender,
            slpRemaining: SafeCast.toUint96(shares)
        });
        q.pendingOf[msg.sender] += shares;
        q.requestIdsOf[msg.sender].push(requestId);
        q.totalPendingShares += shares;
        emit RedeemRequest(msg.sender, asset, requestId, msg.sender, shares);
    }

    /// @inheritdoc IUniswapHook
    function cancelWithdraw(
        address asset,
        uint256 shares
    ) external nonReentrant whenNotPaused {
        _cancelWithdraw(asset, shares, msg.sender);
    }

    /// @inheritdoc IUniswapHook
    function cancelWithdraw(
        address asset,
        uint256 shares,
        address controller
    ) external nonReentrant whenNotPaused {
        _requireOperator(controller);
        _cancelWithdraw(asset, shares, controller);
    }

    /// @notice Cancels unfilled queued SLP, newest requests first, and returns
    /// it to the controller
    /// @dev Requests are pushed in ascending id order and only ever removed
    /// from the back, so the list's last entry is always the controller's
    /// newest: draining from the back preserves the FIFO priority of their
    /// older requests. Retired entries (drained here, or already consumed by
    /// a fill or an id-based cancel) are popped off the list as the walk
    /// passes them, so the walk's cost tracks the requests it retires rather
    /// than the controller's lifetime request count (L004). Only the last
    /// entry the walk touches can be left partially cancelled, and it must
    /// keep at least minRequestShares (or be fully drained), so a
    /// cancellation can never leave a sub-minimum live entry in the
    /// queue (M002). Cancellation then cleans up after itself: it advances
    /// q.head past tombstoned entries, capped at the number of entries this
    /// call drained so a canceller never pays to walk someone else's
    /// backlog (L003)
    function _cancelWithdraw(
        address asset,
        uint256 shares,
        address controller
    ) private {
        _requireSupportedAsset(asset);
        if (shares == 0) revert UniswapHookZeroAmount();
        AssetQueue storage q = _getUniswapHookStorage()._queues[asset];
        uint256 pending = q.pendingOf[controller];
        if (shares > pending) {
            revert UniswapHookInsufficientPending(shares, pending);
        }
        uint256 minShares = minRequestShares();
        uint256[] storage ids = q.requestIdsOf[controller];
        uint256 remainingToCancel = shares;
        uint256 drained = 0;
        // pendingOf is the sum of slpRemaining over the controller's listed
        // requests, so the list cannot run out while shares remain to cancel
        while (remainingToCancel > 0) {
            WithdrawRequest storage r = q.requests[ids[ids.length - 1]];
            uint256 available = r.slpRemaining;
            if (available == 0) {
                // retired by a fill or an id-based cancel; prune (L004)
                ids.pop();
                continue;
            }
            uint256 cancelled = Math.min(available, remainingToCancel);
            uint256 residual = available - cancelled;
            if (residual != 0 && residual < minShares) {
                revert UniswapHookResidualTooSmall(residual, minShares);
            }
            r.slpRemaining = uint96(residual);
            if (residual == 0) {
                ids.pop();
                drained++;
            }
            remainingToCancel -= cancelled;
        }
        if (drained != 0) _sweepHead(q, drained);
        q.pendingOf[controller] = pending - shares;
        q.totalPendingShares -= shares;
        SafeERC20.safeTransfer(IERC20(slp()), controller, shares);
        emit RedeemCancel(controller, asset, msg.sender, shares);
    }

    /// @inheritdoc IUniswapHook
    function cancelWithdrawByIds(
        address asset,
        uint256[] calldata requestIds
    ) external nonReentrant whenNotPaused {
        _cancelWithdrawByIds(asset, requestIds, msg.sender);
    }

    /// @inheritdoc IUniswapHook
    function cancelWithdrawByIds(
        address asset,
        uint256[] calldata requestIds,
        address controller
    ) external nonReentrant whenNotPaused {
        _requireOperator(controller);
        _cancelWithdrawByIds(asset, requestIds, controller);
    }

    /// @notice Cancels the full unfilled remainder of each listed request and
    /// returns the SLP to the controller
    /// @dev Bounded alternative to the amount-based cancel walk: the work is
    /// proportional to the ids listed rather than to the controller's request
    /// history, so a cancellation can always be sized to fit one
    /// transaction (L004). Each listed request must belong to the controller
    /// and still hold unfilled SLP, so a duplicated id reverts on its second
    /// occurrence. Whole entries are drained, never split, so the
    /// minRequestShares residual floor (M002) cannot be tripped. The retired
    /// ids stay in requestIdsOf — their positions are unknown here — and the
    /// amount-based cancel walk prunes them when it reaches them
    function _cancelWithdrawByIds(
        address asset,
        uint256[] calldata requestIds,
        address controller
    ) private {
        _requireSupportedAsset(asset);
        if (requestIds.length == 0) revert UniswapHookZeroAmount();
        AssetQueue storage q = _getUniswapHookStorage()._queues[asset];
        uint256 shares = 0;
        for (uint256 i = 0; i < requestIds.length; i++) {
            WithdrawRequest storage r = q.requests[requestIds[i]];
            uint256 available = r.slpRemaining;
            if (r.controller != controller || available == 0) {
                revert UniswapHookRequestNotCancellable(
                    requestIds[i],
                    controller
                );
            }
            r.slpRemaining = 0;
            shares += available;
        }
        _sweepHead(q, requestIds.length);
        q.pendingOf[controller] -= shares;
        q.totalPendingShares -= shares;
        SafeERC20.safeTransfer(IERC20(slp()), controller, shares);
        emit RedeemCancel(controller, asset, msg.sender, shares);
    }

    /// @notice Advances the queue head past tombstoned entries, capped at the
    /// number of entries the caller just drained so a canceller never pays to
    /// walk someone else's backlog (L003)
    function _sweepHead(AssetQueue storage q, uint256 drained) private {
        uint128 head = q.head;
        uint128 tail = q.tail;
        uint128 newHead = head;
        while (
            drained != 0 &&
            newHead < tail &&
            q.requests[newHead].slpRemaining == 0
        ) {
            newHead++;
            drained--;
        }
        if (newHead != head) q.head = newHead;
    }

    /// @inheritdoc IUniswapHook
    function claimWithdraw(
        address asset,
        address receiver
    ) external nonReentrant whenNotPaused returns (uint256 assets) {
        return _claimWithdraw(asset, receiver, msg.sender);
    }

    /// @inheritdoc IUniswapHook
    function claimWithdraw(
        address asset,
        address receiver,
        address controller
    ) external nonReentrant whenNotPaused returns (uint256 assets) {
        _requireOperator(controller);
        return _claimWithdraw(asset, receiver, controller);
    }

    /// @notice Pays out the controller's full claimable balance
    /// @dev Not gated on oracle health: the redemption price was locked when
    /// the requests were filled (parity with the legacy Vault's M003 behavior)
    function _claimWithdraw(
        address asset,
        address receiver,
        address controller
    ) private returns (uint256 assets) {
        _requireSupportedAsset(asset);
        if (receiver == address(0)) revert UniswapHookZeroAddress();
        AssetQueue storage q = _getUniswapHookStorage()._queues[asset];
        assets = q.claimableOf[controller];
        if (assets == 0) {
            revert UniswapHookNothingToClaim(controller, asset);
        }
        delete q.claimableOf[controller];
        q.totalClaimableAssets -= assets;
        SafeERC20.safeTransfer(IERC20(asset), receiver, assets);
        emit Withdraw(msg.sender, receiver, asset, assets, 0);
    }

    /// @inheritdoc IUniswapHook
    function fill(
        address asset,
        uint256 maxIterations
    ) external restricted nonReentrant whenNotPaused returns (uint256 assets) {
        _requireSupportedAsset(asset);
        _requireAssetPegged(asset);
        (uint256 price, uint8 priceDecimals) = _freshPrice();
        return _fill(asset, price, priceDecimals, maxIterations);
    }

    /// @inheritdoc IUniswapHook
    function replenish(
        address asset,
        uint256 assets,
        uint256 maxIterations
    ) external restricted nonReentrant whenNotPaused {
        _requireSupportedAsset(asset);
        if (assets == 0) revert UniswapHookZeroAmount();
        SafeERC20.safeTransferFrom(
            IERC20(asset),
            msg.sender,
            address(this),
            assets
        );
        emit UniswapHookReplenish(asset, msg.sender, assets);
        _requireAssetPegged(asset);
        (uint256 price, uint8 priceDecimals) = _freshPrice();
        _fill(asset, price, priceDecimals, maxIterations);
    }

    /// @notice Fills the queue FIFO from the hook's free stablecoin at the
    /// current oracle price, burning the filled SLP and reserving the
    /// stablecoin for claims
    /// @dev Partial fills are supported; the fill price is locked per filled
    /// portion at fill time. Dust requests whose value rounds to zero
    /// stablecoin are consumed without credit so they cannot wedge the queue.
    /// Cancelled (tombstoned) entries are skipped on a separate budget of
    /// max(maxIterations, FILL_SKIP_MAX) so they cannot consume the live-fill
    /// iteration bound (L003); q.head persists even when a pass only skips,
    /// so each tombstone costs the queue at most one skip ever.
    struct FillState {
        uint256 budget;
        uint256 shareBasis;
        uint256 assetBasis;
        uint256 sharesBurned;
        uint256 assetsFilled;
        uint256 head;
        uint256 tail;
    }

    function _fill(
        address asset,
        uint256 price,
        uint8 priceDecimals,
        uint256 maxIterations
    ) private returns (uint256) {
        AssetQueue storage q = _getUniswapHookStorage()._queues[asset];
        FillState memory s;
        s.budget = _freeBalance(asset, q);
        s.shareBasis =
            10 ** uint256(priceDecimals) *
            10 ** uint256(slpDecimals());
        s.assetBasis = price * 10 ** uint256(assetDecimals(asset));
        s.head = q.head;
        s.tail = q.tail;
        uint256 skipBudget = Math.max(maxIterations, FILL_SKIP_MAX);
        for (uint256 fills = 0; fills < maxIterations && s.head < s.tail; ) {
            if (q.requests[s.head].slpRemaining == 0) {
                // cancelled (tombstoned) entry: skip without consuming the
                // live-fill budget (L003)
                if (skipBudget == 0) break;
                skipBudget--;
                s.head++;
                continue;
            }
            fills++;
            if (!_fillOne(q, s, asset)) break;
        }
        q.head = SafeCast.toUint128(s.head);
        if (s.sharesBurned != 0) ISLP(slp()).burn(s.sharesBurned);
        return s.assetsFilled;
    }

    /// @notice Fills the live request at the queue head; the caller has
    /// already skipped tombstoned entries, so slpRemaining is nonzero here
    /// @return cont False when the fill budget is exhausted
    function _fillOne(
        AssetQueue storage q,
        FillState memory s,
        address asset
    ) private returns (bool cont) {
        WithdrawRequest storage r = q.requests[s.head];
        uint256 remaining = r.slpRemaining;
        uint256 owed = Math.mulDiv(remaining, s.assetBasis, s.shareBasis);
        uint256 assets_;
        uint256 shares_;
        if (owed == 0) {
            // dust whose value rounds to zero: consume without credit so it
            // cannot wedge the queue
            shares_ = remaining;
        } else if (owed <= s.budget) {
            assets_ = owed;
            shares_ = remaining;
        } else {
            assets_ = s.budget;
            shares_ = Math.mulDiv(
                assets_,
                s.shareBasis,
                s.assetBasis,
                Math.Rounding.Ceil
            );
            if (shares_ > remaining) shares_ = remaining;
            if (shares_ == 0) return false;
        }
        r.slpRemaining = uint96(remaining - shares_);
        q.pendingOf[r.controller] -= shares_;
        q.totalPendingShares -= shares_;
        if (assets_ != 0) {
            q.claimableOf[r.controller] += assets_;
            q.totalClaimableAssets += assets_;
            s.budget -= assets_;
        }
        s.sharesBurned += shares_;
        s.assetsFilled += assets_;
        emit RedeemClaimable(r.controller, asset, assets_, shares_);
        if (r.slpRemaining == 0) s.head++;
        return s.budget != 0;
    }

    // ---------------------------------------------------------------------
    // Operator delegation
    // ---------------------------------------------------------------------

    /// @inheritdoc IUniswapHook
    function setOperator(
        address operator,
        bool approved
    ) external returns (bool) {
        _getUniswapHookStorage()._isOperator[msg.sender][operator] = approved;
        emit OperatorSet(msg.sender, operator, approved);
        return true;
    }

    /// @inheritdoc IUniswapHook
    function isOperator(
        address controller,
        address operator
    ) public view returns (bool) {
        return _getUniswapHookStorage()._isOperator[controller][operator];
    }

    function _requireOperator(address controller) private view {
        if (msg.sender != controller && !isOperator(controller, msg.sender)) {
            revert UniswapHookUnauthorizedSender(msg.sender, controller);
        }
    }

    // ---------------------------------------------------------------------
    // Sivo operations
    // ---------------------------------------------------------------------

    /// @inheritdoc IUniswapHook
    function sweep(
        address asset,
        address to
    ) external restricted nonReentrant returns (uint256 assets) {
        _requireSupportedAsset(asset);
        if (to == address(0)) revert UniswapHookZeroAddress();
        AssetQueue storage q = _getUniswapHookStorage()._queues[asset];
        assets = _freeBalance(asset, q);
        if (assets != 0) SafeERC20.safeTransfer(IERC20(asset), to, assets);
        emit UniswapHookSweep(asset, to, assets);
    }

    /// @notice Atomically updates the oracle, staleness duration, and price band
    /// @dev Restricted through the AccessManager. See OracleGate._setOracle.
    /// The oracle is this contract's pricing source, so it cannot be unset.
    /// @param oracle_ The new Chainlink oracle address
    /// @param maxStaleness_ The new maximum staleness in seconds
    /// @param priceMin_ The new minimum acceptable price
    /// @param priceMax_ The new maximum acceptable price
    function setOracle(
        address oracle_,
        uint256 maxStaleness_,
        int256 priceMin_,
        int256 priceMax_
    ) external restricted {
        if (oracle_ == address(0)) revert UniswapHookZeroAddress();
        _setOracle(oracle_, maxStaleness_, priceMin_, priceMax_);
    }

    /// @notice Atomically updates a stablecoin's own USD feed, staleness
    /// duration, and peg band
    /// @dev Restricted through the AccessManager. The feed gates every
    /// deposit and fill of the asset to the peg band (it never enters the
    /// conversion arithmetic), and the gate is what makes the par assumption
    /// safe, so it cannot be unset. Setting the feed and its band together
    /// revalidates the band against the new feed's decimal basis, mirroring
    /// setOracle.
    /// @param asset The supported stablecoin the feed prices
    /// @param oracle_ The asset's new Chainlink USD feed
    /// @param maxStaleness_ The new maximum staleness in seconds
    /// @param pegMin_ The new minimum acceptable asset price
    /// @param pegMax_ The new maximum acceptable asset price
    function setAssetOracle(
        address asset,
        address oracle_,
        uint256 maxStaleness_,
        int256 pegMin_,
        int256 pegMax_
    ) external restricted {
        _requireSupportedAsset(asset);
        _setAssetOracle(asset, oracle_, maxStaleness_, pegMin_, pegMax_);
    }

    /// @notice Validates and stores a stablecoin's USD feed configuration,
    /// caching the feed decimals
    function _setAssetOracle(
        address asset,
        address oracle_,
        uint256 maxStaleness_,
        int256 pegMin_,
        int256 pegMax_
    ) private {
        if (oracle_ == address(0)) revert UniswapHookZeroAddress();
        _validateOracle(oracle_, pegMin_, pegMax_);
        AssetConfig storage cfg = _getUniswapHookOptionsStorage()._assetConfig[
            asset
        ];
        cfg.oracle = oracle_;
        cfg.oracleDecimals = AggregatorV3Interface(oracle_).decimals();
        cfg.maxStaleness = maxStaleness_;
        cfg.pegMin = pegMin_;
        cfg.pegMax = pegMax_;
        emit UniswapHookAssetOracleChange(
            asset,
            oracle_,
            maxStaleness_,
            pegMin_,
            pegMax_
        );
    }

    /// @notice Convenience overload taking the initializer's options form
    function _setAssetOracle(address asset, AssetOracle memory o) private {
        _setAssetOracle(asset, o.oracle, o.max_staleness, o.peg_min, o.peg_max);
    }

    /// @notice Reverts unless the stablecoin's own USD feed reports a fresh
    /// price inside its peg band
    /// @dev Pure circuit breaker (M001): conversions value the stablecoin at
    /// par, so this gate is what keeps a depegged stablecoin from minting SLP
    /// at par or draining the other stablecoin's reserve at par. The feed
    /// price never enters the conversion arithmetic. Reverts when the feed is
    /// unset, erroring, incomplete, stale, or outside the band — an
    /// ungateable stablecoin is never assumed to be at par.
    function _requireAssetPegged(address asset) private view {
        AssetConfig storage cfg = _getUniswapHookOptionsStorage()._assetConfig[
            asset
        ];
        address oracle_ = cfg.oracle;
        if (oracle_ == address(0)) revert UniswapHookAssetOracleUnset(asset);
        uint256 maxStaleness_ = cfg.maxStaleness;
        int256 pegMin_ = cfg.pegMin;
        int256 pegMax_ = cfg.pegMax;
        (
            PriceStatus status,
            uint80 roundId,
            int256 answer,
            uint256 updatedAt,
            uint80 answeredInRound
        ) = _checkFeed(oracle_, maxStaleness_, pegMin_, pegMax_);
        _requireInRange(
            status,
            roundId,
            answer,
            updatedAt,
            answeredInRound,
            maxStaleness_,
            pegMin_,
            pegMax_
        );
    }

    /// @notice Evaluates a stablecoin's own USD feed against its peg band
    /// @dev External, non-reverting view for off-chain monitoring, mirroring
    /// priceStatus() for the NAV feed. Anything but InRange means deposits
    /// and fills for the asset are currently blocked. An unset feed reports
    /// OracleError: the asset is ungateable either way.
    /// @param asset The supported stablecoin
    /// @return status The outcome of the price evaluation
    function assetPriceStatus(
        address asset
    ) external view returns (PriceStatus status) {
        return _assetPriceStatus(asset);
    }

    /// @notice Evaluates every feed the protocol depends on, in one call
    /// @dev Off-chain monitoring convenience: deposits and fills for a
    /// stablecoin are blocked unless its status AND the SLP NAV status are
    /// both InRange. The asset statuses are ordered like supportedAssets().
    /// @return slpStatus The SLP/USD NAV feed status
    /// @return asset0Status The first supported stablecoin's peg status
    /// @return asset1Status The second supported stablecoin's peg status
    function oracleStatus()
        external
        view
        returns (
            PriceStatus slpStatus,
            PriceStatus asset0Status,
            PriceStatus asset1Status
        )
    {
        (slpStatus, , , , ) = _checkPrice();
        (address asset0, address asset1) = supportedAssets();
        asset0Status = _assetPriceStatus(asset0);
        asset1Status = _assetPriceStatus(asset1);
    }

    /// @notice Non-reverting variant of the asset feed check
    function _assetPriceStatus(
        address asset
    ) private view returns (PriceStatus status) {
        AssetConfig storage cfg = _getUniswapHookOptionsStorage()._assetConfig[
            asset
        ];
        if (cfg.oracle == address(0)) return PriceStatus.OracleError;
        (status, , , , ) = _checkFeed(
            cfg.oracle,
            cfg.maxStaleness,
            cfg.pegMin,
            cfg.pegMax
        );
    }

    /// @notice Updates the minimum SLP amount per withdrawal request
    /// @dev Restricted through the AccessManager; guards the queue against
    /// dust-request griefing
    /// @param minRequestShares_ The new minimum SLP amount
    function setMinRequestShares(
        uint256 minRequestShares_
    ) external restricted {
        _getUniswapHookOptionsStorage()._minRequestShares = minRequestShares_;
        emit UniswapHookMinRequestChange(minRequestShares_);
    }

    /// @notice Pauses swaps, deposits, and the entire queue lifecycle
    /// @dev Restricted through the AccessManager
    function pause() external restricted {
        _pause();
    }

    /// @notice Unpauses the contract
    /// @dev Restricted through the AccessManager
    function unpause() external restricted {
        _unpause();
    }

    function _authorizeUpgrade(
        address newImplementation
    ) internal override restricted {}

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @inheritdoc IUniswapHook
    function pendingWithdraw(
        address asset,
        address controller
    ) external view returns (uint256) {
        return _getUniswapHookStorage()._queues[asset].pendingOf[controller];
    }

    /// @inheritdoc IUniswapHook
    function claimableWithdraw(
        address asset,
        address controller
    ) external view returns (uint256) {
        return _getUniswapHookStorage()._queues[asset].claimableOf[controller];
    }

    /// @inheritdoc IUniswapHook
    function totalPendingShares(address asset) external view returns (uint256) {
        return _getUniswapHookStorage()._queues[asset].totalPendingShares;
    }

    /// @inheritdoc IUniswapHook
    function totalClaimableAssets(
        address asset
    ) external view returns (uint256) {
        return _getUniswapHookStorage()._queues[asset].totalClaimableAssets;
    }

    /// @inheritdoc IUniswapHook
    function sweepable(address asset) external view returns (uint256) {
        return
            _freeBalance(asset, _getUniswapHookStorage()._queues[asset]);
    }

    /// @inheritdoc IUniswapHook
    function queueLength(address asset) external view returns (uint256) {
        return _getUniswapHookStorage()._queues[asset].tail;
    }

    /// @inheritdoc IUniswapHook
    function maxDeposit(address asset) external view returns (uint256) {
        if (
            !isSupportedAsset(asset) ||
            paused() ||
            !_priceInRange() ||
            _assetPriceStatus(asset) != PriceStatus.InRange
        ) return 0;
        return type(uint256).max;
    }

    /// @notice The hook's stablecoin balance minus the claim reserve
    /// @dev The claim reserve belongs to redeemers and can never be swept or
    /// used to fill further requests
    function _freeBalance(
        address asset,
        AssetQueue storage q
    ) private view returns (uint256) {
        uint256 balance = IERC20(asset).balanceOf(address(this));
        uint256 reserved = q.totalClaimableAssets;
        return balance > reserved ? balance - reserved : 0;
    }

    /// @notice Settles a currency debt to the PoolManager with real tokens
    function _settleCurrency(Currency currency, uint256 amount) private {
        poolManager.sync(currency);
        SafeERC20.safeTransfer(
            IERC20(Currency.unwrap(currency)),
            address(poolManager),
            amount
        );
        poolManager.settle();
    }
}
