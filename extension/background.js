const DEFAULT_SERVER = "http://localhost:15551";
const POLL_INTERVAL = 1500;
// 60s extraction budget + 8s buffer so background.js can return tab_timeout
// before the FastAPI request-level timeout expires.
const TAB_TIMEOUT = 68000;
const IMAGE_TAB_TIMEOUT = 170000; // 170s — image generation takes 1-2 min
const ALARM_NAME = "poll-server";

let serverUrl = DEFAULT_SERVER;
let googleAuthUser = 0;
let googleAccounts = [0]; // available authuser indices for quota rotation

// Map<tabId, {queryId, threadId, isFollowUp, deadlineAt, timeoutId}>
const activeTabs = new Map();
// Map<threadId, tabId> — also persisted to chrome.storage.session
let threadTabs = new Map();
let pollInFlight = false;
let isInitialized = false;
const startupPromise = initialize();

// --- Server URL from options ---

async function loadServerUrl() {
  const data = await chrome.storage.sync.get({ serverUrl: DEFAULT_SERVER, googleAuthUser: 0, googleAccounts: [0] });
  serverUrl = data.serverUrl;
  googleAuthUser = data.googleAuthUser;
  googleAccounts = data.googleAccounts;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync") {
    if (changes.serverUrl) {
      serverUrl = changes.serverUrl.newValue || DEFAULT_SERVER;
    }
    if (changes.googleAuthUser != null) {
      googleAuthUser = changes.googleAuthUser.newValue || 0;
    }
    if (changes.googleAccounts) {
      googleAccounts = changes.googleAccounts.newValue || [0];
    }
  }
});

function buildSearchUrl(query, { fast = false, authuser = null, extra = "" } = {}) {
  let url = `https://www.google.com/search?q=${encodeURIComponent(query)}&udm=50`;
  if (!fast) url += "&arv=1";
  const au = authuser !== null ? authuser : googleAuthUser;
  if (au > 0) url += `&authuser=${au}`;
  if (extra) url += extra;
  return url;
}

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
      authuser: entry.authuser,
      fast: entry.fast,
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
      authuser: persisted.authuser ?? null,
      fast: Boolean(persisted.fast),
      deadlineAt: Number(persisted.deadlineAt) || Date.now(),
      timeoutId: null,
    };
    activeTabs.set(tabId, entry);
    scheduleTimeout(tabId, entry);
  }
}

