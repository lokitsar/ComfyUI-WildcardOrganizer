import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

const NODE_TYPE = "WildcardOrganizer";
const HIDDEN_WIDGETS = new Set(["search", "exclude_terms", "include_file_contents", "selected_wildcard", "manual_text", "prompt_parts_json"]);
const PANEL_STATE_KEY = "ComfyUI.WildcardOrganizer.panelState";
const FAVORITES_KEY = "ComfyUI.WildcardOrganizer.favorites";
const DEFAULT_PANEL_STATE = {
  left: 80,
  top: 80,
  width: 760,
  height: 720,
  collapsed: false,
};

function getWidget(node, name) {
  return node.widgets?.find((widget) => widget.name === name);
}

function setWidgetValue(node, name, value) {
  const widget = getWidget(node, name);
  if (widget) {
    widget.value = value;
  }
}

function boolValue(value) {
  if (typeof value === "string") {
    return ["1", "true", "yes", "on"].includes(value.toLowerCase());
  }
  return Boolean(value);
}

function getParts(node) {
  const raw = getWidget(node, "prompt_parts_json")?.value || "[]";
  try {
    const parts = JSON.parse(raw);
    return Array.isArray(parts) ? parts : [];
  } catch {
    return [];
  }
}

function setParts(node, parts) {
  setWidgetValue(node, "prompt_parts_json", JSON.stringify(parts));
}

function parseParts(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item === "object" && item.wildcard) : null;
  } catch {
    return null;
  }
}

function repairCorruptWidgetState(node) {
  const manualWidget = getWidget(node, "manual_text");
  const partsWidget = getWidget(node, "prompt_parts_json");
  const manual = String(manualWidget?.value || "").trim();
  const partsRaw = String(partsWidget?.value || "").trim();
  const manualParts = parseParts(manual);
  const currentParts = parseParts(partsRaw);

  if (manualParts?.length) {
    if (!currentParts?.length) {
      setParts(node, manualParts);
    }
    setWidgetValue(node, "manual_text", "");
  }

  if (!manualParts?.length && partsRaw && !currentParts && /^__.+__$/.test(partsRaw)) {
    setParts(node, []);
  }
}

function loadFavorites() {
  try {
    const favorites = JSON.parse(localStorage.getItem(FAVORITES_KEY) || "{}");
    return favorites && typeof favorites === "object" && !Array.isArray(favorites) ? favorites : {};
  } catch {
    return {};
  }
}

function saveFavorites(favorites) {
  localStorage.setItem(FAVORITES_KEY, JSON.stringify(favorites));
}

function favoriteId(item) {
  return item?.wildcard || item?.key || "";
}

function isFavorite(item) {
  const id = favoriteId(item);
  return Boolean(id && loadFavorites()[id]);
}

function toggleFavorite(item) {
  const id = favoriteId(item);
  if (!id) {
    return false;
  }
  const favorites = loadFavorites();
  if (favorites[id]) {
    delete favorites[id];
  } else {
    favorites[id] = {
      wildcard: item.wildcard,
      key: item.key,
      path: item.path,
      relative_path: item.relative_path,
      kind: item.kind,
    };
  }
  saveFavorites(favorites);
  return Boolean(favorites[id]);
}

function favoriteItems() {
  return Object.values(loadFavorites()).sort((a, b) => String(a.wildcard).localeCompare(String(b.wildcard)));
}

function hideInternalWidgets(node) {
  for (const widget of node.widgets || []) {
    if (!HIDDEN_WIDGETS.has(widget.name)) {
      continue;
    }
    widget.hidden = true;
    widget.options = widget.options || {};
    widget.options.hidden = true;
    widget.computeSize = () => [0, 0];
    if (widget.element) {
      widget.element.style.display = "none";
    }
  }
}

function loadPanelState() {
  try {
    return { ...DEFAULT_PANEL_STATE, ...(JSON.parse(localStorage.getItem(PANEL_STATE_KEY) || "{}")) };
  } catch {
    return { ...DEFAULT_PANEL_STATE };
  }
}

