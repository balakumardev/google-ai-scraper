(() => {
  // Gate: only activate for AI Overview searches (udm=50)
  const params = new URLSearchParams(window.location.search);
  if (params.get("udm") !== "50") return;

  const STABILITY_DELAY = 3000;
  const MAX_WAIT = 25000;

  function findAIOverviewContainer() {
    // Strategy 1: data attributes
    const byAttr =
      document.querySelector('[data-subtree="aimc"]') ||
      document.querySelector('[data-attrid="ai_overview"]');
    if (byAttr) return byAttr;

    // Strategy 2: heading text walk-up
    const headings = document.querySelectorAll("h2, h3, [role='heading']");
    for (const h of headings) {
      if (/ai overview/i.test(h.textContent)) {
        // Walk up to find a content-rich ancestor
        let node = h.parentElement;
        for (let i = 0; i < 5 && node; i++) {
          if (node.querySelectorAll("p, li, span").length >= 3) return node;
          node = node.parentElement;
        }
        // Fallback: return direct parent
        return h.parentElement;
      }
    }

    // Strategy 3: TreeWalker text scan
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: (n) =>
          /ai overview/i.test(n.textContent)
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_REJECT,
      }
    );
    const textNode = walker.nextNode();
    if (textNode) {
      let node = textNode.parentElement;
      for (let i = 0; i < 8 && node; i++) {
        if (node.querySelectorAll("p, li, span").length >= 3) return node;
        node = node.parentElement;
      }
    }

    return null;
  }

  function extractContent(container) {
    // Use main-col for markdown (AI response only), fall back to full container
    const mainCol = container.querySelector('[data-container-id="main-col"]');
    const contentSource = mainCol || container;
    const clone = contentSource.cloneNode(true);

    // Strip UI elements: buttons, SVGs, badges
    clone
      .querySelectorAll('[data-dtype], button, [role="button"], svg')
      .forEach((el) => el.remove());

    // Remove inline source attribution blocks
    clone
      .querySelectorAll('[data-subtree="aimba"]')
      .forEach((el) => el.remove());

    // Remove source card clusters and feedback section from wrapper children
    // Walk the wrapper's direct children to avoid removing parent containers
    const wrapper = clone.querySelector('[data-container-id="main-col"]')
      ? clone.querySelector('[data-container-id="main-col"]').children[0]
      : clone.children[0] || clone;
    const toRemove = [];
    for (const child of wrapper?.children || []) {
      const links = child.querySelectorAll("a").length;
      const imgs = child.querySelectorAll("img").length;
      // Source card clusters: many links + images, little unique text
      if (links > 3 && imgs > 3) {
        toRemove.push(child);
        continue;
      }
      // Feedback/privacy section
      if (child.querySelector('a[href*="policies.google.com"]')) {
        toRemove.push(child);
      }
    }
    toRemove.forEach((el) => el.remove());

    // Remove base64 placeholder images (1x1 transparent GIFs used for math)
    clone.querySelectorAll('img[src^="data:"]').forEach((el) => el.remove());

    // Remove only the first heading (query title), keep section headings
    const firstHeading = clone.querySelector('h2, h3, [role="heading"]');
    if (firstHeading) firstHeading.remove();

    // Convert to Markdown using Turndown
    const td = new TurndownService({
      headingStyle: "atx",
      bulletListMarker: "-",
      codeBlockStyle: "fenced",
    });

    // Custom rule: convert [role="heading"] divs/spans to markdown headings
    td.addRule("roleHeadings", {
      filter: (node) =>
        node.getAttribute && node.getAttribute("role") === "heading",
      replacement: (content) => {
        const text = content.trim();
        if (!text) return "";
        return `\n\n### ${text}\n\n`;
      },
    });

    // Custom rule: skip base64/data images
    td.addRule("skipDataImages", {
      filter: (node) =>
        node.nodeName === "IMG" &&
        (node.getAttribute("src") || "").startsWith("data:"),
      replacement: () => "",
    });

    // Custom rule: clean Google redirect links
    td.addRule("googleLinks", {
      filter: (node) => node.nodeName === "A" && node.getAttribute("href"),
      replacement: (content, node) => {
        let href = node.getAttribute("href") || "";
        // Unwrap Google redirect
        if (href.startsWith("/url?")) {
          try {
            const u = new URL(href, "https://www.google.com");
            href = u.searchParams.get("q") || href;
          } catch {
            // keep as-is
          }
        }
        // Skip internal Google links with no useful href
        if (href.startsWith("/search") || href.startsWith("#")) {
          return content;
        }
        return `[${content}](${href})`;
      },
    });

    const markdown = td.turndown(clone.innerHTML).trim();

    // Extract citations from the full container (includes source cards)
    const links = container.querySelectorAll("a[href]");
    const seen = new Set();
    const citations = [];

    for (const a of links) {
      let href = a.getAttribute("href");
      if (!href) continue;
      // Unwrap Google redirect
      if (href.startsWith("/url?")) {
        try {
          const u = new URL(href, "https://www.google.com");
          href = u.searchParams.get("q") || href;
        } catch {
          continue;
        }
      }
      // Filter out internal/junk links
      if (
        !href ||
        href.startsWith("/") ||
        href.startsWith("#") ||
        href.includes("google.com/search") ||
        href.includes("accounts.google.com") ||
        href.includes("policies.google.com") ||
        href.startsWith("data:") ||
        href.length < 10
      ) {
        continue;
      }
      // Strip Google text fragments for cleaner URLs
      const clean = href.replace(/#:~:text=.*$/, "");
      if (!seen.has(clean)) {
        seen.add(clean);
        citations.push(clean);
      }
    }

    return { markdown, citations };
  }

  function scrapeAndSend() {
    const container = findAIOverviewContainer();
    if (!container) {
      chrome.runtime.sendMessage({
        type: "AI_OVERVIEW_RESULT",
        data: { markdown: "", citations: [], error: "no_ai_overview" },
      });
      return;
    }

    const { markdown, citations } = extractContent(container);
    chrome.runtime.sendMessage({
      type: "AI_OVERVIEW_RESULT",
      data: { markdown, citations, error: null },
    });
  }

  // Wait for streaming to complete using MutationObserver
  let stabilityTimer = null;
  let maxTimer = null;
  let observer = null;
  let done = false;

  function finish() {
    if (done) return;
    done = true;
    if (observer) observer.disconnect();
    clearTimeout(stabilityTimer);
    clearTimeout(maxTimer);
    scrapeAndSend();
  }

  function resetStabilityTimer() {
    clearTimeout(stabilityTimer);
    stabilityTimer = setTimeout(finish, STABILITY_DELAY);
  }

  observer = new MutationObserver(() => {
    resetStabilityTimer();
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  // Start the stability timer (if page is already stable)
  resetStabilityTimer();

  // Absolute max wait
  maxTimer = setTimeout(finish, MAX_WAIT);
})();
