const DEFAULT_URL = "http://localhost:15551";

document.addEventListener("DOMContentLoaded", async () => {
  const input = document.getElementById("serverUrl");
  const searchWindowMode = document.getElementById("searchWindowMode");
  const stored = await chrome.storage.sync.get({
    serverUrl: DEFAULT_URL,
    searchWindowMode: "current",
  });
  input.value = stored.serverUrl;
  searchWindowMode.value = stored.searchWindowMode;

  document.getElementById("save").addEventListener("click", async () => {
    const url = input.value.trim().replace(/\/+$/, "") || DEFAULT_URL;
    input.value = url;
    await chrome.storage.sync.set({
      serverUrl: url,
      searchWindowMode: searchWindowMode.value,
    });
    const status = document.getElementById("status");
    status.classList.add("visible");
    setTimeout(() => status.classList.remove("visible"), 1500);
  });
});