function savePanelState(panel) {
  const state = {
    left: panel.offsetLeft,
    top: panel.offsetTop,
    width: panel.offsetWidth,
    height: panel.offsetHeight,
    collapsed: panel.classList.contains("is-collapsed"),
  };
  localStorage.setItem(PANEL_STATE_KEY, JSON.stringify(state));
}

function applyPanelState(panel, state = loadPanelState()) {
  const maxLeft = Math.max(8, window.innerWidth - 80);
  const maxTop = Math.max(8, window.innerHeight - 60);
  panel.style.left = `${Math.min(Math.max(8, state.left), maxLeft)}px`;
  panel.style.top = `${Math.min(Math.max(8, state.top), maxTop)}px`;
  panel.style.width = `${Math.max(380, state.width)}px`;
  panel.style.height = `${Math.max(46, state.height)}px`;
  panel.classList.toggle("is-collapsed", Boolean(state.collapsed));
}

function ensureOrganizerPanel(node) {
  repairCorruptWidgetState(node);
  if (node.__wildcardOrganizerPanel?.isConnected) {
    node.__wildcardOrganizerPanel.style.display = "flex";
    applyPanelState(node.__wildcardOrganizerPanel);
    return node.__wildcardOrganizerPanel;
  }

  const panel = createPanel(node);
  panel.classList.add("wildcard-organizer-floating");
  document.body.append(panel);
  applyPanelState(panel);
  node.__wildcardOrganizerPanel = panel;
  return panel;
}

