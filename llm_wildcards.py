"""LLM wildcard categories, bounded history, and ComfyUI text nodes."""
import asyncio
import hashlib
import json
import os
import re
import sqlite3
from contextlib import closing, contextmanager
from pathlib import Path
from urllib.parse import unquote, urlsplit

import requests

PROVIDERS = {
    "PolyStrata": "http://127.0.0.1:8080/v1",
    "KoboldCpp": "http://127.0.0.1:5001/v1",
    "NanoGPT": "https://nano-gpt.com/api/v1",
}
SELECTED = "Selected parts only"
WHOLE = "Send whole prompt and rewrite"
VISUAL_RULES = (
    "Write a positive image prompt. Include only details that could be seen in the finished image. "
    "Describe visible expressions, gestures, lighting, colors and textures directly. Omit vibes, "
    "backstory, intentions, smells and sounds. Describe what appears in the frame affirmatively. "
    "Never list exclusions or use negative instructions such as 'no people' or 'without text'."
)
VARIATION_TASK = (
    "Create a closely related visual variation of the source prompt. Preserve the subject, scene, "
    "composition, style, level of detail, distinctive wording, trigger words, weights and prompt format. "
    "Change one or a few concrete visual details so the pictured result differs. Keep surrounding wording "
    "where possible. Do not merely paraphrase, invent a different scene, summarize or embellish. "
    "Follow additional_rules for what to keep or vary within these constraints. Match the source length "
    "using the supplied word range. " + VISUAL_RULES
)
WORDS = re.compile(r"\w+(?:['’-]\w+)*")
NEGATION = re.compile(r"(?<![\w-])(?:no\s+(?!\d)|not\s+|without\s+|do\s+not\s+|avoid\s+|free\s+of\s+)", re.I)
STARTERS = [
    ("outdoor setting", "Name a specific outdoor location.", "a misty orchard, a volcanic shore", 30),
    ("hair style", "Name a hairstyle.", "a braided crown, a tousled bob", 25),
    ("eye color", "Give a short eye color description.", "amber, gray-green", 5),
]
MARK = re.compile(r"\{\{([^{}|]+)(?:\|([^{}]*))?\}\}")
NAME = re.compile(r"[\w][\w .'-]{0,63}")


@contextmanager
def database():
    import folder_paths
    path = Path(folder_paths.get_user_directory()) / "llm_wildcards.sqlite3"
    with closing(sqlite3.connect(path, timeout=15)) as db, db:
        db.execute("CREATE TABLE IF NOT EXISTS category (name TEXT PRIMARY KEY, instruction TEXT, examples TEXT, depth INTEGER)")
        db.execute("CREATE TABLE IF NOT EXISTS recent (id INTEGER PRIMARY KEY, scope TEXT, value TEXT)")
        db.execute("CREATE INDEX IF NOT EXISTS recent_scope ON recent(scope,id)")
        db.executemany("INSERT OR IGNORE INTO category VALUES (?,?,?,?)", STARTERS)
        db.commit()
        yield db


def catalog(db):
    return {name: dict(name=name, instruction=instruction, examples=examples, depth=depth)
            for name, instruction, examples, depth in db.execute("SELECT * FROM category ORDER BY name")}


def nano_key(new_key=None):
    import folder_paths
    path = Path(folder_paths.get_user_directory()) / "__llm_wildcards" / "credentials.sqlite3"
    if new_key is not None or path.exists():
        path.parent.mkdir(mode=0o700, exist_ok=True)
        with closing(sqlite3.connect(path)) as db, db:
            db.execute("CREATE TABLE IF NOT EXISTS credential (provider TEXT PRIMARY KEY, token TEXT NOT NULL)")
            if new_key is not None:
                db.execute("INSERT OR REPLACE INTO credential VALUES ('NanoGPT', ?)", (new_key,))
            saved = db.execute("SELECT token FROM credential WHERE provider='NanoGPT'").fetchone()
            if saved:
                return saved[0]
    return os.getenv("NANOGPT_API_KEY", "").strip()


