"""Regression checks for provider payload isolation and Prompt Line Queue compatibility."""
import importlib.util
import json
import sys
import tempfile
import threading
import types
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

PACK = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("wildcard_pack_test", PACK / "__init__.py")
pack = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = pack
spec.loader.exec_module(pack)
llm = sys.modules[spec.name + ".llm_wildcards"]
queue = sys.modules[spec.name + ".nodes"]


class Generation(unittest.TestCase):
    def setUp(self):
        tmp = self.enterContext(tempfile.TemporaryDirectory())
        self.enterContext(patch.dict(sys.modules, {"folder_paths": types.SimpleNamespace(get_user_directory=lambda: tmp)}))
        self.calls = []
        self.answers = []
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def reply(self, data):
                self.send_response(200)
                self.end_headers()
                self.wfile.write(json.dumps(data).encode())

            def do_GET(self):
                assert self.path == "/v1/models"
                self.reply({"data": [{"id": "local-test"}]})

            def do_POST(self):
                assert self.path == "/v1/chat/completions"
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                owner.calls.append(body)
                answer = owner.answers.pop(0) if owner.answers else f"choice {len(owner.calls)}"
                self.reply({"choices": [{"message": {"content": answer}}]})

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.addCleanup(server.server_close)
        worker = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.02})
        worker.start()
        self.addCleanup(worker.join)
        self.addCleanup(server.shutdown)
        self.args = dict(provider="KoboldCpp", local_base_url=f"http://127.0.0.1:{server.server_port}/v1", model="")

    def test_wildcard_isolation_and_restart(self):
        node = pack.NODE_CLASS_MAPPINGS["LLMWildcard"]()
        self.answers = ["amber", " AMBER ", "blue"]
        prompt = "SECRET {{eye color}} / {{eye color}}"
        self.assertEqual(node.generate(prompt, **self.args)["result"], ("SECRET amber / amber",))
        self.assertEqual(type(node)().generate(prompt, **self.args)["result"], ("SECRET blue / blue",))
        self.assertEqual(len(self.calls), 3)
        self.assertNotIn("SECRET", json.dumps(self.calls))
        fields = json.loads(self.calls[-1]["messages"][1]["content"])
        self.assertEqual(fields["recent"], ["amber"])
        self.assertEqual(fields["category"], "eye color")
        self.assertTrue(fields["examples"])

    def test_selection_batch_isolation_and_queue(self):
        node = llm.LLMPromptVariations()
        prompt = "SECRET  {{eye color|original eyes}}\n--{{hair style|other phrase}}."
        result = node.generate(prompt, **self.args, mode=llm.SELECTED, count=20)
        first, lines = result["result"]
        self.assertEqual(first, "SECRET  choice 1\n--choice 2.")
        parsed = queue._prompt_lines(lines)
        self.assertEqual(len(set(parsed)), 20)
        self.assertEqual(parsed[-1], "SECRET  choice 39 --choice 40.")
        self.assertEqual(result["ui"]["text"], [lines])
        self.assertNotIn("SECRET", json.dumps(self.calls))
        for payload in self.calls:
            fields = json.loads(payload["messages"][1]["content"])
            other = "other phrase" if fields["category"] == "eye color" else "original eyes"
            self.assertNotIn(other, json.dumps(payload))
        with llm.database() as db:
            self.assertEqual(db.execute("SELECT count(*) FROM recent WHERE scope LIKE 'variation:%'").fetchone()[0], 20)

    def test_combined_markers(self):
        node = pack.NODE_CLASS_MAPPINGS["LLMPromptVariations"]()
        prompt = "PRIVATE {{outdoor setting}} / {{hair style|braids}}."
        self.answers = ["orchard", "bob", "shore", "a rewritten prompt"]
        first, lines = node.generate(prompt, **self.args, mode=llm.SELECTED, count=1)["result"]
        self.assertEqual((first, lines), ("PRIVATE orchard / bob.",) * 2)
        self.assertNotIn("PRIVATE", json.dumps(self.calls))
        self.assertNotIn("braids", json.dumps(self.calls[0]))
        node.generate(prompt, **self.args, mode=llm.WHOLE, count=1)
        self.assertEqual(json.loads(self.calls[-1]["messages"][1]["content"])["prompt"], "PRIVATE shore / braids.")

    def test_whole_prompt_rules_and_retries(self):
        node = llm.LLMPromptVariations()
        source = "A red sailboat floats beside the stone pier at dawn."
        rules = "Keep the boat and camera angle. Vary the sail color."
        valid = "A yellow sailboat floats beside the stone pier at dawn."
        self.answers = ["A boat.", "A blue sailboat beside the stone pier with no people.", valid]
        result = node.generate(source, **self.args, mode=llm.WHOLE, count=1, additional_rules=rules)
        self.assertEqual(result["result"][0], valid)
        self.assertEqual(len(self.calls), 3)
        for call in self.calls:
            system, user = call["messages"]
            self.assertIn(llm.VISUAL_RULES, system["content"])
            fields = json.loads(user["content"])
            self.assertEqual(fields["word_range"], [8, 12])
            self.assertEqual(fields["additional_rules"], rules)
        self.assertIn("exclusion", fields["correction"])
        node.generate("Private {{eye color}}", **self.args, mode=llm.SELECTED, count=1, additional_rules=rules)
        self.assertNotIn(rules, json.dumps(self.calls[-1]))

    def test_whole_mode_and_nano_auth(self):
        node = llm.LLMPromptVariations()
        prompt = "FULL PROMPT"
        node.generate(prompt, **self.args, mode=llm.WHOLE, count=2)
        self.assertIn(prompt, json.dumps(self.calls))
        node.generate("Fixed {{eye color|gray eyes}}.", **self.args, mode=llm.WHOLE, count=1)
        self.assertEqual(json.loads(self.calls[-1]["messages"][1]["content"])["prompt"], "Fixed gray eyes.")
        with self.assertRaises(ValueError):
            node.generate(prompt, **self.args, mode=llm.SELECTED, count=1)
        with patch.dict("os.environ", {"NANOGPT_API_KEY": "test-key"}), patch.object(llm.requests, "post") as post:
            post.return_value.status_code = 200
            post.return_value.json.return_value = {"choices": [{"message": {"content": "new shade"}}]}
            llm.LLMWildcard().generate("PRIVATE {{eye color}}", "NanoGPT", self.args["local_base_url"], "test-model")
            self.assertEqual(post.call_args.args, ("https://nano-gpt.com/api/v1/chat/completions",))
            self.assertEqual(post.call_args.kwargs["headers"], {"Authorization": "Bearer test-key"})
            self.assertNotIn("PRIVATE", json.dumps(post.call_args.kwargs))


