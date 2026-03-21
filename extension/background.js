const DEFAULT_SERVER = "http://localhost:15551";
const POLL_INTERVAL = 1500;
// 60s extraction budget + 8s buffer so background.js can return tab_timeout
// before the FastAPI request-level timeout expires.
const TAB_TIMEOUT = 68000;
const IMAGE_TAB_TIMEOUT = 170000; // 170s — image generation takes 1-2 min
const ALARM_NAME = "poll-server";
const GOOGLE_ACCOUNT_SCAN_LIMIT = 10;

let serverUrl = DEFAULT_SERVER;
let googleAuthUser = 0;
let googleAccounts = [0]; // available authuser indices for quota rotation

// Map<tabId, {queryId, threadId, isFollowUp, deadlineAt, timeoutId}>
const activeTabs = new Map();
// Map<threadId, {tabId, authuser, fast}> — also persisted to chrome.storage.session
let threadTabs = new Map();
let pollInFlight = false;
let isInitialized = false;
const startupPromise = initialize();

function normalizeAccountIndex(value, fallback = 0) {
  const num = Number(value);
  return Number.isInteger(num) && num >= 0 ? num : fallback;
}

function normalizeAccountList(values) {
  const list = Array.isArray(values)
    ? values
        .map((value) => normalizeAccountIndex(value, NaN))
        .filter((value) => Number.isInteger(value) && value >= 0)
    : [];
  const unique = [...new Set(list)].sort((a, b) => a - b);
  return unique.length > 0 ? unique : [0];
}

function coerceStoredAccountState(authuser, accounts) {
  const normalizedAccounts = normalizeAccountList(accounts);
  const fallbackAuthUser = normalizedAccounts[0] ?? 0;
  const normalizedAuthUser = normalizeAccountIndex(authuser, fallbackAuthUser);
  return {
    authuser: normalizedAccounts.includes(normalizedAuthUser)
      ? normalizedAuthUser
      : fallbackAuthUser,
    accounts: normalizedAccounts,
  };
}

function setInMemoryAccountState(authuser, accounts) {
  const nextState = coerceStoredAccountState(authuser, accounts);
  googleAuthUser = nextState.authuser;
  googleAccounts = nextState.accounts;
  return nextState;
}

async function persistAccountState(authuser, accounts) {
  const nextState = setInMemoryAccountState(authuser, accounts);
  await chrome.storage.sync.set({
    googleAuthUser: nextState.authuser,
    googleAccounts: nextState.accounts,
  });
  return nextState;
}

function getDefaultAuthUser() {
  if (googleAccounts.includes(googleAuthUser)) {
    return googleAuthUser;
  }
  return googleAccounts[0] ?? 0;
}

function resolveSearchAuthUser(authuser = null) {
  if (authuser === null || authuser === undefined) {
    return getDefaultAuthUser();
  }
  return normalizeAccountIndex(authuser, getDefaultAuthUser());
}

function clearQueryRetryState(queryId) {
  queryRetryState.delete(queryId);
}

function parseThreadTabRecord(value) {
  if (typeof value === "number") {
    return { tabId: value, authuser: 0, fast: false };
  }
  if (value && typeof value === "object") {
    const tabId = Number(value.tabId);
    if (!Number.isInteger(tabId)) return null;
    return {
      tabId,
      authuser: normalizeAccountIndex(value.authuser, 0),
      fast: Boolean(value.fast),
    };
  }
  return null;
}

function findThreadIdByTabId(tabId) {
  for (const [threadId, info] of threadTabs.entries()) {
    if (info.tabId === tabId) return threadId;
  }
  return null;
}

async function withGoogleTab(run) {
  let tab = null;
  let createdTab = false;
  const tabs = await chrome.tabs.query({ url: "https://www.google.com/*" });
  if (tabs.length > 0) {
    tab = tabs[0];
  } else {
    tab = await chrome.tabs.create({ url: "https://www.google.com/", active: false });
    createdTab = true;
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timeoutId);
        resolve();
      };
      const listener = (tabId, info) => {
        if (tabId === tab.id && info.status === "complete") {
          finish();
        }
      };
      const timeoutId = setTimeout(finish, 8000);
      chrome.tabs.onUpdated.addListener(listener);
    });
  }

  try {
    return await run(tab);
  } finally {
    if (createdTab && tab?.id) {
      try {
        await chrome.tabs.remove(tab.id);
      } catch {
        // Tab may already be closed
      }
    }
  }
}

