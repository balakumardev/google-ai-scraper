const DEFAULT_SERVER = "http://localhost:15551";
const POLL_INTERVAL = 1500;
const TAB_TIMEOUT = 28000;
const ALARM_NAME = "poll-server";

let serverUrl = DEFAULT_SERVER;

// Map<tabId, {queryId, threadId, timeoutId}>
const activeTabs = new Map();
// Map<threadId, tabId> — also persisted to chrome.storage.session
let threadTabs = new Map();
let pollInFlight = false;
const startupPromise = initialize();

// --- Server URL from options ---

async function loadServerUrl() {
  const { serverUrl: url } = await chrome.storage.sync.get({ serverUrl: DEFAULT_SERVER });
  serverUrl = url;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.serverUrl) {
    serverUrl = changes.serverUrl.newValue || DEFAULT_SERVER;
  }
});

// --- Persistence for threadTabs + activeTabs ---
// MV3 service workers can restart at any time, so keep both the persistent
// thread->tab mapping and the in-flight query->tab mapping in session storage.

async function saveThreadTabs() {
  const obj = Object.fromEntries(threadTabs);
  await chrome.storage.session.set({ threadTabs: obj });
}

async function loadThreadTabs() {
  const data = await chrome.storage.session.get("threadTabs");
  if (data.threadTabs) {
    threadTabs = new Map(
      Object.entries(data.threadTabs)
        .map(([threadId, tabId]) => [threadId, Number(tabId)])
        .filter(([, tabId]) => Number.isInteger(tabId))
    );
  }
}

function serializeActiveTabs() {
  const obj = {};
  for (const [tabId, entry] of activeTabs.entries()) {
    obj[tabId] = {
      queryId: entry.queryId,
      threadId: entry.threadId,
      isFollowUp: entry.isFollowUp,
      deadlineAt: entry.deadlineAt,
    };
  }
  return obj;
}

async function saveActiveTabs() {
  await chrome.storage.session.set({ activeTabs: serializeActiveTabs() });
}

function clearEntryTimeout(entry) {
  if (entry?.timeoutId) {
    clearTimeout(entry.timeoutId);
  }
}

function scheduleTimeout(tabId, entry) {
  clearEntryTimeout(entry);
  const delay = Math.max(0, entry.deadlineAt - Date.now());
  entry.timeoutId = setTimeout(
    () => handleTimeout(tabId, entry.queryId, entry.threadId, entry.isFollowUp),
    delay
  );
}

async function loadActiveTabs() {
  const data = await chrome.storage.session.get("activeTabs");
  activeTabs.clear();

  for (const [tabIdRaw, persisted] of Object.entries(data.activeTabs || {})) {
    const tabId = Number(tabIdRaw);
    if (!Number.isInteger(tabId)) continue;

    const entry = {
      queryId: persisted.queryId,
      threadId: persisted.threadId,
      isFollowUp: Boolean(persisted.isFollowUp),
      deadlineAt: Number(persisted.deadlineAt) || Date.now(),
      timeoutId: null,
    };
    activeTabs.set(tabId, entry);
    scheduleTimeout(tabId, entry);
  }
}

async function trackActiveTab(tabId, { queryId, threadId, isFollowUp }) {
  const existing = activeTabs.get(tabId);
  clearEntryTimeout(existing);

  const entry = {
    queryId,
    threadId,
    isFollowUp,
    deadlineAt: Date.now() + TAB_TIMEOUT,
    timeoutId: null,
  };

  activeTabs.set(tabId, entry);
  await saveActiveTabs();
  scheduleTimeout(tabId, entry);
}

async function clearActiveTab(tabId) {
  const entry = activeTabs.get(tabId);
  if (!entry) return null;

  clearEntryTimeout(entry);
  activeTabs.delete(tabId);
  await saveActiveTabs();
  return entry;
}

async function ensureInitialized() {
  await startupPromise;
}

