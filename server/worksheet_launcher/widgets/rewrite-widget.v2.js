/* rewrite-widget.v2.js
   Adapter layer that wraps RewriteWidget.mount and exposes renderer-friendly hooks
   without changing the shared base widget implementation.
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

  async function mount(cfg) {
    const controller = await originalMount(cfg);
    const container = document.querySelector(cfg.containerSelector);

    const rewriteStart = makeEmitter();
    const rewriteComplete = makeEmitter();
    const textChange = makeEmitter();

    const getTextarea = () => {
      if (!container) return null;
      return container.querySelector(".rw-textarea");
    };

    const getCurrentText = () => {
      const textarea = getTextarea();
      return textarea ? String(textarea.value || "") : "";
    };

    const onInput = () => {
      textChange.emit({ text: getCurrentText() });
    };

    const textarea = getTextarea();
    if (textarea) {
      textarea.addEventListener("input", onInput);
    }

    const baseRewrite = typeof controller.rewrite === "function"
      ? controller.rewrite.bind(controller)
      : async () => {};

    async function rewrite() {
      const before = getCurrentText();
      rewriteStart.emit({ text: before });

      let error = null;
      try {
        return await baseRewrite();
      } catch (err) {
        error = err;
        throw err;
      } finally {
        const after = getCurrentText();
        rewriteComplete.emit({ before, after, changed: after !== before, error });
      }
    }

    const baseDestroy = typeof controller.destroy === "function"
      ? controller.destroy.bind(controller)
      : () => {};

    return {
      ...controller,
      rewrite,
      getCurrentText,
      onRewriteStart: (callback) => rewriteStart.on(callback),
      onRewriteComplete: (callback) => rewriteComplete.on(callback),
      onTextChange: (callback) => textChange.on(callback),
      destroy: () => {
        const currentTextarea = getTextarea();
        if (currentTextarea) {
          currentTextarea.removeEventListener("input", onInput);
        }
        rewriteStart.clear();
        rewriteComplete.clear();
        textChange.clear();
        baseDestroy();
      }
    };
  }

  global.RewriteWidget = {
    ...baseWidget,
    mount
  };
})(window);
