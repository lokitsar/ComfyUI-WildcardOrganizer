import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

const NODE_TYPE = "PromptLineQueue";
const PANEL_HEIGHT = 660;
const PANEL_WIDTH = 760;
const HIDDEN_WIDGETS = new Set([
  "prompt_text",
  "current_index",
  "auto_advance",
  "wrap",
  "skip_blank_lines",
  "skip_comment_lines",
  "library_folder",
  "selected_file",
  "queue_save_name",
  "wildcard_folder",
  "wildcard_save_path",
  "reset_token",
]);

function getWidget(node, name) {
  return node.widgets?.find((widget) => widget.name === name);
}

function setWidgetValue(node, name, value) {
  const widget = getWidget(node, name);
  if (widget) {
    widget.value = value;
  }
}

function boolValue(value, defaultValue = false) {
  if (value === undefined || value === null) {
    return defaultValue;
  }
  if (typeof value === "string") {
    return ["1", "true", "yes", "on"].includes(value.toLowerCase());
  }
  return Boolean(value);
}

function promptLines(text, skipBlank, skipComments) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && (!skipComments || !line.startsWith("#")) && (skipBlank || line));
}

function clampIndex(index, count) {
  if (!count) {
    return 0;
  }
  return Math.max(0, Math.min(Number(index) || 0, count - 1));
}

function nextIndex(index, count, wrap) {
  if (!count) {
    return 0;
  }
  const next = index + 1;
  return next >= count ? (wrap ? 0 : count - 1) : next;
}

async function fetchJson(path, options) {
  const response = await api.fetchApi(path, options);
  const data = await response.json();
  if (!response.ok || data.error) {
    throw new Error(data.error || response.statusText);
  }
  return data;
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
    widget.draw = () => {};
    if (widget.element) {
      widget.element.style.display = "none";
    }
  }
}

