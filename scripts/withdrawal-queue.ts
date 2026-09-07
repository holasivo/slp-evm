/**
 * Prints the UniswapHook withdrawal queue for every deployed chain: on-chain
 * aggregates per stablecoin plus each live request, reconstructed from the
 * RedeemRequest / RedeemClaimable / RedeemCancel event history.
 *
 * The hook exposes no per-request getter, so individual requests are
 * replayed from events: fills consume a controller's requests oldest-first
 * (FIFO), cancels newest-first, mirroring UniswapHook.sol. The replay is then
 * cross-checked against pendingWithdraw / claimableWithdraw per controller and
 * totalPendingShares per asset; any mismatch is reported in `checks`.
 *
 * Chains are discovered from ignition/deployments/chain-<id>/; the RPC URL
 * follows the hardhat.config convention: RPC_URL_<NETWORK> (e.g.
 * RPC_URL_MAINNET) overrides the Alchemy URL built from ALCHEMY_API_KEY.
 *
 *   npm run queue:show                 # all deployed chains, JSON
 *   npm run queue:show -- --chain 1    # single chain id
 *   npm run queue:show -- --pretty     # human-readable text instead of JSON
 */
import dotenvx from '@dotenvx/dotenvx';
import { alchemyRpcUrls, isChainId, toChainKey } from '../config/chains.js';
import env from 'env-var';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import {
  Address,
  createPublicClient,
  formatUnits,
  http,
  parseAbi,
  PublicClient,
} from 'viem';

dotenvx.config({ convention: 'flow' });

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEPLOYMENTS = resolve(__dirname, '../ignition/deployments');

const HOOK_ABI = parseAbi([
  'function supportedAssets() view returns (address, address)',
  'function slpDecimals() view returns (uint8)',
  'function assetDecimals(address) view returns (uint8)',
  'function minRequestShares() view returns (uint256)',
  'function paused() view returns (bool)',
  'function priceStatus() view returns (uint8)',
  'function assetPriceStatus(address) view returns (uint8)',
  'function queueLength(address) view returns (uint256)',
  'function totalPendingShares(address) view returns (uint256)',
  'function totalClaimableAssets(address) view returns (uint256)',
  'function sweepable(address) view returns (uint256)',
  'function pendingWithdraw(address,address) view returns (uint256)',
  'function claimableWithdraw(address,address) view returns (uint256)',
  'event RedeemRequest(address indexed controller, address indexed asset, uint256 indexed requestId, address sender, uint256 shares)',
  'event RedeemCancel(address indexed controller, address indexed asset, address sender, uint256 shares)',
  'event RedeemClaimable(address indexed controller, address indexed asset, uint256 assets, uint256 shares)',
  'event Withdraw(address indexed sender, address indexed receiver, address indexed asset, uint256 assets, uint256 shares)',
  'event UniswapHookReplenish(address indexed asset, address indexed sender, uint256 assets)',
]);

const ERC20_ABI = parseAbi([
  'function symbol() view returns (string)',
  'function balanceOf(address) view returns (uint256)',
]);

/// Order matches the PriceStatus enum in OracleGate.sol
const PRICE_STATUS = [
  'OK',
  'STALE',
  'OUT_OF_RANGE',
  'NEGATIVE',
  'ROUND_INCOMPLETE',
];
const priceStatus = (s: number): string => PRICE_STATUS[s] ?? `status-${s}`;

interface Request {
  requestId: string;
  controller: Address;
  sender: Address;
  requestedShares: string;
  remainingShares: string;
  block: string;
  timestamp: string;
  tx: string;
}

interface HistoryEntry {
  timestamp: string;
  block: string;
  event: string;
  controller?: Address;
  sender?: Address;
  receiver?: Address;
  shares?: string;
  assets?: string;
  requestId?: string;
  tx: string;
}

interface ControllerView {
  controller: Address;
  pendingShares: string;
  claimableAssets: string;
}

interface AssetQueue {
  symbol: string;
  asset: Address;
  pegStatus: string;
  queueLength: string;
  totalPendingShares: string;
  totalClaimableAssets: string;
  hookBalance: string;
  sweepable: string;
  liveRequests: Request[];
  controllers: ControllerView[];
  history: HistoryEntry[];
  checks: string[];
}

