/**
 * Records which event types get registered on which DOM elements, so boot tests
 * can assert that initialize() wired up the interaction surface — without coupling
 * to HOW listeners are attached. jsdom does not expose registered listeners, so we
 * patch addEventListener (and restore it on each call to keep tests isolated).
 *
 * Returns { eventsOn(element) -> string[] } listing the event types seen on that
 * exact element.
 */
export function trackListeners() {
  const proto = globalThis.EventTarget.prototype;
  const original = proto.addEventListener;
  const seen = new Map(); // element -> Set<type>

  proto.addEventListener = function addEventListener(type, ...rest) {
    let types = seen.get(this);
    if (!types) {
      types = new Set();
      seen.set(this, types);
    }
    types.add(type);
    return original.call(this, type, ...rest);
  };

  return {
    eventsOn(element) {
      return Array.from(seen.get(element) ?? []);
    },
    restore() {
      proto.addEventListener = original;
    },
  };
}