function makeButton(label, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

function selectedOptions(panel) {
  return {
    skipBlank: boolValue(panel.querySelector(".skip-blank")?.checked, true),
    skipComments: boolValue(panel.querySelector(".skip-comments")?.checked, true),
    wrap: boolValue(panel.querySelector(".wrap")?.checked, true),
  };
}

function syncWidgetsFromPanel(node, panel) {
  setWidgetValue(node, "prompt_text", panel.querySelector(".prompt-text")?.value || "");
  setWidgetValue(node, "current_index", Number(panel.querySelector(".line-index")?.value || 1) - 1);
  setWidgetValue(node, "auto_advance", Boolean(panel.querySelector(".auto-advance")?.checked));
  setWidgetValue(node, "wrap", Boolean(panel.querySelector(".wrap")?.checked));
  setWidgetValue(node, "skip_blank_lines", Boolean(panel.querySelector(".skip-blank")?.checked));
  setWidgetValue(node, "skip_comment_lines", Boolean(panel.querySelector(".skip-comments")?.checked));
  setWidgetValue(node, "library_folder", "");
  setWidgetValue(node, "selected_file", panel.querySelector(".file-select")?.value || "");
  setWidgetValue(node, "queue_save_name", panel.querySelector(".queue-save-name")?.value || "");
  setWidgetValue(node, "wildcard_folder", panel.querySelector(".wildcard-folder")?.value || "");
  setWidgetValue(node, "wildcard_save_path", panel.querySelector(".wildcard-save-path")?.value || "");
}

function syncPanelFromWidgets(node, panel) {
  panel.querySelector(".prompt-text").value = getWidget(node, "prompt_text")?.value || "";
  panel.querySelector(".line-index").value = String(Number(getWidget(node, "current_index")?.value || 0) + 1);
  panel.querySelector(".auto-advance").checked = boolValue(getWidget(node, "auto_advance")?.value, true);
  panel.querySelector(".wrap").checked = boolValue(getWidget(node, "wrap")?.value, true);
  panel.querySelector(".skip-blank").checked = boolValue(getWidget(node, "skip_blank_lines")?.value, true);
  panel.querySelector(".skip-comments").checked = boolValue(getWidget(node, "skip_comment_lines")?.value, true);
  panel.querySelector(".queue-save-name").value = getWidget(node, "queue_save_name")?.value || "";
  panel.querySelector(".wildcard-folder").value = getWidget(node, "wildcard_folder")?.value || "";
  panel.querySelector(".wildcard-save-path").value = getWidget(node, "wildcard_save_path")?.value || "";
  updatePreview(node, panel);
}

function bumpResetToken(node) {
  const widget = getWidget(node, "reset_token");
  if (widget) {
    widget.value = (Number(widget.value || 0) + 1) >>> 0;
  }
}

function setLineIndex(node, panel, index) {
  const lines = currentLines(panel);
  const value = clampIndex(index, lines.length);
  panel.querySelector(".line-index").value = String(value + 1);
  setWidgetValue(node, "current_index", value);
  bumpResetToken(node);
  updatePreview(node, panel);
}

function currentLines(panel) {
  const options = selectedOptions(panel);
  return promptLines(panel.querySelector(".prompt-text")?.value || "", options.skipBlank, options.skipComments);
}

function updatePreview(node, panel) {
  syncWidgetsFromPanel(node, panel);
  const lines = currentLines(panel);
  const index = clampIndex(Number(panel.querySelector(".line-index")?.value || 1) - 1, lines.length);
  const preview = panel.querySelector(".current-prompt");
  const status = panel.querySelector(".status");
  preview.textContent = lines[index] || "No prompt lines yet.";
  status.textContent = lines.length ? `Line ${index + 1} / ${lines.length}` : "No usable lines";
}

async function refreshFileList(node, panel) {
  syncWidgetsFromPanel(node, panel);
  const select = panel.querySelector(".file-select");
  const status = panel.querySelector(".library-status");
  select.replaceChildren();
  select.append(Object.assign(document.createElement("option"), { value: "", textContent: "Select prompt file" }));
  status.textContent = "Loading...";
  try {
    const data = await fetchJson("/wildcard_organizer/prompt_queue/list");
    for (const file of data.files || []) {
      select.append(Object.assign(document.createElement("option"), { value: file.path, textContent: file.name }));
    }
    status.textContent = `${(data.files || []).length} file${(data.files || []).length === 1 ? "" : "s"}`;
  } catch (error) {
    status.textContent = error.message;
  }
}

async function loadSelectedFile(node, panel) {
  const path = panel.querySelector(".file-select")?.value || "";
  const status = panel.querySelector(".library-status");
  if (!path) {
    status.textContent = "Select a file first";
    return;
  }
  status.textContent = "Loading...";
  try {
    const data = await fetchJson("/wildcard_organizer/prompt_queue/load", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    panel.querySelector(".prompt-text").value = data.content || "";
    const loadedName = (panel.querySelector(".file-select")?.selectedOptions?.[0]?.textContent || "").replace(/\.txt$/i, "");
    panel.querySelector(".queue-save-name").value = loadedName;
    setWidgetValue(node, "selected_file", data.path || path);
    setLineIndex(node, panel, 0);
    updatePreview(node, panel);
    status.textContent = "Loaded";
  } catch (error) {
    status.textContent = error.message;
  }
}

async function saveQueueFile(node, panel) {
  syncWidgetsFromPanel(node, panel);
  const name = panel.querySelector(".queue-save-name")?.value || "";
  const status = panel.querySelector(".library-status");
  if (!name.trim()) {
    status.textContent = "Name the queue file";
    return;
  }
  status.textContent = "Saving...";
  try {
    const data = await fetchJson("/wildcard_organizer/prompt_queue/save_library", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, content: panel.querySelector(".prompt-text")?.value || "" }),
    });
    setWidgetValue(node, "selected_file", data.path || "");
    status.textContent = "Queue saved";
    await refreshFileList(node, panel);
  } catch (error) {
    status.textContent = error.message;
  }
}

async function exportWildcardFile(node, panel) {
  syncWidgetsFromPanel(node, panel);
  const folder = panel.querySelector(".wildcard-folder")?.value || "";
  const path = panel.querySelector(".wildcard-save-path")?.value || "";
  const status = panel.querySelector(".export-status");
  if (!path.trim()) {
    status.textContent = "Choose a .txt file name";
    return;
  }
  status.textContent = "Exporting...";
  try {
    await fetchJson("/wildcard_organizer/prompt_queue/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folder, path, content: panel.querySelector(".prompt-text")?.value || "" }),
    });
    status.textContent = "Wildcard exported";
  } catch (error) {
    status.textContent = error.message;
  }
}

