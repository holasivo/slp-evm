/*
 * UniswapHook Queue Solvency Specification
 *
 * Verifies the three solvency properties of the oracle-priced Uniswap v4
 * hook (contracts/UniswapHook.sol) that back user funds held in custody:
 *
 *   1. claimReserveBackingPreserved — for each supported stablecoin, the
 *      hook's physical token balance always covers the claim reserve
 *      (`totalClaimableAssets`), i.e. filled-but-unclaimed withdrawals can
 *      always be paid out. Preserved by EVERY external method, including the
 *      PoolManager-driven `beforeSwap`.
 *   2. pendingSharesBackingPreserved — the hook's SLP balance always covers
 *      the total unfilled queued SLP across both asset queues, i.e. every
 *      cancellation can always return the caller's SLP.
 *   3. sweepPreservesClaimReserve / sweepCannotTargetSlp — `sweep` never
 *      decreases the claim reserve, never breaks its backing, and can never
 *      target the SLP token itself.
 *
 * The same invariants are exercised dynamically by the randomized-sequence
 * block in test/UniswapHook.test.ts ("solvency invariants"); this spec
 * checks them exhaustively from symbolic states.
 *
 * Scene: CertoraUniswapHookHarness (the hook), SLP (the share token),
 * Asset/AssetB (the two stablecoins), OracleHarness (the Chainlink feed).
 * The Uniswap v4 PoolManager is intentionally OUT of scene: `sync`, `settle`
 * and `take` resolve to NONDET (no hook-state effect), which over-approximates
 * the real PoolManager for these rules — none of them credits the hook with
 * tokens, so any backing that survives without the PoolManager's inbound
 * `take` transfer also survives with it. `beforeSwap` itself IS in the
 * method scan (msg.sender is checked against the `poolManager` immutable,
 * which the Prover treats symbolically, so the callable path is explored).
 *
 * Summarization rationale (mirrors rwa.spec):
 *   - `Math.mulDiv` (both overloads) is summarized with arbitrary-precision
 *     CVL math, bypassing the nonlinear OpenZeppelin assembly that blows up
 *     the SMT polynomial degree. The 4-arg overload honors Ceil/Expand,
 *     which `_quote` (exact-out) and `_fill` (partial fills) rely on for
 *     protocol-favoring rounding.
 *   - `AccessManager.canCall` is NONDET: authorization is nondeterministic,
 *     which only widens the set of callers — sound for preservation rules.
 *   - Feed/token decimals are pinned to their deployment values (8/6/6/6) so
 *     the `10 ** decimals` bases in `_quote`/`_fill` are concrete constants.
 */

using SLP as slpToken;
using Asset as asset0Token;
using AssetB as asset1Token;
using OracleHarness as oracleFeed;

// CVL summary for Math.mulDiv to bypass the nonlinear assembly implementation.
// Uses arbitrary-precision mathint so the SMT solver avoids polynomial blowup.
// Semantics: floor(x * y / d), reverts when d == 0 or result > max_uint256.
function cvl_mulDiv(uint256 x, uint256 y, uint256 d) returns uint256 {
    require(d != 0, "Math.mulDiv reverts on zero denominator; the summary mirrors that revert by pruning the d == 0 path");
    mathint result = (to_mathint(x) * to_mathint(y)) / to_mathint(d);
    require(result <= to_mathint(max_uint256), "Math.mulDiv reverts when the floor result exceeds uint256; the summary mirrors that revert by pruning the overflow path");
    return require_uint256(result);
}

