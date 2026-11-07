const DEFAULT_SERVER = "http://localhost:15551";
const POLL_INTERVAL = 1500;
const LONG_POLL_WAIT_SECONDS = 20;
// Firefox requires periodInMinutes >= 1; Chrome allows 0.5 for faster MV3 wake.
const ALARM_WAKE_INTERVAL_MINUTES =
  typeof browser !== "undefined" &&
  browser.runtime?.getManifest?.()?.browser_specific_settings?.gecko
    ? 1
    : 0.5;
// 60s extraction budget + 8s buffer so background.js can return tab_timeout
// before the FastAPI request-level timeout expires.
const TAB_TIMEOUT = 68000;
const IMAGE_TAB_TIMEOUT = 170000; // 170s — image generation takes 1-2 min
const ALARM_NAME = "poll-server";
const GOOGLE_ACCOUNT_SCAN_LIMIT = 10;
const GOOGLE_ACCOUNT_CACHE_TTL = 12 * 60 * 60 * 1000;
const SERVER_HEALTH_TIMEOUT = 3000;
const PARKED_THREAD_TTL = 30 * 60 * 1000;
const RESUME_HASH = "#_resume";
const RESUME_READY_TIMEOUT = 20000;

let serverUrl = DEFAULT_SERVER;
let searchWindowMode = "current"; // "current" | "offscreen"
let googleAuthUser = 0;
let googleAccounts = [0]; // available authuser indices for quota rotation
let googleAccountProfiles = [];
let googleAccountsUpdatedAt = 0;
let googleAccountsLastError = "";
let accountRefreshInFlight = null;

// Map<tabId, {queryId, threadId, isFollowUp, deadlineAt, timeoutId}>
const activeTabs = new Map();
// Map<tabId, {queryId, deadlineAt, timeoutId}> — also persisted to chrome.storage.session
const imageActiveTabs = new Map();
// Map<threadId, {tabId, authuser, fast, url, parkedAt}> — also persisted to chrome.storage.session.
// A parked thread has tabId === null: its tab was closed and url reopens the conversation.
let threadTabs = new Map();
let pollInFlight = false;
let isInitialized = false;
const startupPromise = initialize().catch((error) => {
  console.error("Google AI Scraper failed to initialize", error);
});

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

function normalizeTimestamp(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : fallback;
}

function sanitizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeAccountProfile(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const index = normalizeAccountIndex(value.index, NaN);
  const email = sanitizeText(value.email);
  if (!Number.isInteger(index) || index < 0 || !email) {
    return null;
  }

  return {
    index,
    email,
    name: sanitizeText(value.name),
    photo: sanitizeText(value.photo),
  };
}

