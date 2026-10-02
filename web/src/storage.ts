/**
 * Every browser storage key goes through this. GitHub Pages serves all *.github.io
 * projects of an account from one origin, so keys must be namespaced. Never store anything sensitive.
 */
const PREFIX = "stickyard:";

export function storageKey(name: string): string {
  return `${PREFIX}${name}`;
}
