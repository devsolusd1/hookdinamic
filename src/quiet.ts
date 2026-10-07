// Keeps one line off the screen. A library the Solana packages bring along (bigint-buffer)
// says "bigint: Failed to load bindings, pure JS will be used" every time it is loaded on a
// machine where its optional compiled part was not built, which is this one and the server.
// Nothing is wrong when it says so: it does the same work in plain JavaScript. But it is the
// first thing every command prints, and it reads like a failure.
//
// A command imports this file before anything else, so that it is in place when that library
// loads. Every other warning is passed on untouched.
const warn = console.warn;
console.warn = (...args: unknown[]) => {
  if (typeof args[0] === "string" && args[0].startsWith("bigint: Failed to load bindings")) return;
  warn(...args);
};
