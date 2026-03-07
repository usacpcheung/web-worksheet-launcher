(function (global) {
  "use strict";

  const DEFAULT_MAX_POPUP_URL_LENGTH = 1800;
  const DEFAULT_MAX_QUESTION_CHARS = 800;

  function makeRid() {
    return "rid_" + Math.random().toString(16).slice(2) + "_" + Date.now().toString(16);
  }

  function base64urlEncode(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    const b64 = btoa(bin);
    return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  function getValidatedReturnOrigin() {
    try {
      const parsed = new URL(global.location.origin);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        return parsed.origin;
      }
    } catch (e) {
      return "";
    }
    return "";
  }

  function validateWorksheetForLaunch(worksheet, maxQuestionChars) {
    if (!worksheet || !Array.isArray(worksheet.q) || worksheet.q.length !== 1) {
      return "Launch blocked: worksheet must contain exactly one question.";
    }

    const question = worksheet.q[0];
    if (typeof question !== "string" || !question.trim()) {
      return "Launch blocked: question text must be a non-empty string.";
    }

    if (question.length > maxQuestionChars) {
      return `Launch blocked: question text exceeds ${maxQuestionChars} characters (question body limit). Please shorten question text and try again.`;
    }

    return "";
  }

  function validateWorksheetResultPayload(data, launchContext) {
    const answers = Array.isArray(data.answers) ? data.answers : null;
    if (!answers || answers.length !== 1) {
      return "answers must be an array of length 1";
    }

    const firstAnswer = answers[0];
    if (!firstAnswer || typeof firstAnswer !== "object") {
      return "answers[0] must be an object";
    }

    if (firstAnswer.index !== 0) {
      return "answers[0].index must equal 0";
    }

    const expectedQuestion = Array.isArray(launchContext.questions) ? launchContext.questions[0] : "";
    if (typeof firstAnswer.question !== "string" || !firstAnswer.question.trim()) {
      return "answers[0].question must be a non-empty string";
    }

    if (expectedQuestion && firstAnswer.question !== expectedQuestion) {
      return "answers[0].question does not match launched question";
    }

    if (firstAnswer.raw !== undefined && typeof firstAnswer.raw !== "string") {
      return "answers[0].raw must be a string when present";
    }

    if (firstAnswer.rewritten !== undefined && typeof firstAnswer.rewritten !== "string") {
      return "answers[0].rewritten must be a string when present";
    }

    return "";
  }

  function validateIncomingWorksheetMessageEvent(event, trustedSenderOrigin, popupWindowRef, launchContext) {
    if (event.origin !== trustedSenderOrigin) {
      return {
        ok: false,
        reasonCode: "reject_untrusted_origin",
        message: "untrusted event.origin",
        details: { expectedOrigin: trustedSenderOrigin, actualOrigin: event.origin }
      };
    }

    const data = event.data;
    if (!data || data.type !== "worksheetResult") {
      return {
        ok: false,
        reasonCode: "reject_unexpected_type",
        message: "unexpected event.data.type",
        details: { expectedType: "worksheetResult", actualType: data && data.type }
      };
    }

    if (!launchContext || data.rid !== launchContext.rid) {
      return {
        ok: false,
        reasonCode: "reject_rid_mismatch",
        message: "event.data.rid mismatch or missing launch context",
        details: { expectedRid: launchContext && launchContext.rid, actualRid: data.rid }
      };
    }

    if (event.source !== popupWindowRef) {
      return {
        ok: false,
        reasonCode: "reject_untrusted_source",
        message: "event.source does not match popupRef",
        details: { sourceMatchesPopup: false }
      };
    }

    const payloadError = validateWorksheetResultPayload(data, launchContext);
    if (payloadError) {
      return {
        ok: false,
        reasonCode: "reject_invalid_payload",
        message: payloadError,
        details: { expectedQuestion: launchContext.questions[0] }
      };
    }

    return {
      ok: true,
      payload: data
    };
  }

  function buildPopupUrl(renderOrigin, renderPath, worksheet, rid, returnOrigin) {
    const renderUrl = renderOrigin + renderPath;
    const query = new URLSearchParams({
      w: base64urlEncode(JSON.stringify(worksheet)),
      rid,
      returnOrigin
    });
    return `${renderUrl}?${query.toString()}`;
  }

  function defaultQuestionExtractor(element) {
    if (!element) return "";
    const dataQuestion = typeof element.dataset?.questionText === "string" ? element.dataset.questionText.trim() : "";
    if (dataQuestion) return dataQuestion;

    if ("value" in element && typeof element.value === "string") {
      return element.value.trim();
    }

    return (element.textContent || "").trim();
  }

  function defaultAnswerWriter(answer, context) {
    const target = context && context.targetElement;
    if (!target) return;

    if ("value" in target) {
      target.value = answer;
      return;
    }

    target.textContent = answer;
  }

  function getDisplayAnswer(answerItem) {
    if (!answerItem || typeof answerItem !== "object") return "";
    if (typeof answerItem.rewritten === "string" && answerItem.rewritten.trim()) {
      return answerItem.rewritten;
    }
    if (typeof answerItem.raw === "string") return answerItem.raw;
    if (typeof answerItem.answer === "string") return answerItem.answer;
    return "";
  }

  function create(config) {
    if (!config || typeof config !== "object") {
      throw new Error("WorksheetLauncher.create(config): config object is required.");
    }

    const renderOrigin = String(config.renderOrigin || "").trim();
    const renderPath = String(config.renderPath || "").trim();
    const trustedSenderOrigin = String(config.trustedSenderOrigin || "").trim();

    if (!renderOrigin || !renderPath || !trustedSenderOrigin) {
      throw new Error("WorksheetLauncher.create(config): renderOrigin, renderPath, and trustedSenderOrigin are required.");
    }

    const maxPopupUrlLength = Number(config.maxPopupUrlLength) || DEFAULT_MAX_POPUP_URL_LENGTH;
    const maxQuestionChars = Number(config.maxQuestionChars) || DEFAULT_MAX_QUESTION_CHARS;
    const popupName = String(config.popupName || "worksheetPopup");
    const popupFeatures = String(config.popupFeatures || "width=900,height=720");

    const onStatus =
      typeof config.onStatusChange === "function"
        ? config.onStatusChange
        : typeof config.onStatus === "function"
          ? config.onStatus
          : function () {};
    const onError =
      typeof config.onError === "function"
        ? config.onError
        : typeof config.onReject === "function"
          ? config.onReject
          : function () {};
    const onResult = typeof config.onResult === "function" ? config.onResult : function () {};

    const getQuestion = typeof config.getQuestion === "function" ? config.getQuestion : null;
    const questionSelector = typeof config.questionSelector === "string" ? config.questionSelector.trim() : "";
    const questionExtractor = typeof config.questionExtractor === "function" ? config.questionExtractor : defaultQuestionExtractor;
    if (!getQuestion && !questionSelector) {
      throw new Error("WorksheetLauncher.create(config): provide getQuestion() or questionSelector.");
    }

    const answerTargetSelector = typeof config.answerTargetSelector === "string" ? config.answerTargetSelector.trim() : "";
    const setAnswer = typeof config.setAnswer === "function" ? config.setAnswer : null;
    if (!setAnswer && !answerTargetSelector) {
      throw new Error("WorksheetLauncher.create(config): provide setAnswer(answer, context) or answerTargetSelector.");
    }

    let currentLaunchContext = null;
    let popupRef = null;
    let closeWatcher = null;
    let destroyed = false;
    const listeners = {
      open: new Set(),
      blocked: new Set(),
      launchRejected: new Set(),
      resultAccepted: new Set(),
      messageRejected: new Set(),
      popupClosedWithoutResult: new Set()
    };

    function makeStatusPayload(reasonCode, message, rid, rawEvent) {
      const payload = {
        rid: typeof rid === "string" ? rid : null,
        reasonCode,
        message
      };
      if (rawEvent) {
        payload.rawEvent = rawEvent;
      }
      return payload;
    }

    function subscribe(eventName, callback) {
      if (typeof callback !== "function") {
        throw new Error(`WorksheetLauncher subscription for \"${eventName}\" requires a callback function.`);
      }
      const bucket = listeners[eventName];
      if (!bucket) {
        throw new Error(`WorksheetLauncher subscription event \"${eventName}\" is not supported.`);
      }
      bucket.add(callback);
      return function unsubscribe() {
        bucket.delete(callback);
      };
    }

    function emit(eventName, payload) {
      const bucket = listeners[eventName];
      if (!bucket || bucket.size === 0) return;
      bucket.forEach(function (callback) {
        try {
          callback(payload);
        } catch (listenerError) {
          console.warn(`[worksheet-launcher] ${eventName} listener threw`, listenerError);
        }
      });
    }

    function clearCloseWatcher() {
      if (closeWatcher) {
        clearInterval(closeWatcher);
        closeWatcher = null;
      }
    }

    function rejectMessage(rejection, event) {
      const rid = event && event.data && typeof event.data.rid === "string" ? event.data.rid : null;
      const statusPayload = makeStatusPayload(rejection.reasonCode || "message_rejected", rejection.message, rid, {
        origin: event && event.origin,
        sourceMatchesPopup: event ? event.source === popupRef : false,
        type: event && event.data && event.data.type,
        rid,
        details: rejection.details || null
      });
      emit("messageRejected", statusPayload);
      onError(new Error(rejection.message), {
        type: "message_rejected",
        reasonCode: rejection.reasonCode || "message_rejected",
        event,
        reason: rejection.message,
        details: rejection.details || null
      });
      console.warn(`[worksheet-launcher] Rejected message [${rejection.reasonCode || "message_rejected"}]: ${rejection.message}`, {
        origin: event && event.origin,
        data: event && event.data,
        details: rejection.details || null
      });
    }

    function clear() {
      currentLaunchContext = null;
      clearCloseWatcher();
    }

    function teardownPopup() {
      clearCloseWatcher();
      try {
        if (popupRef && !popupRef.closed) popupRef.close();
      } catch (e) {
        // noop
      }
      popupRef = null;
    }

    function handleMessage(event) {
      if (destroyed) return;

      const validation = validateIncomingWorksheetMessageEvent(
        event,
        trustedSenderOrigin,
        popupRef,
        currentLaunchContext
      );
      if (!validation.ok) {
        rejectMessage(validation, event);
        return;
      }

      const data = validation.payload;
      const acceptedContext = currentLaunchContext;
      clear(); // one-shot consume behavior

      const firstAnswer = Array.isArray(data.answers) ? data.answers[0] : null;
      const displayAnswer = getDisplayAnswer(firstAnswer);
      const answerTarget = answerTargetSelector ? global.document.querySelector(answerTargetSelector) : null;
      const applyAnswer = setAnswer || defaultAnswerWriter;
      applyAnswer(displayAnswer, {
        payload: data,
        launchContext: acceptedContext,
        answer: firstAnswer,
        targetElement: answerTarget
      });

      onResult(data, acceptedContext);
      onStatus("Result received ✅ (single-launch, 1 question)", true);
      emit(
        "resultAccepted",
        makeStatusPayload("result_accepted", "Result message accepted and applied.", acceptedContext.rid)
      );
      teardownPopup();
    }

    global.addEventListener("message", handleMessage);

    function resolveQuestion(input) {
      const inputQuestion = input && typeof input.question === "string" ? input.question.trim() : "";
      if (inputQuestion) return inputQuestion;

      if (getQuestion) {
        const callbackQuestion = String(getQuestion()).trim();
        if (callbackQuestion) return callbackQuestion;
      }

      if (questionSelector) {
        const sourceElement = global.document.querySelector(questionSelector);
        if (!sourceElement) {
          throw new Error(`Question source element not found for selector: ${questionSelector}`);
        }
        const extractedQuestion = String(questionExtractor(sourceElement)).trim();
        if (extractedQuestion) return extractedQuestion;
      }

      return "";
    }

    function open(input) {
      if (destroyed) throw new Error("Launcher has been destroyed.");

      const title = input && typeof input.title === "string" ? input.title : "Worksheet";
      const normalizedQuestion = resolveQuestion(input);
      const questions = normalizedQuestion ? [normalizedQuestion] : [];

      if (questions.length !== 1) {
        throw new Error("Please provide exactly 1 question before launch.");
      }

      const worksheet = {
        v: 1,
        title: title || "Worksheet",
        q: questions,
        rewrite: true
      };

      const worksheetError = validateWorksheetForLaunch(worksheet, maxQuestionChars);
      if (worksheetError) {
        emit("launchRejected", makeStatusPayload("launch_validation_error", worksheetError, null));
        onStatus(worksheetError, false);
        onError(new Error(worksheetError), { type: "launch_validation_error", worksheet });
        throw new Error(worksheetError);
      }

      const rid = makeRid();
      if (!rid.trim()) {
        const warning = "Launch blocked: request id (rid) must be a non-empty string.";
        emit("launchRejected", makeStatusPayload("launch_validation_error", warning, null));
        onStatus(warning, false);
        onError(new Error(warning), { type: "launch_validation_error" });
        throw new Error(warning);
      }

      const returnOrigin = getValidatedReturnOrigin();
      if (!returnOrigin) {
        const warning = "Launch blocked: return origin is invalid. Use an absolute http(s) origin.";
        emit("launchRejected", makeStatusPayload("launch_validation_error", warning, rid));
        onStatus(warning, false);
        onError(new Error(warning), { type: "launch_validation_error" });
        throw new Error(warning);
      }

      const launchContext = {
        rid,
        useCaseId: "single-launch",
        questionCount: worksheet.q.length,
        questions: worksheet.q.slice()
      };

      const url = buildPopupUrl(renderOrigin, renderPath, worksheet, rid, returnOrigin);
      if (url.length > maxPopupUrlLength) {
        const warning = `Launch blocked: popup URL is too long (${url.length} chars). Please shorten question text and try again.`;
        emit("launchRejected", makeStatusPayload("popup_url_too_long", warning, rid));
        onStatus(warning, false);
        onError(new Error(warning), { type: "launch_validation_error", urlLength: url.length });
        return false;
      }

      popupRef = global.open(url, popupName, popupFeatures);
      if (!popupRef) {
        const blockedMessage = "Popup blocked. Please allow popups.";
        emit("blocked", makeStatusPayload("popup_blocked", blockedMessage, rid));
        onStatus(blockedMessage, false);
        onError(new Error(blockedMessage), { type: "popup_blocked" });
        return false;
      }

      currentLaunchContext = launchContext;
      emit("open", makeStatusPayload("popup_opened", "Popup opened and waiting for result.", rid));
      onStatus("Popup opened (single-launch, 1 question). Waiting for result…", null);

      clearCloseWatcher();
      closeWatcher = global.setInterval(function () {
        if (!popupRef || popupRef.closed) {
          clearCloseWatcher();
          if (currentLaunchContext && currentLaunchContext.rid === rid) {
            emit(
              "popupClosedWithoutResult",
              makeStatusPayload("popup_closed_without_result", "Popup closed before a valid result was received.", rid)
            );
            onStatus("Popup closed (single-launch, no result).", false);
          }
        }
      }, 600);

      return true;
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      global.removeEventListener("message", handleMessage);
      clear();
      teardownPopup();
    }

    return {
      open,
      onOpen: function (callback) {
        return subscribe("open", callback);
      },
      onBlocked: function (callback) {
        return subscribe("blocked", callback);
      },
      onLaunchRejected: function (callback) {
        return subscribe("launchRejected", callback);
      },
      onResultAccepted: function (callback) {
        return subscribe("resultAccepted", callback);
      },
      onMessageRejected: function (callback) {
        return subscribe("messageRejected", callback);
      },
      onPopupClosedWithoutResult: function (callback) {
        return subscribe("popupClosedWithoutResult", callback);
      },
      clear,
      destroy
    };
  }

  global.WorksheetLauncher = {
    create
  };
})(window);
