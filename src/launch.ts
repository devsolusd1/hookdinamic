// Puts the token on chain in up to four transactions: the curve's config, the hook's
// rulebook, the pool and, for a token with more than one name, the handing of its name to
// the rulebook. The caller supplies `send`, which signs, sends and waits for each one. A step
// already done on chain is skipped, so a launch that stopped halfway can be run again.
//
// The config names the rulebook's address as the one that claims the trading fees. No key
// controls that address: the hook program claims for the keeper written in the rulebook.
import { deriveDbcPoolAddress, deriveDbcTokenVaultAddress, type DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { getTokenMetadata, NATIVE_MINT, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { createUpdateAuthorityInstruction } from "@solana/spl-token-metadata";
import { type Keypair, type PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { curveConfig, type CurveInput } from "./curve.js";
import { initIx, rulebookAddress, type Limits, type Name, type Split } from "./hook.js";

export type Launch = {
  dbc: DynamicBondingCurveClient;
  hookProgram: PublicKey;
  /** Pays for everything and creates the pool. */
  payer: Keypair;
  mint: Keypair;
  config: Keypair;
  guardian: PublicKey;
  agent: PublicKey;
  /**
   * Takes the trading fees Meteora does not keep out of the curve and pays them out. It is
   * written in the rulebook, where the guardian can replace it. The curve itself names the
   * rulebook's address as its fee claimer, which is not a choice: Meteora never lets that
   * address change, so it must not be a key somebody holds.
   */
  keeper: PublicKey;
  /** The app's signing key, for app-only windows. Left out, the token names no app, until the guardian names one. */
  cosigner?: PublicKey;
  /**
   * An owner no rule applies to. Left out, there is none, and that is how this token launches:
   * the keeper is not exempt, and its buyback is judged by the rule in force like any buy.
   */
  exempt?: PublicKey;
  limits: Limits;
  /** The fee split the token opens with. It opens with no rule. */
  split: Split;
  /** Whether the name can change follows from `names`, so it is not asked for here. */
  curve: Omit<CurveInput, "renamable">;
  /** The names the token can go by, the one it launches with first. One name: it never changes. */
  names: Name[];
  uri: string;
};

export type Send = (what: string, tx: Transaction, signers: Keypair[]) => Promise<unknown>;

const bytes = (name: Name) => Buffer.byteLength(name.name) + Buffer.byteLength(name.symbol);
/** Lamports as whole SOL, for a sentence. */
const inSol = (lamports: { toString(): string }) => Math.round(Number(lamports.toString()) / 1e9).toLocaleString("en-US");

export async function launch(p: Launch, send: Send): Promise<{ pool: PublicKey }> {
  const renamable = p.names.length > 1;
  const params = curveConfig({ ...p.curve, renamable });
  const pool = deriveDbcPoolAddress(NATIVE_MINT, p.mint.publicKey, p.config.publicKey);
  const book = rulebookAddress(p.hookProgram, p.mint.publicKey);
  const { connection } = p.dbc;
  const onChain = async (address: PublicKey) => (await connection.getAccountInfo(address)) !== null;

  if (!(await onChain(p.config.publicKey))) {
    const config = await p.dbc.partner.createConfigWithTransferHook({
      ...params,
      config: p.config.publicKey,
      // The fees can be claimed only by the rulebook's address, which is to say only by the
      // hook program, for the keeper. Tokens left over at a graduation would go to the same
      // address; the curve cannot graduate, and is built to leave none.
      feeClaimer: book,
      leftoverReceiver: book,
      quoteMint: NATIVE_MINT,
      payer: p.payer.publicKey,
      transferHookProgram: p.hookProgram,
    });
    await send("create the curve's config", config, [p.payer, p.config]);
  } else {
    // A config left by an earlier run is reused, and nothing in it can ever change: not who
    // claims its fees, and not where its curve graduates. A config made before the curve was
    // set never to graduate would be a curve that can.
    const made = await p.dbc.state.getPoolConfig(p.config.publicKey);
    if (!made?.feeClaimer.equals(book)) throw new Error(`the curve config ${p.config.publicKey.toBase58()} gives its fees to ${made?.feeClaimer.toBase58() ?? "nobody"}, not to this token's rulebook, and that cannot be changed: launch with a new config`);
    if (!made.migrationQuoteThreshold.eq(params.migrationQuoteThreshold)) throw new Error(`the curve config ${p.config.publicKey.toBase58()} would graduate with ${inSol(made.migrationQuoteThreshold)} SOL in it, not the ${inSol(params.migrationQuoteThreshold)} this launch sets, and that cannot be changed: launch with a new config`);
  }

  // The rulebook goes in before the pool: the mint's own key signs it, and without it no
  // transfer of the token can go through.
  if (!(await onChain(book))) {
    const rulebook = new Transaction().add(
      initIx({
        program: p.hookProgram,
        payer: p.payer.publicKey,
        mint: p.mint.publicKey,
        guardian: p.guardian,
        agent: p.agent,
        cosigner: p.cosigner,
        exempt: p.exempt,
        // The pool's address follows from the mint and the config, so its SOL vault is known before it exists.
        curveVault: deriveDbcTokenVaultAddress(pool, NATIVE_MINT),
        keeper: p.keeper,
        limits: p.limits,
        split: p.split,
        names: p.names,
      }),
    );
    await send("write the rulebook", rulebook, [p.payer, p.mint]);
  }

  if (!(await onChain(pool))) {
    // The SDK reads the config back from chain to build this one, and an RPC can lag a moment
    // behind a transaction it has just confirmed.
    const createPool = () =>
      p.dbc.creator.createPoolWithTransferHook({
        ...p.names[0],
        uri: p.uri,
        payer: p.payer.publicKey,
        poolCreator: p.payer.publicKey,
        config: p.config.publicKey,
        baseMint: p.mint.publicKey,
        transferHookProgram: p.hookProgram,
      });
    let creation: Transaction | null = null;
    for (let attempt = 0; !creation; attempt++) {
      creation = await createPool().catch(async (error) => {
        if (attempt >= 10) throw error;
        await new Promise((r) => setTimeout(r, 1_500));
        return null;
      });
    }
    await send("create the pool", creation, [p.payer, p.mint]);
  }

  // Meteora leaves the right to edit the token's metadata with the pool's creator. It goes to
  // the rulebook's address at once, so that from here on a name changes only the way the
  // program allows. The mint is given the lamports to hold the longest of its names.
  if (renamable) {
    const metadata = await getTokenMetadata(connection, p.mint.publicKey, "confirmed", TOKEN_2022_PROGRAM_ID);
    if (metadata?.updateAuthority?.equals(p.payer.publicKey)) {
      const mint = (await connection.getAccountInfo(p.mint.publicKey))!;
      const room = Math.max(...p.names.map(bytes)) - bytes(metadata);
      const missing = (await connection.getMinimumBalanceForRentExemption(mint.data.length + Math.max(room, 0))) - mint.lamports;
      const handover = new Transaction();
      if (missing > 0) handover.add(SystemProgram.transfer({ fromPubkey: p.payer.publicKey, toPubkey: p.mint.publicKey, lamports: missing }));
      handover.add(createUpdateAuthorityInstruction({ programId: TOKEN_2022_PROGRAM_ID, metadata: p.mint.publicKey, oldAuthority: p.payer.publicKey, newAuthority: book }));
      await send("hand the token's name to the rulebook", handover, [p.payer]);
    } else if (!metadata?.updateAuthority?.equals(book)) {
      throw new Error(`the token's name can be edited by ${metadata?.updateAuthority?.toBase58() ?? "nobody"}, not by its rulebook`);
    }
  }

  return { pool };
}