function normalizeAccountProfiles(values) {
  const deduped = new Map();

  for (const value of Array.isArray(values) ? values : []) {
    const account = normalizeAccountProfile(value);
    if (!account) continue;

    const existing = deduped.get(account.email);
    if (!existing) {
      deduped.set(account.email, account);
      continue;
    }

    deduped.set(account.email, {
      index: Math.min(existing.index, account.index),
      email: account.email,
      name: existing.name || account.name,
      photo: existing.photo || account.photo,
    });
  }

  return [...deduped.values()].sort((a, b) => a.index - b.index);
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

function setInMemoryAccountProfiles(profiles, updatedAt = 0) {
  googleAccountProfiles = normalizeAccountProfiles(profiles);
  googleAccountsUpdatedAt = normalizeTimestamp(
    updatedAt,
    googleAccountProfiles.length > 0 ? Date.now() : 0
  );
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

function getSelectedAccountProfile() {
  const selectedAuthUser = getDefaultAuthUser();
  return (
    googleAccountProfiles.find((account) => account.index === selectedAuthUser) ||
    googleAccountProfiles[0] ||
    null
  );
}

function isAccountCacheStale() {
  if (!googleAccountsUpdatedAt) {
    return true;
  }
  return Date.now() - googleAccountsUpdatedAt > GOOGLE_ACCOUNT_CACHE_TTL;
}

function buildPopupState() {
  return {
    authuser: getDefaultAuthUser(),
    accounts: googleAccountProfiles,
    selectedAccount: getSelectedAccountProfile(),
    accountsUpdatedAt: googleAccountsUpdatedAt || null,
    accountsLastError: googleAccountsLastError || null,
    accountsStale: isAccountCacheStale(),
    isRefreshingAccounts: accountRefreshInFlight !== null,
    serverUrl,
  };
}

async function persistAccountProfiles(profiles, selectedAuthUser = getDefaultAuthUser()) {
  const normalizedProfiles = normalizeAccountProfiles(profiles);
  const accountIndices = normalizedProfiles.map((account) => account.index);
  if (accountIndices.length > 0) {
    await persistAccountState(selectedAuthUser, accountIndices);
  }

  setInMemoryAccountProfiles(normalizedProfiles, Date.now());
  googleAccountsLastError = "";

  await chrome.storage.local.set({
    googleAccountProfiles,
    googleAccountsUpdatedAt,
    googleAccountsLastError,
  });

  return normalizedProfiles;
}

async function persistAccountRefreshError(message) {
  googleAccountsLastError = sanitizeText(message);
  await chrome.storage.local.set({ googleAccountsLastError });
}

function clearQueryRetryState(queryId) {
  queryRetryState.delete(queryId);
}

function parseThreadTabRecord(value) {
  if (typeof value === "number") {
    return { tabId: value, authuser: 0, fast: false };
  }
  if (value && typeof value === "object") {
    const url = typeof value.url === "string" ? value.url : null;
    const tabId = value.tabId === null ? null : Number(value.tabId);
    if (tabId === null ? !url : !Number.isInteger(tabId)) return null;
    return {
      tabId,
      authuser: normalizeAccountIndex(value.authuser, 0),
      fast: Boolean(value.fast),
      url,
      parkedAt: normalizeTimestamp(value.parkedAt, 0),
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
        let photo = "";

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

        const photoEl = doc.querySelector(
          'img[src*="googleusercontent.com"], img[data-src*="googleusercontent.com"]'
        );
        if (photoEl) {
          photo = (
            photoEl.getAttribute("src") ||
            photoEl.getAttribute("data-src") ||
            ""
          ).trim();
        }

        if (!email) return null;
        return { index, email, name, photo };
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

async function refreshGoogleAccounts({ force = false } = {}) {
  if (
    !force &&
    googleAccountProfiles.length > 0 &&
    !isAccountCacheStale()
  ) {
    return googleAccountProfiles;
  }

  if (accountRefreshInFlight) {
    return accountRefreshInFlight;
  }

  accountRefreshInFlight = (async () => {
    try {
      const accounts = await withGoogleTab((tab) => probeGoogleAccounts(tab.id));
      const profiles = normalizeAccountProfiles(accounts);
      if (profiles.length === 0) {
        await persistAccountRefreshError("No Google accounts found. Sign in to Google first.");
        return googleAccountProfiles;
      }

      await persistAccountProfiles(profiles, getDefaultAuthUser());
      return googleAccountProfiles;
    } catch (error) {
      console.warn("Failed to refresh Google accounts", error);
      const message =
        error && typeof error.message === "string"
          ? error.message
          : "Failed to refresh Google accounts";
      await persistAccountRefreshError(message);
      return googleAccountProfiles;
    } finally {
      accountRefreshInFlight = null;
    }
  })();

  return accountRefreshInFlight;
}

// --- Offscreen mode: searches load in iframes of an offscreen document ---
// Google forbids framing its pages, so a session rule strips the framing
// headers, only for frames outside any tab (that is, the offscreen document).

const FRAME_HEADER_RULE_ID = 1;
const OFFSCREEN_PARK_GRACE = 60000;
// Map<queryId, {timeoutId, threadId, authuser, fast}>
const offscreenQueries = new Map();
let offscreenReady = null;

function ensureOffscreenDocument() {
  offscreenReady ??= (async () => {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [FRAME_HEADER_RULE_ID],
      addRules: [{
        id: FRAME_HEADER_RULE_ID,
        priority: 1,
        action: {
          type: "modifyHeaders",
          responseHeaders: [
            { header: "x-frame-options", operation: "remove" },
            { header: "content-security-policy", operation: "remove" },
          ],
        },
        condition: {
          requestDomains: ["www.google.com"],
          resourceTypes: ["sub_frame"],
          tabIds: [chrome.tabs.TAB_ID_NONE],
        },
      }],
    });
    const existing = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
    if (existing.length === 0) {
      await chrome.offscreen.createDocument({
        url: "offscreen.html",
        reasons: ["DOM_SCRAPING"],
        justification: "Load Google AI Mode answers without opening visible tabs",
      });
    }
  })().catch((error) => {
    offscreenReady = null;
    throw error;
  });
  return offscreenReady;
}

// A frame lives for one answer: the conversation URL is parked, and a
// follow-up reopens it with the question in the hash (_fq) for content.js.
async function startOffscreenQuery(data, frameUrl, { authuser = 0, fast = false } = {}) {
  await ensureOffscreenDocument();
  offscreenQueries.set(data.query_id, {
    timeoutId: setTimeout(
      () => finishOffscreenQuery(data.query_id, { markdown: "", citations: [], error: "tab_timeout" }),
      TAB_TIMEOUT
    ),
    threadId: data.thread_id,
    authuser,
    fast,
  });
  await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "OPEN_FRAME",
    url: frameUrl,
    key: data.query_id,
  });
}

function useOffscreen() {
  return searchWindowMode === "offscreen" && Boolean(chrome.offscreen);
}

async function startOffscreenFollowUp(data, threadInfo) {
  const hash = new URLSearchParams({ _resume: "1", _oq: data.query_id, _fq: data.query });
  await startOffscreenQuery(data, `${threadInfo.url}#${hash}`, {
    authuser: threadInfo.authuser,
    fast: threadInfo.fast,
  });
}

async function finishOffscreenQuery(queryId, result, pageUrl = null) {
  const query = offscreenQueries.get(queryId);
  if (!query) return;
  clearTimeout(query.timeoutId);
  offscreenQueries.delete(queryId);
  if (pageUrl && !result.error) {
    threadTabs.set(query.threadId, {
      tabId: null,
      authuser: query.authuser,
      fast: query.fast,
      url: stripHash(pageUrl),
      parkedAt: Date.now(),
    });
    await saveThreadTabs();
  }
  await postResult(queryId, result).catch(() => {});
  await chrome.runtime
    .sendMessage({ target: "offscreen", type: "CLOSE_FRAME", key: queryId })
    .catch(() => {});
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.type !== "AI_OVERVIEW_RESULT" || sender.tab || !message.offscreenKey) return;
  finishOffscreenQuery(message.offscreenKey, message.data, message.pageUrl);
});

