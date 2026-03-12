const DEFAULT_URL = "http://localhost:15551";

document.addEventListener("DOMContentLoaded", async () => {
  const input = document.getElementById("serverUrl");
  const { serverUrl } = await chrome.storage.sync.get({ serverUrl: DEFAULT_URL });
  input.value = serverUrl;

  document.getElementById("save").addEventListener("click", async () => {
    const url = input.value.trim().replace(/\/+$/, "") || DEFAULT_URL;
    input.value = url;
    await chrome.storage.sync.set({ serverUrl: url });
    const status = document.getElementById("status");
    status.textContent = "Saved";
    setTimeout(() => { status.textContent = ""; }, 1500);
  });
});