def register_routes(routes):
    from aiohttp import web

    @routes.get("/lokitsar/llm-wildcards/connection")
    async def connection(request):
        return web.json_response({"has_key": bool(nano_key())})

    @routes.post("/lokitsar/llm-wildcards/key")
    async def save_key(request):
        item = await request.json()
        key = item.get("key")
        if not isinstance(key, str) or not key.strip() or any(c.isspace() for c in key.strip()):
            raise web.HTTPBadRequest(text="Enter a valid NanoGPT API key.")
        nano_key(key.strip())
        return web.json_response({"has_key": True})

    @routes.post("/lokitsar/llm-wildcards/models")
    async def list_models(request):
        item = await request.json()
        if item.get("provider") not in PROVIDERS:
            raise web.HTTPBadRequest(text="Choose a supported provider.")
        try:
            chat = Chat(item["provider"], item.get("local_base_url", ""), "")
            models = await asyncio.to_thread(chat.models)
        except requests.RequestException:
            raise web.HTTPBadGateway(text="Could not reach the model server. Check the server address and try again.")
        except (ValueError, RuntimeError) as error:
            raise web.HTTPBadRequest(text=str(error))
        return web.json_response({"models": models})

    @routes.get("/lokitsar/llm-wildcards/categories")
    async def categories(request):
        with database() as db:
            return web.json_response(list(catalog(db).values()))

    @routes.post("/lokitsar/llm-wildcards/categories")
    async def save_category(request):
        item = await request.json()
        name = str(item.get("name", "")).strip().lower()
        depth = item.get("depth", 25)
        if not NAME.fullmatch(name) or type(depth) is not int or not 1 <= depth <= 30:
            raise web.HTTPBadRequest(text="Use a category name of 1–64 letters, numbers, spaces, dots, apostrophes or hyphens and a history of 1–30.")
        with database() as db:
            db.execute("INSERT OR REPLACE INTO category VALUES (?,?,?,?)",
                       (name, str(item.get("instruction", "")).strip(), str(item.get("examples", "")).strip(), depth))
        return web.json_response({"name": name})


def history(db, scope, depth):
    return [r[0] for r in db.execute("SELECT value FROM recent WHERE scope=? ORDER BY id DESC LIMIT ?", (scope, depth))]


def normalized(value):
    return " ".join(value.casefold().split())


def remember(db, scope, value, depth):
    # Recheck under the write lock if another execution generated a result concurrently.
    with db:
        db.execute("BEGIN IMMEDIATE")
        if normalized(value) in {normalized(v) for v in history(db, scope, depth)}:
            return False
        db.execute("INSERT INTO recent(scope,value) VALUES (?,?)", (scope, value))
        db.execute("DELETE FROM recent WHERE scope=? AND id NOT IN (SELECT id FROM recent WHERE scope=? ORDER BY id DESC LIMIT ?)",
                   (scope, scope, depth))
    return True


class Chat:
    def __init__(self, provider, local_base_url, model):
        self.base = PROVIDERS[provider]
        self.headers = {}
        self.model = model.strip()
        if provider == "NanoGPT":
            key = nano_key()
            if key:
                self.headers["Authorization"] = "Bearer " + key
        else:
            self.base = local_base_url.strip().rstrip("/") or self.base
            if urlsplit(self.base).scheme not in ("http", "https"):
                raise ValueError("Specify an HTTP or HTTPS local server base URL ending in /v1.")

    def models(self):
        response = requests.get(self.base + "/models", headers=self.headers, timeout=(5, 20), allow_redirects=False)
        if response.status_code != 200:
            raise RuntimeError(f"Model list returned HTTP {response.status_code}. Check the provider, key and server address.")
        items = response.json().get("data") or []
        models = [item["id"] for item in items if isinstance(item, dict) and isinstance(item.get("id"), str) and item["id"]]
        if not models:
            raise ValueError("The server returned no models. Load a local model or enter its ID manually.")
        return list(dict.fromkeys(models))

    def ask(self, task, fields):
        if self.base == PROVIDERS["NanoGPT"]:
            if not self.headers:
                raise ValueError("NanoGPT key missing. Enter it on this node and click Save key & connect / load models.")
            if not self.model:
                raise ValueError("NanoGPT key is configured. Choose a model on this node: click Save key & connect / load models, then select a model from the dropdown or enter its ID in the model field.")
        payload = {"messages": [{"role": "system", "content": task + " Return one new answer on a single line, without labels, quotes or explanation. Avoid every recent answer."},
                                {"role": "user", "content": json.dumps(fields, ensure_ascii=False)}],
                   "stream": False, "temperature": 1.0}
        if self.model:
            payload["model"] = self.model
        else:
            self.model = payload["model"] = self.models()[0]
        response = requests.post(self.base + "/chat/completions", json=payload, headers=self.headers,
                                 timeout=(10, 180), allow_redirects=False)
        if response.status_code != 200:
            raise RuntimeError(f"Chat server returned HTTP {response.status_code}. Check the model, endpoint and credentials.")
        value = response.json()["choices"][0]["message"]["content"] or ""
        return re.sub(r"^\s*<think>.*?</think>\s*", "", value, flags=re.S).strip()


def fresh(db, chat, scope, depth, task, fields, original="", word_range=None):
    feedback = {}
    for _ in range(4):
        value = chat.ask(task, {**fields, **feedback, "recent": history(db, scope, depth)})
        if word_range:
            words = len(WORDS.findall(value))
            low, high = word_range
            if not low <= words <= high:
                feedback = {"correction": f"Your last answer was {words} words. Return {low} to {high} words."}
                continue
            if NEGATION.search(value):
                feedback = {"correction": "Your last answer included an exclusion. Describe only visible elements that are present."}
                continue
        if value and len(value.splitlines()) == 1 and normalized(value) != normalized(original) and remember(db, scope, value, depth):
            return value
    if word_range:
        raise ValueError(f"After four attempts the model did not return a distinct, single-line positive variation within {low}–{high} words.")
    raise ValueError("The model did not produce a distinct single-line answer after four attempts. Try more examples, a shorter category history or another model.")


