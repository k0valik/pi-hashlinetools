/**
 * Shared mutable state for the auto-read gate.
 *
 * Default state: OFF. The gate is on when the user has set
 * `PI_HASHLINE_AUTO_READ=1` or `PI_HASHLINE_AUTO_READ=true`, or
 * has toggled it on via `/toggle-auto-read`.
 */

let autoReadEnabled = false;

export function isAutoReadEnabled(): boolean {
  return autoReadEnabled;
}

export function setAutoReadEnabled(value: boolean): void {
  autoReadEnabled = value;
}