function createPanel(node) {
  const panel = document.createElement("div");
  panel.className = "prompt-line-queue";
  panel.innerHTML = `
    <style>
      .prompt-line-queue {
        box-sizing: border-box;
        display: flex;
        flex-direction: column;
        gap: 8px;
        width: 100%;
        height: ${PANEL_HEIGHT - 12}px;
        min-width: 420px;
        padding: 8px;
        overflow: hidden;
        color: #ddd;
        background: #202124;
        border: 1px solid #3a3a3a;
        border-radius: 6px;
        font: 12px/1.35 Arial, sans-serif;
      }
      .prompt-line-queue button {
        height: 30px;
        padding: 0 10px;
        color: #eee;
        background: #35373d;
        border: 1px solid #555862;
        border-radius: 4px;
        cursor: pointer;
      }
      .prompt-line-queue button:hover { background: #434650; }
      .prompt-line-queue input,
      .prompt-line-queue select {
        box-sizing: border-box;
        height: 30px;
        padding: 0 8px;
        color: #eee;
        background: #151619;
        border: 1px solid #33363d;
        border-radius: 4px;
        font: 12px/1.35 Arial, sans-serif;
      }
      .prompt-line-queue textarea {
        box-sizing: border-box;
        flex: 1 1 260px;
        min-height: 220px;
        resize: vertical;
        padding: 8px;
        color: #eee;
        background: #151619;
        border: 1px solid #42586f;
        border-radius: 4px;
        font: 12px/1.35 Consolas, monospace;
      }
      .prompt-line-queue .row {
        display: flex;
        gap: 6px;
        align-items: center;
        min-height: 30px;
      }
      .prompt-line-queue .row input[type="text"],
      .prompt-line-queue .row select {
        min-width: 0;
        flex: 1;
      }
      .prompt-line-queue .line-index {
        width: 82px;
      }
      .prompt-line-queue .check {
        display: flex;
        gap: 5px;
        align-items: center;
        color: #b9c0cc;
        white-space: nowrap;
      }
      .prompt-line-queue .status,
      .prompt-line-queue .library-status,
      .prompt-line-queue .export-status {
        min-width: 110px;
        overflow: hidden;
        color: #b9c0cc;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .prompt-line-queue .section-label {
        color: #b9c0cc;
        font-weight: 700;
      }
      .prompt-line-queue .current-prompt {
        flex: 0 0 86px;
        min-height: 0;
        margin: 0;
        padding: 8px;
        overflow: auto;
        color: #e6e6e6;
        background: #151619;
        border: 1px solid #42586f;
        border-radius: 4px;
        white-space: pre-wrap;
      }
    </style>
    <textarea class="prompt-text" placeholder="Paste one prompt per line"></textarea>
    <div class="row">
      <button class="prev" type="button">Prev</button>
      <input class="line-index" type="number" min="1" title="Current line">
      <button class="next" type="button">Next</button>
      <button class="reset" type="button">Reset</button>
      <label class="check"><input class="auto-advance" type="checkbox"> auto advance</label>
      <label class="check"><input class="wrap" type="checkbox"> wrap</label>
      <label class="check"><input class="skip-blank" type="checkbox"> blanks</label>
      <label class="check"><input class="skip-comments" type="checkbox"> comments</label>
      <div class="status">Ready</div>
    </div>
    <pre class="current-prompt">No prompt lines yet.</pre>
    <div class="section-label">Queue Library</div>
    <div class="row">
      <select class="file-select" title="Saved prompt files"></select>
      <button class="load-file" type="button">Load</button>
      <button class="refresh-files" type="button">Refresh</button>
    </div>
    <div class="row">
      <input class="queue-save-name" type="text" placeholder="Queue file name, e.g. sdxl-lora-test">
      <button class="save-queue" type="button">Save Queue</button>
      <div class="library-status">Library</div>
    </div>
    <div class="section-label">Wildcard Export</div>
    <div class="row">
      <input class="wildcard-folder" type="text" placeholder="Wildcard folder for your wildcard node">
    </div>
    <div class="row">
      <input class="wildcard-save-path" type="text" placeholder="Wildcard file name, e.g. carpose_lora.txt">
      <button class="export-wildcard" type="button">Export TXT</button>
      <div class="export-status">Export</div>
    </div>
  `;

  syncPanelFromWidgets(node, panel);
  panel.querySelector(".file-select").append(Object.assign(document.createElement("option"), { value: "", textContent: "Select prompt file" }));

  panel.querySelector(".prompt-text").addEventListener("input", () => {
    bumpResetToken(node);
    updatePreview(node, panel);
  });
  panel.querySelector(".line-index").addEventListener("input", () => setLineIndex(node, panel, Number(panel.querySelector(".line-index").value || 1) - 1));
  panel.querySelector(".prev").addEventListener("click", () => setLineIndex(node, panel, Number(panel.querySelector(".line-index").value || 1) - 2));
  panel.querySelector(".next").addEventListener("click", () => {
    const lines = currentLines(panel);
    const options = selectedOptions(panel);
    setLineIndex(node, panel, nextIndex(Number(panel.querySelector(".line-index").value || 1) - 1, lines.length, options.wrap));
  });
  panel.querySelector(".reset").addEventListener("click", () => setLineIndex(node, panel, 0));
  for (const selector of [".auto-advance", ".wrap", ".skip-blank", ".skip-comments", ".queue-save-name", ".wildcard-folder", ".wildcard-save-path"]) {
    panel.querySelector(selector).addEventListener("input", () => updatePreview(node, panel));
    panel.querySelector(selector).addEventListener("change", () => updatePreview(node, panel));
  }
  panel.querySelector(".refresh-files").addEventListener("click", () => refreshFileList(node, panel));
  panel.querySelector(".load-file").addEventListener("click", () => loadSelectedFile(node, panel));
  panel.querySelector(".save-queue").addEventListener("click", () => saveQueueFile(node, panel));
  panel.querySelector(".export-wildcard").addEventListener("click", () => exportWildcardFile(node, panel));
  panel.querySelector(".file-select").addEventListener("change", () => syncWidgetsFromPanel(node, panel));

  return panel;
}