// CVL summary for the rounding-aware Math.mulDiv overload. Honors the
// Math.Rounding parameter so Ceil / Expand round up when there is a non-zero
// remainder. UniswapHook rounds against the user on exact-out quotes and on
// the SLP burned by partial fills.
function cvl_mulDivRounding(
    uint256 x,
    uint256 y,
    uint256 d,
    Math.Rounding rounding
) returns uint256 {
    require(d != 0, "Math.mulDiv reverts on zero denominator; the summary mirrors that revert by pruning the d == 0 path");
    mathint product = to_mathint(x) * to_mathint(y);
    mathint q = product / to_mathint(d);
    mathint result = q;
    if ((rounding == Math.Rounding.Ceil || rounding == Math.Rounding.Expand)
        && q * to_mathint(d) != product) {
        result = q + 1;
    }
    require(result <= to_mathint(max_uint256), "Math.mulDiv reverts when the rounded result exceeds uint256; the summary mirrors that revert by pruning the overflow path");
    return require_uint256(result);
}

/**
 * CVL summaries for OpenZeppelin's SafeERC20 internal wrappers. Since OZ 5.6
 * the wrappers hand-roll their calldata in assembly scratch space, so the
 * Prover cannot resolve the callee or the selector at the raw `call` site and
 * the unresolved-call DISPATCH admits branches no real execution takes (e.g.
 * an inbound transferFrom that "succeeds" without moving tokens, breaking
 * pendingSharesBackingPreserved on requestWithdraw). Summarizing at the
 * internal boundary routes each wrapper to the real in-scene token code with
 * the hook as msg.sender — exactly the concrete semantics. A token outside
 * the scene (unreachable: every token the hook touches is pinned by
 * requireConfigured) is a no-op.
 */
function cvlSafeTransfer(address token, address to, uint256 value) {
    env e;
    require e.msg.sender == currentContract,
        "SafeERC20 is only ever invoked by the hook, so the token sees the hook as msg.sender";
    require e.msg.value == 0, "ERC-20 transfer is not payable";
    bool ok = true;
    if (token == slpToken) {
        ok = slpToken.transfer(e, to, value);
    } else if (token == asset0Token) {
        ok = asset0Token.transfer(e, to, value);
    } else if (token == asset1Token) {
        ok = asset1Token.transfer(e, to, value);
    }
    require ok, "SafeERC20.safeTransfer reverts when the token returns false; the summary mirrors that revert by pruning the path";
}

function cvlSafeTransferFrom(address token, address from, address to, uint256 value) {
    env e;
    require e.msg.sender == currentContract,
        "SafeERC20 is only ever invoked by the hook, so the token sees the hook as msg.sender";
    require e.msg.value == 0, "ERC-20 transferFrom is not payable";
    bool ok = true;
    if (token == slpToken) {
        ok = slpToken.transferFrom(e, from, to, value);
    } else if (token == asset0Token) {
        ok = asset0Token.transferFrom(e, from, to, value);
    } else if (token == asset1Token) {
        ok = asset1Token.transferFrom(e, from, to, value);
    }
    require ok, "SafeERC20.safeTransferFrom reverts when the token returns false; the summary mirrors that revert by pruning the path";
}

