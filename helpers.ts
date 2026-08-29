export type Numeric = bigint | number;

export const exp = (i: number, d: Numeric = 0, r: Numeric = 6): bigint =>
  (BigInt(Math.floor(i * 10 ** Number(r))) * 10n ** BigInt(d)) /
  10n ** BigInt(r);

export const $ = (amount: number) => BigInt(amount) * BigInt(1e6);
