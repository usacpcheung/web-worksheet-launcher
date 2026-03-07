function parseQueryParams() {
  const sp = new URLSearchParams(window.location.search);
  return {
    w: sp.get("w"),
    rid: sp.get("rid"),
    returnOrigin: sp.get("returnOrigin")
  };
}

function base64urlDecodeToString(b64url) {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((b64url.length + 3) % 4);
  const bin = atob(b64);
  const bytes = new Uint8Array([...bin].map(ch => ch.charCodeAt(0)));
  return new TextDecoder().decode(bytes);
}

function safeText(value) {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return String(value);
}

function setSafeText(element, value) {
  if (!element) return;
  element.textContent = safeText(value);
}

function buildHostId(index) {
  if (!Number.isInteger(index) || index < 0 || index > 999) {
    throw new Error("Invalid question index for widget host id.");
  }

  const hostId = `rw_host_${index}`;
  if (!/^rw_host_\d{1,3}$/.test(hostId)) {
    throw new Error("Unsafe widget host id.");
  }

  return hostId;
}

const MAX_QUESTION_CHARS = 800;
const MAX_REWRITE_INPUT_CHARS = 200;
const SUPPORTED_CONTRACT_VERSIONS = [1];

const { w, rid, returnOrigin } = parseQueryParams();
const elTitle = document.getElementById("title");
const elMeta = document.getElementById("meta");
const elQuestions = document.getElementById("questions");
const elStatus = document.getElementById("status");
const elFlowHint = document.getElementById("flowHint");
const elSendBackBtn = document.getElementById("sendBackBtn");
elSendBackBtn.disabled = true;

let normalizedReturnOrigin = "";
try {
  const parsedReturnOrigin = new URL(returnOrigin);
  if (parsedReturnOrigin.protocol === "http:" || parsedReturnOrigin.protocol === "https:") {
    normalizedReturnOrigin = parsedReturnOrigin.origin;
  }
} catch (e) {
  normalizedReturnOrigin = "";
}

let worksheet = null;
let launchError = "";

if (!w || !rid || !returnOrigin) {
  launchError = "Missing query params. Expected ?w=...&rid=...&returnOrigin=...";
}

if (!launchError && (typeof rid !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(rid))) {
  launchError = "Invalid rid format in launch query.";
}

if (!launchError && !normalizedReturnOrigin) {
  launchError = "Invalid returnOrigin. Use an absolute http(s) origin in the launch query.";
}

if (!launchError) {
  try {
    worksheet = JSON.parse(base64urlDecodeToString(w));
  } catch (e) {
    launchError = "Invalid worksheet payload (w).";
  }
}

if (!launchError && (
  !worksheet ||
  worksheet.v !== 1 ||
  !Array.isArray(worksheet.q) ||
  worksheet.q.length !== 1 ||
  !worksheet.q.every((qItem) => typeof qItem === "string") ||
  (worksheet.title !== undefined && typeof worksheet.title !== "string")
)) {
  launchError = "Invalid worksheet schema (v=1, q must be exactly one string).";
}

if (!launchError) {
  const contractVersion = Number(worksheet.contractVersion);
  if (!Number.isInteger(contractVersion)) {
    launchError = "Invalid worksheet schema: contractVersion must be an integer.";
  } else if (!SUPPORTED_CONTRACT_VERSIONS.includes(contractVersion)) {
    launchError = `Unsupported contractVersion (${contractVersion}). Supported versions: ${SUPPORTED_CONTRACT_VERSIONS.join(",")}.`;
  }
}

if (!launchError) {
  const questionText = worksheet.q[0];
  if (!questionText.trim()) {
    launchError = "Invalid worksheet payload: question text must be non-empty.";
  } else if (questionText.length > MAX_QUESTION_CHARS) {
    launchError = `Invalid worksheet payload: question text exceeds ${MAX_QUESTION_CHARS} characters (question body limit).`;
  }
}

if (launchError) {
  setSafeText(elMeta, launchError);
  elMeta.className = "small bad";
  setSafeText(elStatus, `Launch blocked: ${launchError}`);
  elStatus.className = "small bad";
  setSafeText(elFlowHint, "Fix launch query parameters and reopen this popup.");
  elSendBackBtn.disabled = true;
}

if (!launchError) {
  setSafeText(elTitle, worksheet.title || "Worksheet");
  setSafeText(elMeta, `rid=${rid} • contractVersion=${worksheet.contractVersion} • questions=${worksheet.q.length}`);
  elMeta.className = "small";
  setSafeText(elFlowHint, worksheet.q.length === 1
    ? "Answer the question, optionally click Rewrite, then click Send Back to Parent."
    : "Answer each question in order, optionally click Rewrite per question, then click Send Back to Parent.");
}

const widgetControllers = [];

