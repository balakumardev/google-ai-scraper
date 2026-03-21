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
      func: async () => {
        const accounts = [];
        // Probe authuser=0 through 9, stop at first miss
        for (let i = 0; i < 10; i++) {
          try {
            const resp = await fetch(`https://www.google.com/search?q=test&authuser=${i}`, {
              credentials: "include",
              redirect: "follow",
            });
            const html = await resp.text();

            // Look for email in the page — Google embeds it in aria-labels
            // Pattern: "Google Account: Name\n(email@example.com)"
            let email = null;
            let name = "";
            let photo = "";

            // Pattern 1: aria-label with email
            const ariaMatch = html.match(/aria-label="Google Account:\s*([^"]*?)\\n\(([^)]+@[^)]+)\)"/);
            if (ariaMatch) {
              name = ariaMatch[1].trim();
              email = ariaMatch[2].trim();
            }

            // Pattern 2: data-email attribute
            if (!email) {
              const dataMatch = html.match(/data-email="([^"]+@[^"]+)"/);
              if (dataMatch) email = dataMatch[1];
            }

            // Pattern 3: look for email in OGB account info
            if (!email) {
              const ogbMatch = html.match(/[\w.+-]+@(?:gmail\.com|googlemail\.com|[\w.-]+\.[\w]+)/);
              if (ogbMatch) email = ogbMatch[0];
            }

            if (!email) {
              // No account for this index — might mean no more accounts,
              // but could also be a different page layout. Try one more.
              if (accounts.length > 0) break;
              continue;
            }

            // Extract photo URL
            const photoMatch = html.match(/data-src="(https:\/\/lh3\.googleusercontent\.com\/[^"]+)"/);
            if (photoMatch) photo = photoMatch[1];

            if (!accounts.find(a => a.email === email)) {
              accounts.push({ index: i, email, name, photo });
            } else {
              // Same account as before — no more unique accounts
              break;
            }
          } catch {
            break;
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
  await chrome.storage.sync.set({ googleAccounts: accounts.map(a => a.index) });

  const { googleAuthUser } = await chrome.storage.sync.get({ googleAuthUser: 0 });

  const list = document.createElement("ul");
  list.className = "account-list";

  for (const acct of accounts) {
    const li = document.createElement("li");
    if (acct.index === googleAuthUser) li.classList.add("selected");

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
