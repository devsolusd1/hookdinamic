// Fills the pages from the chain, and keeps them filled as things happen. The markup already
// holds a complete rehearsal; on a live page every slot is overwritten with what the rulebook,
// the curve and the agent's log say. Text that came from the agent is only ever set as text,
// never as markup.
import { air } from "./air.js";
import { decodeRulebook, hashOf, isAddress, isSignature, loggedRule, readChain, readLog } from "./chain.js";
import { recentTrades } from "./feed.js";
import { BUYING_HOOKS, FEE_HOOKS, IDENTITY_HOOK, recogniseRule, recogniseSplit, ruleOf, worded } from "./hooks.js";
import { watchAccounts } from "./live.js";
import { decodePool } from "./pool.js";
import { describe, span } from "./rules.js";

const site = window.SITE;
const root = document.documentElement;
const live = root.dataset.mode === "live";
const POLL_MS = 20_000;
const MAX_ENTRIES = 60;
const MAX_KNOCKS = 40;
/** How long a sentence about somebody at the door stays up. */
const NEWS_MS = 8_000;
/** How old a trade can be and still be told as having just happened. */
const NEWS_AGE_SECS = 90;
/** After this long without an answer, what is on the page is said to be old. */
const STALE_MS = 70_000;
const VIEWS = ["home", "hooks", "door", "journal", "charter"];

const slot = (name) => document.querySelector(`[data-${name}]`);
/** Some things are said in more than one place: the token's ticker is in the top bar and on a switch. */
const write = (name, text) => {
  for (const node of document.querySelectorAll(`[data-${name}]`)) node.textContent = text;
};

const percent = (bps) => `${Number((bps / 100).toFixed(2))}%`;

function clock(seconds) {
  const two = (n) => String(n).padStart(2, "0");
  const hours = Math.floor(seconds / 3_600);
  const rest = `${two(Math.floor((seconds % 3_600) / 60))}:${two(seconds % 60)}`;
  return hours ? `${hours}:${rest}` : rest;
}

const dayAndTime = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC" });
const timeOnly = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC" });
const when = (ms) => `${dayAndTime.format(ms)} UTC`;
const dayOnly = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
/** The same, shorter, for a list of dates near each other: "7 Oct, 03:44 UTC". */
const whenShort = (ms) => (new Date(ms).getUTCFullYear() === new Date().getUTCFullYear() ? `${dayOnly.format(ms)}, ${timeOnly.format(ms)} UTC` : when(ms));

/** How long ago, from seconds: "14 s ago", "3 min ago", "2 h ago", "4 days ago". */
function ago(seconds) {
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${Math.floor(seconds)} s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.floor(hours / 24)} days ago`;
}

/** The same, as short as it goes: "now", "14 s", "3 min", "2 h", "4 days". */
const age = (seconds) => (seconds < 5 ? "now" : ago(seconds).replace(" ago", ""));

const shorten = (text) => `${text.slice(0, 4)}…${text.slice(-4)}`;
const COUNTS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight"];

function link(text, href) {
  const a = document.createElement("a");
  a.textContent = text;
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener";
  return a;
}

function mark(text, className) {
  const node = document.createElement("span");
  node.textContent = text;
  node.className = className;
  return node;
}

const bold = (text) => {
  const node = document.createElement("b");
  node.textContent = text;
  return node;
};

const separated = (parts) => parts.flatMap((part, i) => (i ? [" · ", part] : [part]));

/** A buying hook and its setting, the way the catalogue names them: "Max Buy · 1%". */
const hookLabel = (known) => `${worded(known.hook.name, site.app)}${known.label ? ` · ${known.label}` : ""}`;
const fullName = (name) => (name ? `${name.name} (${name.symbol})` : "a name this page does not know");

// Whoever the agent is called this month.
if (site.agent) write("agent", site.agent);

// The air moves Veluno: the pointer going past, a tap, the page scrolling, and the chain.
const breeze = air(slot("air"), () => !document.hidden);

// One page shows at a time, picked by the address: #hooks, #door, #journal, #charter, or home.
// There is one Veluno. At home it is in the page; anywhere else it floats over the word for
// the place, and going from one to another it flies there with the page in its wake.
const TITLES = { home: "I run a token", hooks: "My hooks", door: "At the door", journal: "My journal", charter: "What I can’t do" };
const still = matchMedia("(prefers-reduced-motion: reduce)");
/** Changes of colour are counted for the same reason flights are. */
let turns = 0;
const seat = slot("seat");
const stops = [...document.querySelectorAll("[data-stop]")];

// A tap on Veluno and it blinks, there and then (the air pushes it too, as before). The eyes
// close and open where they are: they follow nothing.
const face = seat.querySelector(".veluno");
let blinked = 0;
seat.addEventListener("pointerdown", () => {
  face.classList.remove("is-blinking");
  // Read once, so that a second tap during a blink starts a new one.
  void face.getBoundingClientRect();
  face.classList.add("is-blinking");
  clearTimeout(blinked);
  blinked = setTimeout(() => face.classList.remove("is-blinking"), 300);
});
/** How long it takes from one place to the next. */
const FLIGHT_MS = 380;
let shown = null;
/** Flights are counted, so that one ending late does not tidy up after a newer one. */
let flights = 0;

/** Puts the page, the rail and Veluno where `view` has them. It moves nothing by itself. */
function show(view, arrived) {
  root.dataset.view = view;
  for (const item of document.querySelectorAll("[data-nav]")) {
    if (item.dataset.nav !== view) {
      item.removeAttribute("aria-current");
      continue;
    }
    item.setAttribute("aria-current", "page");
    // Whoever opens a page has seen what was new on it.
    item.classList.remove("has-news");
  }
  (view === "home" ? document.getElementById("home") : stops[VIEWS.indexOf(view)]).prepend(seat);
  // Over a word it is a mark, not a picture to be read out.
  if (view === "home") seat.removeAttribute("aria-hidden");
  else seat.setAttribute("aria-hidden", "true");
  breeze.moved();
  document.title = `${site.agent || "Veluno"} · ${TITLES[view]}`;
  slot("skip").href = `#${view}`;
  scrollTo(0, 0);
  // Somebody who came here by a link is told where they are; the page arriving says so by itself.
  if (arrived) document.getElementById(view).querySelector("[tabindex='-1']")?.focus({ preventScroll: true });
}