def slot_prompt(db, chat, source, matches, categories, restore_selected=False):
    pieces = []
    end = 0
    resolved = {}
    for match in matches:
        name = match[1].strip().lower()
        selected = unquote(match[2] or "")
        key = (name, selected)
        if restore_selected and match[2] is not None:
            resolved[key] = selected
        elif key not in resolved:
            cat = categories[name]
            fields = {"category": name, "instruction": cat["instruction"], "examples": cat["examples"]}
            if selected:
                fields["replace_this_phrase"] = selected
            resolved[key] = fresh(db, chat, "category:" + name, cat["depth"],
                                  "Choose a random word or short phrase in the requested category. " + VISUAL_RULES, fields, selected)
        pieces.extend([source[end:match.start()], resolved[key]])
        end = match.end()
    return "".join(pieces) + source[end:]


class LLMWildcard:
    DEPRECATED = True
    CATEGORY = "utils/wildcards"
    FUNCTION = "generate"
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("prompt",)
    OUTPUT_NODE = True

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "prompt": ("STRING", {"default": "", "multiline": True, "dynamicPrompts": False}),
            "provider": (list(PROVIDERS),),
            "local_base_url": ("STRING", {"default": "", "placeholder": "Optional local base URL ending in /v1"}),
            "model": ("STRING", {"default": "", "placeholder": "NanoGPT model ID, or blank for first local model"}),
        }}

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")

    def generate(self, prompt, provider, local_base_url, model):
        with database() as db:
            matches, cats = slots(db, prompt, allow_selected=False)
            text = slot_prompt(db, Chat(provider, local_base_url, model), prompt, matches, cats)
        return {"ui": {"text": [text]}, "result": (text,)}


def slots(db, prompt, allow_selected):
    matches = list(MARK.finditer(prompt))
    cats = catalog(db)
    rest = MARK.sub("", prompt)
    if not matches or "{{" in rest or "}}" in rest:
        raise ValueError("Insert a saved category or mark a selection before running. Check the double-brace markers.")
    for match in matches:
        if match[1].strip().lower() not in cats:
            raise ValueError(f"Unknown category: {match[1]}. Create it in the node first.")
        if not allow_selected and match[2] is not None:
            raise ValueError("The wildcard node accepts category names only.")
    return matches, cats


class LLMPromptVariations(LLMWildcard):
    DEPRECATED = False
    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("first_prompt", "queue_lines")

    @classmethod
    def INPUT_TYPES(cls):
        inputs = super().INPUT_TYPES()
        inputs["required"].update(mode=([SELECTED, WHOLE],), count=("INT", {"default": 1, "min": 1, "max": 20}))
        inputs["optional"] = {"additional_rules": ("STRING", {
            "default": "", "multiline": True, "dynamicPrompts": False,
            "placeholder": "Additional whole-prompt rules, e.g. Keep the camera angle. Vary only the lighting.",
        })}
        return inputs

    def generate(self, prompt, provider, local_base_url, model, mode, count, additional_rules=""):
        if not prompt.strip() or mode not in (SELECTED, WHOLE) or not 1 <= count <= 20:
            raise ValueError("Choose a mode, enter a prompt and request 1–20 variations.")
        expand_wildcards = mode == WHOLE and any(m[2] is None for m in MARK.finditer(prompt))
        if mode == WHOLE and not expand_wildcards:
            prompt = MARK.sub(lambda match: unquote(match[2]), prompt)
        scope = "variation:" + hashlib.sha256((mode + "\0" + prompt).encode()).hexdigest()
        results = []
        with database() as db:
            if mode == SELECTED or expand_wildcards:
                matches, cats = slots(db, prompt, allow_selected=True)
            chat = Chat(provider, local_base_url, model)
            for _ in range(count):
                if mode == WHOLE:
                    source = slot_prompt(db, chat, prompt, matches, cats, restore_selected=True) if expand_wildcards else prompt
                    words = len(WORDS.findall(source))
                    tolerance = max(2, words // 5)
                    bounds = (max(1, words - tolerance), words + tolerance)
                    fields = {"prompt": source, "source_words": words, "word_range": bounds}
                    if additional_rules.strip():
                        fields["additional_rules"] = additional_rules.strip()
                    text = fresh(db, chat, scope, 20, VARIATION_TASK, fields, source, word_range=bounds)
                else:
                    for attempt in range(4):
                        text = slot_prompt(db, chat, prompt, matches, cats)
                        if remember(db, scope, text, 20):
                            break
                    else:
                        raise ValueError("Could not generate a distinct prompt after four attempts.")
                results.append(text)
        queue = "\n".join(" ".join(item.splitlines()) for item in results)
        return {"ui": {"text": [queue]}, "result": (results[0], queue)}
