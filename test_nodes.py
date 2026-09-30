import json
import unittest
from pathlib import Path
from unittest.mock import patch

import nodes


class WildcardOrganizerTests(unittest.TestCase):
    def setUp(self):
        nodes.INDEX_CACHE.clear()

    def test_impact_pack_key_starts_inside_wildcards_folder(self):
        root = Path("C:/ComfyUI")
        wildcard = root / "custom_nodes" / "ComfyUI-Impact-Pack" / "wildcards" / "junkyard" / "hair" / "color" / "Black.txt"

        key = nodes._relative_file_key(root, wildcard)

        self.assertEqual(key, "junkyard/hair/color/black")
        self.assertEqual(nodes._wildcard_text(key), "__junkyard/hair/color/black__")

    def test_nested_impact_wildcard_expands_to_a_file_choice(self):
        root = Path("C:/ComfyUI")
        indexed = {
            "entries": [{"key": "hair/color", "wildcard": "__hair/color__", "kind": "txt", "choices": ["black", "blonde"]}]
        }
        parts = json.dumps([{"type": "wildcard", "wildcard": "__hair/color__"}])
        with patch.object(nodes, "_get_index", return_value=indexed):
            built = nodes._build_prompt(root, parts, seed=0, expand_wildcards=True)

        self.assertIn(built["prompt"], {"black", "blonde"})
        self.assertNotIn("__", built["prompt"])

    def test_choice_group_is_sampled_when_resolved(self):
        parts = json.dumps(
            [{"type": "choice", "choices": [{"type": "text", "text": "red"}, {"type": "text", "text": "blue"}]}]
        )

        built = nodes._build_prompt(None, parts, seed=1, expand_wildcards=True)

        self.assertIn(built["prompt"], {"red", "blue"})
        self.assertNotIn("{", built["prompt"])


if __name__ == "__main__":
    unittest.main()