function makeButton(label, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

function createPanel(node) {
  repairCorruptWidgetState(node);
  const panel = document.createElement("div");
  panel.className = "wildcard-organizer";
  panel.innerHTML = `
    <style>
      .wildcard-organizer-floating {
        position: fixed;
        z-index: 10020;
        left: 80px;
        top: 80px;
        box-shadow: 0 18px 50px rgba(0, 0, 0, 0.45);
      }
      .wildcard-organizer {
        box-sizing: border-box;
        display: flex;
        flex-direction: column;
        gap: 6px;
        width: 760px;
        min-width: 380px;
        max-width: calc(100vw - 48px);
        height: 720px;
        max-height: calc(100vh - 48px);
        padding: 8px;
        overflow-y: auto;
        overflow-x: hidden;
        resize: both;
        color: #ddd;
        background: #202124;
        border: 1px solid #3a3a3a;
        border-radius: 6px;
        font: 12px/1.35 Arial, sans-serif;
      }
      .wildcard-organizer button {
        height: 30px;
        padding: 0 10px;
        color: #eee;
        background: #35373d;
        border: 1px solid #555862;
        border-radius: 4px;
        cursor: pointer;
      }
      .wildcard-organizer button:hover { background: #434650; }
      .wildcard-organizer .panel-titlebar {
        display: flex;
        align-items: center;
        gap: 8px;
        min-height: 28px;
        cursor: move;
        user-select: none;
      }
      .wildcard-organizer .panel-title {
        flex: 1;
        color: #d9dde6;
        font-weight: 700;
      }
      .wildcard-organizer .panel-action {
        width: 30px;
        padding: 0;
      }
      .wildcard-organizer.is-collapsed {
        width: 260px !important;
        height: 46px !important;
        min-width: 220px;
        resize: none;
        overflow: hidden;
      }
      .wildcard-organizer.is-collapsed .filter-grid,
      .wildcard-organizer.is-collapsed .search-toolbar,
      .wildcard-organizer.is-collapsed .search-results,
      .wildcard-organizer.is-collapsed .builder-toolbar,
      .wildcard-organizer.is-collapsed .manual,
      .wildcard-organizer.is-collapsed .parts,
      .wildcard-organizer.is-collapsed .label,
      .wildcard-organizer.is-collapsed .preview {
        display: none;
      }
      .wildcard-organizer .filter-grid {
        display: grid;
        grid-template-columns: minmax(140px, 1fr) minmax(140px, 1fr) auto;
        gap: 6px;
        align-items: center;
      }
      .wildcard-organizer input[type="text"] {
        box-sizing: border-box;
        width: 100%;
        height: 30px;
        padding: 0 8px;
        color: #eee;
        background: #151619;
        border: 1px solid #33363d;
        border-radius: 4px;
        font: 12px/1.35 Arial, sans-serif;
      }
      .wildcard-organizer .check {
        display: flex;
        gap: 6px;
        align-items: center;
        min-height: 30px;
        color: #b9c0cc;
        white-space: nowrap;
      }
      .wildcard-organizer textarea {
        box-sizing: border-box;
        width: 100%;
        min-height: 78px;
        resize: vertical;
        padding: 8px;
        color: #eee;
        background: #151619;
        border: 1px solid #33363d;
        border-radius: 4px;
        font: 12px/1.35 Arial, sans-serif;
      }
      .wildcard-organizer .toolbar {
        display: flex;
        gap: 6px;
        align-items: center;
        min-height: 30px;
      }
      .wildcard-organizer .status {
        min-width: 0;
        flex: 1;
        overflow: hidden;
        color: #aaa;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .wildcard-organizer .label {
        color: #b9c0cc;
        font-weight: 700;
      }
      .wildcard-organizer .search-results {
        min-height: 180px;
        flex: 2 1 260px;
      }
      .wildcard-organizer .parts {
        min-height: 150px;
        flex: 1.5 1 220px;
      }
      .wildcard-organizer .preview {
        min-height: 150px;
        flex: 1.2 1 190px;
      }
      .wildcard-organizer .results {
        min-height: 0;
        overflow-y: scroll;
        overflow-x: hidden;
        border: 1px solid #33363d;
        border-radius: 4px;
        scrollbar-color: #727987 #17191d;
        scrollbar-width: auto;
      }
      .wildcard-organizer .results::-webkit-scrollbar {
        width: 14px;
      }
      .wildcard-organizer .results::-webkit-scrollbar-track {
        background: #17191d;
      }
      .wildcard-organizer .results::-webkit-scrollbar-thumb {
        background: #727987;
        border: 3px solid #17191d;
        border-radius: 8px;
      }
      .wildcard-organizer .results::-webkit-scrollbar-thumb:hover {
        background: #8b94a5;
      }
      .wildcard-organizer .result,
      .wildcard-organizer .part {
        display: block;
        width: 100%;
        min-height: 50px;
        padding: 8px 10px;
        color: #ddd;
        text-align: left;
        background: transparent;
        border: 0;
        border-bottom: 1px solid #33363d;
        border-radius: 0;
      }
      .wildcard-organizer .result.selected { background: #2f405e; }
      .wildcard-organizer .result.is-favorite strong::before {
        content: "* ";
        color: #ffd166;
      }
      .wildcard-organizer .part {
        cursor: grab;
        background: #24272d;
      }
      .wildcard-organizer .part.selected {
        background: #3a4f73;
        outline: 1px solid #8fb5ff;
        outline-offset: -1px;
      }
      .wildcard-organizer .part.dragging {
        opacity: 0.45;
      }
      .wildcard-organizer .part strong,
      .wildcard-organizer .part span,
      .wildcard-organizer .result strong,
      .wildcard-organizer .result span {
        display: block;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .wildcard-organizer .part strong,
      .wildcard-organizer .result strong {
        margin-bottom: 4px;
        font-size: 13px;
        line-height: 1.25;
      }
      .wildcard-organizer .part span,
      .wildcard-organizer .result span {
        font-size: 11px;
        line-height: 1.25;
      }
      .wildcard-organizer .part span,
      .wildcard-organizer .result span { color: #aeb4bf; }
      .wildcard-organizer .preview {
        min-height: 0;
        margin: 0;
        padding: 8px;
        overflow: auto;
        color: #e6e6e6;
        background: #151619;
        border: 1px solid #33363d;
        border-radius: 4px;
        white-space: pre-wrap;
      }
    </style>
    <div class="panel-titlebar">
      <div class="panel-title">Wildcard Organizer</div>
      <button class="panel-minimize panel-action" type="button" title="Minimize">-</button>
      <button class="panel-size panel-action" type="button" title="Toggle size">□</button>
      <button class="panel-close panel-action" type="button" title="Close">x</button>
    </div>
    <div class="filter-grid">
      <input class="search-input" type="text" placeholder="Search filenames">
      <input class="exclude-input" type="text" placeholder="Exclude terms">
      <label class="check"><input class="contents-input" type="checkbox"> contents</label>
    </div>
    <div class="toolbar search-toolbar"></div>
    <div class="results search-results"></div>
    <div class="toolbar builder-toolbar"></div>
    <textarea class="manual" placeholder="Manual prompt text to prepend to the generated wildcard prompt"></textarea>
    <div class="parts results"></div>
    <div class="label">Preview / Final Prompt</div>
    <pre class="preview">Search for wildcards, add them to the builder, drag to reorder, then run.</pre>
  `;

  const toolbar = panel.querySelector(".search-toolbar");
  const builderToolbar = panel.querySelector(".builder-toolbar");
  const status = document.createElement("div");
  status.className = "status";
  status.textContent = "Ready";

  toolbar.append(
    makeButton("Search", () => runSearch(node, panel)),
    makeButton("Refresh Index", () => refreshIndex(node, panel)),
    makeButton("Favorites", () => showFavorites(node, panel)),
    makeButton("Star", () => starSelected(node, panel)),
    makeButton("Add", () => addSelected(node, panel)),
    makeButton("Copy Token", () => copySelected(node, panel)),
    status
  );

  const searchInput = panel.querySelector(".search-input");
  const excludeInput = panel.querySelector(".exclude-input");
  const contentsInput = panel.querySelector(".contents-input");
  searchInput.value = getWidget(node, "search")?.value || "";
  excludeInput.value = getWidget(node, "exclude_terms")?.value || "";
  contentsInput.checked = Boolean(getWidget(node, "include_file_contents")?.value);
  const syncFilters = () => {
    setWidgetValue(node, "search", searchInput.value);
    setWidgetValue(node, "exclude_terms", excludeInput.value);
    setWidgetValue(node, "include_file_contents", contentsInput.checked);
  };
  searchInput.addEventListener("input", syncFilters);
  excludeInput.addEventListener("input", syncFilters);
  contentsInput.addEventListener("change", syncFilters);
  for (const input of [searchInput, excludeInput]) {
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        syncFilters();
        runSearch(node, panel);
      }
    });
  }

  builderToolbar.append(
    makeButton("Run", () => runBuilder(node, panel)),
    makeButton("Copy Prompt", () => copyPrompt(panel)),
    makeButton("Remove Selected", () => removeSelectedParts(node, panel)),
    makeButton("Clear", () => clearBuilder(node, panel)),
    Object.assign(document.createElement("div"), { className: "status", textContent: "Builder" })
  );

  const manual = panel.querySelector(".manual");
  manual.value = getWidget(node, "manual_text")?.value || "";
  manual.addEventListener("input", () => setWidgetValue(node, "manual_text", manual.value));
  panel.querySelector(".panel-minimize").addEventListener("click", () => toggleCollapsed(panel));
  panel.querySelector(".panel-size").addEventListener("click", () => togglePanelSize(panel));
  panel.querySelector(".panel-close").addEventListener("click", () => {
    panel.style.display = "none";
    savePanelState(panel);
  });
  attachFloatingDrag(panel);
  attachResizeObserver(panel);

  renderParts(node, panel);
  return panel;
}