function route() {
  const asked = location.hash.slice(1);
  const view = VIEWS.includes(asked) ? asked : "home";
  const from = shown;
  if (view === from) return;
  shown = view;
  // The page arriving, or less motion asked for: it is simply there.
  if (from === null || still.matches) return show(view, from !== null);

  const [a, b] = [VIEWS.indexOf(from), VIEWS.indexOf(view)];
  const way = Math.sign(b - a);
  const mine = ++flights;
  root.dataset.way = way > 0 ? "on" : "back";
  // Along the rail it goes through the words in between, and each one stirs as it passes.
  for (const stop of stops) stop.classList.remove("is-passed");
  if (a && b) {
    for (let i = Math.min(a, b) + 1; i < Math.max(a, b); i++) {
      stops[i].style.setProperty("--pass", `${Math.round((FLIGHT_MS * Math.abs(i - a)) / Math.abs(b - a)) - 75}ms`);
      void stops[i].offsetWidth;
      stops[i].classList.add("is-passed");
    }
  }
  // It leans into the way it is going; what it was carrying swings it on when it gets there.
  breeze.push(0, 0, way * 80);
  const landed = () => {
    // One overtaken by the next leaves the next to finish.
    if (mine !== flights) return;
    delete root.dataset.way;
    breeze.push(way * 200, -50, way * -60);
  };

  if (document.startViewTransition) {
    const flight = document.startViewTransition(() => show(view, true));
    // One cut short by the next still leaves the right page up.
    flight.ready.catch(() => {});
    return flight.finished.then(landed, landed);
  }
  // No view transitions here: the same flight by hand. First, last, invert, play.
  const first = seat.getBoundingClientRect();
  root.classList.add("no-flight");
  show(view, true);
  const last = seat.getBoundingClientRect();
  seat
    .animate([{ transformOrigin: "0 0", transform: `translate(${first.left - last.left}px, ${first.top - last.top}px) scale(${first.width / last.width})` }, { transformOrigin: "0 0", transform: "none" }], {
      duration: FLIGHT_MS,
      easing: "cubic-bezier(.3,.1,.2,1)",
    })
    .finished.then(landed, landed);
}
addEventListener("hashchange", route);
route();

// Night: the same page on charcoal, for whoever presses the moon at the top right. It is
// remembered on this device, and it spreads out from the button that called it.
const theme = slot("theme-button");
function setTheme(night) {
  if (night) root.dataset.theme = "night";
  else delete root.dataset.theme;
  // The button shows what pressing it brings: the moon by day, the sun by night. Its name says the same.
  theme.setAttribute("aria-label", night ? "Switch to day colours" : "Switch to night colours");
  theme.title = night ? "Day" : "Night";
  document.querySelector('meta[name="theme-color"]').content = night ? "#2a292e" : "#ffffff";
  document.querySelector('meta[name="color-scheme"]').content = night ? "dark" : "light";
}
setTheme(root.dataset.theme === "night");
theme.hidden = false;
theme.addEventListener("click", () => {
  const night = root.dataset.theme !== "night";
  try {
    localStorage.setItem("veluno:theme", night ? "night" : "day");
  } catch {
    // Nowhere to remember it: it lasts as long as the page.
  }
  if (still.matches || !document.startViewTransition) {
    root.dataset.turning = "";
    setTheme(night);
    void root.offsetWidth;
    delete root.dataset.turning;
    return;
  }
  const box = theme.getBoundingClientRect();
  const [x, y] = [box.left + box.width / 2, box.top + box.height / 2];
  root.style.setProperty("--from-x", `${x.toFixed(1)}px`);
  root.style.setProperty("--from-y", `${y.toFixed(1)}px`);
  // As far as the corner furthest from the button.
  root.style.setProperty("--reach", `${Math.ceil(Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y)))}px`);
  const mine = ++turns;
  root.dataset.turning = "";
  const turn = document.startViewTransition(() => setTheme(night));
  turn.ready.catch(() => {});
  const done = () => {
    if (mine === turns) delete root.dataset.turning;
  };
  turn.finished.then(done, done);
  breeze.push(0, night ? 70 : -90, night ? -30 : 30);
});

// The first link on the page skips to the page being shown, whichever it is.
slot("skip").addEventListener("click", (event) => {
  event.preventDefault();
  document.getElementById(shown).querySelector("[tabindex='-1']")?.focus();
});

// Left and right along the rail with the arrow keys. Enter opens a place, as on any link.
document.querySelector(".rail").addEventListener("keydown", (event) => {
  const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
  const links = [...event.currentTarget.querySelectorAll("[data-nav]")];
  const next = step && links[links.indexOf(document.activeElement) + step];
  if (!next) return;
  event.preventDefault();
  next.focus();
});

/** The line under a word on the rail: [words a phone drops][the figure][more words]. Written only when it changes. */
const underSaid = {};
function under(name, before, figure, after = "") {
  const key = [before, figure, after].join("|");
  if (underSaid[name] === key) return;
  underSaid[name] = key;
  const [a, b, c] = document.querySelector(`[data-live="${name}"]`).children;
  [a.textContent, b.textContent, c.textContent] = [before, figure, after];
}

// "Why this one" turns the bubble over to the reasons, and back.
const bubble = slot("bubble");
const ask = slot("ask");
function turnBubble(toWhy) {
  // Kept as tall as it was, so that short reasons do not make the page jump.
  bubble.style.minHeight = toWhy ? `${bubble.offsetHeight}px` : "";
  slot("edict-text").hidden = toWhy;
  slot("edict-reasons").hidden = !toWhy;
  ask.textContent = toWhy ? "Back to the edict" : "Why this one";
}
ask.addEventListener("click", () => {
  turnBubble(slot("edict-reasons").hidden);
  breeze.push(0, 90, 0);
});

/**
 * The catalogue, with what is on marked. `on` says which: a buying hook and its setting, a
 * fee hook, the name in use. What this token cannot use is left out: the hooks about the app
 * when `appAvailable` is false, the change of name when `on.fixedName` says it has one name.
 */