// --- Server URL from options ---

async function loadStoredState() {
  const [syncData, localData] = await Promise.all([
    chrome.storage.sync.get({
      serverUrl: DEFAULT_SERVER,
      searchWindowMode: "current",
      googleAuthUser: 0,
      googleAccounts: [0],
    }),
    chrome.storage.local.get({
      googleAccountProfiles: [],
      googleAccountsUpdatedAt: 0,
      googleAccountsLastError: "",
    }),
  ]);

  serverUrl = syncData.serverUrl;
  searchWindowMode = syncData.searchWindowMode;
  setInMemoryAccountState(syncData.googleAuthUser, syncData.googleAccounts);
  setInMemoryAccountProfiles(
    localData.googleAccountProfiles,
    localData.googleAccountsUpdatedAt
  );
  googleAccountsLastError = sanitizeText(localData.googleAccountsLastError);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync") {
    if (changes.serverUrl) {
      serverUrl = changes.serverUrl.newValue || DEFAULT_SERVER;
    }
    if (changes.searchWindowMode) {
      searchWindowMode = changes.searchWindowMode.newValue || "current";
    }
    if (changes.googleAuthUser != null || changes.googleAccounts) {
      setInMemoryAccountState(
        changes.googleAuthUser ? changes.googleAuthUser.newValue : googleAuthUser,
        changes.googleAccounts ? changes.googleAccounts.newValue : googleAccounts
      );
    }
    return;
  }

  if (area === "local") {
    if (changes.googleAccountProfiles || changes.googleAccountsUpdatedAt) {
      setInMemoryAccountProfiles(
        changes.googleAccountProfiles
          ? changes.googleAccountProfiles.newValue
          : googleAccountProfiles,
        changes.googleAccountsUpdatedAt
          ? changes.googleAccountsUpdatedAt.newValue
          : googleAccountsUpdatedAt
      );
    }
    if (changes.googleAccountsLastError) {
      googleAccountsLastError = sanitizeText(
        changes.googleAccountsLastError.newValue
      );
    }
  }
});

