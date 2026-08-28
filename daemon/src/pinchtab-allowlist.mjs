/** Browse loop first, screenshot last. Match `navigate` and `pinchtab_navigate`. */
export const PINCHTAB_ALLOWLIST = [
  "navigate",
  "snapshot",
  "get_text",
  "click",
  "type",
  "fill",
  "select",
  "key",
  "scroll",
  "wait",
  "list_tabs",
  "back",
  "screenshot",
];

const KEY_ALIASES = new Set([
  "press",
  "keydown",
  "keyup",
  "keyboard",
  "keyboard_type",
  "keyboard_inserttext",
]);

const WAIT_ALIASES = new Set(["wait_for_selector", "wait_for_text", "wait_for_url", "wait_for_load"]);

const SCROLL_ALIASES = new Set(["scroll_into_view"]);

const DENY = new Set([
  "wait_for_function",
  "eval",
  "cookies",
  "cookies_set",
  "scrape",
  "pdf",
  "capture",
  "record",
  "network",
  "network_route",
  "network_unroute",
  "network_detail",
  "network_clear",
]);

export function normalizePinchTabToolName(name) {
  return String(name ?? "")
    .trim()
    .replace(/^pinchtab_/i, "")
    .toLowerCase()
    .replace(/-/g, "_");
}

export function pinchTabToolAllowed(name) {
  const n = normalizePinchTabToolName(name);
  if (!n) return false;
  if (n.includes("eval") || n.includes("function")) return false;
  if (DENY.has(n) || [...DENY].some((hint) => n === hint || n.startsWith(`${hint}_`))) return false;
  if (PINCHTAB_ALLOWLIST.includes(n)) return true;
  if (KEY_ALIASES.has(n)) return true;
  if (WAIT_ALIASES.has(n)) return true;
  if (SCROLL_ALIASES.has(n)) return true;
  return false;
}

export function filterAllowlistedTools(tools) {
  const allowed = (tools ?? []).filter((tool) => pinchTabToolAllowed(tool?.name));
  const rest = [];
  const shots = [];
  for (const tool of allowed) {
    const n = normalizePinchTabToolName(tool?.name);
    if (n === "screenshot") shots.push(tool);
    else rest.push(tool);
  }
  return [...rest, ...shots];
}
