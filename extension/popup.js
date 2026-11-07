const statusMessageTimers = [];

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || t("unknownPopupError")));
        return;
      }
      resolve(response);
    });
  });
}

function formatRelativeTime(timestamp) {
  if (!timestamp) {
    return t("noCacheYet");
  }

  const diffMs = timestamp - Date.now();
  const diffMinutes = Math.round(diffMs / 60000);
  const diffHours = Math.round(diffMs / 3600000);
  const diffDays = Math.round(diffMs / 86400000);
  const formatter = new Intl.RelativeTimeFormat(chrome.i18n.getUILanguage(), { numeric: "auto" });

  if (Math.abs(diffMinutes) < 1) {
    return t("updatedJustNow");
  }
  if (Math.abs(diffMinutes) < 60) {
    return t("updatedAgo", [formatter.format(diffMinutes, "minute")]);
  }
  if (Math.abs(diffHours) < 24) {
    return t("updatedAgo", [formatter.format(diffHours, "hour")]);
  }
  return t("updatedAgo", [formatter.format(diffDays, "day")]);
}

function getHealthPresentation(health) {
  if (!health) {
    return {
      tone: "checking",
      label: t("checkingServer"),
    };
  }

  if (!health.ok) {
    return {
      tone: "disconnected",
      label: health.error || t("serverUnreachable"),
    };
  }

  const data = health.data || {};
  const extensionStatus = data.extension_status || (data.extension_connected ? "connected" : "stale");

  if (extensionStatus === "connected") {
    return {
      tone: "connected",
      label: data.last_poll_age_seconds != null
        ? t("connectedPolled", [String(data.last_poll_age_seconds)])
        : t("connected"),
    };
  }

  if (extensionStatus === "never_seen") {
    return {
      tone: "warning",
      label: t("waitingExtension"),
    };
  }

  return {
    tone: "warning",
    label: data.last_poll_age_seconds != null
      ? t("extensionIdle", [String(data.last_poll_age_seconds)])
      : t("extensionNotCheckedIn"),
  };
}

function clearStatusMessages() {
  while (statusMessageTimers.length > 0) {
    clearTimeout(statusMessageTimers.pop());
  }
}

function setStatusMessage(text, tone = "neutral", autoClear = false) {
  const statusEl = document.getElementById("status");
  statusEl.textContent = text || "";
  statusEl.className = `status-message tone-${tone}`;

  clearStatusMessages();
  if (autoClear && text) {
    statusMessageTimers.push(
      setTimeout(() => {
        statusEl.textContent = "";
        statusEl.className = "status-message tone-neutral";
      }, 2400)
    );
  }
}

function buildAvatar(account) {
  const avatar = document.createElement("div");
  avatar.className = "avatar";

  if (account.photo) {
    const img = document.createElement("img");
    img.src = account.photo;
    img.alt = "";
    img.referrerPolicy = "no-referrer";
    avatar.appendChild(img);
  } else {
    avatar.textContent = (account.name || account.email || "?").slice(0, 1).toUpperCase();
  }

  return avatar;
}

function renderSummary(state) {
  const summaryCard = document.getElementById("summaryCard");
  const selectedAvatar = document.getElementById("selectedAvatar");
  const selectedName = document.getElementById("selectedName");
  const selectedEmail = document.getElementById("selectedEmail");
  const summaryMeta = document.getElementById("summaryMeta");
  const selected = state.selectedAccount;

  if (!selected) {
    summaryCard.hidden = true;
    return;
  }

  summaryCard.hidden = false;
  const avatarNode = buildAvatar(selected);
  selectedAvatar.replaceChildren(...avatarNode.childNodes);
  selectedName.textContent = selected.name || selected.email;
  selectedEmail.textContent = selected.email;
  summaryMeta.textContent = tPlural("accountsCount", state.accounts.length);
}

function renderBanner(state) {
  const banner = document.getElementById("banner");
  if (!state.accountsLastError) {
    banner.hidden = true;
    banner.textContent = "";
    return;
  }

  banner.hidden = false;
  banner.textContent = state.accountsLastError;
}

function renderHealth(health) {
  const dot = document.getElementById("statusDot");
  const label = document.getElementById("connectionLabel");
  const presentation = getHealthPresentation(health);
  dot.className = `status-dot ${presentation.tone}`;
  label.textContent = presentation.label;
}

function renderRefreshButton(state) {
  const btn = document.getElementById("refreshButton");
  btn.disabled = state.isRefreshingAccounts;
  if (state.isRefreshingAccounts) {
    btn.classList.add("spinning");
  } else {
    btn.classList.remove("spinning");
  }
}

async function selectAccount(account) {
  const response = await sendRuntimeMessage({
    type: "POPUP_SELECT_ACCOUNT",
    authuser: account.index,
  });
  return response.state;
}