function renderCatalogue(on, appAvailable = true) {
  /** One tile of the list. `state` is what its margin says; it is on if that starts with "On" or "Now". */
  const row = (hook, state, settings = "") => {
    const node = document.getElementById("hook-template").content.firstElementChild.cloneNode(true);
    node.classList.toggle("is-on", /^(On|Now)\b/.test(state));
    node.querySelector(".hook-name").textContent = worded(hook.name, site.app);
    node.querySelector(".hook-about").textContent = worded(hook.about, site.app);
    if (settings) node.querySelector(".hook-settings").textContent = settings;
    else node.querySelector(".hook-settings").remove();
    node.querySelector(".hook-state").textContent = state || "";
    return node;
  };
  /** A buying hook's settings as things to press. The one pressed says, in the program's own terms, what a buy would be held to. */
  const notches = (node, hook, inForce) => {
    const line = node.querySelector(".hook-settings") ?? node.querySelector(".hook-body").appendChild(document.createElement("p"));
    line.className = "hook-settings notches";
    const says = document.createElement("p");
    says.className = "hook-rule";
    says.setAttribute("aria-live", "polite");
    says.hidden = true;
    const buttons = hook.settings.map((setting, i) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "notch";
      button.textContent = setting.label || "The rule";
      button.setAttribute("aria-pressed", "false");
      if (inForce === i + 1) button.dataset.on = "";
      button.addEventListener("click", () => {
        const open = button.getAttribute("aria-pressed") !== "true";
        for (const other of buttons) other.setAttribute("aria-pressed", String(open && other === button));
        says.hidden = !open;
        if (open) says.textContent = `A buy goes through if ${describe(ruleOf(hook.id, i + 1), site.app).join("; or if ")}.`;
        breeze.push(0, open ? -110 : 60, 0);
      });
      return button;
    });
    line.replaceChildren(...buttons);
    line.after(says);
    return node;
  };
  const group = (title, aside, rows) => {
    const section = document.createElement("section");
    section.className = "hook-group";
    const heading = document.createElement("h3");
    heading.className = "hook-group-title";
    heading.append(title, mark(aside, "hook-group-aside"));
    const list = document.createElement("ol");
    list.className = "hooks";
    list.append(...rows);
    section.append(heading, list);
    return section;
  };
  slot("catalogue").replaceChildren(
    group(
      "Buying hooks",
      "one at a time, or none",
      // A hook the chain says is on is listed whatever else is true of the token.
      BUYING_HOOKS.filter((hook) => appAvailable || !hook.needsApp || on.buying?.hook.id === hook.id).map((hook) => {
        const mine = on.buying?.hook.id === hook.id;
        return notches(row(hook, mine ? `On${on.buying.label ? ` · ${on.buying.label}` : ""}` : ""), hook, mine ? on.buying.setting : 0);
      }),
    ),
    group("Fee hooks", "always one", FEE_HOOKS.map((hook) => row(hook, on.fees?.hook.id === hook.id ? "On" : ""))),
    // A token with one name has no other to take, so nothing is said of changing it.
    ...(on.fixedName ? [] : [group("Name", "a new one now and then", [row(IDENTITY_HOOK, on.name ? `Now ${on.name}` : "", on.names ? `Names: ${on.names}` : "")])]),
  );
}

let book = null;
let entries = [];
/** Whether the last attempt to fetch the log failed: then the page does not know what was published. */
let logMissing = false;
/** The published text of the edict in force, once its hash has been checked against the chain. */
let inForce = { entry: null, verified: false };
/** Logged edicts whose text hashes to the note logged with them. The page shows no other text. */
let sound = new Set();
/** The curve's figures, from the pool account. Null while they cannot be read. */
let market = null;
/** Everyone who came to the door, by signature, and the order they are shown in: newest first. */
const trades = new Map();
let knocks = [];
/** What this tab has already read of the door, kept across reloads: a public node allows few reads. */
const DOOR_KEY = `veluno:door:${site.pool}`;
try {
  for (const trade of JSON.parse(sessionStorage.getItem(DOOR_KEY) ?? "[]")) {
    if (isSignature(trade?.signature) && Number.isFinite(trade.at) && typeof trade.kind === "string") trades.set(trade.signature, trade);
  }
} catch {
  // Nothing kept, or nowhere to keep it.
}
/** Whether the door has been read once. What it holds then is history, not news. */
let doorRead = false;
/** Whether the last attempt to read it was turned away by the node. */
let doorShut = false;
/** How the page is hearing from the chain: "live" over the socket, anything else by asking. */
let line = "off";
/** The chain's clock minus this device's, in seconds. The hook judges by the chain's. */
let skew = 0;
const chainNow = () => Date.now() / 1000 + skew;
/** Whether an edict was standing at the last tick, to notice the moment it runs out. */
let wasStanding = null;

/** The edict's time, as it stands now. */
function term() {
  const now = chainNow();
  const left = Math.ceil(book.ruleUntil - now);
  const standing = left > 0 && !book.paused;
  // What the line under the bubble spans: the edict's term, or the time since the last one ran out.
  const from = standing ? book.updatedAt : book.epoch ? Math.min(book.ruleUntil, now) : book.renamedAt;
  const to = standing ? book.ruleUntil : now;
  return { now, left, standing, from, to };
}

/** The slot each account was last taken at. A reading from an earlier slot is older news, however late it arrives. */
let bookSlot = -1;
let poolSlot = -1;

async function take(nextBook, nextEntries, slot = bookSlot) {
  // An older reading of the rulebook is left alone; a log that came with it is still worth having.
  if (slot < bookSlot) {
    if (!nextEntries) return;
    [nextBook, slot] = [book, bookSlot];
  }
  // A node that is a little behind must not undo an edict this page has already shown.
  if (book && nextBook.epoch < book.epoch) return;
  const log = nextEntries ?? entries;
  const hashes = await Promise.all(log.map((e) => (e.record.action === "rewrite" ? hashOf(e.record) : null)));
  // Something newer may have been taken while the hashes were worked out.
  if (slot < bookSlot || (book && nextBook.epoch < book.epoch)) return;
  bookSlot = slot;
  const entry = log.findLast((e) => e.record.action === "rewrite" && e.record.epoch === nextBook.epoch) ?? null;
  // The edict in force is held to the chain; older ones to the note in their own transaction.
  sound = new Set(log.filter((e, i) => hashes[i] === (e === entry ? nextBook.note : e.note)));
  const fresh = book && nextBook.epoch > book.epoch;
  inForce = { entry, verified: sound.has(entry) };
  book = nextBook;
  entries = log;
  if (fresh) {
    // A new edict while the page is open: the old words step back, and Veluno lifts.
    bubble.classList.add("is-changing");
    setTimeout(() => bubble.classList.remove("is-changing"), 180);
    turnBubble(false);
    breeze.nudge("edict");
    if (shown !== "journal") document.querySelector('[data-nav="journal"]').classList.add("has-news");
  }
  renderRecord();
  renderEdict();
  renderCharter();
  renderAddresses();
  root.dataset.state = "ready";
  renderStatus();
}