methods {
    // Hook views (envfree - pure storage reads)
    function authority() external returns (address) envfree;
    function slpToken.authority() external returns (address) envfree;
    function slp() external returns (address) envfree;
    function supportedAssets() external returns (address, address) envfree;
    function isSupportedAsset(address) external returns (bool) envfree;
    function assetDecimals(address) external returns (uint8) envfree;
    function slpDecimals() external returns (uint8) envfree;
    function oracle() external returns (address) envfree;
    function oracleDecimals() external returns (uint8) envfree;
    function assetOracleConfig(address) external returns (address, uint8, uint256, int256, int256) envfree;
    function totalPendingShares(address) external returns (uint256) envfree;
    function totalClaimableAssets(address) external returns (uint256) envfree;
    function pendingWithdraw(address, address) external returns (uint256) envfree;
    function claimableWithdraw(address, address) external returns (uint256) envfree;
    function sweepable(address) external returns (uint256) envfree;

    // Token views (envfree - pure storage reads)
    function slpToken.balanceOf(address) external returns (uint256) envfree;
    function slpToken.totalSupply() external returns (uint256) envfree;
    function asset0Token.balanceOf(address) external returns (uint256) envfree;
    function asset0Token.totalSupply() external returns (uint256) envfree;
    function asset1Token.balanceOf(address) external returns (uint256) envfree;
    function asset1Token.totalSupply() external returns (uint256) envfree;

    // Dispatchers for the hook's external calls to in-scene contracts. The
    // receivers are storage values (never statically resolvable), so every
    // token/feed call routes through these; rules pin the storage values to
    // the scene instances via requireConfigured().
    function _.mint(address, uint256) external => DISPATCHER(true);
    function _.burn(uint256) external => DISPATCHER(true);
    function _.transfer(address, uint256) external => DISPATCHER(true);
    function _.transferFrom(address, address, uint256) external => DISPATCHER(true);
    function _.balanceOf(address) external => DISPATCHER(true);
    function _.decimals() external => DISPATCHER(true);
    function _.latestRoundData() external => DISPATCHER(true);

    // The AccessManager authority is out of scene: authorization outcomes
    // are nondeterministic. Sound for preservation rules (it only widens the
    // set of non-reverting executions).
    function _.canCall(address, address, bytes4) external => NONDET;

    // The AccessManager's delayed-execution entry point: when canCall reports
    // a nonzero delay, OZ's `restricted` modifier calls
    // IAccessManager(authority()).consumeScheduledOp(caller, data). The
    // authority is out of scene, so without a summary this call AUTO-havocs
    // the entire scene — token balances included — manufacturing phantom
    // counterexamples on every restricted method (even pause()). The real
    // AccessManager only mutates its own schedule bookkeeping, never the
    // scene contracts, so NONDET is sound here for the same reason it is
    // for canCall.
    function _.consumeScheduledOp(address, bytes) external => NONDET;

    // KEY: summarize Math.mulDiv with CVL functions to bypass the nonlinear
    // OpenZeppelin assembly (see rwa.spec for the timeout postmortem that
    // motivated this pattern).
    function _.mulDiv(uint256 x, uint256 y, uint256 d) internal => cvl_mulDiv(x, y, d) expect uint256;
    function _.mulDiv(uint256 x, uint256 y, uint256 d, Math.Rounding rounding) internal =>
        cvl_mulDivRounding(x, y, d, rounding) expect uint256;

    // Summarize the SafeERC20 wrappers at the internal boundary (see the
    // cvlSafeTransfer* rationale above): OZ 5.6's scratch-space assembly
    // hides the callee and selector from the Prover, so the raw call sites
    // would otherwise fall into the unresolved-call DISPATCH below and admit
    // no-op / wrong-token branches no real execution takes.
    function SafeERC20.safeTransfer(address token, address to, uint256 value) internal =>
        cvlSafeTransfer(token, to, value);
    function SafeERC20.safeTransferFrom(address token, address from, address to, uint256 value) internal =>
        cvlSafeTransferFrom(token, from, to, value);

    // PoolManager entry points are typed interface calls: their sighash
    // resolves but the callee (the out-of-scene `poolManager` immutable)
    // never does, so the unresolved-call fallback below — which only covers
    // calls whose sighash is ALSO unknown — does not apply and the Prover
    // would AUTO-havoc the whole scene (token balances included) on every
    // beforeSwap. Explicit NONDET restores the documented over-approximation:
    // no state effect, arbitrary return values. Currency is a user-defined
    // value type over address, so `address` yields the correct selectors.
    function _.take(address, address, uint256) external => NONDET;
    function _.sync(address) external => NONDET;
    function _.settle() external => NONDET;

    // SafeERC20's scratch-space assembly call() sites are unresolved in both
    // callee and sighash (belt to the internal-summary suspenders above).
    // Dispatch token signatures to the in-scene ERC-20s; everything else
    // becomes a non-state-modifying NONDET instead of a storage havoc.
    unresolved external in _._ =>
        DISPATCH [
            _.transfer(address, uint256),
            _.transferFrom(address, address, uint256),
            _.approve(address, uint256),
            _.mint(address, uint256),
            _.burn(uint256)
        ]
        default NONDET;
}

