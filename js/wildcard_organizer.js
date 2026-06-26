import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

const NODE_TYPE = "WildcardOrganizer";
const HIDDEN_WIDGETS = new Set([
  "search",
  "exclude_terms",
  "include_file_contents",
  "selected_wildcard",
  "manual_text",
  "prompt_parts_json",
  "separator",
  "seed",
  "expand_wildcards",
]);
const FAVORITES_KEY = "ComfyUI.WildcardOrganizer.favorites";
const ORGANIZER_HEIGHT = 760;
const ORGANIZER_DEFAULT_WIDTH = 920;

function getWidget(node, name) {
  return node.widgets?.find((widget) => widget.name === name);
}

function setWidgetValue(node, name, value) {
  const widget = getWidget(node, name);
  if (widget) {
    widget.value = value;
  }
}

function getParts(node) {
  const raw = getWidget(node, "prompt_parts_json")?.value || "[]";
  try {
    const parts = JSON.parse(raw);
    return Array.isArray(parts) ? parts.filter(isUsablePart) : [];
  } catch {
    return [];
  }
}

function setParts(node, parts) {
  setWidgetValue(node, "prompt_parts_json", JSON.stringify(parts.filter(isUsablePart)));
}

function parseParts(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed.filter(isUsablePart) : null;
  } catch {
    return null;
  }
}

function isUsablePart(part) {
  if (!part || typeof part !== "object") {
    return false;
  }
  if (part.wildcard || part.text) {
    return true;
  }
  return part.type === "choice" && Array.isArray(part.choices) && part.choices.some((choice) => choice?.wildcard);
}

function wildcardPart(item) {
  return {
    type: "wildcard",
    wildcard: item.wildcard,
    key: item.key,
    path: item.path,
    relative_path: item.relative_path,
  };
}

function partChoices(part) {
  if (part?.type === "choice") {
    return (part.choices || []).filter((choice) => choice?.wildcard).map(wildcardPart);
  }
  if (part?.wildcard) {
    return [wildcardPart(part)];
  }
  return [];
}

function partPrompt(part) {
  if (part?.type === "choice") {
    const options = partChoices(part).map((choice) => choice.wildcard).filter(Boolean);
    if (!options.length) {
      return "";
    }
    return options.length === 1 ? options[0] : `{${options.join(" | ")}}`;
  }
  if (part?.type === "text") {
    return String(part.text || "");
  }
  return String(part?.wildcard || "").trim();
}

function partTitle(part) {
  if (part?.type === "choice") {
    return partPrompt(part);
  }
  if (part?.type === "text") {
    return part.text || "Text";
  }
  return part?.wildcard || "";
}

function partSubtitle(part) {
  if (part?.type === "choice") {
    return `${partChoices(part).length} choices`;
  }
  return part?.relative_path || part?.key || "";
}

function buildPromptText(node, panel) {
  const separator = getWidget(node, "separator")?.value || ", ";
  const manual = (panel?.querySelector(".manual")?.value ?? getWidget(node, "manual_text")?.value ?? "").trim();
  const builderText = getParts(node).map(partPrompt).filter(Boolean).join(separator).trim();
  if (manual && builderText) {
    return `${manual}${separator}${builderText}`;
  }
  return manual || builderText;
}

function repairCorruptWidgetState(node) {
  const manualWidget = getWidget(node, "manual_text");
  const partsWidget = getWidget(node, "prompt_parts_json");
  setWidgetValue(node, "expand_wildcards", false);
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
    widget.computeSize = () => [0, -4];
    if (!widget._wildcardHiddenDrawHooked) {
      widget._wildcardOriginalDraw = widget.hasOwnProperty("draw") ? widget.draw : undefined;
      widget._wildcardHiddenDrawHooked = true;
    }
    widget.draw = () => {};
    if (widget.element) {
      widget.element.style.display = "none";
    }
  }
}