/** The agent writes its log just after its transaction lands: look for the text a few times. */
function chaseLog(epoch) {
  for (const wait of [2_000, 5_000, 10_000]) {
    setTimeout(async () => {
      if (!book || book.epoch !== epoch || inForce.entry) return;
      const log = await readLog(site.log);
      if (log) take(book, log).catch(() => {});
    }, wait);
  }
}

function takePool(bytes, slot = poolSlot) {
  if (slot < poolSlot) return;
  poolSlot = slot;
  try {
    market = bytes ? decodePool(bytes) : null;
  } catch {
    // Not a pool this page can read: better no figures than wrong ones.
    market = null;
  }
  renderCurve();
}

/** When the chain was last asked, so that two reasons to ask at the same moment make one request. */
let askedAt = 0;

/** When the chain last answered this page, by a read or by a push. */
let heardAt = 0;

async function refresh() {
  askedAt = Date.now();
  try {
    // The device's time is noted the moment the chain answers, not when the log has arrived too.
    const [{ chain, at }, log] = await Promise.all([readChain(site.rpc, site.rulebook, site.pool).then((read) => ({ chain: read, at: Date.now() })), readLog(site.log)]);
    if (chain.now !== null) {
      const measured = chain.now - at / 1000;
      // The chain's clock moves in steps; a new reading is only taken when it really differs.
      if (Math.abs(measured - skew) >= 2) skew = measured;
    }
    heardAt = at;
    // A log that comes back shorter than the one already read and checked is a file that was
    // not there for a moment, not a journal that lost its pages.
    const kept = log !== null && log.length < entries.length ? null : log;
    logMissing = kept === null;
    await take(chain.book, kept, chain.slot);
    takePool(chain.pool, chain.slot);
    readDoor();
  } catch {
    // What was last read stays on the page; only a first read that fails shows the notice.
    if (!book) root.dataset.state = "error";
    renderStatus();
  }
}

/** The door is read at most this often, however many things ask for it. */
let doorTimer = 0;
let doorBusy = false;
let doorAgain = false;
/** How many times in a row the newest transaction was listed but not yet readable. */
let doorWaits = 0;
/** Who the last reading of the door found new: their marks and rows arrive, the others are simply there. */
let freshMarks = new Set();
function readDoorSoon(wait) {
  // One that is already on its way is not put off by the next thing that happens.
  if (doorTimer) return;
  doorTimer = setTimeout(() => {
    doorTimer = 0;
    readDoor();
  }, wait);
}

async function readDoor() {
  if (!book || !isAddress(site.pool)) return;
  if (doorBusy) {
    doorAgain = true;
    return;
  }
  doorBusy = true;
  try {
    const listed = await recentTrades(site.rpc, { pool: site.pool, mint: book.mint, hookProgram: site.program, limit: 15, known: trades });
    const came = listed.filter((trade) => trade.kind !== "other");
    const known = new Set(knocks.map((trade) => trade.signature));
    // News is what nobody has seen and has only just happened. An older one read late is history.
    const news = doorRead ? came.filter((trade) => !known.has(trade.signature) && chainNow() - trade.at < NEWS_AGE_SECS) : [];
    // The newest fifteen, then whatever older ones this page has already shown.
    const listedNow = new Set(came.map((trade) => trade.signature));
    knocks = [...came, ...knocks.filter((trade) => !listedNow.has(trade.signature))].sort((a, b) => b.at - a.at).slice(0, MAX_KNOCKS);
    doorRead = true;
    // Not let in to read the newest one: what is shown may be missing whoever came last.
    doorShut = Boolean(listed.behind);
    // Listed but not readable yet, as happens for a moment after a transaction lands: ask again shortly.
    doorWaits = listed.pending && doorWaits < 3 ? doorWaits + 1 : 0;
    if (doorWaits) doorAgain = true;
    try {
      sessionStorage.setItem(DOOR_KEY, JSON.stringify([...trades.values()].sort((a, b) => b.at - a.at).slice(0, 60)));
    } catch {
      // As above.
    }
    freshMarks = new Set(news.map((trade) => trade.signature));
    renderDoor(freshMarks);
    if (news.length) announce(news);
  } catch {
    // The node would not say. The next reading asks again.
    doorShut = true;
    showKnocks();
  } finally {
    doorBusy = false;
    // Somebody came while this reading was out.
    if (doorAgain) {
      doorAgain = false;
      readDoorSoon(900);
    }
  }
}

/** An amount of SOL the way a person would say it: 0.05, 0.066, 1.8. */
const sol = (amount) => `${Number(amount.toPrecision(amount < 1 ? 2 : 3))} SOL`;

/** One who came, in words: "a buy of 0.05 SOL", "a sale for 0.017 SOL". */
function inWords(trade) {
  if (trade.kind === "sell") return trade.sol === null ? "a sale" : `a sale for ${sol(trade.sol)}`;
  if (trade.sol !== null) return `a buy of ${sol(trade.sol)}`;
  return trade.sharePct === null ? "a buy" : `a buy of ${Number(trade.sharePct.toPrecision(2))}% of supply`;
}

const KINDS = { buy: "Let in", refused: "Turned away", sell: "Left" };
/** What its body does for each: it lifts, it shakes, it dips. */
const GESTURES = { buy: "in", refused: "away", sell: "left" };

/** Somebody has just come to the door while the page was open. */
let news = null;
function announce(came) {
  const turned = came.filter((trade) => trade.kind === "refused");
  const [first] = came;
  const text =
    came.length > 1
      ? turned.length
        ? `I just turned away ${turned.length} ${turned.length === 1 ? "buy" : "buys"}.`
        : `${came.length} just came to my door, and I let them through.`
      : first.kind === "refused"
        ? `I just turned away ${inWords(first)}.`
        : first.kind === "buy"
          ? `I just let in ${inWords(first)}.`
          : `Someone just sold${first.sol === null ? "" : ` for ${sol(first.sol)}`}. I never stop a sale.`;
  news = { text, away: turned.length > 0, until: Date.now() + NEWS_MS };
  // A mark a finger tapped gives way to news; one a mouse is resting on keeps its sentence.
  if (byFinger) [pointedAt, pointedMark, tappedMark, byFinger] = [null, null, null, false];
  breeze.nudge(turned.length ? "away" : came.some((trade) => trade.kind === "buy") ? "in" : "left");
  renderRail();
  if (shown !== "door") document.querySelector('[data-nav="door"]').classList.add("has-news");
  renderAside();
}

/** What a mark on the line says while it is pointed at. */
let pointedAt = null;
/** The link to the door in the sentence under the line. */
const toDoor = document.createElement("a");
toDoor.href = "#door";

