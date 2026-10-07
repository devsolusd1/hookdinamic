// Where the page reads the record from. Until `rulebook` is filled in, the page shows its
// specimen issue.
window.SITE = {
  // An RPC endpoint the browser may call. Solana's public one turns browsers away, so this is
  // a provider's, with a key that only answers pages on veluno.li and www.veluno.li. The key is
  // public by nature: it is the provider's lock on the domain that protects it. The page's
  // live connection goes to the same address over wss.
  rpc: "https://mainnet.helius-rpc.com/?api-key=de4569d6-ed27-4b75-a13d-febdeeccf9f4",

  // Addresses, as printed at launch.
  rulebook: "",
  program: "",
  pool: "",

  // The agent's published decisions, one JSON object per line.
  log: "data/log.jsonl",

  // What the keeper has done with the fees: its running totals and the last lines of its
  // ledger, in one small file it replaces after every line.
  ledger: "data/ledger-head.json",

  // The whole ledger, every line from the first. The page links to it and does not read it.
  ledgerFile: "data/ledger.jsonl",

  // The wallet the treasury's share is sent to. The project holds it. The rulebook does not
  // name it: it is an address the keeper is given (TREASURY), so the page shows it from here,
  // and it has to be the same one. The ledger says where each payment went, and the page says
  // so when one went to any other address.
  treasury: "6Zudkofv2WFz2XdAR43cozs7rJavhyn5UmQw7E9QSDph",

  // What the keeper holds itself to when it pays holders, as the charter states it: the least
  // it sends a wallet, how much has to be ready for a round, the longest it waits between
  // rounds, and how long a sum too small to send is kept for a wallet that sold everything.
  // They are the keeper's own settings and are in neither the rulebook nor the ledger.
  payout: { leastSol: 0.001, readySol: 1, waitHours: 24, lapseDays: 30 },

  // The curve's trading fee in basis points. It is fixed with the curve and is not in the rulebook.
  feeBps: 300,

  // What the agent is called on these pages.
  agent: "Veluno",

  // The app a hook about "the app" means. Nothing shows it for a token whose rulebook names no app key.
  app: "FOMO",

  explorer: "https://solscan.io",

  // Shown under the addresses: [{ label: "Jupiter", url: "https://jup.ag/swap/SOL-<mint>" }]
  trade: [],
};

// Set before the page paints, so a live page never shows the specimen.
document.documentElement.dataset.mode = window.SITE.rulebook ? "live" : "specimen";