function ensureOrganizerWidget(node) {
  repairCorruptWidgetState(node);
  if (node.__wildcardOrganizerWidget) {
    return node.__wildcardOrganizerWidget;
  }

  const panel = createPanel(node);
  const widget = node.addDOMWidget("wildcard_organizer_ui", "wildcard_organizer_ui", panel, {
    serialize: false,
    hideOnZoom: false,
    getValue: () => "",
    setValue: () => {},
  });

  widget.computeSize = function (width) {
    const nodeWidth = node.size?.[0] || width || ORGANIZER_DEFAULT_WIDTH;
    const targetWidth = Math.max(360, nodeWidth - 30);
    panel.style.width = `${targetWidth}px`;
    panel.style.maxWidth = `${targetWidth}px`;
    return [targetWidth, ORGANIZER_HEIGHT];
  };

  node.__wildcardOrganizerWidget = widget;
  node.__wildcardOrganizerPanel = panel;
  return widget;
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
      .wildcard-organizer {
        box-sizing: border-box;
        display: flex;
        flex-direction: column;
        gap: 6px;
        width: 100%;
        min-width: 360px;
        height: ${ORGANIZER_HEIGHT - 12}px;
        padding: 8px;
        overflow-y: hidden;
        overflow-x: hidden;
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
      .wildcard-organizer .joiner-input {
        flex: 0 0 76px;
      }
      .wildcard-organizer .text-part-input {
        flex: 1 1 120px;
        min-width: 90px;
      }
      .wildcard-organizer .label {
        color: #b9c0cc;
        font-weight: 700;
      }
      .wildcard-organizer .search-results {
        min-height: 180px;
        flex: 2 1 250px;
      }
      .wildcard-organizer .parts {
        min-height: 150px;
        flex: 1.35 1 190px;
      }
      .wildcard-organizer .preview {
        min-height: 150px;
        flex: 1 1 170px;
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
      .wildcard-organizer .part.choice {
        background: #26303a;
      }
      .wildcard-organizer .part.choice strong::before {
        content: "{ } ";
        color: #9ad5ff;
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
    <div class="filter-grid">
      <input class="search-input" type="text" placeholder="Search filenames">
      <input class="exclude-input" type="text" placeholder="Exclude terms">
      <label class="check"><input class="contents-input" type="checkbox"> contents</label>
    </div>
    <div class="toolbar search-toolbar"></div>
    <div class="results search-results"></div>
    <div class="toolbar builder-toolbar"></div>
    <textarea class="manual" placeholder="Manual prompt text to prepend to the generated prompt"></textarea>
    <div class="parts results"></div>
    <div class="label">Preview / Final Prompt</div>
    <pre class="preview">Search for wildcards, add them to the builder, then group selected rows into choices.</pre>
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
    makeButton("Copy Prompt", () => copyPrompt(panel)),
    makeButton("Group Choice", () => groupSelectedParts(node, panel)),
    makeButton("Ungroup", () => ungroupSelectedParts(node, panel)),
    makeButton("Remove Selected", () => removeSelectedParts(node, panel)),
    makeButton("Clear", () => clearBuilder(node, panel)),
    Object.assign(document.createElement("input"), {
      className: "text-part-input",
      type: "text",
      placeholder: "Text part",
      title: "Literal text to add as a builder row",
    }),
    makeButton("Add Text", () => addTextPart(node, panel)),
    Object.assign(document.createElement("input"), {
      className: "joiner-input",
      type: "text",
      title: "Prompt joiner",
      value: getWidget(node, "separator")?.value || ", ",
    }),
    Object.assign(document.createElement("div"), { className: "status", textContent: "Builder" })
  );

  const joiner = panel.querySelector(".joiner-input");
  joiner.addEventListener("input", () => {
    setWidgetValue(node, "separator", joiner.value);
    updateFinalPrompt(node, panel);
  });
  const textPartInput = panel.querySelector(".text-part-input");
  textPartInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      addTextPart(node, panel);
    }
  });

  const manual = panel.querySelector(".manual");
  manual.value = getWidget(node, "manual_text")?.value || "";
  manual.addEventListener("input", () => {
    setWidgetValue(node, "manual_text", manual.value);
    updateFinalPrompt(node, panel);
  });

  renderParts(node, panel, false);
  updateFinalPrompt(node, panel, false);
  return panel;
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
  parts.push(wildcardPart(selected));
  setParts(node, parts);
  renderParts(node, panel, true);
  statusEl.textContent = `Added ${selected.wildcard}`;
}

function addTextPart(node, panel) {
  const input = panel.querySelector(".text-part-input");
  const statusEl = panel.querySelector(".builder-toolbar .status");
  const text = input?.value || "";
  if (!text.trim()) {
    statusEl.textContent = "Type a text part first";
    return;
  }

  const parts = getParts(node);
  parts.push({ type: "text", text });
  setParts(node, parts);
  if (input) {
    input.value = "";
  }
  renderParts(node, panel, true);
  statusEl.textContent = `Added text`;
}

