import json
import random
import re
from pathlib import Path

try:
    import yaml
except ImportError:
    yaml = None

try:
    from aiohttp import web
    from server import PromptServer
except ImportError:
    web = None
    PromptServer = None


WILDCARD_EXTENSIONS = {".txt", ".yaml", ".yml"}
PREVIEW_LIMIT = 20000
SEARCH_LIMIT = 250
WILDCARD_PATTERN = re.compile(r"__(.+?)__")
CHOICE_PATTERN = re.compile(r"\{([^{}]+)\}")
INDEX_CACHE = {}


def _bool(value):
    if isinstance(value, str):
        return value.lower() in {"1", "true", "yes", "on"}
    return bool(value)


def _split_filter_terms(value):
    return [term.strip().lower() for term in re.split(r"[,;\n]+", value or "") if term.strip()]


def _resolve_root(root):
    root_path = Path(root or "").expanduser()
    if not root_path.is_absolute():
        root_path = Path.cwd() / root_path
    root_path = root_path.resolve()
    if not root_path.exists():
        raise FileNotFoundError(f"Wildcard folder does not exist: {root_path}")
    if not root_path.is_dir():
        raise NotADirectoryError(f"Wildcard path is not a folder: {root_path}")
    return root_path


def _read_text(path, limit=None):
    data = path.read_bytes()
    if limit is not None:
        data = data[:limit]

    for encoding in ("utf-8-sig", "utf-8", "ISO-8859-1"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")


def _impact_normalize(value):
    return value.replace("\\", "/").replace(" ", "-").lower()


def _relative_file_key(root, path):
    relative = path.relative_to(root).with_suffix("")
    return _impact_normalize(relative.as_posix())


def _wildcard_text(key):
    return f"__{key}__"


def _iter_wildcard_files(root):
    for path in root.rglob("*"):
        if path.is_file() and path.suffix.lower() in WILDCARD_EXTENSIONS:
            yield path


def _yaml_value_preview(value):
    if isinstance(value, list):
        return "\n".join(str(item) for item in value[:30])
    if isinstance(value, dict):
        return json.dumps(value, indent=2, ensure_ascii=False)[:PREVIEW_LIMIT]
    return str(value)


def _yaml_choices(value):
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    if isinstance(value, dict):
        return [json.dumps(value, ensure_ascii=False)]
    if value is None:
        return []
    return [str(value).strip()]


def _flatten_yaml_items(data, prefix=""):
    if isinstance(data, dict):
        for key, value in data.items():
            next_key = f"{prefix}/{key}" if prefix else str(key)
            yield from _flatten_yaml_items(value, next_key)
    elif isinstance(data, list):
        yield prefix, data
    elif data is not None:
        yield prefix, [data]


def _yaml_entries(root, path):
    if yaml is None:
        return []

    try:
        data = yaml.load(_read_text(path), Loader=yaml.FullLoader)
    except Exception:
        return []

    entries = []
    for key, value in _flatten_yaml_items(data):
        normalized = _impact_normalize(key)
        if not normalized:
            continue
        entries.append(
            {
                "key": normalized,
                "wildcard": _wildcard_text(normalized),
                "path": str(path),
                "relative_path": path.relative_to(root).as_posix(),
                "kind": "yaml",
                "preview": _yaml_value_preview(value),
                "choices": _yaml_choices(value),
            }
        )
    return entries


def _entries_for_file(root, path):
    suffix = path.suffix.lower()
    if suffix == ".txt":
        key = _relative_file_key(root, path)
        return [
            {
                "key": key,
                "wildcard": _wildcard_text(key),
                "path": str(path),
                "relative_path": path.relative_to(root).as_posix(),
                "kind": "txt",
                "preview": "",
                "choices": [],
            }
        ]

    entries = _yaml_entries(root, path)
    if entries:
        return entries

    key = _relative_file_key(root, path)
    return [
        {
            "key": key,
            "wildcard": _wildcard_text(key),
            "path": str(path),
            "relative_path": path.relative_to(root).as_posix(),
            "kind": suffix.lstrip("."),
            "preview": "",
            "choices": [],
        }
    ]


def _index_entry(root, path, entry, content=""):
    relative_path = path.relative_to(root).as_posix()
    item = dict(entry)
    item["path"] = str(path)
    item["relative_path"] = relative_path
    item["name_haystack"] = f"{path.name}\n{relative_path}".lower()
    item["key_haystack"] = str(entry.get("key", "")).lower()
    item["content_haystack"] = f"{content}\n{entry.get('preview', '')}".lower()
    return item


def _build_index(root, include_contents=False):
    entries = []
    file_count = 0
    content_indexed = _bool(include_contents)

    for path in _iter_wildcard_files(root):
        file_count += 1
        content = ""
        if content_indexed:
            content = _read_text(path, PREVIEW_LIMIT)

        for entry in _entries_for_file(root, path):
            entries.append(_index_entry(root, path, entry, content))

    return {
        "entries": entries,
        "file_count": file_count,
        "entry_count": len(entries),
        "content_indexed": content_indexed,
    }


def _get_index(root, include_contents=False, refresh=False):
    cache_key = str(root)
    cached = INDEX_CACHE.get(cache_key)

    if refresh or cached is None:
        cached = _build_index(root, include_contents)
        INDEX_CACHE[cache_key] = cached
        return cached

    if include_contents and not cached.get("content_indexed"):
        cached = _build_index(root, include_contents=True)
        INDEX_CACHE[cache_key] = cached

    return cached


def _public_result(item):
    return {
        "key": item.get("key", ""),
        "wildcard": item.get("wildcard", ""),
        "path": item.get("path", ""),
        "relative_path": item.get("relative_path", ""),
        "kind": item.get("kind", ""),
        "preview": item.get("preview", ""),
        "matched_in": item.get("matched_in", []),
    }


def _index_summary(index):
    return {
        "file_count": index.get("file_count", 0),
        "entry_count": index.get("entry_count", 0),
        "content_indexed": index.get("content_indexed", False),
    }


def _search_wildcards(root, query, include_contents=False, exclude_terms="", refresh=False):
    query = (query or "").strip().lower()
    exclusions = _split_filter_terms(exclude_terms)
    results = []
    index = _get_index(root, include_contents, refresh)

    for indexed in index["entries"]:
        matched_in = []
        if not query or query in indexed["name_haystack"]:
            matched_in.append("filename")

        exclusion_haystack = f"{indexed['name_haystack']}\n{indexed['key_haystack']}"
        if include_contents:
            exclusion_haystack = f"{exclusion_haystack}\n{indexed['content_haystack']}"
        if exclusions and any(term in exclusion_haystack for term in exclusions):
            continue

        if include_contents and query and query in f"{indexed['key_haystack']}\n{indexed['content_haystack']}":
            matched_in.append("contents")

        if not matched_in:
            continue

        item = dict(indexed)
        item["matched_in"] = sorted(set(matched_in))
        results.append(_public_result(item))
        if len(results) >= SEARCH_LIMIT:
            return results

    return results


def _preview(root, path_text, key_text=""):
    path = Path(path_text or "").expanduser().resolve()
    try:
        path.relative_to(root)
    except ValueError as exc:
        raise PermissionError("Preview path must be inside the selected wildcard folder.") from exc

    if not path.is_file() or path.suffix.lower() not in WILDCARD_EXTENSIONS:
        raise FileNotFoundError("Preview file is not a supported wildcard file.")

    content = _read_text(path, PREVIEW_LIMIT)
    selected_preview = ""
    if path.suffix.lower() in {".yaml", ".yml"} and key_text:
        for entry in _entries_for_file(root, path):
            if entry["key"] == key_text:
                selected_preview = entry.get("preview", "")
                break

    return {
        "path": str(path),
        "relative_path": path.relative_to(root).as_posix(),
        "key": key_text,
        "wildcard": _wildcard_text(key_text) if key_text else "",
        "content": content,
        "selected_preview": selected_preview,
        "truncated": path.stat().st_size > PREVIEW_LIMIT,
    }


def _parts_from_json(parts_json):
    if not parts_json:
        return []
    try:
        data = json.loads(parts_json)
    except json.JSONDecodeError:
        return []
    if not isinstance(data, list):
        return []
    parts = []
    for item in data:
        if not isinstance(item, dict):
            continue
        if item.get("wildcard") or item.get("text"):
            parts.append(item)
            continue
        if item.get("type") == "choice" and isinstance(item.get("choices"), list):
            choices = [choice for choice in item["choices"] if isinstance(choice, dict) and (choice.get("wildcard") or choice.get("text"))]
            if choices:
                updated = dict(item)
                updated["choices"] = choices
                parts.append(updated)
    return parts


def _sanitize_build_inputs(parts_json, manual_text):
    manual_text = manual_text or ""
    parts = _parts_from_json(parts_json)
    manual_parts = _parts_from_json(manual_text.strip()) if manual_text.strip().startswith("[") else []

    if manual_parts:
        if not parts:
            parts_json = json.dumps(manual_parts, ensure_ascii=False)
        manual_text = ""

    if isinstance(parts_json, str) and WILDCARD_PATTERN.fullmatch(parts_json.strip()) and not parts:
        parts_json = "[]"

    return parts_json, manual_text


def _part_prompt(part):
    if part.get("type") == "choice":
        options = [_part_prompt(choice) for choice in part.get("choices", []) if isinstance(choice, dict)]
        options = [option for option in options if option.strip()]
        if not options:
            return ""
        if len(options) == 1:
            return options[0]
        return "{%s}" % " | ".join(options)

    if part.get("type") == "text":
        return str(part.get("text", ""))

    return str(part.get("wildcard", "")).strip()


def _join_prompt_parts(parts, separator):
    return separator.join(text for text in (_part_prompt(part) for part in parts) if text)


def _manual_position(value):
    return "append" if str(value or "").lower() == "append" else "prepend"


def _join_manual_text(manual_text, generated_text, separator, manual_position="prepend"):
    manual_text = (manual_text or "").strip()
    generated_text = (generated_text or "").strip()
    if manual_text and generated_text:
        if _manual_position(manual_position) == "append":
            return f"{generated_text}{separator}{manual_text}"
        return f"{manual_text}{separator}{generated_text}"
    return manual_text or generated_text


def _txt_choices(path):
    choices = []
    for line in _read_text(path).splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            choices.append(line)
    return choices


def _wildcard_entries_by_key(root):
    entries = {}
    for entry in _get_index(root).get("entries", []):
        entries[entry["key"]] = entry
    return entries


def _choice_for_key(root, entries, key, rng):
    entry = entries.get(_impact_normalize(key))
    if not entry:
        return _wildcard_text(key)

    choices = entry.get("choices") or []
    if not choices and entry.get("kind") == "txt":
        choices = _txt_choices(Path(entry["path"]))
    if not choices:
        return entry.get("wildcard", _wildcard_text(key))

    return rng.choice(choices)


def _resolve_choice_groups(text, rng):
    def replace(match):
        options = [option.strip() for option in match.group(1).split("|") if option.strip()]
        if not options:
            return match.group(0)
        return rng.choice(options)

    return CHOICE_PATTERN.sub(replace, text or "")


def _expand_text(root, text, seed=0, max_depth=20):
    entries = _wildcard_entries_by_key(root)
    rng = random.Random(int(seed))
    expanded = text or ""

    for _depth in range(max_depth):
        changed = False
        with_choices = _resolve_choice_groups(expanded, rng)
        if with_choices != expanded:
            expanded = with_choices
            changed = True

        def replace(match):
            nonlocal changed
            changed = True
            return _choice_for_key(root, entries, match.group(1), rng)

        expanded = WILDCARD_PATTERN.sub(replace, expanded)
        if not changed or ("__" not in expanded and "{" not in expanded):
            break

    return expanded


def _build_prompt(root, parts_json, manual_text="", separator=", ", seed=0, expand_wildcards=False, manual_position="prepend"):
    parts_json, manual_text = _sanitize_build_inputs(parts_json, manual_text)
    parts = _parts_from_json(parts_json)
    wildcard_prompt = _join_prompt_parts(parts, separator)
    final_prompt = _join_manual_text(manual_text, wildcard_prompt, separator, manual_position)
    resolved_prompt = _expand_text(root, final_prompt, seed) if root else final_prompt
    return {
        "prompt": resolved_prompt if expand_wildcards else final_prompt,
        "raw_prompt": final_prompt,
        "resolved_prompt": resolved_prompt,
        "wildcard_prompt": wildcard_prompt,
        "expanded_wildcards": resolved_prompt,
        "parts": parts,
    }


def _json_error(message, status=400):
    return web.json_response({"error": message}, status=status)


if PromptServer is not None and web is not None:
    routes = PromptServer.instance.routes

    @routes.get("/wildcard_organizer/search")
    async def wildcard_organizer_search(request):
        try:
            root = _resolve_root(request.query.get("root", ""))
            query = request.query.get("query", "")
            include_contents = _bool(request.query.get("include_contents", "false"))
            exclude_terms = request.query.get("exclude", "")
            refresh = _bool(request.query.get("refresh", "false"))
            results = _search_wildcards(root, query, include_contents, exclude_terms, refresh)
            index = _get_index(root, include_contents)
            return web.json_response({"results": results, "index": _index_summary(index)})
        except Exception as exc:
            return _json_error(str(exc))

    @routes.get("/wildcard_organizer/refresh_index")
    async def wildcard_organizer_refresh_index(request):
        try:
            root = _resolve_root(request.query.get("root", ""))
            include_contents = _bool(request.query.get("include_contents", "false"))
            index = _get_index(root, include_contents, refresh=True)
            return web.json_response({"index": _index_summary(index)})
        except Exception as exc:
            return _json_error(str(exc))

    @routes.get("/wildcard_organizer/preview")
    async def wildcard_organizer_preview(request):
        try:
            root = _resolve_root(request.query.get("root", ""))
            return web.json_response(_preview(root, request.query.get("path", ""), request.query.get("key", "")))
        except Exception as exc:
            return _json_error(str(exc))

    @routes.post("/wildcard_organizer/build")
    async def wildcard_organizer_build(request):
        try:
            data = await request.json()
            root = _resolve_root(data.get("root", ""))
            result = _build_prompt(
                root,
                data.get("parts_json", "[]"),
                data.get("manual_text", ""),
                data.get("separator", ", "),
                data.get("seed", 0),
                _bool(data.get("expand_wildcards", False)),
                data.get("manual_position", "prepend"),
            )
            return web.json_response(result)
        except Exception as exc:
            return _json_error(str(exc))


class WildcardOrganizer:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "wildcard_folder": ("STRING", {"default": "", "multiline": False}),
                "search": ("STRING", {"default": "", "multiline": False}),
                "include_file_contents": ("BOOLEAN", {"default": False}),
                "selected_wildcard": ("STRING", {"default": "", "multiline": False}),
                "manual_text": ("STRING", {"default": "", "multiline": False}),
                "manual_position": (["prepend", "append"], {"default": "prepend"}),
                "prompt_parts_json": ("STRING", {"default": "[]", "multiline": False}),
                "separator": ("STRING", {"default": ", ", "multiline": False}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xFFFFFFFF}),
                "expand_wildcards": ("BOOLEAN", {"default": True}),
                "exclude_terms": ("STRING", {"default": "", "multiline": False}),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("prompt",)
    FUNCTION = "organize"
    CATEGORY = "utils/wildcards"

    def organize(
        self,
        wildcard_folder,
        search="",
        include_file_contents=False,
        selected_wildcard="",
        manual_text="",
        manual_position="prepend",
        prompt_parts_json="[]",
        separator=", ",
        seed=0,
        expand_wildcards=False,
        exclude_terms="",
    ):
        if not wildcard_folder:
            wildcard_prompt = _join_prompt_parts(_parts_from_json(prompt_parts_json), separator)
            prompt = _join_manual_text(manual_text, wildcard_prompt, separator, manual_position)
            return (prompt,)

        root = _resolve_root(wildcard_folder)
        built = _build_prompt(root, prompt_parts_json, manual_text, separator, seed, _bool(expand_wildcards), manual_position)
        return (built["prompt"],)


NODE_CLASS_MAPPINGS = {
    "WildcardOrganizer": WildcardOrganizer,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "WildcardOrganizer": "Wildcard Organizer",
}
