import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

const route = "/lokitsar/llm-wildcards/categories";
const widget = (node, name) => node.widgets.find(w => w.name === name);
const scrollSetting = "WildcardOrganizer.Canvas.ScrollNodeText";

function scrollNodeText(event) {
  if (event.ctrlKey || event.metaKey || event.shiftKey || !event.deltaY ||
      Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
  const area = event.target;
  if (!(area instanceof HTMLTextAreaElement) || area.scrollHeight <= area.clientHeight ||
      !area.closest("#graph-canvas-container, .lg-node[data-node-id], [data-wildcard-prompt-panel]")) return;
  if (app.ui.settings.getSettingValue(scrollSetting) === false) return;
  // Keep native scrolling. Nodes 2.0 forwards the event during ancestor capture.
  event.stopPropagation();
}

function element(tag, text = "") {
  const el = document.createElement(tag);
  el.textContent = text;
  return el;
}

async function categoryRequest(options) {
  const response = await api.fetchApi(route, options);
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

function connectionControls(node, panel) {
  const provider = widget(node, "provider");
  const endpoint = widget(node, "local_base_url");
  const model = widget(node, "model");
  const key = element("input");
  key.type = "password";
  key.autocomplete = "off";
  key.placeholder = "Enter NanoGPT API key";
  key.setAttribute("aria-label", "NanoGPT API key");
  const connect = element("button");
  const list = element("select");
  list.setAttribute("aria-label", "Select model");
  const status = element("div");
  status.setAttribute("role", "status");
  panel.append(key, connect, list, status);
  let revision = 0;
  function reset() {
    revision++;
    key.value = "";
    key.hidden = provider.value !== "NanoGPT";
    connect.textContent = key.hidden ? "Connect / load models" : "Save key & connect / load models";
    list.hidden = true;
    connect.disabled = false;
    status.textContent = "";
  }
  for (const control of [provider, endpoint]) {
    const before = control.callback;
    control.callback = function (...args) {
      before?.apply(this, args);
      reset();
    };
  }
  async function post(path, data) {
    const result = await api.fetchApi("/lokitsar/llm-wildcards/" + path, {method: "POST",
      headers: {"Content-Type": "application/json"}, body: JSON.stringify(data)});
    if (!result.ok) throw new Error(await result.text());
    return result.json();
  }
  connect.onclick = async () => {
    const run = ++revision;
    const settings = {provider: provider.value, local_base_url: endpoint.value};
    connect.disabled = true;
    list.hidden = true;
    status.textContent = "Loading models…";
    try {
      if (settings.provider === "NanoGPT" && key.value.trim()) {
        await post("key", {key: key.value.trim()});
        if (revision !== run) return;
        key.value = "";
        key.placeholder = "NanoGPT key saved • enter to replace";
      }
      const {models} = await post("models", settings);
      if (revision !== run) return;
      list.replaceChildren(new Option("Choose a model…", ""), ...models.map(id => new Option(id, id)));
      list.value = models.includes(model.value) ? model.value : "";
      list.hidden = false;
      status.textContent = models.length + " models available";
    } catch (error) { if (revision === run) status.textContent = error.message; }
    finally { if (revision === run) connect.disabled = false; }
  };
  list.onchange = () => {
    if (!list.value) return;
    model.value = list.value;
    model.callback?.(list.value);
    node.graph?.change?.();
    node.setDirtyCanvas?.(true, true);
  };
  reset();
  api.fetchApi("/lokitsar/llm-wildcards/connection").then(r => r.ok && r.json()).then(state => {
    if (state?.has_key) key.placeholder = "NanoGPT key configured • enter to replace";
  }).catch(() => {});
  return reset;
}

function openPicker(editor, variation, commit, manageOnly, onSaved) {
  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  const selected = editor.value.slice(start, end);
  const dialog = element("dialog");
  dialog.style.cssText = "width:min(440px,85vw);background:#25272b;color:white;border:1px solid #777;padding:16px";
  const form = element("div");
  form.style.cssText = "display:grid;gap:8px";
  dialog.append(form);
  const heading = element("strong", variation ? "Choose a category for this selection" : "Insert a wildcard");
  if (manageOnly) heading.textContent = "Edit wildcards";
  const name = element("input");
  name.placeholder = "Search or enter a new category name";
  name.setAttribute("aria-label", "Category name");
  const list = element("select");
  list.size = 5;
  list.setAttribute("aria-label", "Saved categories");
  const instruction = element("textarea");
  const examples = element("textarea");
  const depth = element("input");
  depth.type = "number"; depth.min = 1; depth.max = 30;
  const status = element("div");
  status.setAttribute("role", "status");
  const apply = element("button", variation ? "Save category and mark selection" : "Save category and insert");
  const save = element("button", "Save wildcard");
  apply.hidden = manageOnly;
  const cancel = element("button", "Cancel");
  function field(label, control) {
    const wrapper = element("label", label);
    wrapper.style.display = "grid";
    wrapper.append(control);
    return wrapper;
  }
  form.append(heading, name, list, field("What should the model choose?", instruction),
    field("Examples (optional)", examples), field("Recent answers to exclude", depth), save, apply, cancel, status);
  let categories = [];
  function filter() {
    const query = name.value.trim().toLowerCase();
    list.replaceChildren(...categories.filter(c => c.name.includes(query)).map(c => new Option(c.name, c.name)));
    const exact = categories.find(c => c.name === query);
    instruction.value = exact?.instruction ?? "";
    examples.value = exact?.examples ?? "";
    depth.value = exact?.depth ?? 25;
    list.value = exact?.name ?? "";
  }
  function choose() {
    if (list.value) { name.value = list.value; filter(); }
  }
  list.onchange = choose;
  name.oninput = filter;
  cancel.onclick = () => dialog.close();
  dialog.onclose = () => { dialog.remove(); editor.focus(); };
  save.disabled = apply.disabled = true;
  async function saveCategory(insert) {
    save.disabled = apply.disabled = true;
    try {
      const result = await categoryRequest({method: "POST", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({name: name.value, instruction: instruction.value, examples: examples.value, depth: Number(depth.value)})});
      if (!dialog.open) return;
      if (insert) {
        const suffix = variation ? "|" + selected.replace(/[%{}|]/g, ch => encodeURIComponent(ch)) : "";
        editor.setRangeText("{{" + result.name + suffix + "}}", start, end, "end");
        commit();
      }
      onSaved(result.name);
      dialog.close();
    } catch (error) { status.textContent = error.message; }
    finally { save.disabled = apply.disabled = false; }
  }
  save.onclick = () => saveCategory(false);
  apply.onclick = () => saveCategory(true);
  name.onkeydown = event => {
    if (event.key === "Enter") {
      event.preventDefault();
      if (list.options.length === 1 && !list.value) {
        name.value = list.options[0].value;
        filter();
      }
      (manageOnly ? save : apply).click();
    }
  };
  document.body.append(dialog);
  dialog.showModal();
  name.focus();
  categoryRequest().then(items => {
    categories = items; filter(); save.disabled = apply.disabled = false;
  }).catch(error => { status.textContent = error.message; });
}

app.registerExtension({
  name: "Lokitsar.LLMWildcards",
  settings: [{
    id: scrollSetting,
    name: "Scroll long node text with the mouse wheel",
    type: "boolean",
    defaultValue: true,
  }],
  setup() {
    window.addEventListener("wheel", scrollNodeText, {capture: true, passive: true});
  },
  beforeRegisterNodeDef(type, data) {
    if (!["LLMWildcard", "LLMPromptVariations"].includes(data.name)) return;
    const variation = data.name === "LLMPromptVariations";
    const created = type.prototype.onNodeCreated;
    type.prototype.onNodeCreated = function () {
      created?.apply(this, arguments);
      const backing = widget(this, "prompt");
      backing.hidden = true;
      backing.options = {...backing.options, hidden: true};
      backing.computeSize = () => [0, -4];
      if (backing.element) backing.element.style.display = "none";
      const panel = element("div");
      panel.dataset.wildcardPromptPanel = "";
      panel.style.cssText = "display:flex;flex-direction:column;gap:5px;padding:5px;box-sizing:border-box;height:100%";
      const editor = element("textarea");
      editor.placeholder = variation ? "Write a prompt. Insert a wildcard at the cursor or highlight a phrase to vary." : "Write a prompt and insert a wildcard at the cursor.";
      editor.style.cssText = "width:100%;flex:2;min-height:50px;resize:none;box-sizing:border-box";
      editor.value = backing.value ?? "";
      const commit = () => {
        backing.value = editor.value;
        backing.callback?.(editor.value);
        this.graph?.change?.();
      };
      editor.oninput = commit;
      const insert = element("button", "Insert wildcard…");
      const status = element("div");
      const edit = element("button", "Edit wildcards…");
      const saved = name => { status.textContent = "Saved wildcard: " + name; };
      edit.onclick = () => openPicker(editor, variation, commit, true, saved);
      insert.onclick = () => openPicker(editor, false, commit, false, saved);
      const output = element("textarea");
      output.readOnly = true;
      output.placeholder = "Generated text appears here after you queue the node.";
      output.style.cssText = "width:100%;flex:1;min-height:40px;resize:none;box-sizing:border-box";
      for (const area of [editor, output]) {
        area.style.overscrollBehavior = "contain";
      }
      const copy = element("button", variation ? "Copy queue lines" : "Copy prompt");
      copy.onclick = async () => {
        if (!output.value) return;
        try { await navigator.clipboard.writeText(output.value); status.textContent = "Copied."; }
        catch { output.focus(); output.select(); status.textContent = "Press Ctrl+C to copy the selected output."; }
      };
      this.resetLLMConnection = connectionControls(this, panel);
      const actions = element("div");
      actions.style.cssText = "display:flex;gap:5px";
      actions.append(insert);
      if (variation) {
        const mark = element("button", "Mark selection…");
        mark.onclick = () => {
          if (widget(this, "mode").value !== "Selected parts only") {
            status.textContent = "Choose Selected parts only to mark a phrase.";
          } else if (editor.selectionStart === editor.selectionEnd) {
            status.textContent = "Highlight the phrase to change first.";
          } else {
            openPicker(editor, true, commit, false, saved);
          }
        };
        actions.append(mark);
      }
      actions.append(edit);
      panel.append(editor, actions, output, copy, status);
      const controls = this.addDOMWidget("llm_tools", "llm_tools", panel, {serialize: false, hideOnZoom: false});
      controls.computeSize = width => [width, 345];
      this.llmEditor = editor;
      this.llmOutput = output;
      this.setSize([Math.max(this.size[0], 430), this.computeSize()[1]]);
    };
    const configured = type.prototype.onConfigure;
    type.prototype.onConfigure = function () {
      configured?.apply(this, arguments);
      requestAnimationFrame(() => {
        if (this.llmEditor) this.llmEditor.value = widget(this, "prompt").value ?? "";
        this.resetLLMConnection?.();
      });
    };
    const executed = type.prototype.onExecuted;
    type.prototype.onExecuted = function (message) {
      executed?.apply(this, arguments);
      if (this.llmOutput) this.llmOutput.value = message?.text?.[0] ?? "";
    };
  },
});