/** The sentence under the line: news while it is news, the mark being pointed at, or the latest one who came. */
function renderAside() {
  const aside = slot("aside");
  if (news && Date.now() > news.until) news = null;
  aside.classList.toggle("is-away", Boolean(news?.away) && !pointedAt);
  if (pointedAt) return aside.replaceChildren(pointedAt);
  if (news) return aside.replaceChildren(news.text);
  if (!doorRead || doorShut) return aside.replaceChildren();
  const { now, from, standing } = term();
  const latest = knocks.find((trade) => trade.at >= from);
  if (book.paused) return aside.replaceChildren();
  const since = standing ? "during this edict" : book.epoch ? "since it ran out" : "yet";
  if (!latest) return aside.replaceChildren(`Nobody has come to my door ${since}.`);
  const [lead, age] = [`Latest at my door: ${inWords(latest)}, `, `${KINDS[latest.kind].toLowerCase()} ${ago(now - latest.at)}`];
  // The clock only changes the words. The link itself stays, or whoever is on it would lose it every second.
  if (aside.children.length === 1 && aside.firstElementChild === toDoor && aside.firstChild.nodeType === Node.TEXT_NODE) {
    if (aside.firstChild.data !== lead) aside.firstChild.data = lead;
    if (toDoor.textContent !== age) toDoor.textContent = age;
    return;
  }
  toDoor.textContent = age;
  aside.replaceChildren(lead, toDoor, ".");
}

/** The marks on the line, as last drawn, each by the signature of its trade, and the one being pointed at. */
let drawnMarks = "";
const marks = new Map();
let pointedMark = null;
let tappedMark = null;
/** Whether the mark being pointed at was tapped by a finger, which has no way to stop pointing. */
let byFinger = false;

/** Everything that moves with the clock: how long the edict stands, the line under it, the countdowns. Runs every second. */
function renderTerm() {
  const { now, left, standing, from, to } = term();
  const known = standing && book.rule.length ? recogniseRule(book.rule) : null;
  const ways = standing ? describe(book.rule, site.app) : [];
  // With nothing on, who may buy is everybody: said that way, not as "none".
  const hook = ways.length === 0 ? "Anyone" : known ? hookLabel(known) : "A rule that is not on my list";

  // The sentence under the bubble.
  const over = Math.max(0, Math.floor(now - book.ruleUntil));
  slot("term").replaceChildren(
    ...(book.paused
      ? ["The guardian has suspended me. No hook applies, and the token trades freely."]
      : book.epoch === 0
        ? ["No edict yet. Every buy goes through."]
        : standing
          ? [`Edict No. ${book.epoch} stands for `, bold(clock(left)), " more."]
          : over < 3_600
            ? [`Edict No. ${book.epoch} ran out `, bold(clock(over)), " ago. Every buy goes through until my next one."]
            : [`Edict No. ${book.epoch} ran out ${ago(over)}. Every buy goes through until my next one.`]),
  );
  bubble.classList.toggle("is-over", !standing && book.epoch > 0);
  // The chain does not record when a suspension began, so the line would have no true left end.
  slot("track").parentElement.hidden = book.paused;
  if (wasStanding === true && !standing) breeze.nudge("over");
  wasStanding = standing;

  // The line: how much of the term has passed, and who came during it.
  const width = Math.max(1, to - from);
  slot("spent").style.setProperty("--n", standing ? Math.min(1, Math.max(0, (now - from) / width)).toFixed(4) : "1");
  write("rule-from", `${standing ? "said at" : book.epoch ? "ran out" : "opened"} ${timeOnly.format(from * 1000)}`);
  write("rule-to", standing ? `ends ${timeOnly.format(to * 1000)} UTC` : "now");
  const within = knocks.filter((trade) => trade.at >= from && trade.at <= to);
  // While an edict stands a mark stays where it is. Afterwards the line stretches, so they are redrawn now and then.
  const drawing = [from, standing ? to : Math.floor(now / 15), ...within.map((trade) => trade.signature)].join(" ");
  if (drawing !== drawnMarks) {
    drawnMarks = drawing;
    const track = slot("track");
    // The rehearsal's marks, and the ones that are no longer on the line.
    const kept = new Set(within.map((trade) => trade.signature));
    for (const old of track.querySelectorAll(".mark")) {
      if (kept.has(old.dataset.signature)) continue;
      if (old === pointedMark) [pointedAt, pointedMark] = [null, null];
      marks.delete(old.dataset.signature);
      old.remove();
    }
    // Oldest first, so that the keyboard walks the line from left to right.
    for (const trade of within.toReversed()) {
      let node = marks.get(trade.signature);
      if (!node) {
        node = link("", `${site.explorer}/tx/${trade.signature}`);
        node.className = `mark is-${trade.kind}${freshMarks.has(trade.signature) ? " is-new" : ""}`;
        node.addEventListener("animationend", () => node.classList.remove("is-new"), { once: true });
        node.dataset.signature = trade.signature;
        const said = `${KINDS[trade.kind]}: ${inWords(trade)}, ${timeOnly.format(trade.at * 1000)} UTC`;
        node.setAttribute("aria-label", said);
        const point = () => {
          [pointedAt, pointedMark] = [said, node];
          renderAside();
          breeze.nudge(GESTURES[trade.kind], 400);
        };
        const leave = (event) => {
          // A finger has nowhere to hover: what it tapped stays said until it taps something else.
          if (pointedMark !== node || event.pointerType === "touch") return;
          [pointedAt, pointedMark] = [null, null];
          renderAside();
        };
        // The first tap of a finger says who it was; the second follows the link.
        node.addEventListener("click", (event) => {
          if (event.pointerType !== "touch" || tappedMark === node) return;
          event.preventDefault();
          tappedMark = node;
          point();
        });
        node.addEventListener("pointerenter", (event) => {
          point();
          byFinger = event.pointerType === "touch";
        });
        node.addEventListener("focus", point);
        node.addEventListener("pointerleave", leave);
        node.addEventListener("blur", leave);
        marks.set(trade.signature, node);
        track.append(node);
      }
      node.style.setProperty("--x", ((trade.at - from) / width).toFixed(4));
    }
  }
  renderAside();

  // The same hook and the same clock, where the other pages say them.
  const on = [hook, ...ways, book.holdersBps, book.burnBps, book.treasuryBps, book.name, book.hasApp, book.names.length].join("\n");
  if (shownOn !== on) {
    shownOn = on;
    write("buying-name", hook);
    write("rule-title", ways.length ? "A buy goes through if" : "");
    slot("ways").replaceChildren(...(ways.length ? ways : ["Every buy goes through."]).map((way) => mark(way, "")));
    renderCatalogue(
      {
        buying: known,
        fees: recogniseSplit(book, book.limits.maxTreasuryBps, book.limits.minTreasuryBps),
        // A token with one name has nothing to change to.
        ...(book.names.length > 1 ? { name: fullName(book.names[book.name]), names: book.names.map(fullName).join(" · ") } : { fixedName: true }),
      },
      book.hasApp,
    );
  }
  write(
    "rule-note",
    book.paused
      ? "suspended by the guardian"
      : standing
        ? `${clock(left)} left · until ${timeOnly.format(book.ruleUntil * 1000)} UTC`
        : book.epoch
          ? `time was up at ${timeOnly.format(book.ruleUntil * 1000)} UTC · next edict due`
          : "no edict yet",
  );
  write(
    "door-now",
    book.paused ? "The guardian has suspended me. Nothing is on the door." : ways.length ? `On the door now: ${hook}, for ${clock(left)} more.` : "Nothing on the door now. Every buy goes through.",
  );
  slot("door-now").classList.toggle("is-open", book.paused || ways.length === 0);
  renderRail();
  const tag = document.querySelector(".entry-tag[data-in-force]");
  if (tag) {
    tag.textContent = book.paused ? "Suspended" : standing ? `On now · ${clock(left)} left` : "Ran out";
    // One whose time is up looks like the others: it no longer applies.
    tag.closest(".entry").classList.toggle("is-in-force", standing);
  }
  for (const node of document.querySelectorAll(".knock-when[data-at]")) node.textContent = ago(now - Number(node.dataset.at));
}