function toggleCollapsed(panel) {
  panel.classList.toggle("is-collapsed");
  savePanelState(panel);
}

function togglePanelSize(panel) {
  panel.classList.remove("is-collapsed");
  const large = panel.offsetWidth < 900 || panel.offsetHeight < 780;
  if (large) {
    panel.style.width = `${Math.min(window.innerWidth - 48, 1040)}px`;
    panel.style.height = `${Math.min(window.innerHeight - 48, 860)}px`;
  } else {
    panel.style.width = `${DEFAULT_PANEL_STATE.width}px`;
    panel.style.height = `${DEFAULT_PANEL_STATE.height}px`;
  }
  savePanelState(panel);
}

function attachResizeObserver(panel) {
  if (panel.__wildcardResizeObserver) {
    return;
  }
  let saveTimer = null;
  panel.__wildcardResizeObserver = new ResizeObserver(() => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => savePanelState(panel), 150);
  });
  panel.__wildcardResizeObserver.observe(panel);
}

function attachFloatingDrag(panel) {
  const handle = panel.querySelector(".panel-titlebar");
  if (!handle) {
    return;
  }

  handle.addEventListener("pointerdown", (event) => {
    if (event.target.closest("button")) {
      return;
    }
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const startLeft = panel.offsetLeft;
    const startTop = panel.offsetTop;
    handle.setPointerCapture(event.pointerId);

    const move = (moveEvent) => {
      panel.style.left = `${Math.max(8, startLeft + moveEvent.clientX - startX)}px`;
      panel.style.top = `${Math.max(8, startTop + moveEvent.clientY - startY)}px`;
    };
    const up = (upEvent) => {
      handle.releasePointerCapture(upEvent.pointerId);
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      savePanelState(panel);
    };

    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  });
}

