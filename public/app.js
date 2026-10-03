const $ = (selector) => document.querySelector(selector);
const state = {
  captures: [],
  selectedId: null,
  targets: [],
  detail: null,
  refreshTimer: null,
};

function setStatus(message, kind = "") {
  const element = $("#status-message");
  element.textContent = message;
  element.dataset.kind = kind;
}

async function requestJson(url, options) {
  const response = await fetch(url, {
    ...options,
    headers: { ...(options?.headers || {}) },
  });
  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json")
    ? await response.json()
    : null;
  if (!response.ok)
    throw new Error(
      payload?.error ||
        payload?.replay?.error ||
        `Request failed (${response.status}).`,
    );
  return payload;
}

function filters() {
  const query = new URLSearchParams();
  for (const name of ["q", "endpoint", "method"]) {
    const value = $(
      `#${name === "q" ? "search-filter" : `${name}-filter`}`,
    ).value.trim();
    if (value) query.set(name, value);
  }
  return query;
}

function renderHistory() {
  const list = $("#history-list");
  list.replaceChildren();
  $("#capture-count").textContent =
    `${state.captures.length} ${state.captures.length === 1 ? "request" : "requests"}`;
  $("#history-empty").hidden = state.captures.length !== 0;
  for (const capture of state.captures) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `history-item${capture.id === state.selectedId ? " selected" : ""}`;
    button.setAttribute(
      "aria-current",
      capture.id === state.selectedId ? "true" : "false",
    );
    button.addEventListener("click", () => void loadDetail(capture.id));
    const top = document.createElement("span");
    top.className = "history-item-top";
    const method = document.createElement("span");
    method.className = `method-text method-${capture.method.toLowerCase()}`;
    method.textContent = capture.method;
    const date = document.createElement("time");
    date.dateTime = capture.receivedAt;
    date.textContent = new Date(capture.receivedAt).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    top.append(method, date);
    const path = document.createElement("span");
    path.className = "history-path";
    path.textContent =
      capture.path + (capture.rawQuery ? `?${capture.rawQuery}` : "");
    const bottom = document.createElement("span");
    bottom.className = "history-item-bottom";
    const endpoint = document.createElement("span");
    endpoint.textContent = `/${capture.endpoint}`;
    const size = document.createElement("span");
    size.textContent = `${capture.bodySize} B`;
    bottom.append(endpoint, size);
    button.append(top, path, bottom);
    list.append(button);
  }
}

function renderEndpointOptions() {
  const select = $("#endpoint-filter");
  const selected = select.value;
  const names = [
    ...new Set(state.captures.map((capture) => capture.endpoint)),
  ].sort();
  select.replaceChildren(new Option("All endpoints", ""));
  for (const name of names) select.add(new Option(`/${name}`, name));
  if (names.includes(selected)) select.value = selected;
}

function renderTargets() {
  const select = $("#target-select");
  select.replaceChildren();
  if (state.targets.length === 0) {
    select.add(new Option("No targets configured", ""));
    $("#replay-help").textContent =
      "Ask the server owner to configure a loopback replay target.";
  } else {
    select.add(new Option("Choose local target", ""));
    for (const target of state.targets)
      select.add(new Option(target.label, target.id));
    $("#replay-help").textContent =
      "Only the server’s configured local targets are available.";
  }
  $("#replay-button").disabled =
    !state.detail || state.targets.length === 0 || !select.value;
}

function renderPairs(target, pairs, emptyLabel) {
  target.replaceChildren();
  if (pairs.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted compact-empty";
    empty.textContent = emptyLabel;
    target.append(empty);
    return;
  }
  for (const [name, value] of pairs) {
    const row = document.createElement("div");
    row.className = "key-value-row";
    const key = document.createElement("code");
    key.textContent = name;
    const content = document.createElement("span");
    content.textContent = value;
    row.append(key, content);
    target.append(row);
  }
}

function renderReplay(replay) {
  const box = $("#replay-result");
  box.replaceChildren();
  box.hidden = !replay;
  if (!replay) return;
  const heading = document.createElement("strong");
  heading.textContent = replay.error
    ? "Replay failed"
    : `Response ${replay.status} ${replay.statusText}`;
  const details = document.createElement("span");
  details.textContent =
    replay.error ||
    `Target: ${replay.targetLabel} · ${replay.durationMs} ms${replay.redirected ? " · Redirect returned but not followed" : ""}`;
  box.append(heading, details);
  if (replay.preview) {
    const preview = document.createElement("pre");
    preview.textContent =
      replay.preview +
      (replay.previewTruncated ? "\n…preview limited to 8 KiB" : "");
    box.append(preview);
  }
}

