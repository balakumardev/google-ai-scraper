// Run: node tests/background-restart.test.js [path/to/background.js]
// Simulates the background context being suspended and restarted between
// "image tab opened" and "content script posts the finished image".
const vm = require("vm"), fs = require("fs");
const file = process.argv[2] || require("path").join(__dirname, "../extension/background.js");
const code = fs.readFileSync(file, "utf8");

const sessionStore = {}, localStore = {};
const posted = [];
function makeCtx() {
  const listeners = { message: [], removed: [] };
  const mk = (store) => ({
    get: async (k) => (typeof k === "string" ? (k in store ? { [k]: JSON.parse(JSON.stringify(store[k])) } : {}) : JSON.parse(JSON.stringify(store))),
    set: async (o) => { Object.assign(store, JSON.parse(JSON.stringify(o))); },
    remove: async () => {},
  });
  const ev = (name) => ({ addListener: (f) => listeners[name]?.push(f) });
  let nextTab = 100;
  const chrome = {
    storage: { session: mk(sessionStore), local: mk(localStore), sync: mk({}), onChanged: { addListener() {} } },
    alarms: { create: async () => {}, clear: async () => {}, onAlarm: { addListener() {} } },
    tabs: { create: async () => ({ id: nextTab++ }), remove: async () => {}, onRemoved: ev("removed"), get: async () => ({}), query: async () => [], sendMessage: async () => ({}) },
    runtime: { onMessage: ev("message"), lastError: null, getManifest: () => ({}), onInstalled: { addListener() {} }, onStartup: { addListener() {} } },
    scripting: { executeScript: async () => [] },
  };
  const fetch = async (url, opts) => {
    if (String(url).includes("/image_result/")) posted.push({ url: String(url), body: JSON.parse(opts.body) });
    return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
  };
  const ctx = vm.createContext({ chrome, fetch, console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, setInterval, clearInterval, URL, URLSearchParams, Intl, Date, Promise, JSON, Math, AbortController, TextEncoder, TextDecoder });
  vm.runInContext(code, ctx, { filename: file });
  return { ctx, listeners };
}
const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const A = makeCtx();
  await tick();
  await vm.runInContext('handleImageQuery({query_id:"q1", query:"a cat"})', A.ctx);
  // context "dies"; a fresh one starts with only the persisted storage
  const B = makeCtx();
  await tick(100);
  let resp;
  await new Promise((resolve) => {
    for (const l of B.listeners.message) {
      const r = l({ type: "AI_IMAGE_RESULT", data: { images: ["data:image/png;base64,AAA"], error: null } }, { tab: { id: 100 } }, (x) => { resp = x; resolve(); });
      if (r === true) return;
    }
    setTimeout(resolve, 500);
  });
  console.log(file.split("/").slice(-2).join("/"), "->", JSON.stringify(resp), "posted:", posted.length, posted[0]?.url?.split("/").pop());
  process.exit(0);
})();