function queryParams(node, panel, refresh = false) {
  const root = getWidget(node, "wildcard_folder")?.value || "";
  const query = panel?.querySelector(".search-input")?.value ?? getWidget(node, "search")?.value ?? "";
  const exclude = panel?.querySelector(".exclude-input")?.value ?? getWidget(node, "exclude_terms")?.value ?? "";
  const includeContents = panel?.querySelector(".contents-input")?.checked ?? Boolean(getWidget(node, "include_file_contents")?.value);
  return new URLSearchParams({
    root,
    query,
    exclude,
    include_contents: includeContents ? "true" : "false",
    refresh: refresh ? "true" : "false",
  });
}

async function fetchJson(path) {
  const response = await api.fetchApi(path);
  const data = await response.json();
  if (!response.ok || data.error) {
    throw new Error(data.error || response.statusText);
  }
  return data;
}

async function postJson(path, body) {
  const response = await api.fetchApi(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok || data.error) {
    throw new Error(data.error || response.statusText);
  }
  return data;
}

async function runSearch(node, panel) {
  const resultsEl = panel.querySelector(".search-results");
  const previewEl = panel.querySelector(".preview");
  const statusEl = panel.querySelector(".search-toolbar .status");
  statusEl.textContent = "Searching...";
  resultsEl.replaceChildren();
  setWidgetValue(node, "search", panel.querySelector(".search-input")?.value || "");
  setWidgetValue(node, "exclude_terms", panel.querySelector(".exclude-input")?.value || "");
  setWidgetValue(node, "include_file_contents", Boolean(panel.querySelector(".contents-input")?.checked));

  try {
    const data = await fetchJson(`/wildcard_organizer/search?${queryParams(node, panel)}`);
    const indexInfo = data.index ? ` from ${data.index.entry_count} indexed` : "";
    statusEl.textContent = `${data.results.length} result${data.results.length === 1 ? "" : "s"}${indexInfo}`;

    renderSearchResults(node, panel, data.results);

    previewEl.textContent = data.results.length ? "Select a wildcard to preview it." : "No wildcard files matched.";
  } catch (error) {
    statusEl.textContent = "Error";
    previewEl.textContent = error.message;
  }
}

function renderSearchResults(node, panel, results) {
  const resultsEl = panel.querySelector(".search-results");
  resultsEl.replaceChildren();

  for (const result of results) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "result";
    row.classList.toggle("is-favorite", isFavorite(result));
    row.innerHTML = `<strong></strong><span></span>`;
    row.querySelector("strong").textContent = result.wildcard;
    row.querySelector("span").textContent = result.relative_path;
    row.addEventListener("click", () => selectResult(node, panel, row, result));
    resultsEl.append(row);
  }
}

function showFavorites(node, panel) {
  const favorites = favoriteItems();
  const statusEl = panel.querySelector(".search-toolbar .status");
  renderSearchResults(node, panel, favorites);
  statusEl.textContent = `${favorites.length} favorite${favorites.length === 1 ? "" : "s"}`;
  panel.querySelector(".preview").textContent = favorites.length ? "Showing favorites." : "No favorites yet.";
}

function starSelected(node, panel) {
  const selected = panel._selectedWildcard;
  const statusEl = panel.querySelector(".search-toolbar .status");
  if (!selected) {
    statusEl.textContent = "Select a wildcard first";
    return;
  }

  const starred = toggleFavorite(selected);
  for (const row of panel.querySelectorAll(".result")) {
    if (row.querySelector("strong")?.textContent === selected.wildcard) {
      row.classList.toggle("is-favorite", starred);
    }
  }
  statusEl.textContent = starred ? `Starred ${selected.wildcard}` : `Unstarred ${selected.wildcard}`;
}