async function fetchServerHealth() {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), SERVER_HEALTH_TIMEOUT);

  try {
    const resp = await fetch(`${serverUrl}/health`, { signal: controller.signal });
    if (!resp.ok) {
      throw new Error(`Server returned ${resp.status}`);
    }
    return { ok: true, data: await resp.json() };
  } catch (error) {
    const message =
      error?.name === "AbortError"
        ? "Timed out contacting the local server"
        : error && typeof error.message === "string"
          ? error.message
          : "Failed to reach the local server";
    return { ok: false, error: message };
  } finally {
    clearTimeout(timeoutId);
  }
}

function buildSearchUrl(query, { fast = false, authuser = null, hl = null, gl = null, extra = "" } = {}) {
  let url = `https://www.google.com/search?q=${encodeURIComponent(query)}&udm=50`;
  if (!fast) url += "&arv=1";
  const au = resolveSearchAuthUser(authuser);
  url += `&authuser=${au}`;
  if (hl) url += `&hl=${encodeURIComponent(hl)}`;
  if (gl) url += `&gl=${encodeURIComponent(gl)}`;
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
      url: info.url ?? null,
      parkedAt: info.parkedAt ?? 0,
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
  await Promise.all([
    loadThreadTabs(),
    loadActiveTabs(),
    loadImageTabs(),
    loadStoredState(),
  ]);
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
  try {
    await chrome.alarms.clear(ALARM_NAME);
    await chrome.alarms.create(ALARM_NAME, {
      periodInMinutes: ALARM_WAKE_INTERVAL_MINUTES,
    });
  } catch (error) {
    console.warn(
      "Failed to create poll alarm; relying on setTimeout polling only",
      error
    );
  }
  // Alarms wake an idle MV3 worker, while setTimeout gives us faster polling
  // whenever the worker is already alive.
  pollServer();
}

