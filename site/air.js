// The air around Veluno. Things push it about: the pointer going past, a tap, the page
// scrolling, and what happens on the chain. It drifts, tilts and comes back to its place the
// way a balloon does. It is the body that moves. The eyes stay as they are drawn.

/** How hard the air pulls it back, and how fast the swing dies: a spring, for the place and for the tilt. */
const PULL = 60;
const DRAG = 7;
const TILT_PULL = 50;
const TILT_DRAG = 5;
/** The furthest it goes: pixels sideways, pixels up or down, degrees of tilt. */
const REACH = [28, 22, 8];
/** Pushes from the chain do not pile up: one in this many milliseconds. */
const BETWEEN_NUDGES_MS = 2_500;

/** What each thing that happens on the chain does to it: [sideways, down, tilt], and a second push a moment later. */
const NUDGES = {
  // a buy let in lifts it
  in: [[0, -200, 0]],
  // a buy turned away: it shakes its whole body, one way and back
  away: [[0, 0, 70], [0, 0, -100]],
  // a sale dips it
  left: [[0, 160, 0]],
  // a new edict lifts it higher
  edict: [[0, -420, 60]],
  // an edict running out lets it sink a little
  over: [[0, 160, -40]],
};

/**
 * Makes `node` something the air can move. `awake()` says whether it is on screen at all.
 * Returns `push(sideways, down, tilt)`, `nudge(kind, gap)` and `moved()` for the page to call.
 */
export function air(node, awake = () => true) {
  const still = matchMedia("(prefers-reduced-motion: reduce)");
  let [x, y, a, vx, vy, va] = [0, 0, 0, 0, 0, 0];
  let frame = 0;
  let before = 0;
  let nudgedAt = 0;

  const rest = () => {
    [x, y, a, vx, vy, va] = [0, 0, 0, 0, 0, 0];
    for (const name of ["--drift-x", "--drift-y", "--tilt"]) node.style.removeProperty(name);
  };

  function step(time) {
    const dt = Math.min(0.032, (time - before) / 1000);
    before = time;
    vx += (-PULL * x - DRAG * vx) * dt;
    vy += (-PULL * y - DRAG * vy) * dt;
    va += (-TILT_PULL * a - TILT_DRAG * va) * dt;
    x += vx * dt;
    y += vy * dt;
    a += va * dt;
    // At the end of its reach it stops dead instead of straining.
    if (Math.abs(x) > REACH[0]) [x, vx] = [Math.sign(x) * REACH[0], 0];
    if (Math.abs(y) > REACH[1]) [y, vy] = [Math.sign(y) * REACH[1], 0];
    if (Math.abs(a) > REACH[2]) [a, va] = [Math.sign(a) * REACH[2], 0];
    if (Math.abs(x) + Math.abs(y) < 0.1 && Math.abs(a) < 0.05 && Math.hypot(vx, vy) < 2 && Math.abs(va) < 1) {
      frame = 0;
      return rest();
    }
    node.style.setProperty("--drift-x", `${x.toFixed(2)}px`);
    node.style.setProperty("--drift-y", `${y.toFixed(2)}px`);
    node.style.setProperty("--tilt", `${a.toFixed(2)}deg`);
    frame = requestAnimationFrame(step);
  }

  function push(sideways, down, tilt) {
    if (still.matches || !awake()) return;
    vx += sideways;
    vy += down;
    va += tilt;
    if (frame) return;
    before = performance.now();
    frame = requestAnimationFrame(step);
  }

  function nudge(kind, gap = BETWEEN_NUDGES_MS) {
    const pushes = NUDGES[kind];
    const now = performance.now();
    if (!pushes || now - nudgedAt < gap) return;
    nudgedAt = now;
    pushes.forEach((each, i) => setTimeout(() => push(...each), i * 180));
  }

  // Whoever asks for less motion gets none, at once.
  still.addEventListener("change", () => {
    cancelAnimationFrame(frame);
    frame = 0;
    rest();
  });

  // Where it rests on the page. Measured rarely: it does not go anywhere by itself.
  let place = null;
  let placedAt = 0;
  const where = () => {
    const now = performance.now();
    if (!place || now - placedAt > 250) {
      const box = node.getBoundingClientRect();
      place = { x: box.left + box.width / 2 - x, y: box.top + box.height / 2 - y, width: box.width };
      placedAt = now;
    }
    return place;
  };

  // The pointer stirs the air as it goes. What counts is how fast it is going, not where it is:
  // held still, it does nothing. Near Veluno the draught is strong, far away it barely arrives.
  let lastMove = null;
  addEventListener(
    "pointermove",
    (event) => {
      if (event.pointerType === "touch" || !awake()) return;
      const [previous, time] = [lastMove, performance.now()];
      lastMove = { x: event.clientX, y: event.clientY, time };
      // The first move after a pause has nowhere to have come from.
      if (!previous || time - previous.time > 120) return;
      const clamp = (value) => Math.max(-80, Math.min(80, value));
      const [dx, dy] = [clamp(event.clientX - previous.x), clamp(event.clientY - previous.y)];
      const { x: cx, y: cy, width } = where();
      const far = Math.hypot(event.clientX - cx, event.clientY - cy);
      const reach = Math.max(0.12, Math.min(1, 1 - (far - 0.6 * width) / (2.4 * width)));
      push(dx * reach * 1.5, dy * reach * 0.9, dx * reach * 0.38);
    },
    { passive: true },
  );

  // A tap or a click pushes it away from the finger.
  node.addEventListener("pointerdown", (event) => {
    const { x: cx, y: cy } = where();
    const [ux, uy] = [cx - event.clientX, cy - event.clientY];
    const far = Math.hypot(ux, uy) || 1;
    push((ux / far) * 260, (uy / far) * 260, Math.sign(ux || 1) * 70);
  });

  // The page moving past is a draught too. On a phone it is the only one there is.
  let lastScroll = scrollY;
  addEventListener(
    "scroll",
    () => {
      const dy = Math.max(-60, Math.min(60, scrollY - lastScroll));
      lastScroll = scrollY;
      push(0, dy * 4, dy * 0.8);
    },
    { passive: true },
  );

  // The page has put it somewhere else: where it rests has to be measured again.
  const moved = () => {
    place = null;
  };

  return { push, nudge, moved };
}
