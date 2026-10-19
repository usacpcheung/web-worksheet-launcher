// Keep ownership bookkeeping out of visible app state during silent probes.
// External state replacements still invalidate pending owners by identity.
export function createSilentSessionStateAdapter({ readState, writeState,
  toCanonical = state => state, fromCanonical = state => state }) {
  const canonical = new WeakMap();
  let pending = null;
  return {
    readState() {
      const visible = readState();
      if (pending?.visible === visible) return pending.value;
      if (!canonical.has(visible)) canonical.set(visible, toCanonical(visible));
      return canonical.get(visible);
    },
    writeState(value) {
      if (value.status === 'checking' && value.settled) {
        pending = { visible: readState(), value };
        return;
      }
      pending = null;
      const visible = fromCanonical(value);
      canonical.set(visible, value);
      writeState(visible);
    },
  };
}
