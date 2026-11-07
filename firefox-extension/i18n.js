// UI strings come from _locales; Chrome picks the browser's language.
// A missing message shows its key, so gaps stay visible.
function t(key, substitutions) {
  return chrome.i18n.getMessage(key, substitutions) || key;
}

function tPlural(baseKey, count) {
  const form = new Intl.PluralRules(chrome.i18n.getUILanguage()).select(count);
  return t(`${baseKey}_${form}`, [String(count)]);
}

function applyI18n(root = document) {
  for (const el of root.querySelectorAll("[data-i18n]")) {
    el.textContent = t(el.dataset.i18n);
  }
  for (const el of root.querySelectorAll("[data-i18n-title]")) {
    el.title = t(el.dataset.i18nTitle);
  }
}

document.addEventListener("DOMContentLoaded", () => applyI18n());
