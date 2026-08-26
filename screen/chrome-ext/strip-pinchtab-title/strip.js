const PREFIX = /^\[PinchTab :\d+(?:,:\d+)*\]\s*/;

function strip() {
  if (typeof document === "undefined") return;
  const title = document.title;
  if (!PREFIX.test(title)) return;
  document.title = title.replace(PREFIX, "");
}

strip();
document.addEventListener("DOMContentLoaded", strip);
new MutationObserver(strip).observe(document.documentElement || document, {
  subtree: true,
  childList: true,
  characterData: true,
});
setInterval(strip, 400);
