// Fills the page from the chain. The markup already holds a complete specimen; on a live page
// every slot is overwritten with what the rulebook and the agent's log say. Text that came
// from the agent is only ever set as text, never as markup.
import { hashOf, isAddress, isSignature, readLog, readRulebook } from "./chain.js";

const site = window.SITE;
const root = document.documentElement;
const POLL_MS = 20_000;
const MAX_ENTRIES = 60;

const slot = (name) => document.querySelector(`[data-${name}]`);
const write = (name, text) => {
  slot(name).textContent = text;
};

const percent = (bps) => `${Number((bps / 100).toFixed(2))}%`;

/** "15 minutes", "6 hours", "1 hour 30 minutes". */
function span(seconds) {
  const parts = [];
  for (const [unit, size] of [["day", 86_400], ["hour", 3_600], ["minute", 60], ["second", 1]]) {
    const count = Math.floor(seconds / size);
    if (count) parts.push(`${count} ${unit}${count === 1 ? "" : "s"}`);
    seconds -= count * size;
    if (parts.length === 2) break;
  }
  return parts.join(" ") || "0 seconds";
}

function clock(seconds) {
  const two = (n) => String(n).padStart(2, "0");
  const hours = Math.floor(seconds / 3_600);
  const rest = `${two(Math.floor((seconds % 3_600) / 60))}:${two(seconds % 60)}`;
  return hours ? `${hours}:${rest}` : rest;
}

const dayAndTime = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC" });
const timeOnly = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC" });
const when = (ms) => `${dayAndTime.format(ms)} UTC`;

