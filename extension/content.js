(() => {
  // Gate: only activate for AI Overview searches (udm=50)
  const params = new URLSearchParams(window.location.search);
  if (params.get("udm") !== "50") return;

  const STABILITY_DELAY = 3000;
  const MAX_WAIT = 25000;

  let followUpInProgress = false;

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

  function createTurndownService() {
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

    return td;
  }

  function extractCitations(container) {
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

    return citations;
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

    const td = createTurndownService();
    const markdown = td.turndown(clone.innerHTML).trim();
    const citations = extractCitations(container);

    return { markdown, citations };
  }

  function scrapeAndSend() {
    try {
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
    } catch (err) {
      chrome.runtime.sendMessage({
        type: "AI_OVERVIEW_RESULT",
        data: { markdown: "", citations: [], error: `extraction_error: ${err.message}` },
      });
    }
  }

  /**
   * Wait for DOM stability then call callback.
   * Returns a cancel function.
   */
  function waitForStability(callback, maxWait = MAX_WAIT) {
    let stabilityTimer = null;
    let maxTimer = null;
    let obs = null;
    let finished = false;

    function finish() {
      if (finished) return;
      finished = true;
      if (obs) obs.disconnect();
      clearTimeout(stabilityTimer);
      clearTimeout(maxTimer);
      callback();
    }

    function resetTimer() {
      clearTimeout(stabilityTimer);
      stabilityTimer = setTimeout(finish, STABILITY_DELAY);
    }

    obs = new MutationObserver(() => {
      resetTimer();
    });

    obs.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    // Start the stability timer (if page is already stable)
    resetTimer();

    // Absolute max wait
    maxTimer = setTimeout(finish, maxWait);

    // Return cancel function
    return () => {
      finished = true;
      if (obs) obs.disconnect();
      clearTimeout(stabilityTimer);
      clearTimeout(maxTimer);
    };
  }

  // --- Initial scrape ---
  waitForStability(() => scrapeAndSend());

  // --- Follow-up query handler ---
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type !== "FOLLOW_UP_QUERY") return;

    if (followUpInProgress) {
      sendResponse({ received: false, error: "follow_up_in_progress" });
      // Also send result so background.js can notify server immediately
      chrome.runtime.sendMessage({
        type: "AI_OVERVIEW_RESULT",
        data: { markdown: "", citations: [], error: "follow_up_in_progress" },
      });
      return;
    }

    followUpInProgress = true;
    handleFollowUp(message.query, message.queryId);
    sendResponse({ received: true });
  });

  async function handleFollowUp(query, queryId) {
    try {
      // 1. Find the follow-up input (textarea or contenteditable div)
      let textbox = findFollowUpInput();

      // If not visible, try clicking an expand/show-more button
      if (!textbox) {
        const buttons = document.querySelectorAll(
          'button, [role="button"], [tabindex="0"]'
        );
        for (const btn of buttons) {
          if (
            /follow.?up|ask.+question|show\s*more|ask\s*a/i.test(
              btn.textContent
            )
          ) {
            btn.click();
            await new Promise((r) => setTimeout(r, 1000));
            textbox = findFollowUpInput();
            break;
          }
        }
      }

      if (!textbox) {
        chrome.runtime.sendMessage({
          type: "AI_OVERVIEW_RESULT",
          data: {
            markdown: "",
            citations: [],
            error: "follow_up_textbox_not_found",
          },
        });
        return;
      }

      // 2. Snapshot current main-col count across the whole page.
      // Follow-ups may create a new aimc container (not just a new main-col
      // within the same container), so we search document-wide.
      const prevMainColCount = document.querySelectorAll(
        '[data-container-id="main-col"]'
      ).length;

      // 3. Type query into input
      textbox.focus();
      if (textbox.tagName === "TEXTAREA" || textbox.tagName === "INPUT") {
        // Native input: set value and fire input event
        const nativeSetter = Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype, "value"
        )?.set || Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype, "value"
        )?.set;
        if (nativeSetter) {
          nativeSetter.call(textbox, query);
        } else {
          textbox.value = query;
        }
        textbox.dispatchEvent(new Event("input", { bubbles: true }));
        textbox.dispatchEvent(new Event("change", { bubbles: true }));
      } else {
        // Contenteditable div
        textbox.innerHTML = "";
        document.execCommand("insertText", false, query);
      }

      // Small delay for UI to react (e.g. show submit button)
      await new Promise((r) => setTimeout(r, 300));

      // 4. Submit: find nearby submit button or press Enter
      const submitted = await submitFollowUp(textbox);
      if (!submitted) {
        chrome.runtime.sendMessage({
          type: "AI_OVERVIEW_RESULT",
          data: {
            markdown: "",
            citations: [],
            error: "follow_up_submit_failed",
          },
        });
        return;
      }

      // 5. Wait for Google to start streaming the response
      await new Promise((r) => setTimeout(r, 800));

      // 6. Wait for stability then scrape
      waitForStability(() => {
        // Google creates a new aimc container (and main-col) for each
        // follow-up. Search document-wide, not scoped to one container.
        const allMainCols = document.querySelectorAll(
          '[data-container-id="main-col"]'
        );

        if (allMainCols.length === 0) {
          chrome.runtime.sendMessage({
            type: "AI_OVERVIEW_RESULT",
            data: {
              markdown: "",
              citations: [],
              error: "no_ai_overview_after_follow_up",
            },
          });
          followUpInProgress = false;
          return;
        }
        let result;

        if (allMainCols.length > prevMainColCount) {
          // New main-col appeared — extract only from it
          const newMainCol = allMainCols[allMainCols.length - 1];
          const tempContainer = newMainCol.cloneNode(true);

          // Apply same cleanup as extractContent
          tempContainer
            .querySelectorAll(
              '[data-dtype], button, [role="button"], svg, [data-subtree="aimba"]'
            )
            .forEach((el) => el.remove());
          tempContainer
            .querySelectorAll('img[src^="data:"]')
            .forEach((el) => el.remove());

          // Remove source card clusters and feedback from wrapper children
          const wrapper = tempContainer.children[0] || tempContainer;
          const toRemove = [];
          for (const child of wrapper?.children || []) {
            const links = child.querySelectorAll("a").length;
            const imgs = child.querySelectorAll("img").length;
            if (links > 3 && imgs > 3) {
              toRemove.push(child);
              continue;
            }
            if (child.querySelector('a[href*="policies.google.com"]')) {
              toRemove.push(child);
            }
          }
          toRemove.forEach((el) => el.remove());

          // Remove first heading (follow-up question echo)
          const firstH = tempContainer.querySelector(
            'h2, h3, [role="heading"]'
          );
          if (firstH) firstH.remove();

          const td = createTurndownService();
          const markdown = td.turndown(tempContainer.innerHTML).trim();
          // Get citations from the last aimc container
          const allAimcs = document.querySelectorAll('[data-subtree="aimc"]');
          const lastAimc = allAimcs[allAimcs.length - 1];
          const citations = extractCitations(lastAimc || document.body);
          result = { markdown, citations, error: null };
        } else {
          // Fallback: extract from the last main-col
          const lastMainCol = allMainCols[allMainCols.length - 1];
          const lastAimcContainer = lastMainCol.closest('[data-subtree="aimc"]') || findAIOverviewContainer();
          result = extractContent(lastAimcContainer);
          result.error = null;
        }

        chrome.runtime.sendMessage({
          type: "AI_OVERVIEW_RESULT",
          data: result,
        });
        followUpInProgress = false;
      });
    } catch (err) {
      chrome.runtime.sendMessage({
        type: "AI_OVERVIEW_RESULT",
        data: {
          markdown: "",
          citations: [],
          error: `follow_up_error: ${err.message}`,
        },
      });
      followUpInProgress = false;
    }
  }

  function findFollowUpInput() {
    // Strategy 1: textarea with relevant placeholder/label
    const textarea = document.querySelector(
      'textarea[placeholder*="Ask" i], textarea[aria-label*="Ask" i], textarea[placeholder*="follow" i]'
    );
    if (textarea && textarea.offsetParent !== null) return textarea;

    // Strategy 2: contenteditable div with textbox role
    const contentEditable = document.querySelector(
      'div[role="textbox"][contenteditable="true"]'
    );
    if (contentEditable && contentEditable.offsetParent !== null)
      return contentEditable;

    // Strategy 3: any visible textarea inside the AI overview area
    const container = findAIOverviewContainer();
    if (container) {
      const ta = container.querySelector("textarea");
      if (ta && ta.offsetParent !== null) return ta;
    }

    return null;
  }

  async function submitFollowUp(textbox) {
    // Strategy 1: find a Send/Submit button nearby (walk up a few levels)
    let parent = textbox.parentElement;
    for (let i = 0; i < 5 && parent; i++) {
      const sendBtn = parent.querySelector(
        'button[aria-label*="Send" i], button[aria-label*="Submit" i], button[type="submit"]'
      );
      if (sendBtn) {
        sendBtn.click();
        return true;
      }
      parent = parent.parentElement;
    }

    // Strategy 2: find a form and submit it
    const form = textbox.closest("form");
    if (form) {
      const formBtn = form.querySelector("button");
      if (formBtn) {
        formBtn.click();
        return true;
      }
    }

    // Strategy 3: look for any nearby button with SVG icon (common submit pattern)
    parent = textbox.parentElement?.parentElement?.parentElement;
    if (parent) {
      const buttons = parent.querySelectorAll("button");
      for (const btn of buttons) {
        if (/cancel|close|clear/i.test(btn.textContent)) continue;
        if (btn.querySelector("svg") || btn.textContent.trim() === "") {
          btn.click();
          return true;
        }
      }
    }

    // Strategy 4: dispatch Enter key
    textbox.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
        bubbles: true,
      })
    );
    return true;
  }
})();