function renderParts(node, panel, showPrompt = false) {
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
    updateFinalPrompt(node, panel, showPrompt);
    return;
  }

  parts.forEach((part, index) => {
    const row = document.createElement("div");
    row.className = "part";
    row.classList.toggle("choice", part.type === "choice");
    row.draggable = true;
    row.dataset.index = String(index);
    row.classList.toggle("selected", panel._selectedPartIndexes.has(index));
    row.innerHTML = `<strong></strong><span></span>`;
    row.querySelector("strong").textContent = partTitle(part);
    row.querySelector("span").textContent = partSubtitle(part);

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
      renderParts(node, panel, true);
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
      renderParts(node, panel, false);
    });

    row.addEventListener("dblclick", () => {
      const updated = getParts(node);
      updated.splice(index, 1);
      setParts(node, updated);
      panel._selectedPartIndexes = new Set();
      renderParts(node, panel, true);
    });

    partsEl.append(row);
  });

  updateFinalPrompt(node, panel, showPrompt);
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
  renderParts(node, panel, true);
  statusEl.textContent = `Removed ${selected.length} item${selected.length === 1 ? "" : "s"}`;
}

function groupSelectedParts(node, panel) {
  const selected = [...(panel._selectedPartIndexes || new Set())].sort((a, b) => a - b);
  const statusEl = panel.querySelector(".builder-toolbar .status");
  if (selected.length < 2) {
    statusEl.textContent = "Select two or more builder rows";
    return;
  }

  const parts = getParts(node);
  const choices = selected.flatMap((index) => partChoices(parts[index]));
  if (choices.length < 2) {
    statusEl.textContent = "Need at least two wildcard choices";
    return;
  }

  const firstIndex = selected[0];
  const selectedSet = new Set(selected);
  const updated = parts.filter((_, index) => !selectedSet.has(index));
  updated.splice(firstIndex, 0, { type: "choice", choices });
  setParts(node, updated);
  panel._selectedPartIndexes = new Set([firstIndex]);
  renderParts(node, panel, true);
  statusEl.textContent = `Grouped ${choices.length} choices`;
}

function ungroupSelectedParts(node, panel) {
  const selected = [...(panel._selectedPartIndexes || new Set())].sort((a, b) => b - a);
  const statusEl = panel.querySelector(".builder-toolbar .status");
  if (!selected.length) {
    statusEl.textContent = "Select a choice group first";
    return;
  }

  const parts = getParts(node);
  let changed = 0;
  for (const index of selected) {
    const part = parts[index];
    if (part?.type !== "choice") {
      continue;
    }
    parts.splice(index, 1, ...partChoices(part));
    changed += 1;
  }

  if (!changed) {
    statusEl.textContent = "Selected rows are not choice groups";
    return;
  }

  setParts(node, parts);
  panel._selectedPartIndexes = new Set();
  renderParts(node, panel, true);
  statusEl.textContent = `Ungrouped ${changed} choice group${changed === 1 ? "" : "s"}`;
}

function updateFinalPrompt(node, panel, showPreview = true) {
  const manual = panel.querySelector(".manual")?.value || "";
  setWidgetValue(node, "manual_text", manual);
  const prompt = buildPromptText(node, panel);
  panel._lastPrompt = prompt;
  if (showPreview) {
    panel.querySelector(".preview").textContent = prompt || "No prompt text yet.";
  }
}

async function copyPrompt(panel) {
  const prompt = panel._lastPrompt || panel.querySelector(".preview").textContent || "";
  await navigator.clipboard.writeText(prompt);
  panel.querySelector(".builder-toolbar .status").textContent = "Copied final prompt";
}

function clearBuilder(node, panel) {
  setParts(node, []);
  panel._selectedPartIndexes = new Set();
  renderParts(node, panel, true);
  panel._lastPrompt = "";
  updateFinalPrompt(node, panel);
  panel.querySelector(".builder-toolbar .status").textContent = "Builder cleared";
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
      hideInternalWidgets(this);
      ensureOrganizerWidget(this);
      requestAnimationFrame(() => {
        if ((this.size?.[0] || 0) < ORGANIZER_DEFAULT_WIDTH) {
          this.size[0] = ORGANIZER_DEFAULT_WIDTH;
        }
        this.setSize?.([this.size[0], this.computeSize?.()?.[1] || ORGANIZER_HEIGHT + 150]);
      });
    };

    const onRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      this.__wildcardOrganizerPanel = null;
      this.__wildcardOrganizerWidget = null;
      return onRemoved?.apply(this, arguments);
    };
  },
});
