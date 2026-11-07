// Hosts one iframe per search, keyed by query id, so searches run without any
// visible tab or window.
const frames = new Map();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== "offscreen") return;

  if (message.type === "OPEN_FRAME") {
    const frame = document.createElement("iframe");
    frame.src = message.url;
    frame.style.width = "1280px";
    frame.style.height = "2000px";
    document.body.appendChild(frame);
    frames.set(message.key, frame);
    sendResponse({ ok: true });
    return;
  }

  if (message.type === "CLOSE_FRAME") {
    frames.get(message.key)?.remove();
    frames.delete(message.key);
    sendResponse({ ok: true });
  }
});