/** What is on, as last put on the page, so that it is only rebuilt when it changes. */
let shownOn = null;

/** One line under each word of the rail, from the same reading as the pages themselves. */
function renderRail() {
  const { now, left, standing } = term();
  const known = standing && book.rule.length ? recogniseRule(book.rule) : null;
  under("home", "", book.paused ? "suspended" : standing ? clock(left) : book.epoch ? "ran out" : "no edict", standing ? " left" : "");
  if (!standing || book.rule.length === 0) under("hooks", "", "none on");
  else under("hooks", `${known ? worded(known.hook.name, site.app) : "Off the list"} `, "on");
  const [latest] = knocks;
  if (!doorRead || doorShut) under("door", "", "");
  else if (!latest) under("door", "", "nobody yet");
  else under("door", `${KINDS[latest.kind].toLowerCase()} `, age(now - latest.at), now - latest.at < 5 ? "" : " ago");
  under("journal", "", book.epoch ? `No. ${book.epoch}` : "nothing yet");
}

function renderEdict() {
  const published = inForce.verified ? inForce.entry.record : null;
  const text = slot("edict-text");
  bubble.classList.toggle("is-plain", !published);
  const words = published
    ? published.announcement
    : book.epoch === 0
      ? "I have not issued an edict yet. The token is as it opened: every buy goes through."
      : inForce.entry
        ? "A text was published for this edict, but its hash does not match the chain, so this page does not show it."
        : logMissing
          ? "I could not load my journal just now, so the text of this edict is missing here."
          : "The text of this edict has not been published yet.";
  if (text.textContent !== words) text.textContent = words;
  // Reasons are only given for words this page could check.
  if (!published) turnBubble(false);
  ask.hidden = !published;
  if (published && slot("edict-reasons").textContent !== published.reasoning) write("edict-reasons", published.reasoning);

  const fees = recogniseSplit(book, book.limits.maxTreasuryBps, book.limits.minTreasuryBps);
  write("fees-name", fees ? fees.hook.name : book.epoch ? "Shares that are not on my list" : "Opening split");
  for (const [name, bps] of [["holders", book.holdersBps], ["burn", book.burnBps], ["treasury", book.treasuryBps]]) {
    slot("split").style.setProperty(`--${name}`, bps);
    write(`split-${name}`, percent(bps));
  }
  const name = book.names[book.name];
  write("token-name", name?.name ?? "Unnamed");
  write("token-symbol", name?.symbol ?? "");
  write("token-since", `since ${when(book.renamedAt * 1000)}`);
  renderTerm();
}

function renderCharter() {
  const { limits } = book;
  write("limit-interval", span(limits.minIntervalSecs));
  write("limit-rule", span(limits.maxRuleSecs));
  write("limit-treasury-min", percent(limits.minTreasuryBps));
  write("limit-treasury", percent(limits.maxTreasuryBps));
  write("limit-rename", span(limits.minRenameSecs));
  write("name-count", COUNTS[book.names.length] ?? String(book.names.length));
  // What is only true of a token with several names, with one name, or with an app, each said in more than one place.
  const only = (name, holds) => {
    for (const node of document.querySelectorAll(`[data-${name}]`)) node.hidden = !holds;
  };
  only("names-many", book.names.length > 1);
  only("names-one", book.names.length < 2);
  only("with-app", book.hasApp);
  write("fee", percent(site.feeBps));
}

/** What a logged edict set, as this page reads it from the logged change and not from what I say. */
function termsOf(record) {
  const { change } = record;
  const rule = loggedRule(change);
  const known = recogniseRule(rule);
  const fees = recogniseSplit(change, book.limits.maxTreasuryBps, book.limits.minTreasuryBps);
  const shares = `holders ${percent(change.holdersBps)}, burn ${percent(change.burnBps)}, treasury ${percent(change.treasuryBps)}`;
  return {
    // With no hook on, the answer to "who may buy" is everybody.
    buying: rule.length === 0 ? "Anyone" : known ? hookLabel(known) : "A rule that is not on my list",
    // The rule itself, for one this page has no name for.
    rule: rule.length && !known ? describe(rule, site.app).join("; or if ") : "",
    fees: fees ? fees.hook.name : "Shares that are not on my list",
    shares,
    term: span(change.ruleSecs),
    name: record.hooks.name === null ? "" : (book.names[record.hooks.name]?.name ?? "a name this page does not know"),
  };
}

