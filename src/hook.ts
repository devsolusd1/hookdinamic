// Client for the hook program: addresses, instructions and the rulebook decoder.
// The byte layouts mirror programs/hook/src/state.rs and processor.rs. The rule language
// itself (facts, comparisons, saying a rule in words) lives in site/rules.js, which the page
// shares with this code.
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY, TransactionInstruction, type AccountMeta } from "@solana/web3.js";
import { compile, describe, FACTS, MAX_CONDITIONS, MAX_GROUPS, OPS, span } from "../site/rules.js";

export { compile, describe, FACTS, MAX_CONDITIONS, MAX_GROUPS, OPS, span };

const INIT = Buffer.from([43, 34, 13, 49, 167, 88, 235, 235]);
const TAG = { setRules: 1, pause: 2, setAgent: 3, setCosigner: 4, setGuardian: 5, setName: 6 } as const;

export const RULEBOOK_LEN = 896;
export const BPS = 10_000;
/** The most names a token can go by, and how long a name and a ticker may be, in bytes of text. */
export const MAX_NAMES = 8;
export const NAME_LEN = 32;
export const SYMBOL_LEN = 10;
const NAME_ENTRY_LEN = 44;

/** What a refused transfer or change shows as its custom program error. */
export const REFUSAL: Record<number, string> = {
  1: "this buy does not fit the rule in force",
  10: "the signer is not the agent",
  11: "the signer is not the guardian",
  12: "the guardian has paused the agent",
  13: "the last change is too recent",
  14: "a value outside the limits fixed at launch",
  15: "the fee split does not add up to 100%",
  16: "a rule the hook could not evaluate",
  17: "a name the token does not have, or the one it already goes by",
  18: "a name changes only together with an edict",
};

/** A condition as the chain stores it: a fact, a comparison and a whole number, in one of four groups. */
export type Condition = { group: number; fact: number; op: number; value: bigint };

/** A condition as a person or the agent writes it. See site/rules.js. */
export type Clause = { group: number; fact: string; op: string; value: number; modulus?: number };

/** How far the agent may go. Fixed at launch. */
export type Limits = {
  /** Shortest time between two edicts. */
  minIntervalSecs: number;
  /** Longest an edict may stand. After that every buy goes through until the next one. */
  maxRuleSecs: number;
  maxTreasuryBps: number;
  /** Shortest time between two changes of the token's name. */
  minRenameSecs: number;
};

/** A name the token can go by, and the ticker that goes with it. */
export type Name = { name: string; symbol: string };

/** Where the trading fees go, in bps. The three add up to 10,000. */
export type Split = { holdersBps: number; burnBps: number; treasuryBps: number };

/** One edict: a rule, how long it stands, and the fee split. No conditions means every buy goes through. */
export type Change = Split & { ruleSecs: number; rule: Condition[] };

export type Rulebook = Split & {
  version: number;
  paused: boolean;
  mint: PublicKey;
  guardian: PublicKey;
  agent: PublicKey;
  cosigner: PublicKey;
  exempt: PublicKey;
  curveVault: PublicKey;
  limits: Limits;
  rule: Condition[];
  /** The unix time the edict's term ends: its rule stops applying and the next edict is due. 0 before the first. */
  ruleUntil: number;
  /** How many times the rules have been rewritten. */
  epoch: bigint;
  updatedAt: number;
  note: Buffer;
  /** The names the token can go by, written at launch. */
  names: Name[];
  /** Which of them it goes by now, counted from 0. */
  name: number;
  /** Since when it has gone by that name. */
  renamedAt: number;
};

export const rulebookAddress = (program: PublicKey, mint: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("rules"), mint.toBuffer()], program)[0];

export const validationAddress = (program: PublicKey, mint: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("extra-account-metas"), mint.toBuffer()], program)[0];

const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };

const encodeSplit = (s: Split) => Buffer.concat([u16(s.holdersBps), u16(s.burnBps), u16(s.treasuryBps)]);

function encodeCondition(c: Condition): Buffer {
  const b = Buffer.alloc(12);
  b.writeUInt8(c.group, 0);
  b.writeUInt8(c.fact, 1);
  b.writeUInt8(c.op, 2);
  b.writeBigUInt64LE(c.value, 4);
  return b;
}

