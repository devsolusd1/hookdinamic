// The guardian's command: the brake the owner pulls from home, with the one key that never
// goes on a server.
//
//   npm run guardian -- <token.json> status
//   npm run guardian -- <token.json> pause              --key <guardian keypair file>
//   npm run guardian -- <token.json> resume             --key <guardian keypair file>
//   npm run guardian -- <token.json> agent <address>    --key <guardian keypair file>
//   npm run guardian -- <token.json> keeper <address>   --key <guardian keypair file>
//
// Without --send it only says what it would do, and asks the chain whether it would be
// accepted. With --send it does it; on mainnet --mainnet is needed as well.
//
// It reaches the chain through the node named as "rpc" in <token.json>, which is the server's
// own, with its key. On the day that key has been deleted or has run out, add
//   --rpc <address>
// to any of the lines above to go through another node for that one command, for example
// --rpc https://api.mainnet-beta.solana.com, Solana's public one, which is enough for this.
//
// <token.json> is the file the launch wrote: it names the network, the program and the mint.
// The key is read from the file named after --key and is used for this one transaction; it is
// not copied, printed or kept. A key that is not the rulebook's guardian is refused before
// anything else is done.
//
//   pause    the agent can issue nothing, and no rule is enforced: every buy goes through
//   resume   the agent may issue edicts again
//   agent    another key becomes the agent; the old one can issue nothing from then on
//   keeper   another key becomes the keeper; the old one can take no fees from then on
import "../src/quiet.js";
import { readFileSync } from "node:fs";
import { Connection, Keypair, PublicKey, sendAndConfirmTransaction, Transaction, type TransactionInstruction } from "@solana/web3.js";
import { decodeRulebook, describe, pauseIx, REFUSAL, rulebookAddress, setAgentIx, setKeeperIx, span, type Rulebook } from "../src/hook.js";

const NETWORKS: Record<string, string> = {
  "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d": "mainnet",
  EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG: "devnet",
  "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY": "testnet",
};
/** Solana's own public nodes: slow and limited, and enough for the few calls this command makes. */
const PUBLIC_NODES: Record<string, string> = { mainnet: "https://api.mainnet-beta.solana.com", devnet: "https://api.devnet.solana.com", testnet: "https://api.testnet.solana.com" };
const ACTIONS = ["status", "pause", "resume", "agent", "keeper"] as const;
type Action = (typeof ACTIONS)[number];
/** The flags that are followed by a word of their own. */
const WITH_A_WORD = ["--key", "--rpc"];

/** A reason to stop that is said to a person as it is, with no stack trace. */
class Halt extends Error {}
function refuse(why: string): never {
  throw new Halt(why);
}

/** What the hook program answered, in words, if the text of an error or a log carries its number. */
function refusalIn(text: string): string | null {
  const code = /custom program error: 0x([0-9a-f]+)/.exec(text)?.[1];
  return code ? (REFUSAL[parseInt(code, 16)] ?? null) : null;
}

/** An error as one line that is safe to print: the RPC's address carries its key, so only the host of any address is kept. */
function plain(error: unknown): string {
  const text = (error instanceof Error ? error.message : String(error)).split("\n")[0];
  return text.replace(/\b(?:https?|wss?):\/\/[^\s"'<>]+/g, (address) => {
    try {
      return new URL(address).origin;
    } catch {
      return "(an address)";
    }
  });
}