/**
 * Pins the hook's configuration storage to the scene instances. Every field
 * required here is written exactly once, by initialize() (which is filtered
 * out of the parametric rules), so this models the one deployed
 * configuration rather than constraining any behavior under test.
 * Decimals are pinned to their deployment values so `10 ** decimals` in
 * `_quote`/`_fill` is a concrete constant for the solver.
 */
function requireConfigured() {
    require slp() == slpToken,
        "Config: the SLP token is the in-scene SLP instance";
    address a0; address a1;
    (a0, a1) = supportedAssets();
    require a0 == asset0Token && a1 == asset1Token,
        "Config: the two supported stablecoins are the in-scene Asset/AssetB instances";
    require oracle() == oracleFeed,
        "Config: the price feed is the in-scene OracleHarness";
    // The AccessManager authority is a dedicated out-of-scene contract in
    // every deployment — never the hook itself, a protocol token, or the
    // feed. Leaving it symbolic lets the AccessManaged `restricted` path
    // (OZ's assembly-parsed canCall staticcall) alias into scene contracts,
    // which produced phantom counterexamples on config-only methods.
    require authority() != currentContract &&
        authority() != slpToken &&
        authority() != asset0Token &&
        authority() != asset1Token &&
        authority() != oracleFeed,
        "Config: the hook's AccessManager is a dedicated out-of-scene contract";
    require slpToken.authority() != currentContract &&
        slpToken.authority() != slpToken &&
        slpToken.authority() != asset0Token &&
        slpToken.authority() != asset1Token &&
        slpToken.authority() != oracleFeed,
        "Config: the SLP token's AccessManager is a dedicated out-of-scene contract";
    require oracleDecimals() == 8, "Config: Chainlink USD feed decimals";
    require slpDecimals() == 6, "Config: SLP token decimals";
    require assetDecimals(asset0Token) == 6, "Config: USDC decimals";
    require assetDecimals(asset1Token) == 6, "Config: USDT decimals";
    // Per-asset USD peg gates (M001): pin both stablecoins' feeds to the
    // in-scene OracleHarness so _requireAssetPegged's latestRoundData call
    // dispatches to the scene instead of havocing. Sharing the NAV feed's
    // instance is fine for the solvency rules — the peg gate only widens or
    // narrows the set of non-reverting executions and its price never enters
    // the conversion arithmetic.
    address feed0; uint8 feedDec0; uint256 stale0; int256 pegMin0; int256 pegMax0;
    (feed0, feedDec0, stale0, pegMin0, pegMax0) = assetOracleConfig(asset0Token);
    require feed0 == oracleFeed,
        "Config: asset0's own USD feed is the in-scene OracleHarness";
    address feed1; uint8 feedDec1; uint256 stale1; int256 pegMin1; int256 pegMax1;
    (feed1, feedDec1, stale1, pegMin1, pegMax1) = assetOracleConfig(asset1Token);
    require feed1 == oracleFeed,
        "Config: asset1's own USD feed is the in-scene OracleHarness";
}

/**
 * The caller is an external account: not the hook itself and not one of the
 * scene's token contracts (tokens never call the hook, and a self-call would
 * conflate the custody balance under test with the actor's balance).
 */
function requireExternalSender(address sender) {
    require sender != currentContract,
        "Sender must not be the hook contract itself";
    require sender != slpToken && sender != asset0Token && sender != asset1Token,
        "Sender must not be a token contract";
    require sender != oracleFeed, "Sender must not be the price feed";
}

/**
 * Pre-state: the ERC-20 supply invariant. In every reachable token state the
 * balances sum to totalSupply, so any two distinct accounts' balances are
 * together bounded by it. The symbolic pre-state does not know this, which
 * lets OpenZeppelin's deliberately unchecked recipient-side balance addition
 * (safe onchain precisely because of this invariant) wrap a near-2^256 hook
 * balance around zero on any inbound transfer or mint, manufacturing phantom
 * solvency violations. Constraining the two accounts that actually move
 * funds — the hook and the external actor — excludes exactly those
 * unreachable states: with balanceOf(hook) <= totalSupply, a mint cannot
 * wrap (its checked totalSupply increment reverts first), and with the pair
 * bounded, a transferFrom cannot either (the amount is capped by the
 * sender's balance).
 */