async function refreshIndex(node, panel) {
  const statusEl = panel.querySelector(".search-toolbar .status");
  statusEl.textContent = "Indexing...";
  setWidgetValue(node, "search", panel.querySelector(".search-input")?.value || "");
  setWidgetValue(node, "exclude_terms", panel.querySelector(".exclude-input")?.value || "");
  setWidgetValue(node, "include_file_contents", Boolean(panel.querySelector(".contents-input")?.checked));

  try {
    const root = getWidget(node, "wildcard_folder")?.value || "";
    const includeContents = Boolean(panel.querySelector(".contents-input")?.checked);
    const params = new URLSearchParams({
      root,
      include_contents: includeContents ? "true" : "false",
    });
    const data = await fetchJson(`/wildcard_organizer/refresh_index?${params}`);
    const index = data.index || {};
    statusEl.textContent = `Indexed ${index.entry_count || 0} entries in ${index.file_count || 0} files`;
    await runSearch(node, panel);
  } catch (error) {
    statusEl.textContent = "Index error";
    panel.querySelector(".preview").textContent = error.message;
  }
}

async function selectResult(node, panel, row, result) {
  for (const item of panel.querySelectorAll(".result")) {
    item.classList.remove("selected");
  }
  row.classList.add("selected");
  panel._selectedWildcard = result;
  setWidgetValue(node, "selected_wildcard", result.wildcard);

  const root = getWidget(node, "wildcard_folder")?.value || "";
  const previewEl = panel.querySelector(".preview");
  if (!result.path) {
    previewEl.textContent = "This favorite is missing its source path. Refresh search results and star it again.";
    return;
  }
  const params = new URLSearchParams({ root, path: result.path, key: result.key });
  previewEl.textContent = "Loading preview...";

  try {
    const data = await fetchJson(`/wildcard_organizer/preview?${params}`);
    previewEl.textContent = data.selected_preview || data.content || "File is empty.";
  } catch (error) {
    previewEl.textContent = error.message;
  }
}

function addSelected(node, panel) {
  const selected = panel._selectedWildcard;
  const statusEl = panel.querySelector(".search-toolbar .status");
  if (!selected) {
    statusEl.textContent = "Select a wildcard first";
    return;
  }

  const parts = getParts(node);
  parts.push({
    wildcard: selected.wildcard,
    key: selected.key,
    path: selected.path,
    relative_path: selected.relative_path,
  });
  setParts(node, parts);
  renderParts(node, panel);
  statusEl.textContent = `Added ${selected.wildcard}`;
}

function renderParts(node, panel) {
  const partsEl = panel.querySelector(".parts");
  partsEl.replaceChildren();
  const parts = getParts(node);
  panel._selectedPartIndexes = panel._selectedPartIndexes || new Set();
  panel._selectedPartIndexes = new Set([...panel._selectedPartIndexes].filter((index) => index >= 0 && index < parts.length));

  if (!parts.length) {
    panel._selectedPartIndexes.clear();
    const empty = document.createElement("div");
    empty.className = "part";
    empty.textContent = "No wildcard parts yet.";
    partsEl.append(empty);
    return;
  }

  parts.forEach((part, index) => {
    const row = document.createElement("div");
    row.className = "part";
    row.draggable = true;
    row.dataset.index = String(index);
    row.classList.toggle("selected", panel._selectedPartIndexes.has(index));
    row.innerHTML = `<strong></strong><span></span>`;
    row.querySelector("strong").textContent = part.wildcard;
    row.querySelector("span").textContent = part.relative_path || part.key || "";

    row.addEventListener("dragstart", (event) => {
      row.classList.add("dragging");
      event.dataTransfer.setData("text/plain", String(index));
      event.dataTransfer.effectAllowed = "move";
    });
    row.addEventListener("dragend", () => row.classList.remove("dragging"));
    row.addEventListener("dragover", (event) => event.preventDefault());
    row.addEventListener("drop", (event) => {
      event.preventDefault();
      const from = Number(event.dataTransfer.getData("text/plain"));
      const to = Number(row.dataset.index);
      if (!Number.isInteger(from) || !Number.isInteger(to) || from === to) {
        return;
      }
      const updated = getParts(node);
      const [moved] = updated.splice(from, 1);
      updated.splice(to, 0, moved);
      setParts(node, updated);
      panel._selectedPartIndexes = new Set([to]);
      renderParts(node, panel);
    });

    row.addEventListener("click", (event) => {
      const selected = panel._selectedPartIndexes || new Set();
      if (event.ctrlKey || event.metaKey || event.shiftKey) {
        if (selected.has(index)) {
          selected.delete(index);
        } else {
          selected.add(index);
        }
      } else {
        selected.clear();
        selected.add(index);
      }
      panel._selectedPartIndexes = selected;
      renderParts(node, panel);
    });

    row.addEventListener("dblclick", () => {
      const updated = getParts(node);
      updated.splice(index, 1);
      setParts(node, updated);
      panel._selectedPartIndexes = new Set();
      renderParts(node, panel);
    });

    partsEl.append(row);
  });
}

