(() => {
  // Gate: only activate for AI Overview searches (udm=50)
  const params = new URLSearchParams(window.location.search);
  if (params.get("udm") !== "50") return;

  // --- Image generation pipeline (separate from text) ---
  if (window.location.hash === "#_img") {
    const IMAGE_MAX_WAIT = 160000; // 160s — image generation takes 1-2 min
    const IMAGE_POLL_INTERVAL = 2000;
    const IMAGE_STABILITY_DELAY = 5000;

    function findGeneratedImages() {
      const imgs = document.querySelectorAll('img[alt="AI generated image"]');
      return Array.from(imgs).filter((img) => img.naturalWidth > 0);
    }

    async function fetchImageAsBase64(img) {
      const resp = await fetch(img.src, { credentials: "include" });
      if (!resp.ok) return null;
      const blob = await resp.blob();
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(blob);
      });
    }

    async function extractAndSendImages() {
      let lastCount = 0;
      let stableTimer = null;
      let finished = false;

      const finish = async (imgs) => {
        if (finished) return;
        finished = true;
        clearInterval(pollTimer);
        clearTimeout(maxTimer);
        clearTimeout(stableTimer);
        if (obs) obs.disconnect();

        if (imgs.length === 0) {
          chrome.runtime.sendMessage({
            type: "AI_IMAGE_RESULT",
            data: { images: [], error: "no_generated_image" },
          });
          return;
        }

        const base64Images = [];
        for (const img of imgs) {
          const data = await fetchImageAsBase64(img);
          if (data) base64Images.push(data);
        }

        chrome.runtime.sendMessage({
          type: "AI_IMAGE_RESULT",
          data: {
            images: base64Images,
            error: base64Images.length === 0 ? "image_fetch_failed" : null,
          },
        });
      };

      const attempt = () => {
        if (finished) return;
        const imgs = findGeneratedImages();
        if (imgs.length > 0 && imgs.length !== lastCount) {
          lastCount = imgs.length;
          clearTimeout(stableTimer);
          stableTimer = setTimeout(() => finish(imgs), IMAGE_STABILITY_DELAY);
        } else if (imgs.length > 0 && imgs.length === lastCount) {
          // Same count — stability timer already running
        }
      };

      const obs = new MutationObserver(attempt);
      obs.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["src"],
      });

      const pollTimer = setInterval(attempt, IMAGE_POLL_INTERVAL);
      const maxTimer = setTimeout(() => {
        const imgs = findGeneratedImages();
        finish(imgs);
      }, IMAGE_MAX_WAIT);

      attempt();
    }

    extractAndSendImages();
    return; // Don't run text extraction
  }

  // Hash flags set by background.js, read before Google rewrites the URL:
  // _resume reopens an earlier conversation only to ask a follow-up; _oq is
  // the query id of a search run in an offscreen-document iframe and _fq the
  // follow-up to ask there.
  const hashParams = new URLSearchParams(window.location.hash.slice(1));
  const isResumedThread = hashParams.has("_resume");
  const inOffscreenFrame = window.top !== window && hashParams.has("_oq");
  const offscreenKey = inOffscreenFrame ? hashParams.get("_oq") : null;

  const EXTRACTION_MAX_WAIT = 60000;
  const EXTRACTION_POLL_INTERVAL = 500;
  const EXTRACTION_STABILITY_DELAY = 3000;
  const FOLLOW_UP_INPUT_SETTLE_DELAY = 300;
  const RESUME_RENDER_TIMEOUT = 15000;
  const RESUME_STABLE_DELAY = 1000;

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
            href = u.searchParams.get("q") || u.searchParams.get("url") || href;
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
          href = u.searchParams.get("q") || u.searchParams.get("url") || href;
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
        href.includes("support.google.com") ||
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

  function stripNonContentElements(root) {
    root
      .querySelectorAll(
        'style, script, noscript, template, link[rel="stylesheet"]'
      )
      .forEach((el) => el.remove());
  }

  // Google renders the rating buttons (data-snt) under an answer only once it
  // has finished streaming, in every UI language.
  function isAnswerComplete(mainCol) {
    return Boolean(mainCol?.querySelector("[data-snt]"));
  }

  // Google draws formulas as an aria-hidden SVG of positioned glyphs: a raised
  // glyph (negative translate y) is a superscript, a lowered one a subscript.
  function mathSvgToText(svg) {
    let out = "";
    let level = 0;
    let run = "";
    const flush = () => {
      if (!run) return;
      if (level === 0) out += run;
      else out += (level < 0 ? "^" : "_") + (/^[\p{L}\p{N}]+$/u.test(run.normalize("NFKC")) ? run : `(${run})`);
      run = "";
    };
    for (const glyph of svg.querySelectorAll("text")) {
      const shift = /translate\(\s*[-\d.]+\s*,\s*([-\d.]+)/.exec(glyph.getAttribute("transform") || "");
      const y = shift ? parseFloat(shift[1]) : 0;
      const glyphLevel = y < -0.1 ? -1 : y > 0.1 ? 1 : 0;
      if (glyphLevel !== level) {
        flush();
        level = glyphLevel;
      }
      run += glyph.textContent;
    }
    flush();
    return out.normalize("NFKC");
  }

  function mathHolderText(holder) {
    const svg = holder.querySelector("svg");
    if (svg && svg.querySelector("text")) return mathSvgToText(svg);
    const math = holder.querySelector("math");
    if (!math) return "";
    const copy = math.cloneNode(true);
    copy.querySelectorAll("annotation, annotation-xml").forEach((el) => el.remove());
    return copy.textContent.normalize("NFKC");
  }

  // The footer of an answer holds the rating buttons, the legal links and the
  // AI disclaimer. Its legal links live in a hidden menu, so it is recognised
  // on the live tree, before hidden elements are dropped.
  function isAnswerFooter(el) {
    return Boolean(
      el.querySelector(
        '[data-snt], a[href*="policies.google.com"], a[href*="support.google.com/websearch"]'
      )
    );
  }

  // The answer DOM carries hidden UI text (copy toasts, share dialog, feedback
  // form); computed style is only available on the live tree, so hidden
  // elements and the footer are tagged there and dropped from the clone.
  function cloneVisible(root) {
    // A formula can be split into nested holders; only the innermost ones carry
    // the drawing, outer ones are plain layout.
    const holders = [...root.querySelectorAll("[data-xpm-math-type]")].filter(
      (holder) => !holder.querySelector("[data-xpm-math-type]")
    );
    holders.forEach((holder, i) => holder.setAttribute("data-gas-math", String(i)));
    const mathTexts = holders.map(mathHolderText);

    const hidden = [];
    const visit = (el) => {
      if (el.hasAttribute("data-gas-math")) return;
      const style = getComputedStyle(el);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        el.getAttribute("aria-hidden") === "true"
      ) {
        hidden.push(el);
        return;
      }
      for (const child of el.children) visit(child);
    };
    for (const child of root.children) visit(child);
    const wrapper =
      root.querySelector('[data-container-id="main-col"]')?.children[0] || root.children[0];
    hidden.push(...[...(wrapper?.children || [])].filter(isAnswerFooter));
    hidden.forEach((el) => el.setAttribute("data-gas-hidden", ""));
    const clone = root.cloneNode(true);
    hidden.forEach((el) => el.removeAttribute("data-gas-hidden"));
    holders.forEach((holder) => holder.removeAttribute("data-gas-math"));
    clone.querySelectorAll("[data-gas-hidden]").forEach((el) => el.remove());
    // Entity names in the answer are clickable chips (span role=button); keep
    // their text before the UI-button cleanup removes every role=button.
    clone.querySelectorAll('span[role="button"]').forEach((chip) => {
      chip.replaceWith(document.createTextNode(chip.textContent));
    });
    clone.querySelectorAll("[data-gas-math]").forEach((holder) => {
      const replacement = document.createElement("span");
      replacement.textContent = mathTexts[Number(holder.getAttribute("data-gas-math"))];
      holder.replaceWith(replacement);
    });
    return clone;
  }

  // A code block is a header row (language label, then the pre) followed by a
  // row with the copy button and a "use code with caution" caption.
  function convertCodeBlocks(root) {
    for (const pre of root.querySelectorAll("pre")) {
      const header = pre.parentElement?.parentElement;
      const isCodeHeader = header?.children.length === 2;
      const label = isCodeHeader ? [...header.children].find((child) => !child.contains(pre)) : null;
      const language = (label?.textContent || "").trim();
      const code = document.createElement("code");
      if (/^[\w#+.-]{1,20}$/.test(language)) {
        code.className = `language-${language.toLowerCase()}`;
        label.remove();
      }
      code.textContent = pre.textContent;
      pre.replaceChildren(code);
      const caption = isCodeHeader ? header.nextElementSibling : null;
      if (
        caption &&
        caption.querySelector("button") &&
        !caption.querySelector("pre") &&
        caption.textContent.trim().length < 120
      ) {
        caption.remove();
      }
    }
  }

  function echoKey(text) {
    return (text || "").toLowerCase().replace(/\s+/g, " ").replace(/[\s?!.¿¡]+$/u, "").trim();
  }

  // Turns a cloneVisible() copy of an answer into markdown. A heading that only
  // repeats the question is dropped; every other heading is a real section.
  function answerMarkdown(clone, question) {
    stripNonContentElements(clone);
    convertCodeBlocks(clone);
    clone
      .querySelectorAll('[data-dtype], button, [role="button"], svg, [data-subtree="aimba"]')
      .forEach((el) => el.remove());

    // Source card clusters: many links and images among the wrapper's children
    const wrapper =
      clone.querySelector('[data-container-id="main-col"]')?.children[0] || clone.children[0] || clone;
    for (const child of [...wrapper.children]) {
      if (child.querySelectorAll("a").length > 3 && child.querySelectorAll("img").length > 3) {
        child.remove();
      }
    }
    clone.querySelectorAll('img[src^="data:"]').forEach((el) => el.remove());

    const firstHeading = clone.querySelector('h2, h3, [role="heading"]');
    if (firstHeading && question && echoKey(firstHeading.textContent) === echoKey(question)) {
      firstHeading.remove();
    }

    // Adjacent bold runs come out as "**a****b**"
    return createTurndownService().turndown(clone.innerHTML).replace(/\*{4}/g, "").trim();
  }

  function extractContent(container) {
    // Use main-col for markdown (AI response only), fall back to full container
    const mainCol = container.querySelector('[data-container-id="main-col"]');
    const question = new URLSearchParams(window.location.search).get("q") || "";
    const markdown = answerMarkdown(cloneVisible(mainCol || container), question);
    const citations = extractCitations(container);

    return { markdown, citations, complete: isAnswerComplete(mainCol) };
  }

  function hasMeaningfulMarkdown(markdown) {
    const text = markdown
      .replace(/[`*_#[\]()>-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (!text) return false;

    const lower = text.toLowerCase();
    if (
      lower === "loading" ||
      lower === "generating" ||
      lower === "searching" ||
      lower === "thinking"
    ) {
      return false;
    }

    const alnumLength = text.replace(/[^a-z0-9]/gi, "").length;
    return alnumLength >= 7;
  }

  function finalizeExtractionResult(markdown, citations, emptyError) {
    const cleanMarkdown = markdown.trim();
    if (!hasMeaningfulMarkdown(cleanMarkdown) && citations.length === 0) {
      return { markdown: "", citations: [], error: emptyError };
    }
    return { markdown: cleanMarkdown, citations, error: null };
  }

  function extractionSignature(markdown, citations) {
    return `${markdown.trim()}\n---\n${citations.join("\n")}`;
  }

  function sendResult({ complete, ...data }) {
    chrome.runtime.sendMessage({
      type: "AI_OVERVIEW_RESULT",
      data,
      offscreenKey,
      pageUrl: window.location.href,
    });
  }

  function isTerminalExtractionError(error) {
    return Boolean(
      error &&
      !error.startsWith("empty_") &&
      !error.startsWith("no_ai_overview")
    );
  }

  function buildQuotaExhaustedResult(query = "") {
    return {
      markdown: "",
      citations: [],
      error: "quota_exhausted_pro",
      _query: query,
    };
  }

  const QUOTA_EXHAUSTION_PATTERNS = [
    /\byou(?:['`\u2019]ve| have)\s+reached\s+(?:your\s+)?(?:daily\s+)?(?:usage\s+)?limit\b/i,
    /\b(?:daily\s+)?(?:usage\s+)?limit\s+(?:has\s+been\s+)?reached\b/i,
  ];

  function waitForExtraction(
    extractFn,
    onDone,
    fallbackError,
    maxWait = EXTRACTION_MAX_WAIT
  ) {
    let pollTimer = null;
    let maxTimer = null;
    let stableTimer = null;
    let obs = null;
    let finished = false;
    let lastResult = { markdown: "", citations: [], error: fallbackError };
    let lastMeaningfulSignature = null;

    function finish(result) {
      if (finished) return;
      finished = true;
      if (obs) obs.disconnect();
      clearInterval(pollTimer);
       clearTimeout(stableTimer);
      clearTimeout(maxTimer);
      onDone(result);
    }

    function attempt() {
      if (finished) return;
      try {
        const result = extractFn();
        if (!result) return;
        lastResult = result;

        if (isTerminalExtractionError(result.error)) {
          finish(result);
          return;
        }

        if (result.complete && !result.error) {
          finish(result);
          return;
        }

        if (result.markdown.trim() || result.citations.length > 0) {
          const signature = extractionSignature(
            result.markdown,
            result.citations
          );
          if (signature !== lastMeaningfulSignature) {
            lastMeaningfulSignature = signature;
            clearTimeout(stableTimer);
            stableTimer = setTimeout(
              () => finish(result),
              EXTRACTION_STABILITY_DELAY
            );
          }
        } else {
          lastMeaningfulSignature = null;
          clearTimeout(stableTimer);
        }
      } catch (err) {
        finish({
          markdown: "",
          citations: [],
          error: `extraction_error: ${err.message}`,
        });
      }
    }

    obs = new MutationObserver(() => {
      attempt();
    });

    obs.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    pollTimer = setInterval(attempt, EXTRACTION_POLL_INTERVAL);
    maxTimer = setTimeout(() => finish(lastResult), maxWait);
    attempt();
  }

  function detectQuotaExhaustion(container) {
    if (!container) return false;
    const text = container.textContent || "";
    return QUOTA_EXHAUSTION_PATTERNS.some((pattern) => pattern.test(text));
  }

  function tryExtractInitialOverview() {
    const container = findAIOverviewContainer();
    if (!container) {
      if (detectQuotaExhaustion(document.body)) {
        const q = new URLSearchParams(window.location.search).get("q") || "";
        return buildQuotaExhaustedResult(q);
      }
      return null;
    }

    if (detectQuotaExhaustion(container)) {
      const q = new URLSearchParams(window.location.search).get("q") || "";
      return buildQuotaExhaustedResult(q);
    }

    const { markdown, citations, complete } = extractContent(container);
    return {
      ...finalizeExtractionResult(markdown, citations, "empty_ai_overview_extraction"),
      complete,
    };
  }

  function extractFollowUpSnapshot() {
    const allMainCols = document.querySelectorAll(
      '[data-container-id="main-col"]'
    );
    if (allMainCols.length === 0) {
      return { markdown: "", citations: [] };
    }

    const lastMainCol = allMainCols[allMainCols.length - 1];
    const lastAimcContainer =
      lastMainCol.closest('[data-subtree="aimc"]') || findAIOverviewContainer();
    if (!lastAimcContainer) {
      return { markdown: "", citations: [] };
    }

    return extractContent(lastAimcContainer);
  }

  function tryExtractFollowUp(prevMainColCount, prevSignature, query) {
    const allMainCols = document.querySelectorAll(
      '[data-container-id="main-col"]'
    );

    if (allMainCols.length === 0) {
      const container = findAIOverviewContainer() || document.body;
      if (detectQuotaExhaustion(container)) {
        return buildQuotaExhaustedResult(query);
      }
      return null;
    }

    if (allMainCols.length > prevMainColCount) {
      // New main-col appeared — extract only from it
      const newMainCol = allMainCols[allMainCols.length - 1];
      const newAimc =
        newMainCol.closest('[data-subtree="aimc"]') || findAIOverviewContainer();
      if (detectQuotaExhaustion(newAimc || newMainCol)) {
        return buildQuotaExhaustedResult(query);
      }
      const markdown = answerMarkdown(cloneVisible(newMainCol), query);
      const allAimcs = document.querySelectorAll('[data-subtree="aimc"]');
      const lastAimc = allAimcs[allAimcs.length - 1];
      const citations = extractCitations(lastAimc || document.body);
      return {
        ...finalizeExtractionResult(markdown, citations, "empty_follow_up_extraction"),
        complete: isAnswerComplete(newMainCol),
      };
    }

    const currentAimc =
      allMainCols[allMainCols.length - 1]?.closest('[data-subtree="aimc"]') ||
      findAIOverviewContainer();
    if (detectQuotaExhaustion(currentAimc || document.body)) {
      return buildQuotaExhaustedResult(query);
    }

    const { markdown, citations } = extractFollowUpSnapshot();
    if (extractionSignature(markdown, citations) === prevSignature) {
      return null;
    }

    return finalizeExtractionResult(
      markdown,
      citations,
      "empty_follow_up_extraction"
    );
  }

  // --- Initial scrape ---
  if (!isResumedThread) {
    waitForExtraction(
      tryExtractInitialOverview,
      (result) => sendResult(result),
      "no_ai_overview"
    );
  }

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

  if (inOffscreenFrame && isResumedThread && hashParams.has("_fq")) {
    followUpInProgress = true;
    handleFollowUp(hashParams.get("_fq"), offscreenKey);
  }

  async function handleFollowUp(query, queryId) {
    try {
      // 1. Find the follow-up input (textarea or contenteditable div)
      if (isResumedThread) {
        await waitForResumedConversation();
      }
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
        sendResult({ markdown: "", citations: [], error: "follow_up_textbox_not_found" });
        followUpInProgress = false;
        return;
      }

      // 2. Snapshot current main-col count and latest extracted content so we
      // can tell when Google has actually rendered a new answer.
      // Follow-ups may create a new aimc container (not just a new main-col
      // within the same container), so we search document-wide.
      const prevMainColCount = document.querySelectorAll(
        '[data-container-id="main-col"]'
      ).length;
      const prevSnapshot = extractFollowUpSnapshot();
      const prevSignature = extractionSignature(
        prevSnapshot.markdown,
        prevSnapshot.citations
      );

      // 3. Type query into input
      const usableButtonsBefore = new Set(
        [...followUpButtonScope(textbox).querySelectorAll("button")].filter(isUsableButton)
      );
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
      await new Promise((r) => setTimeout(r, FOLLOW_UP_INPUT_SETTLE_DELAY));

      // 4. Submit: find nearby submit button or press Enter
      const submitted = await submitFollowUp(textbox, usableButtonsBefore);
      if (!submitted) {
        sendResult({ markdown: "", citations: [], error: "follow_up_submit_failed" });
        followUpInProgress = false;
        return;
      }

      // 5. Wait until the newly rendered follow-up is actually extractable.
      waitForExtraction(
        () => tryExtractFollowUp(prevMainColCount, prevSignature, query),
        (result) => {
          sendResult(result);
          followUpInProgress = false;
        },
        "no_ai_overview_after_follow_up"
      );
    } catch (err) {
      sendResult({ markdown: "", citations: [], error: `follow_up_error: ${err.message}` });
      followUpInProgress = false;
    }
  }

  async function waitForResumedConversation() {
    const deadline = Date.now() + RESUME_RENDER_TIMEOUT;
    let lastCount = -1;
    let stableSince = 0;
    while (Date.now() < deadline) {
      const count = document.querySelectorAll('[data-container-id="main-col"]').length;
      if (count > 0 && count === lastCount && findFollowUpInput()) {
        if (Date.now() - stableSince >= RESUME_STABLE_DELAY) return;
      } else {
        lastCount = count;
        stableSince = Date.now();
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  function findFollowUpInput() {
    // Strategy 1: textarea with relevant placeholder/label
    const textarea = document.querySelector(
      'textarea[placeholder*="Ask" i], textarea[aria-label*="Ask" i], textarea[placeholder*="follow" i]'
    );
    if (textarea && isShown(textarea)) return textarea;

    // Strategy 2: contenteditable div with textbox role
    const contentEditable = document.querySelector(
      'div[role="textbox"][contenteditable="true"]'
    );
    if (contentEditable && isShown(contentEditable))
      return contentEditable;

    // Strategy 3: any visible textarea inside the AI overview area
    const container = findAIOverviewContainer();
    if (container) {
      const ta = container.querySelector("textarea");
      if (ta && isShown(ta)) return ta;
    }

    // Strategy 4: labels are localized, so fall back to the last visible
    // textarea that is not the regular search box.
    const visible = [...document.querySelectorAll("textarea")].filter(
      (ta) => isShown(ta) && ta.name !== "q"
    );
    return visible[visible.length - 1] || null;
  }

  // Offscreen-document frames are never laid out (zero viewport, no
  // offsetParent anywhere), so visibility falls back to computed styles there.
  function isShown(el) {
    if (window.innerWidth > 0) return el.offsetParent !== null;
    for (let node = el; node && node !== document.documentElement; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return false;
    }
    return true;
  }

  function isUsableButton(btn) {
    return (
      isShown(btn) &&
      !btn.disabled &&
      btn.getAttribute("aria-disabled") !== "true"
    );
  }

  function followUpButtonScope(textbox) {
    let scope = textbox;
    for (let i = 0; i < 4 && scope.parentElement; i++) scope = scope.parentElement;
    return scope;
  }

  async function submitFollowUp(textbox, usableButtonsBefore) {
    // Strategy 0: the send button becomes usable only once there is text,
    // which identifies it without relying on localized labels.
    const appeared = [...followUpButtonScope(textbox).querySelectorAll("button")].filter(
      (btn) => isUsableButton(btn) && !usableButtonsBefore.has(btn)
    );
    if (appeared.length === 1) {
      appeared[0].click();
      return true;
    }

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

    // Strategy 3: dispatch Enter key
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