function rpcUrl(chainId: number): { network: string; url: string } {
  const network = isChainId(chainId) ? toChainKey(chainId) : undefined;
  if (!network) throw new Error(`chain ${chainId} missing from evmChainMap`);
  const override = env.get(`RPC_URL_${network.toUpperCase()}`).asString();
  const alchemyKey = env.get('ALCHEMY_API_KEY').asString();
  const base = alchemyRpcUrls[chainId as keyof typeof alchemyRpcUrls];
  const url = override ?? (alchemyKey && base && `${base}/${alchemyKey}`);
  if (!url) {
    throw new Error(
      `no RPC for ${network}: set RPC_URL_${network.toUpperCase()} or ALCHEMY_API_KEY`,
    );
  }
  return { network, url };
}

async function queueForAsset(
  client: PublicClient,
  hook: Address,
  asset: Address,
  slpDecimals: number,
  logs: Awaited<ReturnType<typeof fetchLogs>>,
  timestamps: Map<bigint, string>,
): Promise<AssetQueue> {
  const hookRead = { address: hook, abi: HOOK_ABI } as const;
  const [
    symbol,
    assetDecimals,
    pegStatus,
    length,
    pending,
    claimable,
    sweepable,
    balance,
  ] = await Promise.all([
    client.readContract({
      address: asset,
      abi: ERC20_ABI,
      functionName: 'symbol',
    }),
    client.readContract({
      ...hookRead,
      functionName: 'assetDecimals',
      args: [asset],
    }),
    client.readContract({
      ...hookRead,
      functionName: 'assetPriceStatus',
      args: [asset],
    }),
    client.readContract({
      ...hookRead,
      functionName: 'queueLength',
      args: [asset],
    }),
    client.readContract({
      ...hookRead,
      functionName: 'totalPendingShares',
      args: [asset],
    }),
    client.readContract({
      ...hookRead,
      functionName: 'totalClaimableAssets',
      args: [asset],
    }),
    client.readContract({
      ...hookRead,
      functionName: 'sweepable',
      args: [asset],
    }),
    client.readContract({
      address: asset,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [hook],
    }),
  ]);
  const slp = (x: bigint) => formatUnits(x, slpDecimals);
  const usd = (x: bigint) => formatUnits(x, assetDecimals);

  type Live = { req: Request; remaining: bigint };
  const requests: Live[] = [];
  const history: HistoryEntry[] = [];
  const consume = (
    controller: Address,
    shares: bigint,
    newestFirst: boolean,
  ) => {
    let left = shares;
    const order = newestFirst ? [...requests].reverse() : requests;
    for (const r of order) {
      if (left === 0n) break;
      if (r.req.controller !== controller || r.remaining === 0n) continue;
      const d = r.remaining < left ? r.remaining : left;
      r.remaining -= d;
      left -= d;
    }
    return left;
  };
  const checks: string[] = [];

  for (const log of logs) {
    if (
      (log.args as { asset: Address }).asset.toLowerCase() !==
      asset.toLowerCase()
    )
      continue;
    const base = {
      timestamp: timestamps.get(log.blockNumber) ?? '',
      block: `${log.blockNumber}`,
      tx: log.transactionHash,
    };
    switch (log.eventName) {
      case 'RedeemRequest': {
        const { controller, sender, requestId, shares } = log.args;
        requests.push({
          remaining: shares,
          req: {
            requestId: `${requestId}`,
            controller,
            sender,
            requestedShares: slp(shares),
            remainingShares: '',
            ...base,
          },
        });
        history.push({
          ...base,
          event: 'RedeemRequest',
          controller,
          sender,
          requestId: `${requestId}`,
          shares: slp(shares),
        });
        break;
      }
      case 'RedeemClaimable': {
        const { controller, shares, assets } = log.args;
        const left = consume(controller, shares, false);
        if (left !== 0n)
          checks.push(
            `fill of ${slp(shares)} SLP for ${controller} exceeds replayed requests by ${slp(left)}`,
          );
        history.push({
          ...base,
          event: 'RedeemClaimable',
          controller,
          shares: slp(shares),
          assets: usd(assets),
        });
        break;
      }
      case 'RedeemCancel': {
        const { controller, sender, shares } = log.args;
        const left = consume(controller, shares, true);
        if (left !== 0n)
          checks.push(
            `cancel of ${slp(shares)} SLP for ${controller} exceeds replayed requests by ${slp(left)}`,
          );
        history.push({
          ...base,
          event: 'RedeemCancel',
          controller,
          sender,
          shares: slp(shares),
        });
        break;
      }
      case 'Withdraw': {
        const { sender, receiver, assets, shares } = log.args;
        history.push({
          ...base,
          event: 'Withdraw',
          sender,
          receiver,
          assets: usd(assets),
          shares: slp(shares),
        });
        break;
      }
      case 'UniswapHookReplenish': {
        const { sender, assets } = log.args;
        history.push({
          ...base,
          event: 'UniswapHookReplenish',
          sender,
          assets: usd(assets),
        });
        break;
      }
    }
  }

  const controllers: ControllerView[] = [];
  let sumPending = 0n;
  for (const controller of new Set(requests.map((r) => r.req.controller))) {
    const [p, c] = await Promise.all([
      client.readContract({
        ...hookRead,
        functionName: 'pendingWithdraw',
        args: [asset, controller],
      }),
      client.readContract({
        ...hookRead,
        functionName: 'claimableWithdraw',
        args: [asset, controller],
      }),
    ]);
    sumPending += p;
    const replayed = requests
      .filter((r) => r.req.controller === controller)
      .reduce((s, r) => s + r.remaining, 0n);
    if (replayed !== p) {
      checks.push(
        `${controller}: replayed pending ${slp(replayed)} != on-chain pendingWithdraw ${slp(p)}`,
      );
    }
    controllers.push({
      controller,
      pendingShares: slp(p),
      claimableAssets: usd(c),
    });
  }
  if (sumPending !== pending) {
    checks.push(
      `sum(pendingWithdraw) ${slp(sumPending)} != totalPendingShares ${slp(pending)}`,
    );
  }

  return {
    symbol,
    asset,
    pegStatus: priceStatus(pegStatus),
    queueLength: `${length}`,
    totalPendingShares: slp(pending),
    totalClaimableAssets: usd(claimable),
    hookBalance: usd(balance),
    sweepable: usd(sweepable),
    liveRequests: requests
      .filter((r) => r.remaining > 0n)
      .map((r) => ({ ...r.req, remainingShares: slp(r.remaining) })),
    controllers,
    history,
    checks,
  };
}