async function pollServer() {
  await ensureInitialized();
  if (pollInFlight) return;
  pollInFlight = true;
  const pollStartedAt = Date.now();
  let nextPollDelay = POLL_INTERVAL;

  try {
    const resp = await fetch(`${serverUrl}/pending?wait=${LONG_POLL_WAIT_SECONDS}`, {
      signal: AbortSignal.timeout((LONG_POLL_WAIT_SECONDS + 5) * 1000),
    });
    if (resp.ok) {
      // A long-poll that was held by the server can be renewed at once; an
      // instant empty answer (older server, no long-poll) keeps the interval.
      nextPollDelay = Date.now() - pollStartedAt >= POLL_INTERVAL ? 0 : POLL_INTERVAL;
      const data = await resp.json();

      // Process thread closures first
      if (data.close_threads) {
        for (const threadId of data.close_threads) {
          await closeThread(threadId);
        }
      }
      if (pruneParkedThreads()) {
        await saveThreadTabs();
      }

      // Dispatch query
      if (data.query_id && data.query) {
        nextPollDelay = 0;
        if (data.pipeline === "image") {
          await handleImageQuery(data);
        } else if (data.type === "follow_up") {
          // Not awaited: a resumed tab can take seconds to accept the message.
          handleFollowUp(data).catch((error) => console.error("Follow-up failed", error));
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
  // If the service worker stays alive, polls follow each other back to back.
  // If it goes idle, the alarm wakes it back up on the normal MV3 cadence.
  setTimeout(pollServer, nextPollDelay);
}

// Per-query retry state for quota rotation:
// Map<queryId, { triedAuthUsers: Set<number>, triedFast: boolean, refreshedAccounts: boolean }>
const queryRetryState = new Map();

async function handleNewQuery(data, { fast = false, authuser = null } = {}) {
  await ensureInitialized();
  try {
    const effectiveAuthUser = resolveSearchAuthUser(authuser);
    const url = buildSearchUrl(data.query, {
      fast,
      authuser: effectiveAuthUser,
      hl: data.hl,
      gl: data.gl,
    });
    if (useOffscreen()) {
      await startOffscreenQuery(data, `${url}#_oq=${data.query_id}`, {
        authuser: effectiveAuthUser,
        fast,
      });
      return true;
    }
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

async function resumeParkedThread(threadId, threadInfo) {
  const tab = await chrome.tabs.create({ url: threadInfo.url + RESUME_HASH, active: false });
  const resumed = { ...threadInfo, tabId: tab.id, parkedAt: 0 };
  threadTabs.set(threadId, resumed);
  await saveThreadTabs();
  return resumed;
}

// The content script of a freshly opened tab starts listening only after
// document_idle, so retry until it accepts the message.
async function sendFollowUpWhenReady(tabId, message) {
  const deadline = Date.now() + RESUME_READY_TIMEOUT;
  for (;;) {
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

function pruneParkedThreads() {
  const now = Date.now();
  let changed = false;
  for (const [threadId, info] of threadTabs.entries()) {
    if (info.tabId === null && now - info.parkedAt > PARKED_THREAD_TTL) {
      threadTabs.delete(threadId);
      changed = true;
    }
  }
  return changed;
}

async function handleFollowUp(data) {
  await ensureInitialized();
  let threadInfo = threadTabs.get(data.thread_id);

  if (threadInfo && threadInfo.tabId === null && useOffscreen()) {
    try {
      await startOffscreenFollowUp(data, threadInfo);
    } catch (err) {
      await postResult(data.query_id, {
        markdown: "",
        citations: [],
        error: `thread_resume_failed: ${err.message}`,
      });
    }
    return;
  }

  if (threadInfo && threadInfo.tabId === null) {
    try {
      threadInfo = await resumeParkedThread(data.thread_id, threadInfo);
    } catch (err) {
      await postResult(data.query_id, {
        markdown: "",
        citations: [],
        error: `thread_resume_failed: ${err.message}`,
      });
      return;
    }
  }

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
    const response = await sendFollowUpWhenReady(threadInfo.tabId, {
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

function stripHash(url) {
  const hashAt = url.indexOf("#");
  return hashAt === -1 ? url : url.slice(0, hashAt);
}

async function closeThread(threadId) {
  await ensureInitialized();
  const threadInfo = threadTabs.get(threadId);
  // First close of a live tab parks the thread (the server keeps it resumable);
  // a close of an already parked thread means the server expired it. Offscreen
  // threads are parked as soon as their answer arrives, so the server's
  // close_thread that follows within seconds must not drop them.
  if (
    threadInfo &&
    threadInfo.tabId === null &&
    Date.now() - threadInfo.parkedAt < OFFSCREEN_PARK_GRACE
  ) {
    return;
  }
  let tabUrl = null;
  if (threadInfo && threadInfo.tabId !== null) {
    try {
      tabUrl = (await chrome.tabs.get(threadInfo.tabId)).url || null;
    } catch {
      // Tab may already be closed
    }
  }
  if (tabUrl && new URL(tabUrl).searchParams.get("udm") === "50") {
    threadTabs.set(threadId, {
      ...threadInfo,
      tabId: null,
      url: stripHash(tabUrl),
      parkedAt: Date.now(),
    });
  } else {
    threadTabs.delete(threadId);
  }
  await saveThreadTabs();
  if (threadInfo && threadInfo.tabId !== null) {
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
      let hl = null;
      let gl = null;
      try {
        const params = new URL(sender.tab.url).searchParams;
        hl = params.get("hl");
        gl = params.get("gl");
      } catch {
        // Ignore malformed URLs
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
        const refreshedAccounts = await refreshGoogleAccounts({ force: true });
        nextAccount = refreshedAccounts
          .map((account) => account.index)
          .find((idx) => !state.triedAuthUsers.has(idx));
      }
      if (nextAccount !== undefined && !entry.fast) {
        console.log(`Quota exhausted on authuser=${entry.authuser}, trying authuser=${nextAccount}`, entry.queryId);
        const reopened = await handleNewQuery(
          { query_id: entry.queryId, thread_id: entry.threadId, query, hl, gl },
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
          { query_id: entry.queryId, thread_id: entry.threadId, query, hl, gl },
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message?.type?.startsWith("POPUP_")) return;

  (async () => {
    await ensureInitialized();

    if (message.type === "POPUP_GET_STATE") {
      sendResponse({ ok: true, state: buildPopupState() });
      return;
    }

    if (message.type === "POPUP_GET_HEALTH") {
      const health = await fetchServerHealth();
      sendResponse({ ok: true, health });
      return;
    }

    if (message.type === "POPUP_REFRESH_ACCOUNTS") {
      await refreshGoogleAccounts({ force: true });
      sendResponse({ ok: true, state: buildPopupState() });
      return;
    }

    if (message.type === "POPUP_SELECT_ACCOUNT") {
      const nextAuthUser = normalizeAccountIndex(message.authuser, getDefaultAuthUser());
      const nextAccounts =
        googleAccountProfiles.length > 0
          ? googleAccountProfiles.map((account) => account.index)
          : googleAccounts;
      await persistAccountState(nextAuthUser, nextAccounts);
      sendResponse({ ok: true, state: buildPopupState() });
      return;
    }

    sendResponse({ ok: false, error: `Unsupported popup message: ${message.type}` });
  })().catch((error) => {
    sendResponse({
      ok: false,
      error: error && typeof error.message === "string" ? error.message : String(error),
    });
  });

  return true;
});

// --- Image generation pipeline ---
// Image tabs are fire-and-forget: no thread tracking, tab closes after result.
// The tabId -> queryId map is mirrored into session storage because the
// background context (MV3 worker / Firefox event page) can be suspended while
// Google is still generating; without it the finished image has nowhere to go.

async function saveImageTabs() {
  const obj = {};
  for (const [tabId, entry] of imageActiveTabs.entries()) {
    obj[tabId] = { queryId: entry.queryId, deadlineAt: entry.deadlineAt };
  }
  await chrome.storage.session.set({ imageActiveTabs: obj });
}

function scheduleImageTimeout(tabId, entry) {
  clearTimeout(entry.timeoutId);
  const delay = Math.max(0, entry.deadlineAt - Date.now());
  entry.timeoutId = setTimeout(async () => {
    if (imageActiveTabs.get(tabId) !== entry) return;
    imageActiveTabs.delete(tabId);
    await saveImageTabs().catch(() => {});
    await postImageResult(entry.queryId, {
      images: [],
      error: "image_generation_timeout",
    }).catch(() => {});
    try { await chrome.tabs.remove(tabId); } catch {}
  }, delay);
}

async function loadImageTabs() {
  const data = await chrome.storage.session.get("imageActiveTabs");
  for (const [tabIdRaw, persisted] of Object.entries(data.imageActiveTabs || {})) {
    const tabId = Number(tabIdRaw);
    if (!Number.isInteger(tabId) || !persisted?.queryId) continue;
    if (imageActiveTabs.has(tabId)) continue;
    const entry = {
      queryId: persisted.queryId,
      deadlineAt: Number(persisted.deadlineAt) || Date.now(),
      timeoutId: null,
    };
    imageActiveTabs.set(tabId, entry);
    scheduleImageTimeout(tabId, entry);
  }
}

async function handleImageQuery(data) {
  try {
    const url = buildSearchUrl(data.query, { extra: "#_img" });
    const tab = await chrome.tabs.create({ url, active: false });

    // Register in memory first so an early result from the content script
    // can never beat the bookkeeping, then persist.
    const entry = {
      queryId: data.query_id,
      deadlineAt: Date.now() + IMAGE_TAB_TIMEOUT,
      timeoutId: null,
    };
    imageActiveTabs.set(tab.id, entry);
    scheduleImageTimeout(tab.id, entry);
    await saveImageTabs();
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
    await ensureInitialized();
    const tabId = sender.tab.id;
    const entry = imageActiveTabs.get(tabId);
    if (!entry) {
      sendResponse({ received: false, error: "image_tab_not_found" });
      return;
    }

    clearTimeout(entry.timeoutId);
    imageActiveTabs.delete(tabId);
    await saveImageTabs().catch(() => {});
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
// Google sends suspected bots to /sorry/, where no content script runs, so the
// query fails at once instead of waiting for the tab timeout.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url?.startsWith("https://www.google.com/sorry/")) return;
  (async () => {
    await ensureInitialized();
    const entry = await clearActiveTab(tabId);
    if (!entry) return;
    clearQueryRetryState(entry.queryId);
    await postResult(entry.queryId, {
      markdown: "",
      citations: [],
      error: "google_captcha",
    }).catch(() => {});
  })().catch(() => {});
});

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
      await saveImageTabs().catch(() => {});
      await postImageResult(imgEntry.queryId, {
        images: [],
        error: "tab_closed_externally",
      }).catch(() => {});
    }
  })().catch(() => {});
});
