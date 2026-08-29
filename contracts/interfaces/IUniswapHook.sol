// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

/// @title IUniswapHook - Oracle-Priced Uniswap v4 Hook Interface
/// @author Sivo
/// @notice One hook contract serves both SLP pools (SLP/USDC and SLP/USDT).
/// Deposits swap a stablecoin for freshly minted SLP at the exact Chainlink
/// NAV price, gated on the stablecoin's own Chainlink USD feed sitting
/// inside a tight peg band; exits go through an asynchronous FIFO
/// withdrawal queue that is filled by inbound deposits and operator
/// replenishment, mirroring the ERC-7540 request/claimable/claim lifecycle
/// of the legacy Vault.
/// @dev The pools hold zero curve liquidity: every swap is fully absorbed by
/// the hook via BeforeSwapDelta custom accounting. Only the stable-to-SLP
/// direction is a swap; the SLP-to-stable direction reverts and must use
/// requestWithdraw instead. Queue views and claims aggregate per
/// (asset, controller) so requests stay fungible, like requestId 0 in the
/// legacy ERC-7540 vault.
interface IUniswapHook {
    /// @notice Emitted when a deposit swap clears at the oracle price
    /// @param sender The address that initiated the deposit or swap
    /// @param receiver The address receiving the minted SLP
    /// @param asset The stablecoin paid in
    /// @param assets The amount of stablecoin paid in
    /// @param shares The amount of SLP minted to the receiver
    event Deposit(
        address indexed sender,
        address indexed receiver,
        address indexed asset,
        uint256 assets,
        uint256 shares
    );

    /// @notice Emitted when a withdrawal request enters the queue
    /// @param controller The address that can claim or cancel the request
    /// @param asset The stablecoin the request redeems into
    /// @param requestId The queue position identifier of the request
    /// @param sender The address that submitted the request
    /// @param shares The amount of SLP queued
    event RedeemRequest(
        address indexed controller,
        address indexed asset,
        uint256 indexed requestId,
        address sender,
        uint256 shares
    );

    /// @notice Emitted when queued SLP is cancelled and returned
    /// @param controller The controller whose pending SLP was returned
    /// @param asset The stablecoin the cancelled request redeemed into
    /// @param sender The address that submitted the cancellation
    /// @param shares The amount of unfilled SLP returned
    event RedeemCancel(
        address indexed controller,
        address indexed asset,
        address sender,
        uint256 shares
    );

    /// @notice Emitted when queued SLP is filled at the current oracle price
    /// @param controller The controller whose request was filled
    /// @param asset The stablecoin reserved for the controller
    /// @param assets The stablecoin amount locked for claiming
    /// @param shares The amount of SLP burned by the fill
    event RedeemClaimable(
        address indexed controller,
        address indexed asset,
        uint256 assets,
        uint256 shares
    );

    /// @notice Emitted when a controller claims filled withdrawal proceeds
    /// @param sender The address that initiated the claim
    /// @param receiver The address the stablecoin was paid to
    /// @param asset The stablecoin paid out
    /// @param assets The amount of stablecoin paid out
    /// @param shares The amount of SLP that was burned when the claim was
    /// filled (0 here; shares are reported on RedeemClaimable)
    event Withdraw(
        address indexed sender,
        address indexed receiver,
        address indexed asset,
        uint256 assets,
        uint256 shares
    );

    /// @notice Emitted when an operator is set or unset for a controller
    /// @param controller The controller granting or revoking the approval
    /// @param operator The operator being approved or revoked
    /// @param approved True when the operator is approved
    event OperatorSet(
        address indexed controller,
        address indexed operator,
        bool approved
    );

    /// @notice Emitted when the operator replenishes stablecoin to fill the queue
    /// @param asset The stablecoin replenished
    /// @param sender The operator that provided the stablecoin
    /// @param assets The amount of stablecoin pulled in
    event UniswapHookReplenish(
        address indexed asset,
        address indexed sender,
        uint256 assets
    );