function renderAccounts(state, onSelect) {
  const content = document.getElementById("content");
  content.textContent = "";

  if (state.isRefreshingAccounts && !state.accounts.length) {
    content.innerHTML = `
      <div class="skeleton-list">
        <div class="skeleton-item"><div class="skeleton-avatar"></div><div class="skeleton-lines"><div class="skeleton-line"></div><div class="skeleton-line"></div></div></div>
        <div class="skeleton-item"><div class="skeleton-avatar"></div><div class="skeleton-lines"><div class="skeleton-line"></div><div class="skeleton-line"></div></div></div>
        <div class="skeleton-item"><div class="skeleton-avatar"></div><div class="skeleton-lines"><div class="skeleton-line"></div><div class="skeleton-line"></div></div></div>
      </div>
    `;
    return;
  }

  if (!state.accounts.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML = `
      <div class="empty-title" data-i18n="noAccountsTitle"></div>
      <div class="empty-copy" data-i18n="noAccountsCopy"></div>
    `;
    applyI18n(empty);
    content.appendChild(empty);
    return;
  }

  const list = document.createElement("ul");
  list.className = "account-list";

  for (const account of state.accounts) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = `account-card${account.index === state.authuser ? " selected" : ""}`;
    button.setAttribute("aria-pressed", String(account.index === state.authuser));

    const avatar = buildAvatar(account);
    const info = document.createElement("div");
    info.className = "account-copy";

    const title = document.createElement("div");
    title.className = "account-name";
    title.textContent = account.name || account.email;

    const subtitle = document.createElement("div");
    subtitle.className = "account-email";
    subtitle.textContent = account.email;

    info.appendChild(title);
    info.appendChild(subtitle);

    const badge = document.createElement("span");
    badge.className = "account-badge";
    badge.textContent = account.index === state.authuser ? t("badgeActive") : `authuser=${account.index}`;

    button.appendChild(avatar);
    button.appendChild(info);
    button.appendChild(badge);

    button.addEventListener("click", async () => {
      try {
        const nextState = await onSelect(account);
        window.popupState = nextState;
        renderAll();
        setStatusMessage(t("usingAccount", [account.email]), "success", true);
      } catch (error) {
        setStatusMessage(error.message, "error");
      }
    });

    item.appendChild(button);
    list.appendChild(item);
  }

  content.appendChild(list);
}

function renderAll() {
  const state = window.popupState;
  const health = window.popupHealth;
  if (!state) return;

  renderSummary(state);
  renderBanner(state);
  renderHealth(health);
  renderRefreshButton(state);
  renderAccounts(state, selectAccount);
}

async function refreshHealth() {
  try {
    const response = await sendRuntimeMessage({ type: "POPUP_GET_HEALTH" });
    window.popupHealth = response.health;
  } catch (error) {
    window.popupHealth = { ok: false, error: error.message };
  }
  renderAll();
}

async function refreshAccounts({ showSuccessMessage = false } = {}) {
  try {
    window.popupState = {
      ...window.popupState,
      isRefreshingAccounts: true,
    };
    renderAll();
    setStatusMessage(t("refreshingAccounts"), "neutral");

    const response = await sendRuntimeMessage({ type: "POPUP_REFRESH_ACCOUNTS" });
    window.popupState = response.state;
    renderAll();

    if (showSuccessMessage) {
      const successText = window.popupState.accounts.length
        ? t("accountsRefreshed")
        : t("noAccountsFound");
      setStatusMessage(successText, "success", true);
    } else {
      setStatusMessage("");
    }
  } catch (error) {
    setStatusMessage(error.message, "error");
  } finally {
    window.popupState = {
      ...window.popupState,
      isRefreshingAccounts: false,
    };
    renderAll();
    await refreshHealth();
  }
}

async function loadInitialState() {
  setStatusMessage(t("loadingAccounts"), "neutral");

  const response = await sendRuntimeMessage({ type: "POPUP_GET_STATE" });
  window.popupState = response.state;
  window.popupHealth = null;
  renderAll();

  void refreshHealth();

  if (!window.popupState.accounts.length) {
    await refreshAccounts();
  } else {
    setStatusMessage("");
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  document.getElementById("refreshButton").addEventListener("click", async () => {
    await refreshAccounts({ showSuccessMessage: true });
  });

  document.getElementById("settingsButton").addEventListener("click", async () => {
    await chrome.runtime.openOptionsPage();
  });

  try {
    await loadInitialState();
  } catch (error) {
    window.popupState = {
      authuser: 0,
      accounts: [],
      selectedAccount: null,
      accountsUpdatedAt: null,
      accountsLastError: error.message,
      accountsStale: true,
      isRefreshingAccounts: false,
      serverUrl: "",
    };
    window.popupHealth = { ok: false, error: error.message };
    renderAll();
    setStatusMessage(error.message, "error");
  }
});