function ensurePanel(node) {
  if (node.__promptLineQueueWidget) {
    return node.__promptLineQueueWidget;
  }

  const panel = createPanel(node);
  const widget = node.addDOMWidget("prompt_line_queue_ui", "prompt_line_queue_ui", panel, {
    serialize: false,
    hideOnZoom: false,
    getValue: () => "",
    setValue: () => {},
  });
  widget.computeSize = function (width) {
    const nodeWidth = node.size?.[0] || width || PANEL_WIDTH;
    const targetWidth = Math.max(420, nodeWidth - 30);
    panel.style.width = `${targetWidth}px`;
    panel.style.maxWidth = `${targetWidth}px`;
    return [targetWidth, PANEL_HEIGHT];
  };
  node.__promptLineQueueWidget = widget;
  node.__promptLineQueuePanel = panel;
  return widget;
}

api.addEventListener("executed", ({ detail }) => {
  const node = app.graph?._nodes_by_id?.[detail?.node];
  const panel = node?.__promptLineQueuePanel;
  const output = detail?.output;
  if (!panel || node?.comfyClass !== NODE_TYPE || !output) {
    return;
  }
  const line = output.line?.[0] ?? 0;
  const count = output.count?.[0] ?? 0;
  const prompt = output.prompt?.[0] || "";
  panel.querySelector(".status").textContent = count ? `Emitted ${line} / ${count}` : "No usable lines";
  panel.querySelector(".current-prompt").textContent = prompt || "No prompt lines yet.";
});

app.registerExtension({
  name: "PromptLineQueue",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_TYPE) {
      return;
    }

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      onNodeCreated?.apply(this, arguments);
      hideInternalWidgets(this);
      ensurePanel(this);
      requestAnimationFrame(() => {
        if ((this.size?.[0] || 0) < PANEL_WIDTH) {
          this.size[0] = PANEL_WIDTH;
        }
        this.setSize?.([this.size[0], this.computeSize?.()?.[1] || PANEL_HEIGHT + 80]);
      });
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const result = onConfigure?.apply(this, arguments);
      hideInternalWidgets(this);
      ensurePanel(this);
      requestAnimationFrame(() => syncPanelFromWidgets(this, this.__promptLineQueuePanel));
      return result;
    };

    const onRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      this.__promptLineQueuePanel = null;
      this.__promptLineQueueWidget = null;
      return onRemoved?.apply(this, arguments);
    };
  },
});
