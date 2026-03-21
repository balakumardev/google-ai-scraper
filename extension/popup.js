const GOOGLE_ACCOUNT_SCAN_LIMIT = 10;

async function fetchGoogleAccounts() {
  // Find or create a google.com tab to make same-origin fetches
  let tab;
  let createdTab = false;
  const tabs = await chrome.tabs.query({ url: "https://www.google.com/*" });
  if (tabs.length > 0) {
    tab = tabs[0];
  } else {
    tab = await chrome.tabs.create({ url: "https://www.google.com/", active: false });
    createdTab = true;
    await new Promise((resolve) => {
      const listener = (tabId, info) => {
        if (tabId === tab.id && info.status === "complete") {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      setTimeout(resolve, 8000);
    });
  }

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
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
              const match = label.match(
                /Google Account:\s*(.*?)(?:\s*(?:\n|\r)\(|$)/i
              );
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
            photo =
              (photoEl.getAttribute("src") || photoEl.getAttribute("data-src") || "")
                .trim();
          }

          if (!email) return null;
          return { index, email, name, photo };
        }

        const accounts = [];
        const seen = new Set();
        for (let i = 0; i < scanLimit; i++) {
          try {
            const resp = await fetch(`https://www.google.com/search?q=test&authuser=${i}`, {
              credentials: "include",
              redirect: "follow",
            });
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

    return results[0]?.result || [];
  } finally {
    if (createdTab) {
      try { await chrome.tabs.remove(tab.id); } catch {}
    }
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  const content = document.getElementById("content");
  const status = document.getElementById("status");

  content.innerHTML = '<div class="loading">Detecting accounts…</div>';

  let accounts;
  try {
    accounts = await fetchGoogleAccounts();
  } catch (err) {
    content.innerHTML = `<div class="loading error">${err.message}</div>`;
    return;
  }

  if (accounts.length === 0) {
    content.innerHTML = `<div class="loading error">No Google accounts found. Sign in to Google first.</div>`;
    return;
  }

  // Persist full account list for background.js quota rotation
  const uniqueAccounts = [...new Map(accounts.map((account) => [account.email, account])).values()]
    .sort((a, b) => a.index - b.index);
  const accountIndices = uniqueAccounts.map((account) => account.index);

  const { googleAuthUser } = await chrome.storage.sync.get({ googleAuthUser: 0 });
  const initialAuthUser = accountIndices.includes(googleAuthUser)
    ? googleAuthUser
    : accountIndices[0];
  await chrome.storage.sync.set({
    googleAuthUser: initialAuthUser,
    googleAccounts: accountIndices,
  });

  const list = document.createElement("ul");
  list.className = "account-list";

  for (const acct of uniqueAccounts) {
    const li = document.createElement("li");
    if (acct.index === initialAuthUser) li.classList.add("selected");

    const avatar = document.createElement("div");
    avatar.className = "avatar";
    if (acct.photo) {
      const img = document.createElement("img");
      img.src = acct.photo;
      img.referrerPolicy = "no-referrer";
      avatar.appendChild(img);
    } else {
      avatar.textContent = (acct.name || acct.email || "?")[0].toUpperCase();
    }

    const info = document.createElement("div");
    info.className = "account-info";
    const name = document.createElement("div");
    name.className = "account-name";
    name.textContent = acct.name || acct.email;
    const email = document.createElement("div");
    email.className = "account-email";
    email.textContent = acct.email;
    info.appendChild(name);
    info.appendChild(email);

    li.appendChild(avatar);
    li.appendChild(info);

    li.addEventListener("click", async () => {
      list.querySelectorAll("li").forEach((el) => el.classList.remove("selected"));
      li.classList.add("selected");
      await chrome.storage.sync.set({ googleAuthUser: acct.index });
      status.textContent = `Using ${acct.email}`;
      setTimeout(() => { status.textContent = ""; }, 2000);
    });

    list.appendChild(li);
  }

  content.innerHTML = "";
  content.appendChild(list);
});
