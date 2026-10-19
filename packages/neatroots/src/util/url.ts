/** `u` without its trailing slashes. A loop: `/\/+$/` is quadratic on a long run of slashes. */
export function trimSlash(u: string): string {
  let end = u.length;
  while (end > 0 && u[end - 1] === "/") end--;
  return u.slice(0, end);
}
