export function shortId(len = 8) {
  return Math.random().toString(36).slice(2, 2 + len);
}

const ALLOWED = /^[a-z0-9][a-z0-9_-]{0,62}$/i;

export function validSessionName(name: string): boolean {
  return ALLOWED.test(name);
}
