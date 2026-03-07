/* rewrite-widget.v2.js
   Adapter layer that wraps RewriteWidget.mount and exposes renderer-friendly hooks
   without changing the shared base widget implementation.

   Canonical readiness rule (prototype): strict
   - Rewrite is allowed only when model-status API reports status === "ready".
*/
(function (global) {
  "use strict";

  const baseWidget = global.RewriteWidget;
  if (!baseWidget || typeof baseWidget.mount !== "function") {
    return;
  }

  const originalMount = baseWidget.mount.bind(baseWidget);

  function makeEmitter() {
    const listeners = new Set();

    return {
      on(callback) {
        if (typeof callback !== "function") return () => {};
        listeners.add(callback);
        return () => listeners.delete(callback);
      },
      emit(payload) {
        for (const cb of listeners) {
          try {
            cb(payload);
          } catch {
            // Ignore listener errors to avoid breaking widget behavior.
          }
        }
      },
      clear() {
        listeners.clear();
      }
    };
  }

  function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(url, {
      ...options,
      signal: controller.signal,
      credentials: "include"
    }).finally(() => clearTimeout(timeoutId));
  }

  const StrictStatus = (() => {
    const pollers = new Map();

    function createPoller(statusUrl) {
      let state = {
        ready: false,
        status: "unknown",
        lastError: "",
        updatedAt: 0
      };
      let inFlight = false;
      let intervalMs = 5000;
      let timer = null;
      const subscribers = new Set();

      function notify() {
        for (const cb of subscribers) {
          try {
            cb({ ...state });
          } catch {
            // Ignore subscriber errors.
          }
        }
      }

      function setState(next) {
        state = { ...state, ...next, updatedAt: Date.now() };
        notify();
      }

      async function pollOnce() {
        if (inFlight) return { ...state };
        inFlight = true;
        try {
          const res = await fetchWithTimeout(statusUrl, { method: "GET" }, 8000);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();
          const status = String(data?.status || "unknown").toLowerCase();
          setState({
            status,
            ready: status === "ready",
            lastError: ""
          });
        } catch (err) {
          setState({
            status: "down",
            ready: false,
            lastError: err?.message || "Status poll failed"
          });
        } finally {
          inFlight = false;
        }
        return { ...state };
      }

      function start() {
        if (timer) return;
        timer = setInterval(() => {
          pollOnce();
        }, intervalMs);
      }

      function stopIfUnused() {
        if (subscribers.size > 0) return;
        if (timer) {
          clearInterval(timer);
          timer = null;
        }
      }

      return {
        subscribe(callback) {
          subscribers.add(callback);
          try {
            callback({ ...state });
          } catch {
            // Ignore subscriber errors.
          }
          start();
          return () => {
            subscribers.delete(callback);
            stopIfUnused();
          };
        },
        pollOnce,
        setIntervalMs(ms) {
          const n = Number(ms);
          if (!Number.isFinite(n) || n < 1000) return;
          intervalMs = n;
          if (timer) {
            clearInterval(timer);
            timer = setInterval(() => {
              pollOnce();
            }, intervalMs);
          }
        },
        getState() {
          return { ...state };
        }
      };
    }

    return {
      get(statusUrl) {
        if (!pollers.has(statusUrl)) {
          pollers.set(statusUrl, createPoller(statusUrl));
        }
        return pollers.get(statusUrl);
      }
    };
  })();

  async function mount(cfg) {
    const controller = await originalMount(cfg);
    const container = document.querySelector(cfg.containerSelector);
    const apiBase = String(cfg.apiBase ?? "").replace(/\/+$/, "");
    const statusUrl = `${apiBase}/api/rewrite-bridge/model-status`;

    const rewriteStart = makeEmitter();
    const rewriteComplete = makeEmitter();
    const textChange = makeEmitter();
    const readinessChange = makeEmitter();

    const strictPoller = StrictStatus.get(statusUrl);
    if (Number.isFinite(cfg.statusPollIntervalMs)) {
      strictPoller.setIntervalMs(cfg.statusPollIntervalMs);
    }

    const getTextarea = () => {
      if (!container) return null;
      return container.querySelector(".rw-textarea");
    };

    const getRewriteButton = () => {
      if (!container) return null;
      return container.querySelector(".rw-primary");
    };

    const getCurrentText = () => {
      const textarea = getTextarea();
      return textarea ? String(textarea.value || "") : "";
    };

    let strictReady = false;
    let rewriteInFlight = false;

    const syncStrictGate = () => {
      const rewriteButton = getRewriteButton();
      if (!rewriteButton) return;

      if (!strictReady || rewriteInFlight) {
        rewriteButton.disabled = true;
        rewriteButton.dataset.rwV2ForcedDisabled = "1";
        return;
      }

      if (rewriteButton.dataset.rwV2ForcedDisabled === "1") {
        delete rewriteButton.dataset.rwV2ForcedDisabled;
        const textarea = getTextarea();
        if (textarea) {
          textarea.dispatchEvent(new Event("input", { bubbles: true }));
        }
      }
    };

    const onInput = () => {
      textChange.emit({ text: getCurrentText() });
      syncStrictGate();
    };

    const textarea = getTextarea();
    if (textarea) {
      textarea.addEventListener("input", onInput);
    }

    const unsubscribeStrictPoll = strictPoller.subscribe((st) => {
      const nextReady = st.ready === true;
      const changed = nextReady !== strictReady;
      strictReady = nextReady;
      syncStrictGate();
      if (changed) {
        readinessChange.emit({ ready: strictReady, status: st.status, lastError: st.lastError || "" });
      }
    });

    // Kick an immediate strict poll so adapter readiness is available quickly.
    strictPoller.pollOnce();

    const baseRewrite = typeof controller.rewrite === "function"
      ? controller.rewrite.bind(controller)
      : async () => {};

    async function rewrite() {
      if (!strictReady) {
        throw new Error("Rewrite unavailable: model status is not ready.");
      }

      const before = getCurrentText();
      rewriteInFlight = true;
      syncStrictGate();
      rewriteStart.emit({ text: before });

      let error = null;
      try {
        return await baseRewrite();
      } catch (err) {
        error = err;
        throw err;
      } finally {
        rewriteInFlight = false;
        syncStrictGate();
        const after = getCurrentText();
        rewriteComplete.emit({ before, after, changed: after !== before, error });
      }
    }

    const rewriteBtn = getRewriteButton();
    const blockIfNotReady = (event) => {
      if (strictReady) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    if (rewriteBtn) {
      rewriteBtn.addEventListener("click", blockIfNotReady, true);
      syncStrictGate();
    }

    const baseDestroy = typeof controller.destroy === "function"
      ? controller.destroy.bind(controller)
      : () => {};

    return {
      ...controller,
      rewrite,
      getCurrentText,
      isRewriteReady: () => strictReady,
      onRewriteStart: (callback) => rewriteStart.on(callback),
      onRewriteComplete: (callback) => rewriteComplete.on(callback),
      onTextChange: (callback) => textChange.on(callback),
      onReadinessChange: (callback) => readinessChange.on(callback),
      destroy: () => {
        const currentTextarea = getTextarea();
        if (currentTextarea) {
          currentTextarea.removeEventListener("input", onInput);
        }
        const currentRewriteBtn = getRewriteButton();
        if (currentRewriteBtn) {
          currentRewriteBtn.removeEventListener("click", blockIfNotReady, true);
        }
        unsubscribeStrictPoll();
        rewriteStart.clear();
        rewriteComplete.clear();
        textChange.clear();
        readinessChange.clear();
        baseDestroy();
      }
    };
  }

  global.RewriteWidget = {
    ...baseWidget,
    mount
  };
})(window);
