const SERVER = "http://localhost:8000";
const POLL_INTERVAL = 1500;
const TAB_TIMEOUT = 28000;
const ALARM_NAME = "poll-server";

// Map<tabId, {queryId, threadId, timeoutId}>
const activeTabs = new Map();
// Map<threadId, tabId> — also persisted to chrome.storage.session
let threadTabs = new Map();

// --- Persistence for threadTabs ---
// Service workers can restart at any time (MV3). Persist threadTabs so
// close_threads from the server can still find the right tab after restart.

async function saveThreadTabs() {
  const obj = Object.fromEntries(threadTabs);
  await chrome.storage.session.set({ threadTabs: obj });
}

async function loadThreadTabs() {
  const data = await chrome.storage.session.get("threadTabs");
  if (data.threadTabs) {
    threadTabs = new Map(Object.entries(data.threadTabs));
  }
}

// --- Polling via chrome.alarms (survives service worker inactivity) ---

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    pollServer();
  }
});

async function startPolling() {
  await chrome.alarms.create(ALARM_NAME, {
    delayInMinutes: 0,
    periodInMinutes: POLL_INTERVAL / 60000,
  });
  // Also fire immediately (alarms have ~1min minimum in MV3,
  // so we supplement with setTimeout for responsiveness)
  pollServer();
}

async function pollServer() {
  try {
    const resp = await fetch(`${SERVER}/pending`);
    if (resp.ok) {
      const data = await resp.json();

      // Process thread closures first
      if (data.close_threads) {
        for (const threadId of data.close_threads) {
          await closeThread(threadId);
        }
      }

      // Dispatch query
      if (data.query_id && data.query) {
        if (data.type === "follow_up") {
          await handleFollowUp(data);
        } else {
          await handleNewQuery(data);
        }
      }
    }
  } catch {
    // Server not running — silently retry next poll
  }

  // Supplement alarm with setTimeout for sub-minute responsiveness.
  // If the service worker stays alive, this fires at 1.5s intervals.
  // If it goes idle, the alarm wakes it back up (at ~1min intervals).
  setTimeout(pollServer, POLL_INTERVAL);
}

async function handleNewQuery(data) {
  const url = `https://www.google.com/search?q=${encodeURIComponent(data.query)}&udm=50`;
  const tab = await chrome.tabs.create({ url, active: false });

  const timeoutId = setTimeout(
    () => handleTimeout(tab.id, data.query_id, data.thread_id, false),
    TAB_TIMEOUT
  );
  activeTabs.set(tab.id, {
    queryId: data.query_id,
    threadId: data.thread_id,
    timeoutId,
  });
  threadTabs.set(data.thread_id, tab.id);
  await saveThreadTabs();
}

async function handleFollowUp(data) {
  const tabId = threadTabs.get(data.thread_id);

  if (!tabId) {
    await postResult(data.query_id, {
      markdown: "",
      citations: [],
      error: "thread_tab_not_found",
    });
    return;
  }

  // Verify tab still exists
  try {
    await chrome.tabs.get(tabId);
  } catch {
    threadTabs.delete(data.thread_id);
    await saveThreadTabs();
    await postResult(data.query_id, {
      markdown: "",
      citations: [],
      error: "thread_tab_crashed",
    });
    return;
  }

  const timeoutId = setTimeout(
    () => handleTimeout(tabId, data.query_id, data.thread_id, true),
    TAB_TIMEOUT
  );
  activeTabs.set(tabId, {
    queryId: data.query_id,
    threadId: data.thread_id,
    timeoutId,
  });

  // Send follow-up to content script
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "FOLLOW_UP_QUERY",
      query: data.query,
      queryId: data.query_id,
    });
  } catch {
    clearTimeout(timeoutId);
    activeTabs.delete(tabId);
    await postResult(data.query_id, {
      markdown: "",
      citations: [],
      error: "content_script_unreachable",
    });
  }
}

async function handleTimeout(tabId, queryId, threadId, isFollowUp) {
  activeTabs.delete(tabId);
  try {
    await postResult(queryId, {
      markdown: "",
      citations: [],
      error: "tab_timeout",
    });
  } catch {
    // Server may be gone
  }

  if (!isFollowUp) {
    // New query timeout: clean up tab and thread mapping
    threadTabs.delete(threadId);
    await saveThreadTabs();
    try {
      await chrome.tabs.remove(tabId);
    } catch {
      // Tab may already be closed
    }
  }
  // Follow-up timeout: keep tab alive for potential retry
}

async function postResult(queryId, data) {
  await fetch(`${SERVER}/result/${queryId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

async function closeThread(threadId) {
  const tabId = threadTabs.get(threadId);
  threadTabs.delete(threadId);
  await saveThreadTabs();
  if (tabId) {
    const entry = activeTabs.get(tabId);
    if (entry) {
      clearTimeout(entry.timeoutId);
      activeTabs.delete(tabId);
    }
    try {
      await chrome.tabs.remove(tabId);
    } catch {
      // Tab may already be closed
    }
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== "AI_OVERVIEW_RESULT" || !sender.tab) return;

  const tabId = sender.tab.id;
  const entry = activeTabs.get(tabId);
  if (!entry) return;

  clearTimeout(entry.timeoutId);
  activeTabs.delete(tabId);

  // Tab stays alive for follow-ups — do NOT close it
  postResult(entry.queryId, message.data).catch(() => {});

  sendResponse({ received: true });
});

// Clean up maps when a tab is closed externally
chrome.tabs.onRemoved.addListener((tabId) => {
  const entry = activeTabs.get(tabId);
  if (entry) {
    clearTimeout(entry.timeoutId);
    activeTabs.delete(tabId);
    threadTabs.delete(entry.threadId);
    saveThreadTabs();
  }
});

// Initialize: load persisted state, then start polling
loadThreadTabs().then(() => startPolling());