/** One edict in the journal: its number, what it set, what I said. Why, and the proof, are one press away. */
function renderEntry(entry) {
  const { record } = entry;
  const node = document.getElementById("entry-template").content.firstElementChild.cloneNode(true);
  const at = Date.parse(record.at);
  node.querySelector(".entry-no").textContent = `No. ${record.epoch}`;
  const time = node.querySelector(".entry-when");
  time.textContent = whenShort(at);
  time.dateTime = record.at;
  // The edict the chain has in force wears a tag, which the clock keeps filled.
  const mine = entry === inForce.entry;
  node.classList.toggle("is-in-force", mine);
  if (mine) node.querySelector(".entry-tag").dataset.inForce = "";
  const why = node.querySelector(".entry-why");
  if (sound.has(entry)) {
    const set = termsOf(record);
    for (const [name, text] of [["buying", set.buying], ["fees", set.fees], ["term", set.term], ["name", set.name]]) {
      const value = node.querySelector(`[data-set="${name}"]`);
      if (text) value.textContent = text;
      else value.parentElement.remove();
    }
    node.querySelector(".entry-text").textContent = record.announcement;
    // For an edict that is over, my sentence says again what the row above shows: it goes behind the press.
    if (!mine) {
      node.querySelector(".entry-more").prepend(node.querySelector(".entry-text"));
      node.querySelector(".entry-more summary").textContent = "What I said, and the proof";
      node.querySelector(".entry-more").prepend(node.querySelector(".entry-more summary"));
    }
    // Behind the press: my reasons, then the rule and the shares in full.
    why.textContent = record.reasoning;
    const fine = [set.rule ? `A buy goes through if ${set.rule}.` : "", `Fees: ${set.shares}.`].filter(Boolean).join(" ");
    why.after(Object.assign(document.createElement("p"), { className: "entry-fine", textContent: fine }));
  } else {
    node.classList.add("is-unsound");
    node.querySelector(".entry-text").textContent = "The text logged for this edict does not match its hash, so it is not shown.";
    node.querySelector(".entry-set").remove();
    why.remove();
    node.querySelector(".entry-more summary").textContent = "The proof";
  }
  const proof = node.querySelector(".entry-proof");
  if (isSignature(entry.signature)) {
    const parts = [link(`transaction ${shorten(entry.signature)}`, `${site.explorer}/tx/${entry.signature}`)];
    // Who wrote the words is part of the record that was hashed: the model, or a person testing.
    if (sound.has(entry) && typeof record.model === "string" && record.model) parts.unshift(`written by ${record.model.slice(0, 40)}`);
    if (typeof entry.note === "string") parts.push(`text hash ${entry.note.slice(0, 16)}…`);
    if (mine) parts.push(inForce.verified ? mark("matches the chain", "is-verified") : mark("does not match the chain", "is-mismatch"));
    proof.replaceChildren(...separated(parts));
  } else {
    proof.remove();
  }
  if (!node.querySelector(".entry-more p")) node.querySelector(".entry-more").remove();
  return node;
}

/** How many edicts the journal shows before somebody asks for more. */
let journalShows = 8;
/** What the journal, the addresses and the door last showed, so that each is only built again when that changes. */
let recordShown = "";
let addressesShown = null;
let doorShown = "";

function renderRecord() {
  // The journal is the edicts. A look that changed nothing is in the log file, not here.
  const edicts = entries.filter((entry) => entry.record.action === "rewrite");
  const key = JSON.stringify([journalShows, logMissing, edicts.slice(-Math.min(journalShows, MAX_ENTRIES)).map((entry) => [entry.record.epoch, entry.signature, sound.has(entry), entry === inForce.entry, inForce.verified]), edicts.length]);
  if (key === recordShown) return;
  recordShown = key;
  const open = new Set([...document.querySelectorAll(".entry-more[open]")].map((node) => node.closest(".entry").dataset.epoch));
  slot("record").replaceChildren(
    ...edicts
      .slice(-Math.min(journalShows, MAX_ENTRIES))
      .reverse()
      .map((entry) => {
        const node = renderEntry(entry);
        node.dataset.epoch = entry.record.epoch;
        // A new reading of the chain does not shut what somebody has opened.
        const more = open.has(String(entry.record.epoch)) ? node.querySelector(".entry-more") : null;
        if (more) {
          more.open = true;
          more.dataset.kept = "";
        }
        return node;
      }),
  );
  slot("record-empty").hidden = edicts.length > 0;
  slot("record-empty").textContent = logMissing ? "I could not load my journal just now." : "I have not written anything here yet.";
  slot("record-earlier").hidden = edicts.length <= journalShows || journalShows >= MAX_ENTRIES;
  slot("record-more").hidden = edicts.length <= MAX_ENTRIES || journalShows < MAX_ENTRIES;
  slot("record-file").href = site.log;
}

slot("record-earlier").addEventListener("click", () => {
  journalShows += 16;
  if (!book) return;
  renderRecord();
  renderTerm();
});

/** Everyone who came, newest first. `fresh` are the ones nobody has seen yet. */
function renderDoor(fresh = new Set()) {
  const key = [...knocks.map((trade) => trade.signature), "new", ...fresh].join(" ");
  if (key !== doorShown) {
    doorShown = key;
    buildDoor(fresh);
  }
  showKnocks();
  // The line on the first page shows the same people.
  if (book) renderTerm();
}

function buildDoor(fresh) {
  slot("knocks").replaceChildren(
    ...knocks.map((trade) => {
      const node = document.getElementById("knock-template").content.firstElementChild.cloneNode(true);
      node.classList.add(`is-${trade.kind}`);
      node.classList.toggle("is-new", fresh.has(trade.signature));
      node.querySelector(".knock-kind").textContent = KINDS[trade.kind];
      node.querySelector(".knock-what").textContent = inWords(trade);
      const age = node.querySelector(".knock-when");
      age.href = `${site.explorer}/tx/${trade.signature}`;
      age.dataset.at = trade.at;
      age.textContent = ago(chainNow() - trade.at);
      return node;
    }),
  );
}

// Pointing at somebody on the tape makes Veluno do again what it did for them.
slot("knocks").addEventListener("pointerover", (event) => {
  const row = event.target.closest(".knock");
  if (!row || row.contains(event.relatedTarget)) return;
  const kind = ["buy", "refused", "sell"].find((each) => row.classList.contains(`is-${each}`));
  if (kind) breeze.nudge(GESTURES[kind], 400);
});