function requireSupplyInvariant(address actor) {
    require slpToken.balanceOf(currentContract) + slpToken.balanceOf(actor)
            <= to_mathint(slpToken.totalSupply()),
        "ERC-20 invariant: two distinct accounts' SLP balances cannot exceed the total supply";
    require asset0Token.balanceOf(currentContract) + asset0Token.balanceOf(actor)
            <= to_mathint(asset0Token.totalSupply()),
        "ERC-20 invariant: two distinct accounts' asset0 balances cannot exceed the total supply";
    require asset1Token.balanceOf(currentContract) + asset1Token.balanceOf(actor)
            <= to_mathint(asset1Token.totalSupply()),
        "ERC-20 invariant: two distinct accounts' asset1 balances cannot exceed the total supply";
}

/** Pre-state: both solvency invariants hold (established at deployment,
 *  where every balance and queue total is zero). */
function requireSolvencyPre() {
    require asset0Token.balanceOf(currentContract) >= totalClaimableAssets(asset0Token),
        "Pre-state: asset0 claim reserve is backed";
    require asset1Token.balanceOf(currentContract) >= totalClaimableAssets(asset1Token),
        "Pre-state: asset1 claim reserve is backed";
    require slpToken.balanceOf(currentContract) >= totalPendingShares(asset0Token) + totalPendingShares(asset1Token),
        "Pre-state: queued SLP is backed";
}

////////////////////////////////////////////////////////////////
//                                                            //
//        Rule 1: claim reserves are always backed            //
//                                                            //
////////////////////////////////////////////////////////////////

/**
 * Property: for each supported stablecoin, the hook's physical balance
 * covers the stablecoin reserved for filled-but-unclaimed withdrawals.
 * `_fill` only reserves out of `_freeBalance` (balance minus the existing
 * reserve), `claimWithdraw` decrements reserve and balance together, and
 * `sweep` moves only the free portion — so no method can leave a claim
 * unpayable.
 *
 * Method scope (`f.contract == currentContract`): the property quantifies
 * over the HOOK's entry points. Token methods are excluded deliberately —
 * from a symbolic pre-state the prover can conjure allowances (e.g.
 * `asset.transferFrom(hook, attacker, x)`) that no reachable state contains,
 * because the hook never calls approve on any token. `initialize` is
 * filtered (the implementation ships with `_disableInitializers()`; the
 * proxy runs it exactly once at deployment, where all balances and reserves
 * are zero), and so is `upgradeToAndCall` (Safe-gated; it swaps out the very
 * code under verification, so "preservation across an arbitrary new
 * implementation" is not a meaningful property). `beforeAddLiquidity` and
 * `beforeDonate` revert unconditionally by design (the pools hold no curve
 * liquidity and accept no donations), so they preserve every invariant
 * vacuously; they are filtered so the vacuity sanity check does not flag
 * them, and their always-revert behavior is pinned by the unit tests.
 */
rule claimReserveBackingPreserved(env e, method f, calldataarg args)
    filtered {
        f ->
            f.contract == currentContract &&
            f.selector != sig:initialize(UniswapHookOptions.Options).selector &&
            f.selector != sig:upgradeToAndCall(address, bytes).selector &&
            f.selector != sig:beforeAddLiquidity(address, UniswapHook.PoolKey, UniswapHook.ModifyLiquidityParams, bytes).selector &&
            f.selector != sig:beforeDonate(address, UniswapHook.PoolKey, uint256, uint256, bytes).selector
    }
{
    requireConfigured();
    requireExternalSender(e.msg.sender);
    requireSupplyInvariant(e.msg.sender);
    requireSolvencyPre();

    f(e, args);

    assert asset0Token.balanceOf(currentContract) >= totalClaimableAssets(asset0Token),
        "Every hook method must leave the asset0 claim reserve fully backed by the hook's balance";
    assert asset1Token.balanceOf(currentContract) >= totalClaimableAssets(asset1Token),
        "Every hook method must leave the asset1 claim reserve fully backed by the hook's balance";
}