    /// @notice Emitted when free (unreserved) stablecoin is swept to Sivo
    /// @param asset The stablecoin swept
    /// @param to The recipient of the sweep
    /// @param assets The amount swept
    event UniswapHookSweep(
        address indexed asset,
        address indexed to,
        uint256 assets
    );

    /// @notice Emitted when the minimum withdrawal request size changes
    /// @param minRequestShares The new minimum SLP amount per request
    event UniswapHookMinRequestChange(uint256 minRequestShares);

    /// @notice Emitted when an asset's own USD feed configuration changes
    /// @param asset The stablecoin the feed prices
    /// @param oracle The asset's Chainlink USD feed
    /// @param maxStaleness The feed's maximum staleness in seconds
    /// @param pegMin The minimum acceptable asset price
    /// @param pegMax The maximum acceptable asset price
    event UniswapHookAssetOracleChange(
        address indexed asset,
        address indexed oracle,
        uint256 maxStaleness,
        int256 pegMin,
        int256 pegMax
    );

    /// @notice A zero address was provided where one is not allowed
    error UniswapHookZeroAddress();

    /// @notice The asset is not one of the configured stablecoins
    /// @param asset The unsupported asset address
    error UniswapHookUnsupportedAsset(address asset);

    /// @notice A pool key not sanctioned by this hook attempted to initialize
    error UniswapHookUnsupportedPool();

    /// @notice The SLP token and the two stablecoins must be three distinct
    /// addresses
    error UniswapHookInvalidAssetConfig();

    /// @notice Liquidity can never be added to the oracle-priced pools
    error UniswapHookLiquidityNotAllowed();

    /// @notice Donations to the oracle-priced pools are not allowed
    error UniswapHookDonateNotAllowed();

    /// @notice SLP cannot be swapped back through the pool; exits must use
    /// the asynchronous withdrawal queue
    error UniswapHookExitViaQueue();

    /// @notice The withdrawal request is below the configured minimum size
    /// @param shares The requested SLP amount
    /// @param minRequestShares The configured minimum SLP amount
    error UniswapHookRequestTooSmall(uint256 shares, uint256 minRequestShares);

    /// @notice A partial cancellation would leave a live request below the
    /// configured minimum size
    /// @dev Cancel enough to keep the request at or above the minimum, or
    /// cancel its full remaining amount
    /// @param residualShares The SLP that would remain in the request
    /// @param minRequestShares The configured minimum SLP amount
    error UniswapHookResidualTooSmall(
        uint256 residualShares,
        uint256 minRequestShares
    );

    /// @notice The controller has less unfilled SLP queued than requested
    /// @param shares The SLP amount requested for cancellation
    /// @param pending The controller's unfilled queued SLP
    error UniswapHookInsufficientPending(uint256 shares, uint256 pending);

    /// @notice The request cannot be cancelled by id: it does not belong to
    /// the controller or holds no unfilled SLP
    /// @param requestId The request identifier that was rejected
    /// @param controller The controller the cancellation was attempted for
    error UniswapHookRequestNotCancellable(
        uint256 requestId,
        address controller
    );

    /// @notice The controller has no claimable stablecoin for the asset
    /// @param controller The controller attempting the claim
    /// @param asset The stablecoin being claimed
    error UniswapHookNothingToClaim(address controller, address asset);

    /// @notice The sender is neither the controller nor an approved operator
    /// @param sender The unauthorized sender
    /// @param controller The controller of the request
    error UniswapHookUnauthorizedSender(address sender, address controller);

    /// @notice A swap or deposit resolves to a zero input or output amount
    error UniswapHookZeroAmount();

    /// @notice The asset has no USD feed configured, so its peg cannot be
    /// checked
    /// @dev Deposits and fills against the asset revert until setAssetOracle
    /// configures its feed; an ungateable asset is never assumed to be at par
    /// @param asset The asset without a feed
    error UniswapHookAssetOracleUnset(address asset);