function removeSelectedParts(node, panel) {
  const selected = [...(panel._selectedPartIndexes || new Set())].sort((a, b) => b - a);
  const statusEl = panel.querySelector(".builder-toolbar .status");
  if (!selected.length) {
    statusEl.textContent = "Select builder items first";
    return;
  }

  const updated = getParts(node);
  for (const index of selected) {
    if (index >= 0 && index < updated.length) {
      updated.splice(index, 1);
    }
  }
  setParts(node, updated);
  panel._selectedPartIndexes = new Set();
  renderParts(node, panel);
  statusEl.textContent = `Removed ${selected.length} item${selected.length === 1 ? "" : "s"}`;
}

async function runBuilder(node, panel) {
  repairCorruptWidgetState(node);
  const previewEl = panel.querySelector(".preview");
  previewEl.textContent = "Building prompt...";

  const manual = panel.querySelector(".manual").value;
  setWidgetValue(node, "manual_text", manual);

  try {
    const data = await postJson("/wildcard_organizer/build", {
      root: getWidget(node, "wildcard_folder")?.value || "",
      parts_json: getWidget(node, "prompt_parts_json")?.value || "[]",
      manual_text: manual,
      separator: getWidget(node, "separator")?.value || ", ",
      seed: getWidget(node, "seed")?.value || 0,
      expand_wildcards: boolValue(getWidget(node, "expand_wildcards")?.value),
    });
    panel._lastPrompt = data.prompt;
    previewEl.textContent = data.prompt || "No prompt text yet.";
  } catch (error) {
    previewEl.textContent = error.message;
  }
}

async function copyPrompt(panel) {
  const prompt = panel._lastPrompt || panel.querySelector(".preview").textContent || "";
  await navigator.clipboard.writeText(prompt);
  panel.querySelector(".search-toolbar .status").textContent = "Copied final prompt";
}

function clearBuilder(node, panel) {
  setParts(node, []);
  panel._selectedPartIndexes = new Set();
  renderParts(node, panel);
  panel._lastPrompt = "";
  panel.querySelector(".preview").textContent = "Builder cleared.";
}

async function copySelected(node, panel) {
  const selected = panel._selectedWildcard;
  const statusEl = panel.querySelector(".search-toolbar .status");
  if (!selected) {
    statusEl.textContent = "Select a wildcard first";
    return;
  }

  await navigator.clipboard.writeText(selected.wildcard);
  setWidgetValue(node, "selected_wildcard", selected.wildcard);
  statusEl.textContent = `Copied ${selected.wildcard}`;
}

app.registerExtension({
  name: "WildcardOrganizer",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_TYPE) {
      return;
    }

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      onNodeCreated?.apply(this, arguments);
      const panel = createPanel(this);
      panel.remove();
      this.addWidget("button", "Open Organizer", null, () => {
        ensureOrganizerPanel(this);
      });
      hideInternalWidgets(this);
      this.setSize([360, this.computeSize?.()?.[1] || 260]);
    };

    const onRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      this.__wildcardOrganizerPanel?.remove?.();
      this.__wildcardOrganizerPanel = null;
      return onRemoved?.apply(this, arguments);
    };
  },
});