class CategoryRoutes(unittest.IsolatedAsyncioTestCase):
    async def test_save_and_reload(self):
        routes = web.RouteTableDef()
        llm.register_routes(routes)
        app = web.Application()
        app.add_routes(routes)
        with tempfile.TemporaryDirectory() as tmp, patch.dict(sys.modules, {
            "folder_paths": types.SimpleNamespace(get_user_directory=lambda: tmp)
        }):
            async with TestClient(TestServer(app)) as client:
                url = "/lokitsar/llm-wildcards/categories"
                category = dict(name="cloud type", instruction="Choose a cloud.", examples="cirrus", depth=12)
                self.assertEqual((await client.post(url, json=category)).status, 200)
                self.assertIn(category, await (await client.get(url)).json())
                self.assertEqual((await client.post(url, json={**category, "depth": 0})).status, 400)

    async def test_saved_key_and_model_discovery(self):
        routes = web.RouteTableDef()
        llm.register_routes(routes)
        app = web.Application()
        app.add_routes(routes)
        base = "/lokitsar/llm-wildcards/"
        with tempfile.TemporaryDirectory() as tmp, patch.dict(sys.modules, {
            "folder_paths": types.SimpleNamespace(get_user_directory=lambda: tmp)
        }), patch.dict("os.environ", {"NANOGPT_API_KEY": ""}):
            async with TestClient(TestServer(app)) as client:
                self.assertEqual(await (await client.get(base + "connection")).json(), {"has_key": False})
                response = await client.post(base + "key", json={"key": "fixture-key"})
                self.assertEqual(await response.json(), {"has_key": True})
                self.assertEqual(await (await client.get(base + "connection")).json(), {"has_key": True})
                with patch.object(llm.requests, "get") as get:
                    get.return_value.status_code = 200
                    get.return_value.json.return_value = {"data": [{"id": "one"}, {"id": "two"}]}
                    for provider, endpoint in llm.PROVIDERS.items():
                        response = await client.post(base + "models", json={"provider": provider})
                        self.assertEqual(await response.json(), {"models": ["one", "two"]})
                        self.assertEqual(get.call_args.args, (endpoint + "/models",))
                        expected = {"Authorization": "Bearer fixture-key"} if provider == "NanoGPT" else {}
                        self.assertEqual(get.call_args.kwargs["headers"], expected)
                chat = llm.Chat("NanoGPT", "", "two")
                with patch.object(llm.requests, "post") as post:
                    post.return_value.status_code = 200
                    post.return_value.json.return_value = {"choices": [{"message": {"content": "blue"}}]}
                    self.assertEqual(chat.ask("Choose a color", {}), "blue")
                    self.assertEqual(post.call_args.kwargs["json"]["model"], "two")
                    self.assertEqual(post.call_args.kwargs["headers"]["Authorization"], "Bearer fixture-key")


if __name__ == "__main__":
    unittest.main()