/** A name as the rulebook stores it: 32 bytes of name, 10 of ticker, two spare, padded with zeros. */
function encodeName({ name, symbol }: Name): Buffer {
  const [nameBytes, symbolBytes] = [Buffer.from(name, "utf8"), Buffer.from(symbol, "utf8")];
  if (nameBytes.length < 1 || nameBytes.length > NAME_LEN) throw new Error(`the name "${name}" has to be 1 to ${NAME_LEN} bytes long`);
  if (symbolBytes.length < 1 || symbolBytes.length > SYMBOL_LEN) throw new Error(`the ticker "${symbol}" has to be 1 to ${SYMBOL_LEN} bytes long`);
  if ([...(name + symbol)].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new Error(`"${name}" (${symbol}) has a character that cannot go on a token`);
  const entry = Buffer.alloc(NAME_ENTRY_LEN);
  nameBytes.copy(entry, 0);
  symbolBytes.copy(entry, NAME_LEN);
  return entry;
}

const encodeChange = (c: Change) =>
  Buffer.concat([u32(c.ruleSecs), encodeSplit(c), Buffer.from([c.rule.length]), ...c.rule.map(encodeCondition)]);

/** Writes the token's rulebook. The mint signs, so this goes out before or with the pool creation. */
export function initIx(p: {
  program: PublicKey;
  payer: PublicKey;
  mint: PublicKey;
  guardian: PublicKey;
  agent: PublicKey;
  cosigner: PublicKey;
  /** An owner no rule applies to (the buyback vault). Leave out for nobody. */
  exempt?: PublicKey;
  /** The token account that holds the curve's SOL. */
  curveVault: PublicKey;
  limits: Limits;
  split: Split;
  /** The names the token can go by, the one it launches with first. */
  names: Name[];
}): TransactionInstruction {
  if (p.names.length < 1 || p.names.length > MAX_NAMES) throw new Error(`a token has between 1 and ${MAX_NAMES} names`);
  return new TransactionInstruction({
    programId: p.program,
    keys: [
      { pubkey: p.payer, isSigner: true, isWritable: true },
      { pubkey: p.mint, isSigner: true, isWritable: false },
      { pubkey: validationAddress(p.program, p.mint), isSigner: false, isWritable: true },
      { pubkey: rulebookAddress(p.program, p.mint), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([
      INIT,
      p.guardian.toBuffer(),
      p.agent.toBuffer(),
      p.cosigner.toBuffer(),
      (p.exempt ?? PublicKey.default).toBuffer(),
      p.curveVault.toBuffer(),
      u32(p.limits.minIntervalSecs),
      u32(p.limits.maxRuleSecs),
      u16(p.limits.maxTreasuryBps),
      u32(p.limits.minRenameSecs),
      encodeSplit(p.split),
      ...p.names.map(encodeName),
    ]),
  });
}

/** The agent rewrites the rules. `note` is 32 bytes of its choice: the hash of the text it published. */
export function setRulesIx(p: { program: PublicKey; agent: PublicKey; mint: PublicKey; change: Change; note?: Buffer }): TransactionInstruction {
  const note = p.note ?? Buffer.alloc(32);
  if (note.length !== 32) throw new Error("the note is 32 bytes");
  return new TransactionInstruction({
    programId: p.program,
    keys: [
      { pubkey: p.agent, isSigner: true, isWritable: false },
      { pubkey: rulebookAddress(p.program, p.mint), isSigner: false, isWritable: true },
    ],
    data: Buffer.concat([Buffer.from([TAG.setRules]), encodeChange(p.change), note]),
  });
}

/**
 * The agent switches the token to another of its names. It only works in the same transaction
 * as an edict, placed after it. `index` counts from 0.
 */
export function setNameIx(p: { program: PublicKey; agent: PublicKey; mint: PublicKey; index: number }): TransactionInstruction {
  return new TransactionInstruction({
    programId: p.program,
    keys: [
      { pubkey: p.agent, isSigner: true, isWritable: false },
      { pubkey: rulebookAddress(p.program, p.mint), isSigner: false, isWritable: true },
      { pubkey: p.mint, isSigner: false, isWritable: true },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([TAG.setName, p.index]),
  });
}

function guardianIx(program: PublicKey, guardian: PublicKey, mint: PublicKey, tag: number, data: Buffer, extra: AccountMeta[] = []) {
  return new TransactionInstruction({
    programId: program,
    keys: [
      { pubkey: guardian, isSigner: true, isWritable: false },
      { pubkey: rulebookAddress(program, mint), isSigner: false, isWritable: true },
      ...extra,
    ],
    data: Buffer.concat([Buffer.from([tag]), data]),
  });
}

/** The guardian stops or restarts the agent. While paused the hook enforces nothing. */
export const pauseIx = (p: { program: PublicKey; guardian: PublicKey; mint: PublicKey; paused: boolean }) =>
  guardianIx(p.program, p.guardian, p.mint, TAG.pause, Buffer.from([p.paused ? 1 : 0]));

export const setAgentIx = (p: { program: PublicKey; guardian: PublicKey; mint: PublicKey; agent: PublicKey }) =>
  guardianIx(p.program, p.guardian, p.mint, TAG.setAgent, p.agent.toBuffer());

export const setCosignerIx = (p: { program: PublicKey; guardian: PublicKey; mint: PublicKey; cosigner: PublicKey }) =>
  guardianIx(p.program, p.guardian, p.mint, TAG.setCosigner, p.cosigner.toBuffer());

/** The new guardian signs too. */
export const setGuardianIx = (p: { program: PublicKey; guardian: PublicKey; mint: PublicKey; newGuardian: PublicKey }) =>
  guardianIx(p.program, p.guardian, p.mint, TAG.setGuardian, Buffer.alloc(0), [{ pubkey: p.newGuardian, isSigner: true, isWritable: false }]);

export function decodeRulebook(data: Buffer): Rulebook {
  if (data.length !== RULEBOOK_LEN) throw new Error(`a rulebook is ${RULEBOOK_LEN} bytes, got ${data.length}`);
  const key = (at: number) => new PublicKey(data.subarray(at, at + 32));
  const count = Math.min(data[280], MAX_CONDITIONS);
  const text = (at: number, length: number) => {
    const field = data.subarray(at, at + length);
    const end = field.indexOf(0);
    return field.subarray(0, end < 0 ? length : end).toString("utf8");
  };
  return {
    version: data[0],
    paused: data[2] !== 0,
    mint: key(8),
    guardian: key(40),
    agent: key(72),
    cosigner: key(104),
    exempt: key(136),
    curveVault: key(168),
    limits: {
      minIntervalSecs: data.readUInt32LE(200),
      maxRuleSecs: data.readUInt32LE(204),
      maxTreasuryBps: data.readUInt16LE(208),
      minRenameSecs: data.readUInt32LE(210),
    },
    ruleUntil: Number(data.readBigInt64LE(216)),
    holdersBps: data.readUInt16LE(224),
    burnBps: data.readUInt16LE(226),
    treasuryBps: data.readUInt16LE(228),
    epoch: data.readBigUInt64LE(232),
    updatedAt: Number(data.readBigInt64LE(240)),
    note: Buffer.from(data.subarray(248, 280)),
    rule: Array.from({ length: count }, (_, i) => {
      const at = 288 + i * 12;
      return { group: data[at], fact: data[at + 1], op: data[at + 2], value: data.readBigUInt64LE(at + 4) };
    }),
    names: Array.from({ length: Math.min(data[481], MAX_NAMES) }, (_, i) => {
      const at = 512 + i * NAME_ENTRY_LEN;
      return { name: text(at, NAME_LEN), symbol: text(at + NAME_LEN, SYMBOL_LEN) };
    }),
    name: data[480],
    renamedAt: Number(data.readBigInt64LE(488)),
  };
}

/**
 * The accounts a hooked transfer of `mint` carries after the usual ones, in Token-2022's order.
 * The SDK resolves them from chain once the mint exists; this is for a buy in the same
 * transaction that creates it.
 */
export function hookTransferAccounts(program: PublicKey, mint: PublicKey, curveVault: PublicKey): AccountMeta[] {
  return [
    { pubkey: rulebookAddress(program, mint), isSigner: false, isWritable: false },
    { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
    { pubkey: curveVault, isSigner: false, isWritable: false },
    { pubkey: program, isSigner: false, isWritable: false },
    { pubkey: validationAddress(program, mint), isSigner: false, isWritable: false },
  ];
}