async function initialize() {
  await Promise.all([loadThreadTabs(), loadActiveTabs(), loadServerUrl()]);
  await startPolling();
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
  if (pollInFlight) return;
  pollInFlight = true;

  try {
    const resp = await fetch(`${serverUrl}/pending`);
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
  } finally {
    pollInFlight = false;
  }

  // Supplement alarm with setTimeout for sub-minute responsiveness.
  // If the service worker stays alive, this fires at 1.5s intervals.
  // If it goes idle, the alarm wakes it back up (at ~1min intervals).
  setTimeout(pollServer, POLL_INTERVAL);
}

async function handleNewQuery(data) {
  try {
    const url = `https://www.google.com/search?q=${encodeURIComponent(data.query)}&udm=50`;
    const tab = await chrome.tabs.create({ url, active: false });

    threadTabs.set(data.thread_id, tab.id);
    await Promise.all([
      saveThreadTabs(),
      trackActiveTab(tab.id, {
        queryId: data.query_id,
        threadId: data.thread_id,
        isFollowUp: false,
      }),
    ]);
  } catch (err) {
    await postResult(data.query_id, {
      markdown: "",
      citations: [],
      error: `tab_create_failed: ${err.message}`,
    }).catch(() => {});
  }
}

async function handleFollowUp(data) {
  await ensureInitialized();
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

  await trackActiveTab(tabId, {
    queryId: data.query_id,
    threadId: data.thread_id,
    isFollowUp: true,
  });

  // Send follow-up to content script
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: "FOLLOW_UP_QUERY",
      query: data.query,
      queryId: data.query_id,
    });
    // Content script rejected (e.g. follow_up_in_progress)
    if (response && response.received === false && activeTabs.has(tabId)) {
      clearTimeout(activeTabs.get(tabId).timeoutId);
      activeTabs.delete(tabId);
      await postResult(data.query_id, {
        markdown: "",
        citations: [],
        error: response.error || "follow_up_rejected",
      }).catch(() => {});
    }
  } catch {
    await clearActiveTab(tabId);
    await postResult(data.query_id, {
      markdown: "",
      citations: [],
      error: "content_script_unreachable",
    });
  }
}

async function handleTimeout(tabId, queryId, threadId, isFollowUp) {
  await clearActiveTab(tabId);
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
  await fetch(`${serverUrl}/result/${queryId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

async function closeThread(threadId) {
  await ensureInitialized();
  const tabId = threadTabs.get(threadId);
  threadTabs.delete(threadId);
  await saveThreadTabs();
  if (tabId) {
    await clearActiveTab(tabId);
    try {
      await chrome.tabs.remove(tabId);
    } catch {
      // Tab may already be closed
    }
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== "AI_OVERVIEW_RESULT" || !sender.tab) return;

  (async () => {
    await ensureInitialized();

    const tabId = sender.tab.id;
    const entry = await clearActiveTab(tabId);
    if (!entry) {
      console.warn("Missing active tab state for AI overview result", { tabId });
      sendResponse({ received: false, error: "active_tab_not_found" });
      return;
    }

    // Tab stays alive for follow-ups — do NOT close it
    await postResult(entry.queryId, message.data);
    sendResponse({ received: true });
  })().catch((error) => {
    console.error("Failed to relay AI overview result", error);
    sendResponse({ received: false, error: String(error) });
  });

  return true;
});

// Clean up maps when a tab is closed externally
chrome.tabs.onRemoved.addListener((tabId) => {
  (async () => {
    await ensureInitialized();
    const entry = await clearActiveTab(tabId);
    if (entry) {
      // Notify server immediately so /ask doesn't hang until timeout
      await postResult(entry.queryId, {
        markdown: "",
        citations: [],
        error: "tab_closed_externally",
      }).catch(() => {});
      threadTabs.delete(entry.threadId);
      await saveThreadTabs();
    }
  })().catch(() => {});
});