////////////////////////////////////////////////////////////////
//                                                            //
//        Rule 2: queued SLP is always backed                 //
//                                                            //
////////////////////////////////////////////////////////////////

/**
 * Property: the hook's SLP balance covers the total unfilled queued SLP
 * across both asset queues, so `cancelWithdraw` can always return the
 * caller's SLP. `requestWithdraw` transfers exactly the queued amount in,
 * `cancelWithdraw` transfers exactly the dequeued amount out, and `_fill`
 * burns exactly the shares it dequeues.
 *
 * Stated as >= rather than ==: SLP can be donated to the hook by plain
 * ERC-20 transfers (not hook methods), and `deposit(_, _, receiver)` may
 * name the hook itself as receiver — both only ever increase the left-hand
 * side. The == form on the reachable no-donation path is exercised by the
 * unit tests' randomized invariant block.
 *
 * Method scope: same filter rationale as claimReserveBackingPreserved.
 */
rule pendingSharesBackingPreserved(env e, method f, calldataarg args)
    filtered {
        f ->
            f.contract == currentContract &&
            f.selector != sig:initialize(UniswapHookOptions.Options).selector &&
            f.selector != sig:upgradeToAndCall(address, bytes).selector &&
            f.selector != sig:beforeAddLiquidity(address, UniswapHook.PoolKey, UniswapHook.ModifyLiquidityParams, bytes).selector &&
            f.selector != sig:beforeDonate(address, UniswapHook.PoolKey, uint256, uint256, bytes).selector
    }
{
    requireConfigured();
    requireExternalSender(e.msg.sender);
    requireSupplyInvariant(e.msg.sender);
    requireSolvencyPre();

    f(e, args);

    assert slpToken.balanceOf(currentContract) >= totalPendingShares(asset0Token) + totalPendingShares(asset1Token),
        "Every hook method must leave the hook's SLP balance covering all unfilled queued SLP";
}

////////////////////////////////////////////////////////////////
//                                                            //
//        Rule 3: sweep can never touch user funds            //
//                                                            //
////////////////////////////////////////////////////////////////

/**
 * Property: sweep() pays out at most the free balance — it never decreases
 * the claim reserve of ANY asset and never leaves a reserve unbacked.
 */
rule sweepPreservesClaimReserve(env e, address asset, address to) {
    requireConfigured();
    requireExternalSender(e.msg.sender);
    require to != currentContract,
        "A self-sweep is a no-op on balances; require a real outflow so the assertion is meaningful";
    requireSolvencyPre();

    uint256 reserved0Before = totalClaimableAssets(asset0Token);
    uint256 reserved1Before = totalClaimableAssets(asset1Token);

    sweep(e, asset, to);

    assert totalClaimableAssets(asset0Token) == reserved0Before &&
           totalClaimableAssets(asset1Token) == reserved1Before,
        "sweep must never change any claim reserve";
    assert asset0Token.balanceOf(currentContract) >= reserved0Before,
        "sweep must leave the asset0 claim reserve fully backed";
    assert asset1Token.balanceOf(currentContract) >= reserved1Before,
        "sweep must leave the asset1 claim reserve fully backed";
}

/**
 * Property: sweep() can never target the SLP token, so queued SLP is out of
 * its reach entirely. Guaranteed by initialize()'s
 * UniswapHookInvalidAssetConfig validation (the SLP token is never a
 * supported asset) and _requireSupportedAsset's gate.
 */
rule sweepCannotTargetSlp(env e, address to) {
    requireConfigured();

    sweep@withrevert(e, slpToken, to);

    assert lastReverted,
        "sweep(slp, _) must revert: the SLP token is never a supported asset";
}
