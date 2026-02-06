const SERVER = "http://localhost:8000";
const POLL_INTERVAL = 1500;
const TAB_TIMEOUT = 28000;

// Map<tabId, {queryId, timeoutId}>
const activeTabs = new Map();

async function pollServer() {
  try {
    const resp = await fetch(`${SERVER}/pending`);
    if (resp.ok) {
      const data = await resp.json();
      if (data.query_id && data.query) {
        const url = `https://www.google.com/search?q=${encodeURIComponent(data.query)}&udm=50`;
        const tab = await chrome.tabs.create({ url, active: false });

        const timeoutId = setTimeout(() => handleTimeout(tab.id, data.query_id), TAB_TIMEOUT);
        activeTabs.set(tab.id, { queryId: data.query_id, timeoutId });
      }
    }
  } catch {
    // Server not running — silently retry next poll
  }

  setTimeout(pollServer, POLL_INTERVAL);
}

async function handleTimeout(tabId, queryId) {
  activeTabs.delete(tabId);
  try {
    await postResult(queryId, { markdown: "", citations: [], error: "tab_timeout" });
    await chrome.tabs.remove(tabId);
  } catch {
    // Tab may already be closed
  }
}

async function postResult(queryId, data) {
  await fetch(`${SERVER}/result/${queryId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== "AI_OVERVIEW_RESULT" || !sender.tab) return;

  const tabId = sender.tab.id;
  const entry = activeTabs.get(tabId);
  if (!entry) return;

  clearTimeout(entry.timeoutId);
  activeTabs.delete(tabId);

  postResult(entry.queryId, message.data)
    .then(() => chrome.tabs.remove(tabId))
    .catch(() => {});

  sendResponse({ received: true });
});

// Start polling
pollServer();