async function probeGoogleAccounts(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    args: [GOOGLE_ACCOUNT_SCAN_LIMIT],
    func: async (scanLimit) => {
      function parseAccount(html, index) {
        const doc = new DOMParser().parseFromString(html, "text/html");
        let email = "";
        let name = "";

        const emailEl = doc.querySelector("[data-email]");
        if (emailEl) {
          email = (emailEl.getAttribute("data-email") || "").trim();
        }

        const labeledNodes = [...doc.querySelectorAll("[aria-label]")];
        if (!email) {
          for (const node of labeledNodes) {
            const label = node.getAttribute("aria-label") || "";
            const match = label.match(
              /Google Account:\s*(.*?)\s*(?:\n|\r)\(([^)]+@[^)]+)\)/i
            );
            if (match) {
              name = match[1].trim();
              email = match[2].trim();
              break;
            }
          }
        }

        if (!email) {
          const emailMatch = html.match(
            /[\w.+-]+@(?:gmail\.com|googlemail\.com|[\w.-]+\.[a-z]{2,})/i
          );
          if (emailMatch) {
            email = emailMatch[0].trim();
          }
        }

        if (!name && email) {
          for (const node of labeledNodes) {
            const label = node.getAttribute("aria-label") || "";
            if (!label.includes(email)) continue;
            const match = label.match(/Google Account:\s*(.*?)(?:\s*(?:\n|\r)\(|$)/i);
            if (match) {
              name = match[1].trim();
              break;
            }
          }
        }

        if (!email) return null;
        return { index, email };
      }

      const accounts = [];
      const seen = new Set();
      for (let i = 0; i < scanLimit; i++) {
        try {
          const resp = await fetch(
            `https://www.google.com/search?q=test&authuser=${i}`,
            {
              credentials: "include",
              redirect: "follow",
            }
          );
          const html = await resp.text();
          const account = parseAccount(html, i);
          if (!account || seen.has(account.email)) continue;
          seen.add(account.email);
          accounts.push(account);
        } catch {
          // Keep scanning remaining indices in case only one slot fails.
        }
      }
      return accounts;
    },
  });

  return results?.[0]?.result || [];
}

async function refreshGoogleAccounts() {
  try {
    const accounts = await withGoogleTab((tab) => probeGoogleAccounts(tab.id));
    const detectedIndices = normalizeAccountList(accounts.map((account) => account.index));
    await persistAccountState(getDefaultAuthUser(), detectedIndices);
    return detectedIndices;
  } catch (error) {
    console.warn("Failed to refresh Google accounts", error);
    return googleAccounts;
  }
}

// --- Server URL from options ---

async function loadServerUrl() {
  const data = await chrome.storage.sync.get({ serverUrl: DEFAULT_SERVER, googleAuthUser: 0, googleAccounts: [0] });
  serverUrl = data.serverUrl;
  setInMemoryAccountState(data.googleAuthUser, data.googleAccounts);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync") {
    if (changes.serverUrl) {
      serverUrl = changes.serverUrl.newValue || DEFAULT_SERVER;
    }
    if (changes.googleAuthUser != null || changes.googleAccounts) {
      setInMemoryAccountState(
        changes.googleAuthUser ? changes.googleAuthUser.newValue : googleAuthUser,
        changes.googleAccounts ? changes.googleAccounts.newValue : googleAccounts
      );
    }
  }
});

function buildSearchUrl(query, { fast = false, authuser = null, extra = "" } = {}) {
  let url = `https://www.google.com/search?q=${encodeURIComponent(query)}&udm=50`;
  if (!fast) url += "&arv=1";
  const au = resolveSearchAuthUser(authuser);
  if (au > 0) url += `&authuser=${au}`;
  if (extra) url += extra;
  return url;
}

// --- Persistence for threadTabs + activeTabs ---
// MV3 service workers can restart at any time, so keep both the persistent
// thread->tab mapping and the in-flight query->tab mapping in session storage.

async function saveThreadTabs() {
  const obj = {};
  for (const [threadId, info] of threadTabs.entries()) {
    obj[threadId] = {
      tabId: info.tabId,
      authuser: info.authuser,
      fast: info.fast,
    };
  }
  await chrome.storage.session.set({ threadTabs: obj });
}

async function loadThreadTabs() {
  const data = await chrome.storage.session.get("threadTabs");
  if (data.threadTabs) {
    threadTabs = new Map(
      Object.entries(data.threadTabs)
        .map(([threadId, value]) => [threadId, parseThreadTabRecord(value)])
        .filter(([, info]) => info !== null)
    );
  }
}

