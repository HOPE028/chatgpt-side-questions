(() => {
  const api = typeof browser !== "undefined" ? browser : chrome;

  const MSG = {
    SIDE_Q: "side-q",
    DELTA: "delta",
    DONE: "done",
    ERROR: "error",
    CANCEL: "cancel",
  };

  // Centralised so a ChatGPT DOM refactor is a one-line fix.
  const SELECTORS = {
    assistantMessage: '[data-message-author-role="assistant"]',
    markdown: ".markdown",
  };

  const MIN_SELECTION_LEN = 2;

  // Keep in sync with src/options/options.html
  const MODELS = [
    "gpt-4o-mini",
    "gpt-4o",
    "gpt-4.1-mini",
    "gpt-4.1",
    "o4-mini",
    "gpt-5-mini",
  ];
  const DEFAULT_MODEL = "gpt-4o-mini";

  let pillEl = null;
  let composerEl = null;
  let currentSelection = null;

  document.addEventListener("selectionchange", onSelectionChange);
  document.addEventListener("mousedown", (e) => {
    // Don't let clicks inside our UI clear the selection.
    if (e.target.closest(".side-q-pill, .side-q-composer, .side-q-card")) return;
    hidePill();
    hideComposer();
  });

  function onSelectionChange() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) {
      hidePill();
      return;
    }
    const text = sel.toString().trim();
    if (text.length < MIN_SELECTION_LEN) {
      hidePill();
      return;
    }

    const anchorEl = nodeToElement(sel.anchorNode);
    const focusEl = nodeToElement(sel.focusNode);
    if (!anchorEl || !focusEl) return hidePill();

    const anchorMsg = anchorEl.closest(SELECTORS.assistantMessage);
    const focusMsg = focusEl.closest(SELECTORS.assistantMessage);
    if (!anchorMsg || anchorMsg !== focusMsg) return hidePill();

    currentSelection = {
      text,
      assistantEl: anchorMsg,
      range: sel.getRangeAt(0).cloneRange(),
    };
    showPill(sel.getRangeAt(0).getBoundingClientRect());
  }

  function nodeToElement(node) {
    if (!node) return null;
    return node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  }

  function showPill(rect) {
    if (!pillEl) {
      pillEl = document.createElement("button");
      pillEl.className = "side-q-pill";
      pillEl.type = "button";
      pillEl.textContent = "Ask side-question";
      pillEl.addEventListener("mousedown", (e) => e.preventDefault()); // keep selection
      pillEl.addEventListener("click", onPillClick);
      document.body.appendChild(pillEl);
    }
    const top = window.scrollY + rect.top - 36;
    const left = window.scrollX + rect.left;
    pillEl.style.top = `${Math.max(top, window.scrollY + 8)}px`;
    pillEl.style.left = `${left}px`;
    pillEl.style.display = "block";
  }

  function hidePill() {
    if (pillEl) pillEl.style.display = "none";
  }

  function onPillClick() {
    if (!currentSelection) return;
    hidePill();
    openComposer(currentSelection);
  }

  function openComposer(selection) {
    hideComposer();
    const rect = selection.range.getBoundingClientRect();
    composerEl = document.createElement("div");
    composerEl.className = "side-q-composer";
    composerEl.innerHTML = `
      <input type="text" class="side-q-input" placeholder="Ask a side-question about the highlighted text…" />
      <button type="button" class="side-q-send">Ask</button>
      <button type="button" class="side-q-close" title="Close">×</button>
    `;
    document.body.appendChild(composerEl);

    const top = window.scrollY + rect.bottom + 6;
    const left = window.scrollX + rect.left;
    composerEl.style.top = `${top}px`;
    composerEl.style.left = `${left}px`;

    const input = composerEl.querySelector(".side-q-input");
    const send = composerEl.querySelector(".side-q-send");
    const close = composerEl.querySelector(".side-q-close");

    input.focus();
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submit(input.value, selection);
      } else if (e.key === "Escape") {
        hideComposer();
      }
    });
    send.addEventListener("click", () => submit(input.value, selection));
    close.addEventListener("click", hideComposer);
  }

  function hideComposer() {
    if (composerEl) {
      composerEl.remove();
      composerEl = null;
    }
  }

  async function submit(question, selection) {
    const q = (question || "").trim();
    if (!q) return;
    hideComposer();

    const card = insertCard(selection.assistantEl, q, selection.text, selection.range);
    const messageText = extractMessageText(selection.assistantEl);
    const payload = { snippet: selection.text, messageText, question: q };

    const { apiKey } = await api.storage.local.get(["apiKey"]);
    if (!apiKey) {
      card.renderSetup(() => sendRequest(card, payload));
      return;
    }
    sendRequest(card, payload);
  }

  function sendRequest(card, payload) {
    card.resetToLoading();
    const port = api.runtime.connect({ name: "side-q" });
    let gotAnyDelta = false;

    port.onMessage.addListener((msg) => {
      if (msg.type === MSG.DELTA) {
        if (!gotAnyDelta) {
          card.body.textContent = "";
          gotAnyDelta = true;
        }
        card.body.textContent += msg.text;
      } else if (msg.type === MSG.DONE) {
        card.setDone();
        port.disconnect();
      } else if (msg.type === MSG.ERROR) {
        // If the background couldn't find a key in storage, show the setup form
        // inline instead of a dead-end error message.
        if (/no openai api key set/i.test(msg.message)) {
          card.renderSetup(() => sendRequest(card, payload));
        } else {
          card.setError(msg.message);
        }
        port.disconnect();
      }
    });

    port.onDisconnect.addListener(() => {
      if (!card.isFinished() && !card.isAwaitingSetup()) {
        card.setError("Connection closed unexpectedly.");
      }
    });

    card.onCancel = () => {
      try {
        port.postMessage({ type: MSG.CANCEL });
      } catch {}
      try {
        port.disconnect();
      } catch {}
    };

    port.postMessage({ type: MSG.SIDE_Q, ...payload });
  }

  function extractMessageText(assistantEl) {
    const md = assistantEl.querySelector(SELECTORS.markdown);
    return (md || assistantEl).innerText.trim();
  }

  async function renderSetupForm(container, onSaved) {
    const { model: savedModel = DEFAULT_MODEL } = await api.storage.local.get([
      "model",
    ]);

    container.className = "side-q-body side-q-setup";
    container.innerHTML = `
      <div class="side-q-setup-title">Add your OpenAI API key to get an answer</div>
      <div class="side-q-setup-row">
        <input type="password" class="side-q-setup-key"
               placeholder="sk-..." autocomplete="off" spellcheck="false" />
        <select class="side-q-setup-model"></select>
      </div>
      <div class="side-q-setup-actions">
        <button type="button" class="side-q-setup-save">Save &amp; ask</button>
        <span class="side-q-setup-status" role="status" aria-live="polite"></span>
      </div>
      <div class="side-q-setup-hint">
        Stored locally in this extension only. Get a key at platform.openai.com/api-keys.
      </div>
    `;

    const select = container.querySelector(".side-q-setup-model");
    for (const m of MODELS) {
      const opt = document.createElement("option");
      opt.value = m;
      opt.textContent = m === DEFAULT_MODEL ? `${m} (default)` : m;
      if (m === savedModel) opt.selected = true;
      select.appendChild(opt);
    }

    const keyInput = container.querySelector(".side-q-setup-key");
    const saveBtn = container.querySelector(".side-q-setup-save");
    const statusEl = container.querySelector(".side-q-setup-status");

    keyInput.focus();

    const trySave = async () => {
      const apiKey = keyInput.value.trim();
      if (!apiKey) {
        statusEl.textContent = "Paste a key first.";
        statusEl.className = "side-q-setup-status err";
        return;
      }
      saveBtn.disabled = true;
      statusEl.textContent = "Saving…";
      statusEl.className = "side-q-setup-status";
      await api.storage.local.set({ apiKey, model: select.value });
      onSaved();
    };

    saveBtn.addEventListener("click", trySave);
    keyInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        trySave();
      }
    });
  }

  function findInsertionAnchor(range, assistantEl) {
    // Find the top-level block inside the markdown container that contains the
    // end of the selection. We insert the card immediately after that block so
    // the answer appears right under the paragraph / list / code block the
    // user highlighted, instead of at the bottom of the whole message.
    const markdownEl = assistantEl.querySelector(SELECTORS.markdown);
    if (!markdownEl) return null;
    let node = range.endContainer;
    if (node.nodeType !== Node.ELEMENT_NODE) node = node.parentElement;
    while (node && node.parentElement !== markdownEl) {
      if (node === assistantEl || !node.parentElement) return null;
      node = node.parentElement;
    }
    return node;
  }

  function insertCard(assistantEl, question, snippet, range) {
    const el = document.createElement("div");
    el.className = "side-q-card";
    el.innerHTML = `
      <div class="side-q-card-head">
        <span class="side-q-badge">Side-Q</span>
        <span class="side-q-q"></span>
        <button type="button" class="side-q-card-close" title="Remove">×</button>
      </div>
      <div class="side-q-snippet"></div>
      <div class="side-q-body">Thinking…</div>
    `;
    el.querySelector(".side-q-q").textContent = question;
    el.querySelector(".side-q-snippet").textContent = `“${snippet}”`;

    const body = el.querySelector(".side-q-body");
    const closeBtn = el.querySelector(".side-q-card-close");

    let finished = false;
    let awaitingSetup = false;
    const card = {
      el,
      body,
      setDone() {
        finished = true;
        el.classList.add("side-q-card--done");
      },
      setError(message) {
        finished = true;
        awaitingSetup = false;
        body.textContent = `⚠ ${message}`;
        el.classList.add("side-q-card--error");
      },
      resetToLoading() {
        finished = false;
        awaitingSetup = false;
        el.classList.remove("side-q-card--error", "side-q-card--done");
        body.className = "side-q-body";
        body.textContent = "Thinking…";
      },
      renderSetup(onSaved) {
        awaitingSetup = true;
        el.classList.remove("side-q-card--done");
        el.classList.add("side-q-card--setup");
        renderSetupForm(body, () => {
          awaitingSetup = false;
          el.classList.remove("side-q-card--setup");
          onSaved();
        });
      },
      isFinished() {
        return finished;
      },
      isAwaitingSetup() {
        return awaitingSetup;
      },
      onCancel: null,
    };

    closeBtn.addEventListener("click", () => {
      if (!finished && card.onCancel) card.onCancel();
      el.remove();
    });

    const anchor = range && findInsertionAnchor(range, assistantEl);
    if (anchor && anchor.parentElement) {
      anchor.parentElement.insertBefore(el, anchor.nextSibling);
    } else {
      assistantEl.appendChild(el);
    }
    return card;
  }
})();
