export const SIDEBAR_COOKIE_NAME = "sidebar_state";
const SIDEBAR_COOKIE_MAX_AGE = 60 * 60 * 24 * 7;

export function shouldAutoCollapseSidebar(pathname: string): boolean {
  return (
    /^\/traces\/[^/]+$/.test(pathname) ||
    /^\/evals\/(?:batches|schedules)\/[^/]+$/.test(pathname)
  );
}

export function persistSidebarOpenCookie(open: boolean) {
  document.cookie = `${SIDEBAR_COOKIE_NAME}=${open}; path=/; max-age=${SIDEBAR_COOKIE_MAX_AGE}`;
}

export function parseSidebarOpenCookie(
  value: string | undefined
): boolean | null {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  return null;
}

export function resolveInitialSidebarOpen(
  storedPreference: boolean | null,
  shouldAutoCollapse: boolean
): boolean {
  return shouldAutoCollapse ? false : (storedPreference ?? true);
}