async function renderQuestions() {
  for (const [idx, qText] of worksheet.q.entries()) {
    const card = document.createElement("div");
    card.className = "card";

    const questionText = document.createElement("div");
    questionText.className = "question-text";

    const questionLabel = document.createElement("b");
    setSafeText(questionLabel, `Q${idx + 1}. `);
    questionText.appendChild(questionLabel);
    questionText.appendChild(document.createTextNode(safeText(qText)));

    const hint = document.createElement("div");
    hint.className = "small question-hint";
    setSafeText(hint, "Write your response here (up to 200 chars for Rewrite). Rewrite is optional.");

    const hostId = buildHostId(idx);
    const host = document.createElement("div");
    host.id = hostId;
    host.className = "rw-host";

    card.appendChild(questionText);
    card.appendChild(hint);
    card.appendChild(host);
    elQuestions.appendChild(card);

    const widget = await RewriteWidget.mount({
      containerSelector: `#${hostId}`,
      apiBase: "",
      title: `Answer ${idx + 1}`,
      placeholder: "Type your answer, then click Rewrite if you want a polished version.",
      maxChars: MAX_REWRITE_INPUT_CHARS,
      statusPollIntervalMs: 5000,
      pollModelStatus: true
    });

    const state = {
      rawText: "",
      rewrittenText: "",
      latestText: "",
      rewriteInFlight: false,
      rewriteReady: false
    };

    const getTrimmedText = () => {
      if (!widget || typeof widget.getCurrentText !== "function") return "";
      return widget.getCurrentText().trim();
    };

    const updateLatestFromAdapter = () => {
      state.latestText = getTrimmedText();
    };

    if (widget && typeof widget.onTextChange === "function") {
      widget.onTextChange(() => {
        updateLatestFromAdapter();
        if (!state.rewriteInFlight) {
          // Manual edits become the latest source text and clear stale rewrite snapshots.
          state.rawText = state.latestText;
          state.rewrittenText = "";
        }
      });
    }


    if (widget && typeof widget.onReadinessChange === "function") {
      widget.onReadinessChange(({ ready }) => {
        state.rewriteReady = ready === true;
      });
    }
    if (widget && typeof widget.isRewriteReady === "function") {
      state.rewriteReady = widget.isRewriteReady();
    }

    if (widget && typeof widget.onRewriteStart === "function") {
      widget.onRewriteStart(({ text }) => {
        state.rawText = safeText(text).trim();
        state.rewriteInFlight = true;
      });
    }

    if (widget && typeof widget.onRewriteComplete === "function") {
      widget.onRewriteComplete(({ after, changed }) => {
        state.latestText = safeText(after).trim();
        if (changed && state.latestText && state.latestText !== state.rawText) {
          state.rewrittenText = state.latestText;
        }
        state.rewriteInFlight = false;
      });
    }

    updateLatestFromAdapter();
    if (!state.rawText) {
      state.rawText = state.latestText;
    }

    widgetControllers[idx] = {
      index: idx,
      question: safeText(qText),
      widget,
      state,
      getLatestText: () => getTrimmedText()
    };
  }
}

function buildAnswersPayload() {
  return widgetControllers.map((controller, idx) => {
    const latestText = controller.getLatestText();
    const rawText = controller.state.rawText || latestText;
    // Deterministic fallback rules:
    // - Non-rewrite path: rewritten falls back to latest text.
    // - Rewrite success: rewritten preserves rewritten output when it differs from raw.
    const rewrittenText = controller.state.rewrittenText || (rawText === latestText ? latestText : "");

    return {
      index: idx,
      question: controller.question,
      answer: latestText,
      raw: rawText,
      rewritten: rewrittenText
    };
  });
}

if (!launchError) {
  renderQuestions().then(() => {
    elSendBackBtn.disabled = false;
  }).catch((err) => {
    setSafeText(elStatus, String(err?.message || err));
    elStatus.className = "small bad";
    elSendBackBtn.disabled = true;
  });
}

// Send back to parent
elSendBackBtn.addEventListener("click", () => {
  if (launchError || !worksheet) {
    setSafeText(elStatus, "Cannot send result: launch query is invalid.");
    elStatus.className = "small bad";
    return;
  }

  if (widgetControllers.length !== worksheet.q.length) {
    setSafeText(elStatus, "Cannot send result: answer widget initialization is incomplete.");
    elStatus.className = "small bad";
    return;
  }

  const payload = {
    type: "worksheetResult",
    rid,
    worksheet: {
      contractVersion: worksheet.contractVersion,
      v: worksheet.v,
      title: worksheet.title,
      q: worksheet.q,
      launchOptions: worksheet.launchOptions || null
    },
    answers: buildAnswersPayload(),
    meta: { sentAt: new Date().toISOString() }
  };

  if (!normalizedReturnOrigin) {
    setSafeText(elStatus, "Cannot send result: returnOrigin is missing or invalid.");
    elStatus.className = "small bad";
    return;
  }

  if (!window.opener) {
    setSafeText(elStatus, "No opener found (opened with noopener?). Cannot send back.");
    elStatus.className = "small bad";
    return;
  }

  const targetOrigin = normalizedReturnOrigin;
  window.opener.postMessage(payload, targetOrigin);
  setSafeText(elStatus, "Sent back to parent ✅");
  elStatus.className = "small ok";
});

document.getElementById("printBtn").addEventListener("click", () => window.print());
