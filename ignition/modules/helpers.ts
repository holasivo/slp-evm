import '@dotenvx/dotenvx/config';
import SafeApiKit_ from '@safe-global/api-kit';
import Safe_ from '@safe-global/protocol-kit';
import type { MetaTransactionData } from '@safe-global/types-kit';
import env from 'env-var';
import { encodeFunctionData, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
const Safe = Safe_ as unknown as typeof Safe_.default;
const SafeApiKit = SafeApiKit_ as unknown as typeof SafeApiKit_.default;
export type Numeric = bigint | number;

export const exp = (i: number, d: Numeric = 0, r: Numeric = 6): bigint =>
  (BigInt(Math.floor(i * 10 ** Number(r))) * 10n ** BigInt(d)) /
  10n ** BigInt(r);

const key = env.get('SIVO_WALLET_PRIVATE_KEY').asString();
const a = key ? privateKeyToAccount(`0x${key}`) : undefined;
export const defaults = { owner: a?.address };
console.log(defaults);

const abi = [
  {
    name: 'upgradeToAndCall',
    type: 'function',
    inputs: [
      { name: 'newImplementation', type: 'address' },
      { name: 'data', type: 'bytes' },
    ],
    outputs: [],
    stateMutability: 'payable',
  },
] as const;

export const encodeUpgrade = (impl: Address): Hex =>
  encodeFunctionData({
    abi,
    functionName: 'upgradeToAndCall',
    args: [impl, '0x'],
  });

type SafeProposalParams = {
  readonly rpcUrl: string;
  readonly chainId: number;
  readonly txs: readonly MetaTransactionData[];
};

export const proposeSafeTransaction = async (params: SafeProposalParams) => {
  const { rpcUrl, chainId, txs } = params;
  const apiKey = env.get('SAFE_API_KEY').asString();
  const safeAddress = env.get('SAFE_ADDRESS').required().asString();
  const { owner: senderAddress } = defaults;
  if (!senderAddress) throw Error('missing sender address');
  const signer = `0x${key}`;
  const kit = await Safe.init({ provider: rpcUrl, signer, safeAddress });
  const apiKit = new SafeApiKit({ chainId: BigInt(chainId), apiKey });
  const hashes: string[] = [];
  // Queue-aware: the on-chain nonce ignores proposals already pending in the
  // transaction service, which would make a new proposal conflict with them
  // instead of following them.
  let nonce = Number(await apiKit.getNextNonce(safeAddress));
  for (const tx of txs) {
    const transactions = [{ ...tx, operation: 0 }];
    const options = { nonce: nonce++ };
    const safeTx = await kit.createTransaction({ transactions, options });
    const safeTxHash = await kit.getTransactionHash(safeTx);
    const signature = await kit.signHash(safeTxHash);
    await apiKit.proposeTransaction({
      safeAddress,
      safeTransactionData: safeTx.data,
      safeTxHash,
      senderAddress,
      senderSignature: signature.data,
    });
    console.log(`Proposed tx: ${safeTxHash}`);
    hashes.push(safeTxHash);
  }
  console.log(`\nProposed ${hashes.length} txs to Safe: ${safeAddress}`);
  return hashes;
};
