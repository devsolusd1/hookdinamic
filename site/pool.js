// Reading the market: the token's pool account on Meteora's bonding curve, decoded without the SDK.
// The byte layout is PoolState from the curve program's IDL (0.2.1), after Anchor's 8 bytes of
// discriminator. The struct is zero-copy with its padding written out as fields, so every offset is
// the sizes before it added up; pool.test.mjs checks them against live accounts and the SDK.

const DBC_PROGRAM = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN";
const POOL_LEN = 424;

/** The two kinds of pool account. A token with a transfer hook gets the second; the bytes after are laid out the same. */
const DISCRIMINATORS = [
  [213, 224, 5, 209, 98, 69, 119, 92], // VirtualPool
  [237, 219, 184, 23, 42, 189, 169, 35], // TransferHookPool
];

// Where the four numbers come from. All are little-endian.
const BASE_RESERVE = 232; // u64: tokens still in the curve, in the token's smallest unit
const QUOTE_RESERVE = 240; // u64: lamports in the curve, fees not counted
const SQRT_PRICE = 280; // u128: the square root of lamports per smallest unit of token, times 2^64
const TOTAL_TRADING_QUOTE_FEE = 336; // u64: metrics.total_trading_quote_fee, see decodePool

// Fixed at launch (src/curve.ts): the token's decimals and supply. The quote is wrapped SOL.
const TOKEN_DECIMALS = 6;
const QUOTE_DECIMALS = 9;
const TOTAL_SUPPLY = 1_000_000_000;

/** The nearest double to a/b. Through decimal text, so a 256-bit product loses nothing on the way. */
function quotient(a, b) {
  const digits = 50;
  return Number(`${(a * 10n ** BigInt(digits)) / b}e-${digits}`);
}

/**
 * The market, from the bytes of the pool account.
 *   marketCapSol  the price of one token in SOL, times the whole supply
 *   solInCurve    SOL the curve holds against the tokens sold
 *   soldPct       how much of the supply has left the curve, 0 to 100
 *   feesSol       trading fees taken in SOL since launch and credited to the pool's partner and
 *                 creator. It only grows: claiming does not lower it. The protocol's own cut is
 *                 counted apart (metrics.total_protocol_quote_fee, at 320) and is not in it.
 */
export function decodePool(bytes) {
  if (bytes.length < POOL_LEN) throw new Error(`a pool is ${POOL_LEN} bytes, this account has ${bytes.length}`);
  if (!DISCRIMINATORS.some((kind) => kind.every((byte, i) => bytes[i] === byte))) throw new Error("this account is not a bonding curve pool");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u64 = (at) => view.getBigUint64(at, true);
  const sqrtPrice = u64(SQRT_PRICE) | (u64(SQRT_PRICE + 8) << 64n);

  // sqrtPrice squared over 2^128 is lamports per smallest unit; the powers of ten turn that into SOL per token.
  const price = quotient(sqrtPrice * sqrtPrice * 10n ** BigInt(TOKEN_DECIMALS), (1n << 128n) * 10n ** BigInt(QUOTE_DECIMALS));

  return {
    marketCapSol: price * TOTAL_SUPPLY,
    solInCurve: Number(u64(QUOTE_RESERVE)) / 10 ** QUOTE_DECIMALS,
    soldPct: 100 - (Number(u64(BASE_RESERVE)) / 10 ** TOKEN_DECIMALS / TOTAL_SUPPLY) * 100,
    feesSol: Number(u64(TOTAL_TRADING_QUOTE_FEE)) / 10 ** QUOTE_DECIMALS,
  };
}

/** The same, read from an RPC node. */
export async function readPool(rpc, address) {
  const response = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [address, { encoding: "base64", commitment: "confirmed" }] }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`the RPC answered ${response.status}`);
  const { result, error } = await response.json();
  if (error) throw new Error(error.message);
  if (!result?.value) throw new Error("there is no account at the pool's address");
  if (result.value.owner !== DBC_PROGRAM) throw new Error("the account at the pool's address is not the bonding curve's");
  return decodePool(Uint8Array.from(atob(result.value.data[0]), (char) => char.charCodeAt(0)));
}
