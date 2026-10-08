// Puts the token on chain in up to four transactions: the curve's config, the hook's
// rulebook, the pool and, for a token with more than one name, the handing of its name to
// the rulebook. The caller supplies `send`, which signs, sends and waits for each one. A step
// already done on chain is skipped, so a launch that stopped halfway can be run again.
//
// A config and a rulebook are written once and never changed. So before anything is sent,
// whatever an earlier run left on chain is read and compared, setting by setting, with what
// this launch would send. One difference and the launch is refused: to go on would make a
// token that is not the one this launch describes.
//
// The config names the rulebook's address as the one that claims the trading fees. No key
// controls that address: the hook program claims for the keeper written in the rulebook.
import {
  CollectFeeMode,
  deriveDbcPoolAddress,
  deriveDbcTokenVaultAddress,
  getPriceFromSqrtPrice,
  TokenAuthorityOption,
  type ConfigParameters,
  type ConfigWithTransferHook,
  type DynamicBondingCurveClient,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { getMint, getTokenMetadata, getTransferHook, NATIVE_MINT, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { createUpdateAuthorityInstruction } from "@solana/spl-token-metadata";
import { type Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import BN from "bn.js";
import { curveConfig, SOL_IN_EXISTENCE, TOKEN_DECIMALS, TOTAL_SUPPLY, type CurveInput } from "./curve.js";
import { decodeRulebook, initIx, METEORA_DBC, rulebookAddress, RULEBOOK_LEN, type Limits, type Name, type Rulebook, type Split } from "./hook.js";

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

/** How far an earlier run of a launch got. It decides what a launch that now asks for something else can still do. */
export type Reached = "config" | "rulebook" | "pool";

/** What is true about the way out of a refusal, by how far the earlier run got. */
const WAY_OUT: Record<Reached, string> = {
  config: "A config can never be changed: launch what it holds, or make a new config and lose what the old one cost",
  rulebook:
    "Neither a config nor a rulebook can ever be changed, and a new config is no way out once the rulebook is written, because the rulebook holds the vault of the one pool its mint and that config make: launch what they hold, or start again with a new mint and a new config and lose what was spent on these",
  pool: "The token is launched and is what the chain holds: nothing a launch asks for can change it now",
};

/**
 * What a launch says when the chain already holds part of it and that part is not what the
 * launch now asks for. Nothing was sent. `difference` names the first thing that differs,
 * `reached` how far the earlier run got. `guardianCan` is set when what differs is the agent,
 * the keeper or the app key, which the guardian the rulebook names can replace once the token
 * is launched. It is not set for the guardian itself: a rulebook that names a guardian nobody
 * holds the key of can never be put right.
 */
export class Refused extends Error {
  constructor(readonly difference: string, readonly reached: Reached, readonly guardianCan = false) {
    super(`${difference}. ${WAY_OUT[reached]}`);
  }
}

/** What the chain says of a launched token, read from its config, its rulebook and its mint. */
export type Launched = {
  pool: PublicKey;
  /** The SOL the curve has to hold to graduate. */
  graduationSol: number;
  /** How many segments the curve has. This launch draws one. */
  segments: number;
  /** The market cap the curve starts at, in SOL. */
  startCapSol: number;
  /** The fee on every trade, in bps. `feeFlat` says it never changes, `feeInSol` that it is taken in SOL on buys and sells. */
  feeBps: number;
  feeFlat: boolean;
  feeInSol: boolean;
  /** Who claims the fees: the rulebook's address. */
  feeClaimer: PublicKey;
  /** The hook program the mint carries. */
  hook: PublicKey;
  /** The name and ticker the mint goes by now, and the address of its card. */
  name: string;
  symbol: string;
  uri: string;
  /** Keys the rulebook names that are not the launch's. Those can be replaced once a token is launched, so then they are told, not refused. */
  since: string[];
};

const bytes = (name: Name) => Buffer.byteLength(name.name) + Buffer.byteLength(name.symbol);
/** Lamports as whole SOL, for a sentence. */
const inSol = (lamports: { toString(): string }) => Math.round(Number(lamports.toString()) / LAMPORTS_PER_SOL).toLocaleString("en-US");
/** The market cap, in SOL, at a price written the way Meteora writes one. */
const capAt = (sqrtPrice: BN) => Number((getPriceFromSqrtPrice(sqrtPrice, TOKEN_DECIMALS, 9).toNumber() * TOTAL_SUPPLY).toFixed(6));

/** A curve is launched as one that cannot graduate only if filling it takes at least this many times all the SOL there is. */
export const TIMES_ALL_SOL = 10;

/**
 * Refuses a config whose curve could fill. Meteora takes the hook off a token in the buy that
 * fills its curve, so a curve is only launched if that takes more SOL than there is, with room
 * for the years in which there will be more.
 */
export function mustNotGraduate({ migrationQuoteThreshold }: { migrationQuoteThreshold: BN }) {
  if (migrationQuoteThreshold.gte(new BN(TIMES_ALL_SOL * SOL_IN_EXISTENCE).mul(new BN(LAMPORTS_PER_SOL)))) return;
  throw new Error(
    `this curve would graduate with ${inSol(migrationQuoteThreshold)} SOL in it, which is under ${TIMES_ALL_SOL} times all the SOL there is (about ${Math.round(SOL_IN_EXISTENCE / 1e6)} million), and a curve that fills loses its hook. It is not launched: the number is GRADUATION_SOL in src/curve.ts`,
  );
}

/**
 * One thing a launch fixes: how a refusal says it, what this launch would send and what the
 * chain keeps. `changes` marks the four keys of the rulebook, which can be replaced after the
 * launch. `guardianCan` marks the three of them the guardian replaces by itself.
 */
type Line = { says: string; sent: string; kept: string; differs: boolean; why?: string; changes?: boolean; guardianCan?: boolean };

/** A config as a launch sends it: Meteora's parameters and the four addresses that go in beside them. */
type ConfigSent = Omit<ConfigParameters, "padding"> & { transferHookProgram: PublicKey; feeClaimer: PublicKey; leftoverReceiver: PublicKey; quoteMint: PublicKey };

/**
 * A config account said as the parameters that write one, so that it can be compared name by
 * name with what a launch sends. The program keeps every parameter, a few under another name
 * or in another form. What it works out from them for itself is left out.
 */
function asSent({ config: made, transferHookProgram }: ConfigWithTransferHook): ConfigSent {
  const { baseFee, dynamicFee } = made.poolFees;
  const vesting = (kept: typeof made.partnerLiquidityVestingInfo) => ({
    vestingPercentage: kept.vestingPercentage,
    bpsPerPeriod: kept.bpsPerPeriod,
    numberOfPeriods: kept.numberOfPeriods,
    cliffDurationFromMigrationTime: kept.cliffDurationFromMigrationTime,
    frequency: kept.frequency,
  });
  // The fee schedule of a graduated pool is kept as the sixteen bytes it was sent in.
  const schedule = Buffer.from(made.migratedPoolBaseFeeBytes);
  return {
    transferHookProgram,
    feeClaimer: made.feeClaimer,
    leftoverReceiver: made.leftoverReceiver,
    quoteMint: made.quoteMint,
    poolFees: {
      baseFee: { cliffFeeNumerator: baseFee.cliffFeeNumerator, firstFactor: baseFee.firstFactor, secondFactor: baseFee.secondFactor, thirdFactor: baseFee.thirdFactor, baseFeeMode: baseFee.baseFeeMode },
      dynamicFee: dynamicFee.initialized
        ? {
            binStep: dynamicFee.binStep,
            binStepU128: dynamicFee.binStepU128,
            filterPeriod: dynamicFee.filterPeriod,
            decayPeriod: dynamicFee.decayPeriod,
            reductionFactor: dynamicFee.reductionFactor,
            maxVolatilityAccumulator: dynamicFee.maxVolatilityAccumulator,
            variableFeeControl: dynamicFee.variableFeeControl,
          }
        : null,
    },
    activationType: made.activationType,
    collectFeeMode: made.collectFeeMode,
    migrationOption: made.migrationOption,
    tokenType: made.tokenType,
    tokenDecimal: made.tokenDecimal,
    migrationQuoteThreshold: made.migrationQuoteThreshold,
    partnerLiquidityPercentage: made.partnerLiquidityPercentage,
    partnerPermanentLockedLiquidityPercentage: made.partnerPermanentLockedLiquidityPercentage,
    creatorLiquidityPercentage: made.creatorLiquidityPercentage,
    creatorPermanentLockedLiquidityPercentage: made.creatorPermanentLockedLiquidityPercentage,
    sqrtStartPrice: made.sqrtStartPrice,
    lockedVesting: {
      amountPerPeriod: made.lockedVestingConfig.amountPerPeriod,
      cliffDurationFromMigrationTime: made.lockedVestingConfig.cliffDurationFromMigrationTime,
      frequency: made.lockedVestingConfig.frequency,
      numberOfPeriod: made.lockedVestingConfig.numberOfPeriod,
      cliffUnlockAmount: made.lockedVestingConfig.cliffUnlockAmount,
    },
    migrationFeeOption: made.migrationFeeOption,
    tokenSupply: made.fixedTokenSupplyFlag ? { preMigrationTokenSupply: made.preMigrationTokenSupply, postMigrationTokenSupply: made.postMigrationTokenSupply } : null,
    creatorTradingFeePercentage: made.creatorTradingFeePercentage,
    tokenUpdateAuthority: made.tokenUpdateAuthority,
    migrationFee: { feePercentage: made.migrationFeePercentage, creatorFeePercentage: made.creatorMigrationFeePercentage },
    migratedPoolFee: { collectFeeMode: made.migratedCollectFeeMode, dynamicFee: made.migratedDynamicFee, poolFeeBps: made.migratedPoolFeeBps },
    poolCreationFee: made.poolCreationFee,
    partnerLiquidityVestingInfo: vesting(made.partnerLiquidityVestingInfo),
    creatorLiquidityVestingInfo: vesting(made.creatorLiquidityVestingInfo),
    migratedPoolBaseFeeMode: made.migratedPoolBaseFeeMode,
    migratedPoolMarketCapFeeSchedulerParams: {
      numberOfPeriod: schedule.readUInt16LE(0),
      sqrtPriceStepBps: schedule.readUInt16LE(2),
      schedulerExpirationDuration: schedule.readUInt32LE(4),
      reductionFactor: new BN(schedule.subarray(8, 16), "le"),
    },
    enableFirstSwapWithMinFee: made.enableFirstSwapWithMinFee !== 0,
    compoundingFeeBps: made.migratedCompoundingFeeBps,
    // A config account has room for twenty segments, and the ones not used are all zeros.
    curve: made.curve.filter((point) => !point.sqrtPrice.isZero() || !point.liquidity.isZero()).map(({ sqrtPrice, liquidity }) => ({ sqrtPrice, liquidity })),
  };
}

/** Every setting in `settings` under its own name, such as poolFees.baseFee.cliffFeeNumerator, as text that compares. */
function flat(settings: unknown, name = ""): [string, string][] {
  if (settings === null || settings === undefined) return [[name, "none"]];
  if (settings instanceof PublicKey) return [[name, settings.toBase58()]];
  if (BN.isBN(settings)) return [[name, settings.toString()]];
  if (typeof settings === "boolean") return [[name, settings ? "1" : "0"]];
  if (Array.isArray(settings)) return [[`${name}.length`, String(settings.length)], ...settings.flatMap((one, at) => flat(one, `${name}[${at}]`))];
  if (typeof settings === "object") return Object.entries(settings).flatMap(([key, inner]) => flat(inner, name ? `${name}.${key}` : key));
  return [[name, String(settings)]];
}

/** How a refusal says the settings of a config that a launch decides, and how it shows their values. The rest go by the name Meteora gives them. */
const CONFIG_WORDS: Record<string, { says: string; show?: (value: string) => string }> = {
  transferHookProgram: { says: "names as the program of the token's hook" },
  feeClaimer: { says: "names as the one who claims its fees" },
  leftoverReceiver: { says: "names as the receiver of tokens left over at a graduation" },
  quoteMint: { says: "is priced in the coin" },
  "poolFees.baseFee.cliffFeeNumerator": { says: "has a trading fee of", show: (value) => `${Number(value) / 1e7}%` },
  sqrtStartPrice: { says: "starts at", show: (value) => `${capAt(new BN(value))} SOL of market cap` },
  migrationQuoteThreshold: { says: "would graduate with", show: (value) => `${inSol(value)} SOL in the curve` },
  "curve.length": { says: "has a curve of", show: (value) => (value === "1" ? "one segment" : `${value} segments`) },
  tokenUpdateAuthority: {
    says: "leaves the right to edit the token's name with",
    show: (value) => (value === String(TokenAuthorityOption.Immutable) ? "nobody" : value === String(TokenAuthorityOption.CreatorUpdateAuthority) ? "the pool's creator, as a token with several names needs" : `Meteora's option ${value}`),
  },
};

/** A config on chain against the one this launch would send, every setting of both. */
function configLines(sent: ConfigSent, made: ConfigWithTransferHook): Line[] {
  const [wanted, kept] = [new Map(flat(sent)), new Map(flat(asSent(made)))];
  return [...new Set([...wanted.keys(), ...kept.keys()])].map((name) => {
    const [a, b] = [wanted.get(name) ?? "nothing", kept.get(name) ?? "nothing"];
    const meteoras = { says: `has Meteora's setting ${name} at`, sent: a, kept: b, differs: a !== b };
    const words = CONFIG_WORDS[name];
    if (a === b || !words) return meteoras;
    if (!words.show) return { ...meteoras, says: words.says };
    // Two values that differ can still read the same once rounded for a sentence. Then they are shown as they are.
    const [shownA, shownB] = [words.show(a), words.show(b)];
    return shownA === shownB ? meteoras : { says: words.says, sent: shownA, kept: shownB, differs: true };
  });
}

/** A rulebook on chain against the one this launch would write. `vault` is where the pool this launch makes keeps its SOL. */
function bookLines(p: Launch, vault: PublicKey, book: Rulebook): Line[] {
  const key = (one?: PublicKey) => (!one || one.equals(PublicKey.default) ? "none" : one.toBase58());
  const names = (list: Name[]) => list.map((name) => `${name.name} (${name.symbol})`).join(", ");
  const split = (shares: Split) => `holders ${shares.holdersBps}, burn ${shares.burnBps}, treasury ${shares.treasuryBps} bps`;
  const line = (says: string, sent: string, kept: string, more: Partial<Line> = {}): Line => ({ says, sent, kept, differs: sent !== kept, ...more });
  return [
    line("names as its guardian", key(p.guardian), key(book.guardian), { changes: true }),
    line("names as its agent", key(p.agent), key(book.agent), { changes: true, guardianCan: true }),
    line("names as its keeper", key(p.keeper), key(book.keeper), { changes: true, guardianCan: true }),
    line("names as its app key", key(p.cosigner), key(book.cosigner), { changes: true, guardianCan: true }),
    line("names as the owner no rule applies to", key(p.exempt), key(book.exempt)),
    ...(["minIntervalSecs", "maxRuleSecs", "minTreasuryBps", "maxTreasuryBps", "minRenameSecs"] as const).map((limit) => line(`sets limits.${limit} to`, String(p.limits[limit]), String(book.limits[limit]))),
    // Told apart by more than the way they read: a name may itself hold a comma or a bracket.
    line("goes by the names", names(p.names), names(book.names), { differs: JSON.stringify(p.names.map((name) => [name.name, name.symbol])) !== JSON.stringify(book.names.map((name) => [name.name, name.symbol])) }),
    line("holds as the curve's SOL vault", vault.toBase58(), book.curveVault.toBase58(), { why: `which is where the pool its mint makes with the config ${p.config.publicKey.toBase58()} keeps its SOL` }),
    // The split a rulebook holds is the one it opened with only until the first edict.
    ...(book.epoch === 0n ? [line("opens with the fees split", split(p.split), split(book))] : []),
  ];
}

/** What an earlier run left on chain. A part is null while it is not there, and "other" if something else is at its address. */
type There = {
  config: ConfigWithTransferHook | "other" | null;
  book: Rulebook | "other" | null;
  pool: boolean;
  /** The mint, which exists from the pool's creation on, so it is read only when the pool is there. */
  mint: { hook: PublicKey | null; minter: PublicKey | null; freezer: PublicKey | null; name: string; symbol: string; uri: string } | null;
};

async function whatIsThere(p: Launch, pool: PublicKey): Promise<There> {
  const { connection } = p.dbc;
  const [config, book, pooled] = (await connection.getMultipleAccountsInfo([p.config.publicKey, rulebookAddress(p.hookProgram, p.mint.publicKey), pool])).map((account) =>
    // Lamports somebody sent to an address that is still empty do not make an account there: whoever creates it counts them towards its rent.
    account && (account.data.length > 0 || !account.owner.equals(SystemProgram.programId)) ? account : null,
  );
  const coder = p.dbc.state.getProgram().coder.accounts;
  const asConfig = (data: Buffer) => {
    try {
      return coder.decode<ConfigWithTransferHook>("configWithTransferHook", data);
    } catch {
      return "other" as const;
    }
  };
  let mint: There["mint"] = null;
  if (pooled) {
    const [made, metadata] = [await getMint(connection, p.mint.publicKey, "confirmed", TOKEN_2022_PROGRAM_ID), await getTokenMetadata(connection, p.mint.publicKey, "confirmed", TOKEN_2022_PROGRAM_ID)];
    mint = { hook: getTransferHook(made)?.programId ?? null, minter: made.mintAuthority, freezer: made.freezeAuthority, name: metadata?.name ?? "", symbol: metadata?.symbol ?? "", uri: metadata?.uri ?? "" };
  }
  return {
    config: config && (config.owner.equals(METEORA_DBC) ? asConfig(config.data) : "other"),
    book: book && (book.owner.equals(p.hookProgram) && book.data.length === RULEBOOK_LEN ? decodeRulebook(book.data) : "other"),
    pool: pooled !== null,
    mint,
  };
}

/**
 * What is on chain against what this launch asks for. `wrong` is the first thing that
 * differs, said in one sentence, or null if all of it is what the launch would have sent.
 * `since` tells the keys that are no longer the launch's in a token that is already launched.
 */
function compared(p: Launch, sent: ConfigSent, pool: PublicKey, there: There): { reached: Reached | null; wrong: { text: string; guardianCan: boolean } | null; since: string[] } {
  const reached: Reached | null = there.pool ? "pool" : there.book ? "rulebook" : there.config ? "config" : null;
  const [config, book, mint] = [p.config.publicKey.toBase58(), rulebookAddress(p.hookProgram, p.mint.publicKey).toBase58(), p.mint.publicKey.toBase58()];
  const since: string[] = [];
  const stop = (text: string, guardianCan = false) => ({ reached, wrong: { text, guardianCan }, since });
  /** The first line of `lines` that differs, as a sentence about `subject`. */
  const first = (subject: string, lines: Line[]) => {
    const line = lines.find((one) => one.differs);
    return line ? stop(`${subject} ${line.says} ${line.kept}, and this launch asks for ${line.sent}${line.why ? `, ${line.why}` : ""}`, line.guardianCan) : null;
  };

  if (there.config === "other") return stop(`there is an account at ${config}, where the curve's config goes, and it is not a config of Meteora's for a token with a hook`);
  if (there.book === "other") return stop(`there is an account at ${book}, where the token's rulebook goes, and it is not a rulebook of the program ${p.hookProgram.toBase58()}`);
  const inConfig = there.config && first(`the curve config ${config}, left on chain by an earlier run,`, configLines(sent, there.config));
  if (inConfig) return inConfig;
  if (there.book) {
    const lines = bookLines(p, deriveDbcTokenVaultAddress(pool, NATIVE_MINT), there.book);
    // Once the token is launched its four keys can be replaced, so a key that is not the launch's is told and not refused.
    const replaced = there.pool ? lines.filter((line) => line.changes && line.differs) : [];
    for (const line of replaced) since.push(`the rulebook now ${line.says} ${line.kept}, not the ${line.sent} of this launch: a key can be replaced after the launch, and this one may have been`);
    const inBook = first(`the rulebook ${book}, written by an earlier run,`, lines.filter((line) => !replaced.includes(line)));
    if (inBook) return inBook;
  }
  if (there.mint) {
    const who = (one: PublicKey | null) => one?.toBase58() ?? "nobody";
    const line = (says: string, wanted: string, kept: string): Line => ({ says, sent: wanted, kept, differs: wanted !== kept });
    const inMint = first(`the token ${mint}, launched by an earlier run,`, [
      line("carries as the program of its hook", p.hookProgram.toBase58(), there.mint.hook?.toBase58() ?? "none"),
      line("can have more of it minted by", "nobody", who(there.mint.minter)),
      line("can have its accounts frozen by", "nobody", who(there.mint.freezer)),
      line("names its card at", p.uri, there.mint.uri),
    ]);
    if (inMint) return inMint;
  }
  return { reached, wrong: null, since };
}

/** The config this launch would send, and the pool it would make. */
function planned(p: Launch) {
  const renamable = p.names.length > 1;
  const params = curveConfig({ ...p.curve, renamable });
  mustNotGraduate(params);
  const book = rulebookAddress(p.hookProgram, p.mint.publicKey);
  // The fees can be claimed only by the rulebook's address, which is to say only by the hook
  // program, for the keeper. Tokens left over at a graduation would go to the same address;
  // the curve cannot graduate, and is built to leave none.
  const accounts = { transferHookProgram: p.hookProgram, feeClaimer: book, leftoverReceiver: book, quoteMint: NATIVE_MINT };
  // The builder's padding is no setting: the program reads past it.
  const { padding: _padding, ...settings } = params;
  return { renamable, params, accounts, sent: { ...accounts, ...settings } satisfies ConfigSent, book, pool: deriveDbcPoolAddress(NATIVE_MINT, p.mint.publicKey, p.config.publicKey) };
}

/**
 * How far an earlier run of this launch got, without sending anything: null if nothing of it
 * is on chain. Refused, as `launch` is, if what is there is not what this launch asks for.
 */
export async function earlierRun(p: Launch): Promise<Reached | null> {
  const plan = planned(p);
  const { reached, wrong } = compared(p, plan.sent, plan.pool, await whatIsThere(p, plan.pool));
  if (wrong) throw new Refused(wrong.text, reached!, wrong.guardianCan);
  return reached;
}

export async function launch(p: Launch, send: Send): Promise<{ pool: PublicKey }> {
  const { renamable, params, accounts, sent, book, pool } = planned(p);
  const { connection } = p.dbc;
  // Everything an earlier run left is compared before the first transaction, not step by
  // step: a rulebook written for another config has to stop the launch before a new config is paid for.
  const there = await whatIsThere(p, pool);
  const { reached, wrong } = compared(p, sent, pool, there);
  if (wrong) throw new Refused(wrong.text, reached!, wrong.guardianCan);

  if (!there.config) {
    const config = await p.dbc.partner.createConfigWithTransferHook({ ...params, ...accounts, config: p.config.publicKey, payer: p.payer.publicKey });
    await send("create the curve's config", config, [p.payer, p.config]);
  }

  // The rulebook goes in before the pool: the mint's own key signs it, and without it no
  // transfer of the token can go through.
  if (!there.book) {
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

  if (!there.pool) {
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

/**
 * Reads a launched token back from the chain and says what its config and its mint hold. It
 * is refused, as a launch is, if they are not what `p` describes. A node can show a
 * transaction as confirmed a moment before it shows what the transaction made, so it asks a
 * few times before saying the token is not there.
 */
export async function readBack(p: Launch, tries = 10): Promise<Launched> {
  const { sent, pool } = planned(p);
  for (let attempt = 1; ; attempt++) {
    const there = await whatIsThere(p, pool).catch((error: unknown) => (attempt < tries ? null : Promise.reject(error)));
    if (there?.config && there.book && there.pool && there.mint) {
      const { wrong, since } = compared(p, sent, pool, there);
      if (wrong) throw new Refused(wrong.text, "pool", wrong.guardianCan);
      // Past the comparison the config is a config, with the hook this launch names on its mint.
      const { config: made } = there.config as ConfigWithTransferHook;
      const { baseFee, dynamicFee } = made.poolFees;
      return {
        pool,
        graduationSol: Number(made.migrationQuoteThreshold.toString()) / LAMPORTS_PER_SOL,
        segments: made.curve.filter((point) => !point.sqrtPrice.isZero() || !point.liquidity.isZero()).length,
        startCapSol: capAt(made.sqrtStartPrice),
        feeBps: Number(baseFee.cliffFeeNumerator.toString()) / 1e5,
        feeFlat: !dynamicFee.initialized && baseFee.firstFactor === 0 && baseFee.secondFactor.isZero() && baseFee.thirdFactor.isZero(),
        feeInSol: made.collectFeeMode === CollectFeeMode.QuoteToken && made.quoteMint.equals(NATIVE_MINT),
        feeClaimer: made.feeClaimer,
        hook: there.mint.hook!,
        name: there.mint.name,
        symbol: there.mint.symbol,
        uri: there.mint.uri,
        since,
      };
    }
    if (attempt >= tries) throw new Error(`the node does not show ${!there?.config ? "the curve's config" : !there.book ? "the rulebook" : "the pool"} of this token: either it is not launched, or the node is behind`);
    await new Promise((r) => setTimeout(r, 1_500));
  }
}