function ago(ms) {
  const minutes = Math.floor((Date.now() - ms) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.floor(hours / 24)} days ago`;
}

const shorten = (text) => `${text.slice(0, 4)}…${text.slice(-4)}`;

function link(text, href) {
  const a = document.createElement("a");
  a.textContent = text;
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener";
  return a;
}

function mark(text, className) {
  const span = document.createElement("span");
  span.textContent = text;
  span.className = className;
  return span;
}

const separated = (parts) => parts.flatMap((part, i) => (i ? [" · ", part] : [part]));

let book = null;
let entries = [];
/** The published text of the edict in force, once its hash has been checked against the chain. */
let inForce = { entry: null, verified: false };
/** Logged edicts whose text hashes to the note logged with them. The page shows no other text. */
let sound = new Set();

async function refresh() {
  try {
    const [nextBook, nextEntries] = await Promise.all([readRulebook(site.rpc, site.rulebook), readLog(site.log)]);
    const log = nextEntries ?? entries;
    const hashes = await Promise.all(log.map((e) => (e.record.action === "rewrite" ? hashOf(e.record) : null)));
    const entry = log.findLast((e) => e.record.action === "rewrite" && e.record.epoch === nextBook.epoch) ?? null;
    // The edict in force is held to the chain; older ones to the note in their own transaction.
    sound = new Set(log.filter((e, i) => hashes[i] === (e === entry ? nextBook.note : e.note)));
    inForce = { entry, verified: sound.has(entry) };
    book = nextBook;
    entries = log;
    renderEdict();
    renderCharter();
    renderRecord();
    renderAddresses();
    root.dataset.state = "ready";
  } catch {
    // What was last read stays on the page; only a first read that fails shows the notice.
    if (!book) root.dataset.state = "error";
  }
  renderStatus();
}

function renderStatus() {
  const status = slot("status");
  if (!book) {
    status.textContent = "Not read yet";
    return;
  }
  status.classList.toggle("is-active", !book.paused);
  const last = entries.at(-1);
  const looked = last && !book.paused ? ` · agent last looked ${ago(Date.parse(last.record.at))}` : "";
  status.textContent = `${book.epoch} ${book.epoch === 1 ? "edict" : "edicts"} issued${book.paused ? " · agent suspended" : looked}`;
}

function renderBuying() {
  const left = Math.ceil(book.gateUntil - Date.now() / 1000);
  if (left > 0) {
    write("term-buying", `${site.app} app only`);
    write("term-buying-note", `${clock(left)} left · closes ${timeOnly.format(book.gateUntil * 1000)} UTC`);
  } else {
    write("term-buying", "Open to all");
    write("term-buying-note", "no app-only window");
  }
}

function renderEdict() {
  const published = inForce.verified ? inForce.entry.record : null;
  document.querySelector(".edict").classList.toggle("is-suspended", book.paused);
  write("edict-title", book.epoch ? `Edict No. ${book.epoch}` : "Opening rules");
  write("edict-issued", book.updatedAt ? `· issued ${when(book.updatedAt * 1000)}` : "");
  write("edict-status", book.paused ? "Suspended by the guardian · no rule applies" : "In force");
  write("seal-no", String(book.epoch));

  const text = slot("edict-text");
  text.classList.toggle("is-plain", !published);
  text.textContent = published
    ? published.announcement
    : book.epoch === 0
      ? "No edict has been issued yet. The rules the token opened with are in force."
      : inForce.entry
        ? "A text was published for this edict, but its hash does not match the chain, so it is not shown. The terms below are the chain’s."
        : "The text of this edict has not been published yet. The terms below are the chain’s.";

  renderBuying();
  write("term-buy", book.maxBuyBps ? `${percent(book.maxBuyBps)} of supply` : "No limit");
  write("term-wallet", book.maxWalletBps ? `${percent(book.maxWalletBps)} of supply` : "No limit");
  for (const [name, bps] of [["holders", book.holdersBps], ["burn", book.burnBps], ["treasury", book.treasuryBps]]) {
    slot("split").style.setProperty(`--${name}`, bps);
    write(`split-${name}`, percent(bps));
  }

  slot("reasons-block").hidden = !published;
  if (published) write("edict-reasons", published.reasoning);

  const proof = [`Agent ${shorten(book.agent)}`];
  if (inForce.entry && isSignature(inForce.entry.signature)) proof.push(link(`transaction ${shorten(inForce.entry.signature)}`, `${site.explorer}/tx/${inForce.entry.signature}`));
  if (book.epoch) proof.push(`text hash ${book.note.slice(0, 16)}…`);
  if (inForce.entry) proof.push(inForce.verified ? mark("matches the published text", "is-verified") : mark("does not match the published text", "is-mismatch"));
  slot("edict-proof").replaceChildren(...separated(proof));
}

function renderCharter() {
  const { limits } = book;
  const windows = limits.maxGateSecs > 0 && book.hasApp;
  slot("has-window").hidden = !windows;
  slot("no-window").hidden = windows;
  write("limit-interval", span(limits.minIntervalSecs));
  write("limit-window", span(limits.maxGateSecs));
  write("limit-buy", percent(limits.minMaxBuyBps));
  write("limit-wallet", percent(limits.minMaxWalletBps));
  write("limit-treasury", percent(limits.maxTreasuryBps));
  write("fee", percent(site.feeBps));
}

const termsLine = (change) =>
  [
    change.gateSecs ? `${site.app} only for ${span(change.gateSecs)}` : "Buying open",
    `Largest buy ${change.maxBuyBps ? percent(change.maxBuyBps) : "none"}`,
    `Largest wallet ${change.maxWalletBps ? percent(change.maxWalletBps) : "none"}`,
    `Fees ${change.holdersBps / 100} / ${change.burnBps / 100} / ${change.treasuryBps / 100}`,
  ].join(" · ");

function renderEntry(entry) {
  const { record } = entry;
  const edict = record.action === "rewrite";
  const node = document.getElementById("entry-template").content.firstElementChild.cloneNode(true);
  node.classList.toggle("is-hold", !edict);
  node.querySelector(".entry-no").textContent = edict ? `No. ${record.epoch}` : "No change";
  node.querySelector(".entry-when").textContent = when(Date.parse(record.at));
  if (edict && sound.has(entry)) {
    node.querySelector(".entry-text").textContent = record.announcement;
    node.querySelector(".entry-terms").textContent = termsLine(record.change);
    node.querySelector(".entry-reasons p").textContent = record.reasoning;
  } else {
    node.classList.toggle("is-unsound", edict);
    node.querySelector(".entry-text").textContent = edict ? "The text logged for this edict does not match its hash, so it is not shown." : record.reasoning;
    node.querySelector(".entry-terms").remove();
    node.querySelector(".entry-reasons").remove();
  }
  const proof = node.querySelector(".entry-proof");
  if (edict && isSignature(entry.signature)) {
    const parts = [link(`transaction ${shorten(entry.signature)}`, `${site.explorer}/tx/${entry.signature}`)];
    if (typeof entry.note === "string") parts.push(`text hash ${entry.note.slice(0, 16)}…`);
    proof.replaceChildren(...separated(parts));
  } else {
    proof.remove();
  }
  return node;
}

function renderRecord() {
  slot("record").replaceChildren(...entries.slice(-MAX_ENTRIES).reverse().map(renderEntry));
  slot("record-empty").hidden = entries.length > 0;
  slot("record-more").hidden = entries.length <= MAX_ENTRIES;
  slot("record-file").href = site.log;
}

/** The addresses in config.js are shown at once; the ones only the rulebook knows follow its first read. */
function renderAddresses() {
  const rows = [
    ["Token", book?.mint, "token"],
    ["Rulebook", site.rulebook, "account"],
    ["Hook program", site.program, "account"],
    ["Curve", site.pool, "account"],
    ["Agent", book?.agent, "account"],
    ["Guardian", book?.guardian, "account"],
  ].filter(([, address]) => isAddress(address));
  slot("addresses").replaceChildren(
    ...rows.map(([label, address, kind]) => {
      const node = document.getElementById("address-template").content.firstElementChild.cloneNode(true);
      node.querySelector("dt").textContent = label;
      node.querySelector("code").textContent = address;
      node.querySelector("a").href = `${site.explorer}/${kind}/${address}`;
      return node;
    }),
  );

  const links = site.trade.filter((item) => /^https:\/\//.test(item.url));
  slot("trade").hidden = links.length === 0;
  slot("trade-links").replaceChildren(...links.map((item) => link(item.label, item.url)));
}

slot("addresses").addEventListener("click", async (event) => {
  const button = event.target.closest(".copy");
  if (!button) return;
  const code = button.closest(".address").querySelector("code");
  try {
    await navigator.clipboard.writeText(code.textContent);
    button.textContent = "Copied";
  } catch {
    // The browser refused the clipboard: select the address, so one keystroke copies it.
    getSelection().selectAllChildren(code);
    button.textContent = "Selected";
  }
  setTimeout(() => {
    button.textContent = "Copy";
  }, 1_500);
});

if (root.dataset.mode === "live") {
  renderAddresses();
  refresh();
  setInterval(() => {
    if (!document.hidden) refresh();
  }, POLL_MS);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refresh();
  });
  // The countdown and "looked n min ago" move with the clock, not with the chain.
  setInterval(() => {
    if (!book) return;
    renderBuying();
    renderStatus();
  }, 1_000);
}