function renderDetail(capture) {
  state.detail = capture;
  state.selectedId = capture.id;
  $("#detail-empty").hidden = true;
  $("#detail-view").hidden = false;
  $("#detail-method").textContent = capture.method;
  $("#detail-method").className =
    `method-badge method-${capture.method.toLowerCase()}`;
  $("#detail-title-value").textContent =
    capture.path + (capture.rawQuery ? `?${capture.rawQuery}` : "");
  $("#detail-meta").textContent =
    `/${capture.endpoint} · ${new Date(capture.receivedAt).toLocaleString()} · ${capture.bodySize} bytes`;
  $("#query-count").textContent = capture.query.length;
  $("#header-count").textContent = capture.headers.length;
  $("#body-size").textContent = `${capture.bodySize} bytes`;
  renderPairs($("#query-table"), capture.query, "No query parameters");
  renderPairs(
    $("#header-table"),
    capture.headers.map(({ name, value }) => [name, value]),
    "No headers",
  );
  $("#body-content code").textContent =
    capture.bodyText === null
      ? `Binary payload · base64\n${capture.bodyBase64}`
      : capture.bodyText || "(empty body)";
  renderReplay(capture.replay);
  $("#replay-button").disabled =
    state.targets.length === 0 || !$("#target-select").value;
  renderHistory();
}

async function loadHistory(keepSelection = true) {
  try {
    const query = filters();
    query.set("limit", "100");
    const data = await requestJson(`/api/captures?${query}`);
    state.captures = data.captures;
    renderEndpointOptions();
    renderHistory();
    if (
      keepSelection &&
      state.selectedId &&
      state.captures.some((capture) => capture.id === state.selectedId)
    ) {
      await loadDetail(state.selectedId, false);
    } else if (
      !state.selectedId ||
      !state.captures.some((capture) => capture.id === state.selectedId)
    ) {
      state.selectedId = null;
      if (
        state.detail &&
        !state.captures.some((capture) => capture.id === state.detail.id)
      ) {
        state.detail = null;
        $("#detail-view").hidden = true;
        $("#detail-empty").hidden = false;
      }
    }
  } catch (error) {
    setStatus(error.message, "error");
  }
}

async function loadDetail(id, updateHistory = true) {
  try {
    const data = await requestJson(`/api/captures/${encodeURIComponent(id)}`);
    renderDetail(data.capture);
    if (updateHistory) setStatus("Capture loaded.", "success");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

async function refreshTargets() {
  try {
    const data = await requestJson("/api/targets");
    state.targets = data.targets;
    renderTargets();
  } catch (error) {
    setStatus(error.message, "error");
  }
}

$("#filters").addEventListener("submit", (event) => {
  event.preventDefault();
  void loadHistory(false);
});
for (const id of ["search-filter", "endpoint-filter", "method-filter"]) {
  $(`#${id}`).addEventListener(
    id === "search-filter" ? "input" : "change",
    () => {
      clearTimeout(state.refreshTimer);
      state.refreshTimer = setTimeout(
        () => void loadHistory(false),
        id === "search-filter" ? 200 : 0,
      );
    },
  );
}
$("#refresh-button").addEventListener("click", () => {
  void loadHistory();
  setStatus("History refreshed.", "success");
});
$("#delete-button").addEventListener("click", async () => {
  if (!state.detail || !window.confirm("Delete this captured request?")) return;
  try {
    await requestJson(`/api/captures/${encodeURIComponent(state.detail.id)}`, {
      method: "DELETE",
    });
    state.selectedId = null;
    state.detail = null;
    $("#detail-view").hidden = true;
    $("#detail-empty").hidden = false;
    await loadHistory(false);
    setStatus("Capture deleted.", "success");
  } catch (error) {
    setStatus(error.message, "error");
  }
});
$("#replay-button").addEventListener("click", async () => {
  if (!state.detail || !$("#target-select").value) return;
  $("#replay-button").disabled = true;
  setStatus("Sending replay to the configured local target…");
  try {
    const data = await requestJson(
      `/api/captures/${encodeURIComponent(state.detail.id)}/replay`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetId: $("#target-select").value }),
      },
    );
    renderReplay(data.replay);
    state.detail.replay = data.replay;
    setStatus("Replay completed.", "success");
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    $("#replay-button").disabled =
      state.targets.length === 0 || !$("#target-select").value;
  }
});
$("#target-select").addEventListener("change", () => {
  $("#replay-button").disabled = !state.detail || !$("#target-select").value;
});
$("#copy-body").addEventListener("click", async () => {
  const text = state.detail?.bodyText ?? state.detail?.bodyBase64 ?? "";
  try {
    await navigator.clipboard.writeText(text);
    setStatus("Body copied.", "success");
  } catch {
    setStatus("Clipboard is unavailable in this browser context.", "error");
  }
});

async function loadHealth() {
  try {
    const data = await requestJson("/api/health");
    $("#capture-url").textContent = `${window.location.origin}/hooks/<name>`;
    $(".capture-address p").textContent =
      `Any HTTP method · ${data.maxBodyBytes.toLocaleString()} byte body limit`;
  } catch (error) {
    setStatus(error.message, "error");
  }
}

await loadHealth();
await refreshTargets();
await loadHistory(false);
window.setInterval(() => void loadHistory(), 5000);