    /// @notice Deposits a stablecoin and receives SLP at the oracle price
    /// @dev Convenience entrypoint equivalent to routing a swap through the
    /// pool: the hook pulls the stablecoin, executes the oracle-priced swap
    /// against the PoolManager, and delivers freshly minted SLP. Requires a
    /// prior ERC-20 approval of this contract. Blocked while paused, while
    /// the NAV price is out of range, or while the stablecoin's own USD feed
    /// is outside its peg band.
    /// @param asset The stablecoin to deposit (USDC or USDT)
    /// @param assets The amount of stablecoin to deposit
    /// @param receiver The recipient of the minted SLP
    /// @return shares The amount of SLP delivered
    function deposit(
        address asset,
        uint256 assets,
        address receiver
    ) external returns (uint256 shares);

    /// @notice Queues SLP for asynchronous redemption into a stablecoin
    /// @dev Pulls SLP into the hook (requires a prior SLP approval). No price
    /// is locked at request time; pricing happens when the request is filled.
    /// @param asset The stablecoin to redeem into (USDC or USDT)
    /// @param shares The amount of SLP to queue
    /// @return requestId The queue position identifier
    function requestWithdraw(
        address asset,
        uint256 shares
    ) external returns (uint256 requestId);

    /// @notice Cancels unfilled queued SLP and returns it to the caller
    /// @dev A partial cancellation may not leave a live request below
    /// minRequestShares; cancel less, or the request's full remainder
    /// @param asset The stablecoin queue to cancel from
    /// @param shares The amount of unfilled SLP to cancel
    function cancelWithdraw(address asset, uint256 shares) external;

    /// @notice Cancels unfilled queued SLP on behalf of a controller
    /// @dev The caller must be the controller or an approved operator; the
    /// SLP is returned to the controller. A partial cancellation may not
    /// leave a live request below minRequestShares.
    /// @param asset The stablecoin queue to cancel from
    /// @param shares The amount of unfilled SLP to cancel
    /// @param controller The controller whose request is cancelled
    function cancelWithdraw(
        address asset,
        uint256 shares,
        address controller
    ) external;

    /// @notice Cancels the full unfilled remainder of each listed request and
    /// returns the SLP to the caller
    /// @dev Bounded alternative to the amount-based cancel: the work is
    /// proportional to the ids listed rather than to the caller's request
    /// history, so a cancellation can always be sized to fit one
    /// transaction (L004). Every listed request must belong to the caller and
    /// still hold unfilled SLP; listing an id twice reverts. Whole entries
    /// are drained, never split, so the minRequestShares floor does not apply
    /// @param asset The stablecoin queue to cancel from
    /// @param requestIds The identifiers of the requests to cancel in full
    function cancelWithdrawByIds(
        address asset,
        uint256[] calldata requestIds
    ) external;

    /// @notice Cancels explicitly listed requests on behalf of a controller
    /// @dev The caller must be the controller or an approved operator; the
    /// SLP is returned to the controller. See the caller-bound overload for
    /// the id requirements.
    /// @param asset The stablecoin queue to cancel from
    /// @param requestIds The identifiers of the requests to cancel in full
    /// @param controller The controller whose requests are cancelled
    function cancelWithdrawByIds(
        address asset,
        uint256[] calldata requestIds,
        address controller
    ) external;

    /// @notice Claims the caller's filled withdrawal proceeds
    /// @dev Pays out the full claimable balance. Not gated on oracle health:
    /// the price was locked when the request was filled.
    /// @param asset The stablecoin to claim
    /// @param receiver The recipient of the stablecoin
    /// @return assets The amount of stablecoin paid out
    function claimWithdraw(
        address asset,
        address receiver
    ) external returns (uint256 assets);

    /// @notice Claims filled withdrawal proceeds on behalf of a controller
    /// @dev The caller must be the controller or an approved operator
    /// @param asset The stablecoin to claim
    /// @param receiver The recipient of the stablecoin
    /// @param controller The controller whose proceeds are claimed
    /// @return assets The amount of stablecoin paid out
    function claimWithdraw(
        address asset,
        address receiver,
        address controller
    ) external returns (uint256 assets);

