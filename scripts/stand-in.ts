// A stand-in for the model, for the local tests and the seeded page: it works through the
// catalogue in order, so everything around the model's answer can be run without calling it.
import { buyingHooksFor, FEE_HOOKS } from "../site/hooks.js";
import { buyingLabel, type Choice, type Decide } from "../src/agent.js";
import { span } from "../src/hook.js";

/**
 * Each call takes the next buying hook at its first setting (every fourth edict none at all),
 * the next fee hook, and the next name whenever the program would allow a change, unless
 * told to keep the name. `minutes` is how long each edict stands; left out, a quarter of the
 * longest the token allows.
 */
export function byRote(options: { minutes?: number; keepName?: boolean } = {}): Decide {
  let calls = 0;
  return async (snapshot) => {
    const n = calls++;
    const minutes = options.minutes ?? snapshot.limits.longest_edict_minutes / 4;
    const usable = buyingHooksFor(snapshot.limits.app_available).filter((hook) => (hook.settings[0].minMinutes ?? 0) <= minutes);
    const hook = n % 4 === 3 ? null : usable[(n - Math.floor(n / 4)) % usable.length];
    const fees = FEE_HOOKS[n % FEE_HOOKS.length];
    const current = snapshot.names.findIndex((name) => name.current);
    const choice: Choice = {
      buying: hook ? { hook: hook.id, setting: 1 } : null,
      fees: fees.id,
      name: snapshot.name_change.allowed_now && !options.keepName ? (current + 1) % snapshot.names.length : null,
      minutes,
    };
    const renamed = choice.name === null ? "" : ` From now on I am ${snapshot.names[choice.name].name}.`;
    return {
      action: "rewrite",
      choice,
      announcement: `For the next ${span(Math.round(minutes * 60))}: ${hook ? buyingLabel(choice.buying) : "no buying hook"}, and ${fees.name} for the fees.${renamed}`,
      reasoning: "This entry was written by a stand-in for the model, on a local chain. It takes the hooks of the catalogue in order.",
      model: "stand-in",
    };
  };
}
