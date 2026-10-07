// Where the page reads the record from. Until `rulebook` is filled in, the page shows its
// specimen issue.
window.SITE = {
  // An RPC endpoint the browser may call. Solana's public one turns browsers away under load.
  rpc: "https://api.mainnet-beta.solana.com",

  // Addresses, as printed at launch.
  rulebook: "",
  program: "",
  pool: "",

  // The agent's published decisions, one JSON object per line.
  log: "data/log.jsonl",

  // The curve's trading fee in basis points. It is fixed with the curve and is not in the rulebook.
  feeBps: 200,

  // What the agent is called on these pages.
  agent: "Veluno",

  // The app a hook about "the app" means.
  app: "FOMO",

  explorer: "https://solscan.io",

  // Shown under the addresses: [{ label: "Jupiter", url: "https://jup.ag/swap/SOL-<mint>" }]
  trade: [],
};

// Set before the page paints, so a live page never shows the specimen.
document.documentElement.dataset.mode = window.SITE.rulebook ? "live" : "specimen";
