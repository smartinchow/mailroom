/** Extract the bare address from "Display Name <a@b.c>" or "a@b.c". */
export function bareAddress(from: string): string | null {
  const angled = from.match(/<([^<>]+)>\s*$/);
  const addr = (angled ? angled[1] : from).trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr) ? addr.toLowerCase() : null;
}
