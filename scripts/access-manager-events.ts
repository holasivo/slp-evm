/**
 * Downloads the AccessManager's role events for every deployed chain and
 * prints current role membership plus function-role wiring as JSON.
 *
 * Deterministic replacement for scraping the Etherscan events tab: fetches
 * RoleGranted / RoleRevoked / RoleLabel / TargetFunctionRoleUpdated via
 * eth_getLogs from the contract's full history, then replays grants and
 * revokes to compute who currently holds which role.
 *
 * Chains are discovered from ignition/deployments/chain-<id>/; the RPC URL
 * follows the hardhat.config convention: RPC_URL_<NETWORK> (e.g.
 * RPC_URL_MAINNET) overrides the Alchemy URL built from ALCHEMY_API_KEY.
 *
 *   npm run roles:audit                # all deployed chains
 *   npm run roles:audit -- --chain 1   # single chain
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
  http,
  parseAbi,
  toFunctionSelector,
} from 'viem';

import { Roles } from '../ignition/modules/hook/roles.js';

dotenvx.config({ convention: 'flow' });

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEPLOYMENTS = resolve(__dirname, '../ignition/deployments');

const ACCESS_MANAGER_EVENTS = parseAbi([
  'event RoleGranted(uint64 indexed roleId, address indexed account, uint32 delay, uint48 since, bool newMember)',
  'event RoleRevoked(uint64 indexed roleId, address indexed account)',
  'event RoleLabel(uint64 indexed roleId, string label)',
  'event TargetFunctionRoleUpdated(address indexed target, bytes4 selector, uint64 indexed roleId)',
]);

const roleName = (id: bigint): string =>
  Object.entries(Roles).find(([, v]) => v === id)?.[0] ?? `role-${id}`;

/// Selectors the deployment maps via roles.ts, plus the UUPS upgrade
/// entrypoint, so the output shows names instead of raw 4-byte values.
const KNOWN_SIGNATURES = [
  'function mint(address,uint256)',
  'function pause()',
  'function unpause()',
  'function setMarket(address,(address,address,address,address,uint256))',
  'function setPrice(int256)',
  'function fill(address,uint256)',
  'function replenish(address,uint256,uint256)',
  'function sweep(address,address)',
  'function setAssetOracle(address,address,uint256,int256,int256)',
  'function setOracle(address,uint256,int256,int256)',
  'function setMinRequestShares(uint256)',
  'function upgradeToAndCall(address,bytes)',
];
const selectorNames = new Map(
  KNOWN_SIGNATURES.map((s) => [
    toFunctionSelector(s),
    s.slice('function '.length),
  ]),
);

interface Grant {
  roleId: string;
  role: string;
  delay: number;
  since: number;
  block: string;
}

async function auditChain(chainId: number, accessManager: Address) {
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

  // Full-range eth_getLogs on mainnet can exceed viem's default 10s timeout.
  const client = createPublicClient({
    transport: http(url, { timeout: 60_000 }),
  });
  const logs = await client.getLogs({
    address: accessManager,
    events: ACCESS_MANAGER_EVENTS,
    fromBlock: 'earliest',
    strict: true,
  });
  // eth_getLogs returns logs ordered, but sort explicitly so the output is
  // stable regardless of provider.
  logs.sort((a, b) =>
    a.blockNumber === b.blockNumber
      ? a.logIndex - b.logIndex
      : a.blockNumber < b.blockNumber
        ? -1
        : 1,
  );

  const membership = new Map<Address, Map<string, Grant>>();
  const labels: Record<string, string> = {};
  // Later TargetFunctionRoleUpdated events override earlier ones for the
  // same (target, selector), so replay with last-wins semantics.
  const wiring = new Map<
    Address,
    Map<
      string,
      { selector: string; function: string; roleId: string; role: string }
    >
  >();

  for (const log of logs) {
    const { eventName, args } = log;
    if (eventName === 'RoleGranted') {
      const { roleId, account, delay, since } = args;
      const grants = membership.get(account) ?? new Map<string, Grant>();
      grants.set(`${roleId}`, {
        roleId: `${roleId}`,
        role: roleName(roleId),
        delay,
        since: Number(since),
        block: `${log.blockNumber}`,
      });
      membership.set(account, grants);
    } else if (eventName === 'RoleRevoked') {
      const { roleId, account } = args;
      const grants = membership.get(account);
      grants?.delete(`${roleId}`);
      if (grants?.size === 0) membership.delete(account);
    } else if (eventName === 'RoleLabel') {
      labels[`${args.roleId}`] = args.label;
    } else {
      const { target, selector, roleId } = args;
      const bySelector = wiring.get(target) ?? new Map();
      bySelector.set(selector, {
        selector,
        function: selectorNames.get(selector) ?? selector,
        roleId: `${roleId}`,
        role: roleName(roleId),
      });
      wiring.set(target, bySelector);
    }
  }

  const functionRoles = Object.fromEntries(
    [...wiring.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([target, bySelector]) => [
        target,
        [...bySelector.values()].sort((a, b) =>
          a.function.localeCompare(b.function),
        ),
      ]),
  );

  return {
    chainId,
    network,
    accessManager,
    eventCount: logs.length,
    membership: [...membership.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([account, grants]) => ({
        account,
        roles: [...grants.values()].sort((a, b) =>
          a.roleId.localeCompare(b.roleId, undefined, { numeric: true }),
        ),
      })),
    roleLabels: labels,
    functionRoles,
  };
}

async function main(): Promise<void> {
  const chainArg = process.argv.indexOf('--chain');
  const only = chainArg === -1 ? undefined : Number(process.argv[chainArg + 1]);

  const chains = readdirSync(DEPLOYMENTS)
    .map((d) => /^chain-(\d+)$/.exec(d)?.[1])
    .filter((id): id is string => !!id)
    .map(Number)
    .filter((id) => only === undefined || id === only)
    .sort((a, b) => a - b);
  if (chains.length === 0) throw new Error('no matching chain-* deployments');

  const results = [];
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
    const accessManager = deployed['AccessManagerModule#AccessManager'];
    if (!accessManager) {
      console.error(`chain-${chainId}: no AccessManager deployed; skipping`);
      continue;
    }
    results.push(await auditChain(chainId, accessManager));
  }

  console.log(JSON.stringify(results, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