function serializeActiveTabs() {
  const obj = {};
  for (const [tabId, entry] of activeTabs.entries()) {
    obj[tabId] = {
      queryId: entry.queryId,
      threadId: entry.threadId,
      query: entry.query,
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
      query: persisted.query ?? "",
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

async function trackActiveTab(tabId, {
  queryId,
  threadId,
  query,
  isFollowUp,
  authuser = null,
  fast = false,
}) {
  const existing = activeTabs.get(tabId);
  clearEntryTimeout(existing);

  const entry = {
    queryId,
    threadId,
    query,
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

// Per-query retry state for quota rotation:
// Map<queryId, { triedAuthUsers: Set<number>, triedFast: boolean, refreshedAccounts: boolean }>
const queryRetryState = new Map();

async function handleNewQuery(data, { fast = false, authuser = null } = {}) {
  await ensureInitialized();
  try {
    const effectiveAuthUser = resolveSearchAuthUser(authuser);
    const url = buildSearchUrl(data.query, { fast, authuser: effectiveAuthUser });
    const tab = await chrome.tabs.create({ url, active: false });

    threadTabs.set(data.thread_id, {
      tabId: tab.id,
      authuser: effectiveAuthUser,
      fast,
    });
    await Promise.all([
      saveThreadTabs(),
      trackActiveTab(tab.id, {
        queryId: data.query_id,
        threadId: data.thread_id,
        query: data.query,
        isFollowUp: false,
        authuser: effectiveAuthUser,
        fast,
      }),
    ]);
    return true;
  } catch (err) {
    clearQueryRetryState(data.query_id);
    await postResult(data.query_id, {
      markdown: "",
      citations: [],
      error: `tab_create_failed: ${err.message}`,
    }).catch(() => {});
    return false;
  }
}

async function handleFollowUp(data) {
  await ensureInitialized();
  const threadInfo = threadTabs.get(data.thread_id);

  if (!threadInfo) {
    await postResult(data.query_id, {
      markdown: "",
      citations: [],
      error: "thread_tab_not_found",
    });
    return;
  }

  // Verify tab still exists
  try {
    await chrome.tabs.get(threadInfo.tabId);
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

  await trackActiveTab(threadInfo.tabId, {
    queryId: data.query_id,
    threadId: data.thread_id,
    query: data.query,
    isFollowUp: true,
    authuser: threadInfo.authuser,
    fast: threadInfo.fast,
  });

  // Send follow-up to content script
  try {
    const response = await chrome.tabs.sendMessage(threadInfo.tabId, {
      type: "FOLLOW_UP_QUERY",
      query: data.query,
      queryId: data.query_id,
    });
    // Content script rejected (e.g. follow_up_in_progress)
    if (response && response.received === false) {
      const entry = await clearActiveTab(threadInfo.tabId);
      if (!entry) return;
      clearQueryRetryState(data.query_id);
      await postResult(data.query_id, {
        markdown: "",
        citations: [],
        error: response.error || "follow_up_rejected",
      }).catch(() => {});
    }
  } catch {
    await clearActiveTab(threadInfo.tabId);
    clearQueryRetryState(data.query_id);
    await postResult(data.query_id, {
      markdown: "",
      citations: [],
      error: "content_script_unreachable",
    });
  }
}

async function handleTimeout(tabId, queryId, threadId, isFollowUp) {
  await clearActiveTab(tabId);
  clearQueryRetryState(queryId);
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
  const threadInfo = threadTabs.get(threadId);
  threadTabs.delete(threadId);
  await saveThreadTabs();
  if (threadInfo) {
    const entry = await clearActiveTab(threadInfo.tabId);
    if (entry) {
      clearQueryRetryState(entry.queryId);
    }
    try {
      await chrome.tabs.remove(threadInfo.tabId);
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
        state = { triedAuthUsers: new Set(), triedFast: false, refreshedAccounts: false };
        queryRetryState.set(entry.queryId, state);
      }
      state.triedAuthUsers.add(resolveSearchAuthUser(entry.authuser));

      // Close the current tab
      try { await chrome.tabs.remove(tabId); } catch {}
      threadTabs.delete(entry.threadId);
      await saveThreadTabs();

      let query = entry.query || message.data._query;
      if (!query && sender.tab.url) {
        try {
          query = new URL(sender.tab.url).searchParams.get("q");
        } catch {
          // Ignore malformed URLs
        }
      }
      if (!query) {
        clearQueryRetryState(entry.queryId);
        await postResult(entry.queryId, { markdown: "", citations: [], error: "quota_exhausted_all_accounts" });
        sendResponse({ received: true });
        return;
      }

      // Try next untried account in pro mode
      let nextAccount = googleAccounts.find((idx) => !state.triedAuthUsers.has(idx));
      if (nextAccount === undefined && !state.refreshedAccounts) {
        state.refreshedAccounts = true;
        const refreshedAccounts = await refreshGoogleAccounts();
        nextAccount = refreshedAccounts.find((idx) => !state.triedAuthUsers.has(idx));
      }
      if (nextAccount !== undefined && !entry.fast) {
        console.log(`Quota exhausted on authuser=${entry.authuser}, trying authuser=${nextAccount}`, entry.queryId);
        const reopened = await handleNewQuery(
          { query_id: entry.queryId, thread_id: entry.threadId, query },
          { authuser: nextAccount }
        );
        if (reopened) {
          await persistAccountState(nextAccount, [...googleAccounts, nextAccount]);
        }
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
      clearQueryRetryState(entry.queryId);
      await postResult(entry.queryId, { markdown: "", citations: [], error: "quota_exhausted_all_accounts" });
      sendResponse({ received: true });
      return;
    }

    // Tab stays alive for follow-ups — do NOT close it
    clearQueryRetryState(entry.queryId);
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
      clearQueryRetryState(entry.queryId);
      await postResult(entry.queryId, {
        markdown: "",
        citations: [],
        error: "tab_closed_externally",
      }).catch(() => {});
      if (threadTabs.delete(entry.threadId)) {
        await saveThreadTabs();
      }
    } else {
      const threadId = findThreadIdByTabId(tabId);
      if (threadId) {
        threadTabs.delete(threadId);
        await saveThreadTabs();
      }
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