async function run() {
  const args = process.argv.slice(2);
  const flag = (name: string) => args.includes(name);
  /** The word after a flag such as --key. */
  const after = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const words = args.filter((arg, i) => !arg.startsWith("--") && !WITH_A_WORD.includes(args[i - 1]));
  const [file, action, given] = words as [string | undefined, Action | undefined, string | undefined];
  if (!file || !action || !ACTIONS.includes(action)) {
    refuse(`Say which token and what to do, for example:\n    npm run guardian -- token.json status\n    npm run guardian -- token.json pause --key guardian.json\n  What it can do: ${ACTIONS.join(", ")}.\n  If the node in token.json does not answer, add --rpc and the address of another one.`);
  }

  let token: { rpc?: string; hookProgram: string; mint: string; network?: string };
  try {
    token = JSON.parse(readFileSync(file, "utf8"));
    if (!token.hookProgram || !token.mint) throw new Error("incomplete");
  } catch {
    refuse(`${file} is not the token.json the launch wrote: it has to name rpc, hookProgram and mint.`);
  }
  let program: PublicKey;
  let mint: PublicKey;
  try {
    [program, mint] = [new PublicKey(token.hookProgram), new PublicKey(token.mint)];
  } catch {
    refuse(`${file} is not the token.json the launch wrote: its hookProgram and mint have to be addresses.`);
  }

  // The node to ask. The one in token.json is the server's own; --rpc names another for this one command.
  const otherNode = after("--rpc");
  /** Solana's public node for this token's network, as the launch wrote it down. */
  const publicNode = PUBLIC_NODES[token.network ?? ""];
  if (flag("--rpc") && (!otherNode || otherNode.startsWith("--"))) refuse(`--rpc needs the address of a node after it, for example --rpc ${publicNode ?? PUBLIC_NODES.mainnet}`);
  const node = otherNode ?? token.rpc;
  if (!node) refuse(`${file} names no rpc. Add --rpc and the address of a node, for example --rpc ${publicNode ?? PUBLIC_NODES.mainnet}`);
  let connection: Connection;
  try {
    connection = new Connection(node, "confirmed");
  } catch {
    refuse(`${otherNode ? "The address after --rpc" : `The rpc in ${file}`} is not a node's address: it has to start with https://`);
  }
  /** The node by its host only: the rest of the address may be its key. */
  const host = plain(node);
  /** Whether the transaction has left. After that, a node that stops answering no longer means nothing happened. */
  let sent = false;
  /**
   * An answer from the node. When none comes it is said in plain words, with the way round it:
   * in an emergency the server's own node may be the very thing that is gone.
   */
  async function ask<T>(question: () => Promise<T>): Promise<T> {
    try {
      return await question();
    } catch (error) {
      if (error instanceof Halt) throw error;
      const wayRound = otherNode
        ? "That is the node you named after --rpc. Check its address, or name another."
        : `That is the node named as "rpc" in ${file}, the server's own: its key may have been deleted or used up.\n  Run the same command again through another node, by adding at the end:\n      --rpc ${publicNode ?? `${PUBLIC_NODES.mainnet}\n  (that one is mainnet's; on devnet it is ${PUBLIC_NODES.devnet})`}`;
      refuse(`I could not get an answer from the node at ${host}: ${plain(error)}.\n  ${sent ? "The transaction had been sent by then: run status to see whether it went through." : "Nothing was sent."}\n  ${wayRound}`);
    }
  }

  const rulebook = rulebookAddress(program, mint);
  const network = NETWORKS[await ask(() => connection.getGenesisHash())] ?? "an unknown network (a local validator?)";
  // A node of another network shows no rulebook at this address, which would read as the wrong token.json.
  if (publicNode && network !== token.network && Object.values(NETWORKS).includes(network)) {
    refuse(`The node at ${host} is on ${network}, and ${file} says this token is on ${token.network}.\n  Nothing was done. Name a ${token.network} node, for example --rpc ${publicNode}`);
  }

  const readBook = async (): Promise<Rulebook> => {
    const account = await ask(() => connection.getAccountInfo(rulebook, "confirmed"));
    if (!account) refuse(`There is no rulebook at ${rulebook.toBase58()} on ${network}. Is this the right token.json?`);
    return decodeRulebook(account.data);
  };
  const chainTime = async () => (await ask(async () => connection.getBlockTime(await connection.getSlot("confirmed")))) ?? Math.floor(Date.now() / 1000);

  /** The rulebook as it stands, in a few lines. */
  const show = (book: Rulebook, now: number) => {
    const name = book.names[book.name];
    const left = book.ruleUntil - now;
    const rule = left <= 0 ? "none: the last edict's term is over" : book.rule.length === 0 ? `no buying rule, for another ${span(left)}` : `a buy goes through if ${describe(book.rule).join("; or if ")}, for another ${span(left)}`;
    console.log(`
  network     ${network}
  token       ${name ? `${name.name} (${name.symbol})` : "unnamed"}, mint ${mint.toBase58()}
  rulebook    ${rulebook.toBase58()}
  guardian    ${book.guardian.toBase58()}
  agent       ${book.agent.toBase58()}
  keeper      ${book.keeper.toBase58()}
  app key     ${book.cosigner.equals(PublicKey.default) ? "none: no hook about an app applies" : book.cosigner.toBase58()}
  state       ${book.paused ? "PAUSED: the agent can issue nothing and no rule is enforced" : "running"}
  edicts      ${book.epoch} so far
  in force    ${book.paused ? "nothing while paused" : rule}`);
  };

  const book = await readBook();
  show(book, await chainTime());
  if (action === "status") return void console.log("\n  Nothing was sent: status only looks.\n");

  const keyFile = after("--key");
  if (!keyFile) refuse(`"${action}" needs the guardian's key: add --key and the path of its keypair file.`);
  let guardian: Keypair;
  try {
    guardian = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keyFile, "utf8"))));
  } catch {
    refuse(`${keyFile} is not a keypair file: it has to hold a list of 64 numbers.`);
  }
  // Before anything else: the wrong key would only be refused by the program, after paying for a transaction.
  if (!guardian.publicKey.equals(book.guardian)) {
    refuse(`The key in ${keyFile} is ${guardian.publicKey.toBase58()}.\n  This token's guardian is ${book.guardian.toBase58()}.\n  It is not the guardian's key, so nothing was done.`);
  }

  /** An address given on the command line. It has to be an ordinary wallet's: a key somebody can sign with. */
  const wallet = (what: string): PublicKey => {
    let key: PublicKey;
    try {
      key = new PublicKey(given ?? "");
    } catch {
      refuse(`"${action}" needs the address of the new ${what}: npm run guardian -- ${file} ${action} <address> --key ${keyFile}`);
    }
    if (key.equals(PublicKey.default) || !PublicKey.isOnCurve(key.toBytes())) refuse(`${key.toBase58()} is not a wallet's address: nobody could sign as the ${what} with it.`);
    return key;
  };

  let ix: TransactionInstruction;
  let plan: string[];
  /** Whether the rulebook shows the change, once it is made. */
  let made: (after: Rulebook) => boolean;
  if (action === "pause" || action === "resume") {
    const paused = action === "pause";
    if (book.paused === paused) return void console.log(`\n  The agent is already ${paused ? "paused" : "running"}: there is nothing to do.\n`);
    ix = pauseIx({ program, guardian: guardian.publicKey, mint, paused });
    plan = paused
      ? ["PAUSE the agent.", "From then on the agent can issue nothing, and no buying rule is enforced: every buy goes through.", "Selling was never restricted. The keeper goes on paying out the fees as the last split says.", `Undo it with: npm run guardian -- ${file} resume --key ${keyFile} --send${network === "mainnet" ? " --mainnet" : ""}`]
      : ["RESUME the agent.", "From then on the agent may issue edicts again.", "If the last edict's term has not run out, its buying rule applies again from that moment."];
    made = (after) => after.paused === paused;
  } else if (action === "agent") {
    const agent = wallet("agent");
    if (agent.equals(book.agent)) return void console.log(`\n  ${agent.toBase58()} is the agent already: there is nothing to do.\n`);
    ix = setAgentIx({ program, guardian: guardian.publicKey, mint, agent });
    plan = [
      "REPLACE THE AGENT.",
      `old agent   ${book.agent.toBase58()}   can issue nothing from then on`,
      `new agent   ${agent.toBase58()}   becomes the only key that can issue edicts`,
      "The edict in force stays as it is. The service has to be given the new agent's key before it can issue the next one.",
      ...(agent.equals(guardian.publicKey) ? ["WARNING: that is the guardian's own key. Whoever gets one then has both."] : []),
      ...(agent.equals(book.keeper) ? ["WARNING: that is the keeper's key. One stolen key would then be both."] : []),
    ];
    made = (after) => after.agent.equals(agent);
  } else {
    const keeper = wallet("keeper");
    if (keeper.equals(book.keeper)) return void console.log(`\n  ${keeper.toBase58()} is the keeper already: there is nothing to do.\n`);
    ix = setKeeperIx({ program, guardian: guardian.publicKey, mint, keeper });
    plan = [
      "REPLACE THE KEEPER.",
      `old keeper  ${book.keeper.toBase58()}   can take no fees out of the pool from then on`,
      `new keeper  ${keeper.toBase58()}   becomes the only key the fees can be claimed for`,
      "Fees still in the pool are safe: only the new keeper can claim them.",
      "What the old keeper had already claimed and not yet paid out is in the old keeper's wallet. Left running, the old keeper pays it out by itself and then stops for good; stopped, nothing moves it for you.",
      "The service has to be given the new keeper's key, and the old keeper's books do not carry over by themselves.",
      ...(keeper.equals(guardian.publicKey) ? ["WARNING: that is the guardian's own key. Whoever gets one then has both."] : []),
      ...(keeper.equals(book.agent) ? ["WARNING: that is the agent's key. One stolen key would then be both."] : []),
    ];
    made = (after) => after.keeper.equals(keeper);
  }

  const send = flag("--send");
  console.log(`\n  ${send ? "Doing this" : "This is what --send would do"}, signed by the guardian ${guardian.publicKey.toBase58()}:\n`);
  for (const line of plan) console.log(`    ${line}`);

  // The guardian pays the network's fee itself: 0.000005 SOL.
  const balance = await ask(() => connection.getBalance(guardian.publicKey, "confirmed"));
  if (balance < 10_000) refuse(`The guardian's wallet ${guardian.publicKey.toBase58()} holds ${balance / 1e9} SOL on ${network}.\n  It pays the network's fee for this, 0.000005 SOL: send it 0.01 SOL and run this again.`);
  const tx = new Transaction().add(ix);
  tx.feePayer = guardian.publicKey;

  if (!send) {
    const { value } = await ask(async () => {
      tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
      return connection.simulateTransaction(tx);
    });
    console.log(value.err ? `\n  The chain would REFUSE it: ${refusalIn((value.logs ?? []).join("\n")) ?? JSON.stringify(value.err)}.` : "\n  The chain would accept it.");
    console.log(`  Nothing was sent. To do it, run the same command with --send${network === "mainnet" ? " --mainnet" : ""} at the end.\n`);
    return;
  }
  if (network === "mainnet" && !flag("--mainnet")) refuse("This is mainnet: add --mainnet as well as --send if that is what you mean.");

  sent = true;
  const signature = await sendAndConfirmTransaction(connection, tx, [guardian], { commitment: "confirmed" }).catch((error: unknown) => {
    const text = error instanceof Error ? error.message : String(error);
    refuse(`It did not go through: ${refusalIn(text) ?? plain(error)}.\n  Run "npm run guardian -- ${file} status"${otherNode ? ", with the same --rpc," : ""} to see how things stand: a transaction can land although its confirmation was not seen.`);
  });
  console.log(`\n  Done. Transaction ${signature}`);
  const now = await readBook();
  show(now, await chainTime());
  console.log(made(now) ? "\n  The rulebook shows the change.\n" : "\n  The rulebook does NOT show the change yet. Run status again in a moment.\n");
}

// The command ends by reaching the end of the file, not through process.exit. On Windows that
// call cuts across the connection to the RPC while Node is still closing it, and the process
// dies on its way out with a failed assertion and exit code 127.
try {
  await run();
} catch (error) {
  console.error(`\n  ${error instanceof Halt ? error.message : `It stopped on an error: ${plain(error)}`}\n`);
  process.exitCode = 1;
}