    /// @notice Fills the withdrawal queue from the hook's free stablecoin
    /// @dev Restricted through the AccessManager to the operator (L002):
    /// filling locks each request's redemption price at the current oracle
    /// read, so an arbitrary third party must not choose the settlement
    /// moment for queued redeemers. Permissionless queue progress still
    /// happens via the bounded auto-fill pass inside deposits. Requires an
    /// in-range NAV price and an in-band stablecoin peg because filling sets
    /// the redemption price
    /// @param asset The stablecoin queue to fill
    /// @param maxIterations The maximum number of requests to visit
    /// @return assets The amount of stablecoin locked for claims
    function fill(
        address asset,
        uint256 maxIterations
    ) external returns (uint256 assets);

    /// @notice Pulls stablecoin from the operator and fills the queue
    /// @param asset The stablecoin to replenish
    /// @param assets The amount of stablecoin to pull in
    /// @param maxIterations The maximum number of requests to visit
    function replenish(
        address asset,
        uint256 assets,
        uint256 maxIterations
    ) external;

    /// @notice Sweeps free (unreserved) stablecoin to Sivo for RWA deployment
    /// @dev Free balance is the hook's physical balance minus the stablecoin
    /// reserved for filled-but-unclaimed withdrawals; the reserve can never
    /// be swept
    /// @param asset The stablecoin to sweep
    /// @param to The recipient of the sweep
    /// @return assets The amount swept
    function sweep(address asset, address to) external returns (uint256 assets);

    /// @notice Approves or revokes an operator for the caller's requests
    /// @param operator The operator to approve or revoke
    /// @param approved True to approve, false to revoke
    /// @return success Always true
    function setOperator(
        address operator,
        bool approved
    ) external returns (bool success);

    /// @notice Whether an operator is approved for a controller
    /// @param controller The controller
    /// @param operator The candidate operator
    /// @return status True when the operator is approved
    function isOperator(
        address controller,
        address operator
    ) external view returns (bool status);

    /// @notice The controller's unfilled queued SLP for an asset
    /// @param asset The stablecoin queue
    /// @param controller The controller
    /// @return shares The unfilled SLP amount
    function pendingWithdraw(
        address asset,
        address controller
    ) external view returns (uint256 shares);

    /// @notice The controller's claimable stablecoin for an asset
    /// @param asset The stablecoin queue
    /// @param controller The controller
    /// @return assets The claimable stablecoin amount
    function claimableWithdraw(
        address asset,
        address controller
    ) external view returns (uint256 assets);

    /// @notice The maximum stablecoin amount a deposit can currently swap
    /// @dev Returns 0 while paused, while the NAV price is out of range, or
    /// while the stablecoin's own USD feed is unset, stale, or outside its
    /// peg band
    /// @param asset The stablecoin to deposit
    /// @return assets The maximum deposit amount
    function maxDeposit(address asset) external view returns (uint256 assets);

    /// @notice Total unfilled SLP queued for an asset
    /// @param asset The stablecoin queue
    /// @return shares The total unfilled SLP
    function totalPendingShares(
        address asset
    ) external view returns (uint256 shares);

    /// @notice Total stablecoin reserved for filled-but-unclaimed withdrawals
    /// @param asset The stablecoin queue
    /// @return assets The total reserved stablecoin
    function totalClaimableAssets(
        address asset
    ) external view returns (uint256 assets);

    /// @notice The hook's free (sweepable) stablecoin balance
    /// @param asset The stablecoin
    /// @return assets The sweepable amount
    function sweepable(address asset) external view returns (uint256 assets);

    /// @notice The number of requests ever queued for an asset
    /// @param asset The stablecoin queue
    /// @return length The queue tail index
    function queueLength(address asset) external view returns (uint256 length);
}