/** What the door says when it has nobody to show: not read yet, nobody at all, or nobody of the kind asked for. */
function showKnocks() {
  const list = slot("knocks");
  const asked = list.dataset.show;
  const count = (kind) => knocks.filter((trade) => trade.kind === kind).length;
  write("count-all", knocks.length);
  for (const kind of ["refused", "buy", "sell"]) write(`count-${kind}`, count(kind));
  const away = asked === "refused";
  const none = asked === "all" ? knocks.length === 0 : count(asked) === 0;
  const empty = slot("knocks-empty");
  empty.hidden = !none && !doorShut;
  empty.textContent = !isAddress(site.pool)
    ? "There is no curve to read yet."
    : doorShut
      ? "I cannot read the curve’s latest transactions just now. I keep trying."
      : !doorRead
        ? "One moment. I am reading who came."
        : away
      ? "I have not turned anyone away lately."
      : asked === "buy"
        ? "I have not let anyone in lately."
        : asked === "sell"
          ? "Nobody has sold lately."
          : "Nobody has come to the door yet.";
}

for (const button of document.querySelectorAll("[data-filter]")) {
  button.addEventListener("click", () => {
    slot("knocks").dataset.show = button.dataset.filter;
    for (const other of document.querySelectorAll("[data-filter]")) other.setAttribute("aria-pressed", String(other === button));
    if (live) showKnocks();
  });
}

/** The curve's four figures. One that has changed says so for a moment. */
function renderCurve() {
  slot("curve").hidden = !market;
  slot("curve-head").hidden = !market;
  slot("curve-note").hidden = !market;
  if (!market) return;
  const figures = {
    "market-cap": market.marketCapSol.toFixed(2),
    "market-sol": market.solInCurve.toFixed(market.solInCurve < 1 ? 4 : 3),
    "market-sold": market.soldPct.toFixed(2),
    "market-fees": market.feesSol.toFixed(market.feesSol < 1 ? 5 : 4),
  };
  for (const [name, text] of Object.entries(figures)) {
    const node = slot(name);
    const changed = node.dataset.read && node.textContent !== text;
    node.textContent = text;
    node.dataset.read = "yes";
    if (!changed) continue;
    node.classList.add("is-fresh");
    // Next frame: the colour set at once, then left to fade back.
    requestAnimationFrame(() => requestAnimationFrame(() => node.classList.remove("is-fresh")));
  }
}

// The charter is a list of things I cannot do. Ask for one and I shake my whole body, as I do for a buy I turn away.
for (const article of document.querySelectorAll(".articles li")) {
  const dare = document.createElement("button");
  dare.type = "button";
  dare.className = "dare label";
  dare.textContent = "Ask me to";
  let back = 0;
  dare.addEventListener("click", () => {
    breeze.nudge("away", 400);
    dare.textContent = "I can’t.";
    dare.classList.add("is-no");
    clearTimeout(back);
    back = setTimeout(() => {
      dare.textContent = "Ask me to";
      dare.classList.remove("is-no");
    }, 1_600);
  });
  article.append(dare);
}

// In the journal, opening the reasons for an edict lifts me the way issuing it did.
slot("record").addEventListener(
  "toggle",
  (event) => {
    const more = event.target;
    if (!more.matches(".entry-more")) return;
    // One the page reopened after reading the chain again is not somebody opening it.
    if ("kept" in more.dataset) return void delete more.dataset.kept;
    breeze.push(0, more.open ? -150 : 70, 0);
  },
  true,
);

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
  if (rows.join() === addressesShown) return;
  addressesShown = rows.join();
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

/** How the page is hearing from the chain, and what the agent has been doing. */
function renderStatus() {
  if (!book) return write("status", root.dataset.state === "error" ? "I cannot reach the chain. Trying again." : "Not read yet");
  // A page that has stopped hearing says so, and since when: what it shows is from then.
  const silent = Date.now() - heardAt > STALE_MS && line !== "live";
  root.dataset.stale = String(silent);
  const hearing = silent
    ? `The chain has not answered me since ${timeOnly.format(heardAt)} UTC. What is here is from then`
    : line === "live"
      ? "Hearing from the chain as it happens"
      : "Asking the chain every twenty seconds";
  write("status", `${hearing} · ${book.epoch} ${book.epoch === 1 ? "edict" : "edicts"} so far${book.paused ? " · suspended by the guardian" : ""}`);
}

if (live) {
  // Until the chain is read the page lists what every token has. What is on, the hooks about
  // the app and the change of name follow the first read, if this token has them.
  renderCatalogue({ fixedName: true }, false);
  renderAddresses();
  // The rehearsal's made-up callers have no place on a live page, even before the door is read.
  slot("knocks").replaceChildren();
  showKnocks();
  takePool(null);
  renderStatus();
  refresh();

  // The chain is asked every twenty seconds while that is the only way to know, and once a
  // minute as a safety net while it is also pushing. A door the node would not show is asked
  // for again on every beat.
  let beats = 0;
  setInterval(() => {
    if (document.hidden) return;
    if (line !== "live" || !book || ++beats % 3 === 0) refresh();
    else if (!doorRead || doorShut) readDoor();
  }, POLL_MS);

  // The line: the rulebook and the curve are pushed the moment they change, and so is every
  // transaction that names the curve, which is how a buy that was turned away is heard of.
  let hangUp = null;
  const listen = () => {
    hangUp ??= watchAccounts(
      site.ws || site.rpc,
      [site.rulebook, site.pool],
      (address, bytes, slot) => {
        heardAt = Date.now();
        if (address === site.pool) {
          takePool(bytes, slot);
          return readDoorSoon(600);
        }
        const pushed = decodeRulebook(bytes);
        const fresh = !book || pushed.epoch > book.epoch;
        take(pushed, null, slot).then(() => fresh && chaseLog(pushed.epoch), () => {});
      },
      (state) => {
        line = state;
        root.dataset.line = state;
        // Whatever happened while the line was down was not kept for this page. At the start
        // there was no "while": the page has only just asked.
        if (state === "live" && Date.now() - askedAt > 5_000) refresh();
        else renderStatus();
      },
      isAddress(site.pool) ? { mentions: site.pool, onMention: () => readDoorSoon(900) } : {},
    );
  };
  if (!document.hidden) listen();
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      hangUp?.();
      hangUp = null;
    } else {
      listen();
      refresh();
    }
  });

  // The countdowns and the ages move with the clock, not with the chain.
  setInterval(() => {
    if (!book || document.hidden) return;
    renderTerm();
    renderStatus();
  }, 1_000);
} else {
  // The rehearsal: the catalogue of a token that names no app and has one name, marked the
  // way the made-up edict would leave it.
  renderCatalogue(
    {
      buying: { hook: BUYING_HOOKS.find((hook) => hook.id === "newcomers"), setting: 2, label: "up to 0.5%" },
      fees: { hook: FEE_HOOKS.find((hook) => hook.id === "holders-payday") },
      fixedName: true,
    },
    false,
  );
}