async function fetchLogs(client: PublicClient, hook: Address) {
  const logs = await client.getLogs({
    address: hook,
    events: HOOK_ABI.filter((x) => x.type === 'event'),
    fromBlock: 'earliest',
    strict: true,
  });
  return logs.sort((a, b) =>
    a.blockNumber === b.blockNumber
      ? a.logIndex - b.logIndex
      : a.blockNumber < b.blockNumber
        ? -1
        : 1,
  );
}

async function inspectChain(chainId: number, hook: Address) {
  const { network, url } = rpcUrl(chainId);
  const client = createPublicClient({
    transport: http(url, { timeout: 60_000 }),
  });

  const [latest, slpDecimals, minRequestShares, paused, slpPrice, assets] =
    await Promise.all([
      client.getBlock(),
      client.readContract({
        address: hook,
        abi: HOOK_ABI,
        functionName: 'slpDecimals',
      }),
      client.readContract({
        address: hook,
        abi: HOOK_ABI,
        functionName: 'minRequestShares',
      }),
      client.readContract({
        address: hook,
        abi: HOOK_ABI,
        functionName: 'paused',
      }),
      client.readContract({
        address: hook,
        abi: HOOK_ABI,
        functionName: 'priceStatus',
      }),
      client.readContract({
        address: hook,
        abi: HOOK_ABI,
        functionName: 'supportedAssets',
      }),
    ]);

  const logs = await fetchLogs(client, hook);
  const timestamps = new Map<bigint, string>();
  for (const blockNumber of new Set(logs.map((l) => l.blockNumber))) {
    const block = await client.getBlock({ blockNumber });
    timestamps.set(
      blockNumber,
      new Date(Number(block.timestamp) * 1000).toISOString(),
    );
  }

  const queues = [];
  for (const asset of assets) {
    queues.push(
      await queueForAsset(client, hook, asset, slpDecimals, logs, timestamps),
    );
  }

  return {
    chainId,
    network,
    hook,
    block: `${latest.number}`,
    blockTime: new Date(Number(latest.timestamp) * 1000).toISOString(),
    paused,
    slpPriceStatus: priceStatus(slpPrice),
    minRequestShares: formatUnits(minRequestShares, slpDecimals),
    eventCount: logs.length,
    queues,
  };
}