async function trackActiveTab(tabId, { queryId, threadId, isFollowUp, authuser = null, fast = false }) {
  const existing = activeTabs.get(tabId);
  clearEntryTimeout(existing);

  const entry = {
    queryId,
    threadId,
    isFollowUp,
    authuser,
    fast,
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
  if (isInitialized) return;
  await startupPromise;
}

async function initialize() {
  await Promise.all([loadThreadTabs(), loadActiveTabs(), loadServerUrl()]);
  isInitialized = true;
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
  await ensureInitialized();
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
        if (data.pipeline === "image") {
          await handleImageQuery(data);
        } else if (data.type === "follow_up") {
          await handleFollowUp(data);
        } else {
          await handleNewQuery(data, {
            fast: data.mode === "fast",
            authuser: data.authuser !== undefined && data.authuser !== null ? data.authuser : null,
          });
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

// Per-query retry state for quota rotation: Map<queryId, { triedAuthUsers: Set<number>, triedFast: boolean }>
const queryRetryState = new Map();

async function handleNewQuery(data, { fast = false, authuser = null } = {}) {
  await ensureInitialized();
  try {
    const url = buildSearchUrl(data.query, { fast, authuser });
    const tab = await chrome.tabs.create({ url, active: false });

    threadTabs.set(data.thread_id, tab.id);
    await Promise.all([
      saveThreadTabs(),
      trackActiveTab(tab.id, {
        queryId: data.query_id,
        threadId: data.thread_id,
        isFollowUp: false,
        authuser: authuser !== null ? authuser : googleAuthUser,
        fast,
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
    if (response && response.received === false) {
      const entry = await clearActiveTab(tabId);
      if (!entry) return;
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

    // Quota exhausted — rotate to next account, then fall back to fast mode
    if (message.data?.error === "quota_exhausted_pro") {
      let state = queryRetryState.get(entry.queryId);
      if (!state) {
        state = { triedAuthUsers: new Set(), triedFast: false };
        queryRetryState.set(entry.queryId, state);
      }
      state.triedAuthUsers.add(entry.authuser ?? googleAuthUser);

      // Close the current tab
      try { await chrome.tabs.remove(tabId); } catch {}
      threadTabs.delete(entry.threadId);
      await saveThreadTabs();

      let query = message.data._query;
      if (!query) {
        try { query = new URL(sender.tab.url).searchParams.get("q"); } catch {}
      }
      if (!query) {
        queryRetryState.delete(entry.queryId);
        await postResult(entry.queryId, { markdown: "", citations: [], error: "quota_exhausted_all_accounts" });
        sendResponse({ received: true });
        return;
      }

      // Try next untried account in pro mode
      const nextAccount = googleAccounts.find(idx => !state.triedAuthUsers.has(idx));
      if (nextAccount !== undefined && !entry.fast) {
        console.log(`Quota exhausted on authuser=${entry.authuser}, trying authuser=${nextAccount}`, entry.queryId);
        await handleNewQuery(
          { query_id: entry.queryId, thread_id: entry.threadId, query },
          { authuser: nextAccount }
        );
        sendResponse({ received: true });
        return;
      }

      // All accounts exhausted in pro mode — try fast mode (once)
      if (!state.triedFast) {
        state.triedFast = true;
        console.log("All accounts exhausted on Pro, trying fast mode", entry.queryId);
        await handleNewQuery(
          { query_id: entry.queryId, thread_id: entry.threadId, query },
          { fast: true }
        );
        sendResponse({ received: true });
        return;
      }

      // Everything failed
      queryRetryState.delete(entry.queryId);
      await postResult(entry.queryId, { markdown: "", citations: [], error: "quota_exhausted_all_accounts" });
      sendResponse({ received: true });
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

// --- Image generation pipeline ---
// Image tabs are fire-and-forget: no thread tracking, tab closes after result.

const imageActiveTabs = new Map(); // Map<tabId, {queryId, timeoutId}>

async function handleImageQuery(data) {
  try {
    const url = buildSearchUrl(data.query, { extra: "#_img" });
    const tab = await chrome.tabs.create({ url, active: false });

    const timeoutId = setTimeout(async () => {
      imageActiveTabs.delete(tab.id);
      await postImageResult(data.query_id, {
        images: [],
        error: "image_generation_timeout",
      }).catch(() => {});
      try { await chrome.tabs.remove(tab.id); } catch {}
    }, IMAGE_TAB_TIMEOUT);

    imageActiveTabs.set(tab.id, { queryId: data.query_id, timeoutId });
  } catch (err) {
    await postImageResult(data.query_id, {
      images: [],
      error: `tab_create_failed: ${err.message}`,
    }).catch(() => {});
  }
}

async function postImageResult(queryId, data) {
  await fetch(`${serverUrl}/image_result/${queryId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== "AI_IMAGE_RESULT" || !sender.tab) return;

  (async () => {
    const tabId = sender.tab.id;
    const entry = imageActiveTabs.get(tabId);
    if (!entry) {
      sendResponse({ received: false, error: "image_tab_not_found" });
      return;
    }

    clearTimeout(entry.timeoutId);
    imageActiveTabs.delete(tabId);
    await postImageResult(entry.queryId, message.data);
    sendResponse({ received: true });

    // Close tab — image queries are one-shot
    try { await chrome.tabs.remove(tabId); } catch {}
  })().catch((error) => {
    sendResponse({ received: false, error: String(error) });
  });

  return true;
});

// Clean up maps when a tab is closed externally
chrome.tabs.onRemoved.addListener((tabId) => {
  (async () => {
    await ensureInitialized();

    // Check text pipeline
    const entry = await clearActiveTab(tabId);
    if (entry) {
      await postResult(entry.queryId, {
        markdown: "",
        citations: [],
        error: "tab_closed_externally",
      }).catch(() => {});
      threadTabs.delete(entry.threadId);
      await saveThreadTabs();
    }

    // Check image pipeline
    const imgEntry = imageActiveTabs.get(tabId);
    if (imgEntry) {
      clearTimeout(imgEntry.timeoutId);
      imageActiveTabs.delete(tabId);
      await postImageResult(imgEntry.queryId, {
        images: [],
        error: "tab_closed_externally",
      }).catch(() => {});
    }
  })().catch(() => {});
});
