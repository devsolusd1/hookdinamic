// Puts the token on chain in three transactions: the curve's config, the hook's rulebook, the
// pool. The caller supplies `send`, which signs, sends and waits for each one.
import { type Keypair, type PublicKey, Transaction } from "@solana/web3.js";
import { deriveDbcPoolAddress, type DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { NATIVE_MINT } from "@solana/spl-token";
import { curveConfig, type CurveInput } from "./curve.js";
import { initIx, type Change, type Limits } from "./hook.js";

export type Launch = {
  dbc: DynamicBondingCurveClient;
  hookProgram: PublicKey;
  /** Pays for everything and creates the pool. */
  payer: Keypair;
  mint: Keypair;
  config: Keypair;
  /** Receives the trading fees Meteora does not keep. */
  feeClaimer: PublicKey;
  guardian: PublicKey;
  agent: PublicKey;
  /** The app's signing key, for app-only windows. */
  cosigner: PublicKey;
  /** An owner no rule applies to (the buyback vault). */
  exempt?: PublicKey;
  limits: Limits;
  first: Change;
  curve: CurveInput;
  name: string;
  symbol: string;
  uri: string;
};

export type Send = (what: string, tx: Transaction, signers: Keypair[]) => Promise<unknown>;

export async function launch(p: Launch, send: Send): Promise<{ pool: PublicKey; solToGraduate: number }> {
  const params = curveConfig(p.curve);
  const config = await p.dbc.partner.createConfigWithTransferHook({
    ...params,
    config: p.config.publicKey,
    feeClaimer: p.feeClaimer,
    leftoverReceiver: p.feeClaimer,
    quoteMint: NATIVE_MINT,
    payer: p.payer.publicKey,
    transferHookProgram: p.hookProgram,
  });
  await send("create the curve's config", config, [p.payer, p.config]);

  // The rulebook goes in before the pool: the mint's own key signs it, and without it no
  // transfer of the token can go through.
  const rulebook = new Transaction().add(
    initIx({ program: p.hookProgram, payer: p.payer.publicKey, mint: p.mint.publicKey, guardian: p.guardian, agent: p.agent, cosigner: p.cosigner, exempt: p.exempt, limits: p.limits, first: p.first }),
  );
  await send("write the rulebook", rulebook, [p.payer, p.mint]);

  // The SDK reads the config back from chain to build this one, and an RPC can lag a moment
  // behind a transaction it has just confirmed.
  const createPool = () =>
    p.dbc.creator.createPoolWithTransferHook({
      name: p.name,
      symbol: p.symbol,
      uri: p.uri,
      payer: p.payer.publicKey,
      poolCreator: p.payer.publicKey,
      config: p.config.publicKey,
      baseMint: p.mint.publicKey,
      transferHookProgram: p.hookProgram,
    });
  let pool: Transaction | null = null;
  for (let attempt = 0; !pool; attempt++) {
    pool = await createPool().catch(async (error) => {
      if (attempt >= 10) throw error;
      await new Promise((r) => setTimeout(r, 1_500));
      return null;
    });
  }
  await send("create the pool", pool, [p.payer, p.mint]);

  return {
    pool: deriveDbcPoolAddress(NATIVE_MINT, p.mint.publicKey, p.config.publicKey),
    solToGraduate: Number(params.migrationQuoteThreshold.toString()) / 1e9,
  };
}
