// Taking the trading fees out of the curve. This is what the keeper calls.
//
// Meteora gives a curve's fees to one address, written in the curve's config for good. For
// this token that address is the rulebook's own, which no key controls, so nobody can claim
// from Meteora directly. The keeper the rulebook names asks the hook program instead: the
// program makes Meteora's claim with the rulebook signing, and lets the fees land only in
// token accounts that keeper owns. The guardian can put another keeper in (setKeeperIx).
import { deriveDbcPoolAddress, deriveDbcTokenVaultAddress } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction, getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { type PublicKey, Transaction } from "@solana/web3.js";
import { claimFeesIx, rulebookAddress } from "./hook.js";

/** The address a curve's config names as its fee claimer: the token's rulebook. */
export const feeClaimerAddress = rulebookAddress;

/** Asked for as the most to claim, it means everything that is waiting. */
export const EVERYTHING = 2n ** 64n - 1n;

/**
 * The whole claim, as one transaction for the keeper to sign and pay for. Nothing is read
 * from the network: every address follows from the four given.
 *
 *   1. opens the keeper's token account for the token, if it has none. Meteora's claim names
 *      it although this curve takes its fees in SOL and no token moves. Its rent is paid
 *      once and the account stays.
 *   2. opens the keeper's wrapped-SOL account, where the fees arrive
 *   3. the claim, through the hook program
 *   4. closes the wrapped-SOL account, so the fees and its rent end up as plain SOL in the
 *      keeper's wallet. Any wrapped SOL the keeper already had there is unwrapped with them.
 *
 * Meteora gives the smaller of `lamports` and what is waiting, so a claim for the figure read
 * from the pool a moment ago comes to exactly that figure.
 */
export function claimFeesTx(p: {
  /** The hook program. */
  program: PublicKey;
  keeper: PublicKey;
  mint: PublicKey;
  /** The curve's config: `curveConfig` in token.json, and bytes 72 to 104 of the pool's account. */
  config: PublicKey;
  /** The most to claim, in lamports. Left out: everything that is waiting. */
  lamports?: bigint;
}): Transaction {
  const pool = deriveDbcPoolAddress(NATIVE_MINT, p.mint, p.config);
  const tokenAccount = getAssociatedTokenAddressSync(p.mint, p.keeper, false, TOKEN_2022_PROGRAM_ID);
  const solAccount = getAssociatedTokenAddressSync(NATIVE_MINT, p.keeper);
  return new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(p.keeper, tokenAccount, p.keeper, p.mint, TOKEN_2022_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(p.keeper, solAccount, p.keeper, NATIVE_MINT),
    claimFeesIx({
      program: p.program,
      keeper: p.keeper,
      mint: p.mint,
      config: p.config,
      pool,
      tokenVault: deriveDbcTokenVaultAddress(pool, p.mint),
      solVault: deriveDbcTokenVaultAddress(pool, NATIVE_MINT),
      tokenAccount,
      solAccount,
      maxTokens: 0n,
      maxLamports: p.lamports ?? EVERYTHING,
    }),
    createCloseAccountInstruction(solAccount, p.keeper, p.keeper),
  );
}