type ChainReport = Awaited<ReturnType<typeof inspectChain>>;

function pretty(r: ChainReport): string {
  const out: string[] = [];
  out.push(`# ${r.network} (chain ${r.chainId}) — hook ${r.hook}`);
  out.push(
    `block ${r.block} @ ${r.blockTime}  paused=${r.paused}  slpPrice=${r.slpPriceStatus}  minRequestShares=${r.minRequestShares} SLP`,
  );
  for (const q of r.queues) {
    out.push('');
    out.push(`## ${q.symbol} ${q.asset}  peg=${q.pegStatus}`);
    out.push(
      `requests ever: ${q.queueLength}  pending: ${q.totalPendingShares} SLP  claimable: ${q.totalClaimableAssets} ${q.symbol}  hook balance: ${q.hookBalance}  sweepable: ${q.sweepable}`,
    );
    out.push(`live requests (${q.liveRequests.length}):`);
    for (const l of q.liveRequests) {
      out.push(
        `  #${l.requestId} ${l.controller} requested ${l.requestedShares} remaining ${l.remainingShares} SLP at ${l.timestamp} tx ${l.tx}`,
      );
    }
    out.push(`controllers:`);
    for (const c of q.controllers) {
      out.push(
        `  ${c.controller} pending ${c.pendingShares} SLP  claimable ${c.claimableAssets} ${q.symbol}`,
      );
    }
    out.push(`history (${q.history.length}):`);
    for (const h of q.history) {
      const who = h.controller ?? h.receiver ?? h.sender;
      const amt = [
        h.shares && `${h.shares} SLP`,
        h.assets && `${h.assets} ${q.symbol}`,
      ]
        .filter(Boolean)
        .join(' -> ');
      out.push(
        `  ${h.timestamp.slice(0, 16)} ${h.event.padEnd(20)} ${h.requestId !== undefined ? `#${h.requestId} ` : ''}${amt} ${who}`,
      );
    }
    out.push(
      q.checks.length
        ? `CHECKS FAILED:\n  ${q.checks.join('\n  ')}`
        : 'checks: OK (replay matches on-chain views)',
    );
  }
  return out.join('\n');
}

async function main(): Promise<void> {
  const chainArg = process.argv.indexOf('--chain');
  const only = chainArg === -1 ? undefined : Number(process.argv[chainArg + 1]);
  const isPretty = process.argv.includes('--pretty');

  const chains = readdirSync(DEPLOYMENTS)
    .map((d) => /^chain-(\d+)$/.exec(d)?.[1])
    .filter((id): id is string => !!id)
    .map(Number)
    .filter((id) => only === undefined || id === only)
    .sort((a, b) => a - b);
  if (chains.length === 0) throw new Error('no matching chain-* deployments');

  const results: ChainReport[] = [];
  for (const chainId of chains) {
    const file = resolve(
      DEPLOYMENTS,
      `chain-${chainId}/deployed_addresses.json`,
    );
    if (!existsSync(file)) continue;
    const deployed = JSON.parse(readFileSync(file, 'utf-8')) as Record<
      string,
      Address
    >;
    const hook = deployed['SlpRolesModule#UniswapHook'];
    if (!hook) {
      console.error(
        `chain-${chainId}: no UniswapHook proxy deployed; skipping`,
      );
      continue;
    }
    results.push(await inspectChain(chainId, hook));
  }

  console.log(
    isPretty
      ? results.map(pretty).join('\n\n')
      : JSON.stringify(results, null, 2),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
