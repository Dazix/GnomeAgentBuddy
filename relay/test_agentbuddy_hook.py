import json
import os
import socket
import sys
import tempfile
import threading
import unittest

sys.path.insert(0, os.path.dirname(__file__))
import agentbuddy_hook as hook  # noqa: E402

AGENTS = ["", "gemini", "antigravity", "cursor", "codex", "copilot", "opencode", "my-tool"]
EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest",
          "Notification", "Stop", "StopFailure", "SessionEnd", ""]


def no_env(_):
    return None


def run(raw, agent="", event=""):
    line, name, question, _suggestions = hook.prepare(raw.encode(), agent, event, no_env, "/home/me/here")
    return json.loads(line), name, question


def allows(out):
    value = json.loads(out)
    decided = "decision" in value and value["decision"] != "ask"
    return "allow" in json.dumps(value) or decided


class EventNames(unittest.TestCase):
    def test_agent_names_map_onto_claude_code(self):
        for raw, canonical in [("BeforeTool", "PreToolUse"), ("AfterAgent", "Stop"),
                               ("PreInvocation", "UserPromptSubmit"), ("preToolUse", "PreToolUse"),
                               ("permissionRequest", "PermissionRequest"),
                               ("beforeSubmitPrompt", "UserPromptSubmit"),
                               ("subagentStop", "SubagentStop")]:
            self.assertEqual(hook.canonical_event(raw), canonical)
        for same in ("PreToolUse", "Interrupt", "somethingNew"):
            self.assertEqual(hook.canonical_event(same), same)

    def test_stop_with_error_is_a_failure(self):
        self.assertEqual(hook.refine_event("Stop", {"status": "error"}), "StopFailure")
        self.assertEqual(hook.refine_event("Stop", {"status": "completed"}), "Stop")
        self.assertEqual(hook.refine_event("PreToolUse", {"status": "error"}), "PreToolUse")


class Fields(unittest.TestCase):
    def test_antigravity_tool_call(self):
        payload = {"conversationId": "c1", "workspacePaths": ["/w"],
                   "toolCall": {"name": "run_command", "args": {"CommandLine": "ls"}}}
        hook.normalize_fields(payload, no_env)
        self.assertEqual(payload["tool_name"], "run_command")
        self.assertEqual(payload["tool_input"]["command"], "ls")
        self.assertEqual(payload["session_id"], "c1")
        self.assertEqual(payload["cwd"], "/w")

    def test_copilot_args_as_json_text(self):
        payload = {"toolName": "bash", "toolArgs": "{\"command\":\"npm test\"}",
                   "sessionId": "s9", "workdir": "/app"}
        hook.normalize_fields(payload, no_env)
        self.assertEqual(payload["tool_input"]["command"], "npm test")
        self.assertEqual(payload["cwd"], "/app")

    def test_existing_fields_are_kept(self):
        payload = {"tool_name": "Bash", "session_id": "keep", "cwd": "/keep",
                   "toolName": "other", "conversationId": "no", "workdir": "/no"}
        hook.normalize_fields(payload, lambda _: "env")
        self.assertEqual((payload["tool_name"], payload["session_id"], payload["cwd"]),
                         ("Bash", "keep", "/keep"))

    def test_gemini_session_from_env_last(self):
        payload = {}
        hook.normalize_fields(payload, lambda k: "g7" if k == "GEMINI_SESSION_ID" else None)
        self.assertEqual(payload["session_id"], "g7")

    def test_odd_shapes_are_ignored(self):
        payload = {"toolCall": "nope", "toolArgs": "not json", "workspacePaths": "x", "tool": 3}
        hook.normalize_fields(payload, no_env)
        for key in ("tool_name", "tool_input", "cwd"):
            self.assertNotIn(key, payload)


class Prepare(unittest.TestCase):
    def test_claude_code_payload_passes_through(self):
        value, name, _ = run('{"hook_event_name":"PreToolUse","tool_name":"Bash","cwd":"/p"}')
        self.assertEqual(name, "PreToolUse")
        self.assertNotIn("agentbuddy_agent", value)
        self.assertEqual(value["cwd"], "/p")

    def test_agent_event_is_tagged_and_renamed(self):
        value, name, _ = run('{"hook_event_name":"BeforeTool","toolCall":{"name":"shell",'
                             '"args":{"CommandLine":"ls"}}}', "gemini")
        self.assertEqual(name, "PreToolUse")
        self.assertEqual(value["agentbuddy_agent"], "gemini")
        self.assertEqual(value["tool_input"]["command"], "ls")
        self.assertEqual(value["cwd"], "/home/me/here")

    def test_unreadable_input_is_not_forwarded(self):
        for raw in (b"", b"not json", b"[1,2]"):
            self.assertIsNone(hook.prepare(raw, "", "", no_env, "/"))
        self.assertIsNotNone(hook.prepare(b'\xef\xbb\xbf{"hook_event_name":"Stop"}', "", "", no_env, "/"))

    def test_question_is_kept_whole(self):
        long = "x" * 3000
        raw = json.dumps({"hook_event_name": "PermissionRequest", "tool_name": "AskUserQuestion",
                          "tool_input": {"questions": [{"question": long}]}})
        value, _, question = run(raw)
        self.assertEqual(len(question["questions"][0]["question"]), 3000)
        self.assertTrue(value["tool_input"]["questions"][0]["question"].endswith("…"))

    def test_long_strings_cut_on_char_boundary(self):
        value = hook.truncate_payload({"tool_input": {"content": "é" * 4000}}, "PreToolUse")
        text = value["tool_input"]["content"]
        self.assertTrue(text.endswith("…"))
        self.assertLessEqual(len(text.encode()), hook.MAX_FIELD_LEN + 4)

    def test_finished_edit_keeps_text_whole(self):
        big = "line\n" * 4000
        payload = {"tool_name": "Edit", "cwd": "x" * 4000,
                   "tool_input": {"file_path": "/p/a.ts", "old_string": big, "new_string": big}}
        value = hook.truncate_payload(payload, "PostToolUse")
        self.assertEqual(len(value["tool_input"]["old_string"]), len(big))
        self.assertLessEqual(len(value["cwd"].encode()), hook.MAX_FIELD_LEN + 4)
        self.assertNotIn("agentbuddy_diff_truncated", value)

    def test_edit_is_capped_before_it_happens_and_for_other_tools(self):
        big = "é" * 4000
        for event, tool in (("PreToolUse", "Edit"), ("PermissionRequest", "Write"),
                            ("PostToolUse", "Bash")):
            value = hook.truncate_payload({"tool_name": tool, "tool_input": {"content": big}}, event)
            self.assertLessEqual(len(value["tool_input"]["content"].encode()), hook.MAX_FIELD_LEN + 4)

    def test_edit_beyond_budget_is_cut_and_flagged(self):
        value = hook.truncate_payload(
            {"tool_name": "Write", "tool_input": {"content": "x" * (hook.MAX_DIFF_FIELD_LEN + 10)}},
            "PostToolUse")
        self.assertIs(value["agentbuddy_diff_truncated"], True)


class Replies(unittest.TestCase):
    def test_nothing_allowed_without_a_decision(self):
        for agent in AGENTS:
            for event in EVENTS:
                for decision in (None, "", "ask", "maybe", '{"permissionDecision":"allow"}'):
                    out = hook.reply_stdout(agent, event, decision, None)
                    if out:
                        self.assertFalse(allows(out), (agent, event, decision, out))

    def test_decision_only_counts_on_permission_request_of_deciding_agent(self):
        for agent in AGENTS:
            for event in (e for e in EVENTS if e != "PermissionRequest"):
                out = hook.reply_stdout(agent, event, "allow", None)
                if out:
                    self.assertFalse(allows(out))
            out = hook.reply_stdout(agent, "PermissionRequest", "allow", None)
            self.assertEqual(bool(out and allows(out)), hook.takes_decisions(agent), (agent, out))

    def test_reply_shapes(self):
        allow = ('{"hookSpecificOutput": {"hookEventName": "PermissionRequest", '
                 '"decision": {"behavior": "allow"}}}')
        for agent in ("", "codex"):
            self.assertEqual(hook.reply_stdout(agent, "PermissionRequest", "allow", None), allow)
            self.assertEqual(hook.reply_stdout(agent, "PermissionRequest", "always", None), allow)
            self.assertIn('"deny"', hook.reply_stdout(agent, "PermissionRequest", "deny", None))
            self.assertIsNone(hook.reply_stdout(agent, "PermissionRequest", None, None))
            self.assertIsNone(hook.reply_stdout(agent, "PreToolUse", None, None))
        self.assertEqual(hook.reply_stdout("copilot", "PermissionRequest", "deny", None),
                         '{"permissionDecision":"deny"}')
        self.assertEqual(hook.reply_stdout("copilot", "PermissionRequest", None, None),
                         '{"permissionDecision":"ask"}')
        self.assertEqual(hook.reply_stdout("copilot", "PreToolUse", None, None), "{}")
        self.assertEqual(hook.reply_stdout("antigravity", "PreToolUse", None, None), '{"decision":"ask"}')
        self.assertEqual(hook.reply_stdout("antigravity", "Stop", None, None), "{}")
        self.assertEqual(hook.reply_stdout("gemini", "PreToolUse", None, None), "{}")
        self.assertIsNone(hook.reply_stdout("cursor", "PreToolUse", None, None))
        self.assertIsNone(hook.reply_stdout("gemini", "PermissionRequest", "allow", None))

    def test_answers_must_match_the_questions(self):
        question = {"questions": [
            {"question": "Which?", "options": [{"label": "A"}, {"label": "B"}]},
            {"question": "Extras?", "multiSelect": True,
             "options": [{"label": "Tests"}, {"label": "Docs"}]}]}

        def ok(answers):
            return hook.decision_json(json.dumps({"answers": answers}), question) is not None

        self.assertTrue(ok({"Which?": "A", "Extras?": ["Tests", "Docs"]}))
        self.assertFalse(ok({"Which?": "C", "Extras?": ["Tests"]}))
        self.assertFalse(ok({"Which?": "A"}))
        self.assertFalse(ok({"Which?": ["A"], "Extras?": ["Tests"]}))
        self.assertFalse(ok({"Which?": "A", "Extras?": "Tests"}))
        self.assertFalse(ok({"Which?": "A", "Extras?": []}))
        self.assertFalse(ok({"Which?": "A", "Extras?": ["Tests", "Tests"]}))
        self.assertIsNone(hook.decision_json('{"answers":{"q":"a"}}', None))

    def test_answered_question_returns_same_input_plus_answers(self):
        question = {"questions": [{"question": "Which?", "options": [{"label": "A"}, {"label": "B"}]}]}
        out = hook.reply_stdout("", "PermissionRequest", '{"answers":{"Which?":"B"}}', question)
        decision = json.loads(out)["hookSpecificOutput"]["decision"]
        self.assertEqual(decision["updatedInput"]["questions"], question["questions"])
        self.assertEqual(decision["updatedInput"]["answers"], {"Which?": "B"})
        self.assertIsNone(hook.reply_stdout("codex", "PermissionRequest",
                                            '{"answers":{"Which?":"B"}}', question))


class Suggestions(unittest.TestCase):
    RULE = {"type": "addRules", "rules": [{"toolName": "Bash", "ruleContent": "node --check"}],
            "behavior": "allow", "destination": "localSettings"}
    MODE = {"type": "setMode", "mode": "auto", "destination": "session"}

    def choose(self, index, suggestions, agent=""):
        return hook.reply_stdout(agent, "PermissionRequest", json.dumps({"suggestion": index}), None, suggestions)

    def test_picked_suggestion_is_echoed_back_verbatim(self):
        out = self.choose(1, [self.RULE, self.MODE])
        decision = json.loads(out)["hookSpecificOutput"]["decision"]
        self.assertEqual(decision, {"behavior": "allow", "updatedPermissions": [self.MODE]})
        self.assertEqual(json.loads(self.choose(0, [self.RULE]))["hookSpecificOutput"]["decision"]
                         ["updatedPermissions"], [self.RULE])

    def test_whole_suggestions_survive_the_field_cap(self):
        long_rule = dict(self.RULE, rules=[{"toolName": "Bash", "ruleContent": "x" * 5000}])
        raw = json.dumps({"hook_event_name": "PermissionRequest", "tool_name": "Bash",
                          "permission_suggestions": [long_rule]})
        line, _, _, suggestions = hook.prepare(raw.encode(), "", "", no_env, "/")
        self.assertEqual(suggestions[0]["rules"][0]["ruleContent"], "x" * 5000)
        self.assertTrue(json.loads(line)["permission_suggestions"][0]["rules"][0]["ruleContent"].endswith("…"))

    def test_nothing_unsafe_or_out_of_range_is_accepted(self):
        deny_rule = dict(self.RULE, behavior="deny")
        bypass = {"type": "setMode", "mode": "bypassPermissions", "destination": "session"}
        elsewhere = dict(self.RULE, destination="/etc")
        unknown = {"type": "replaceRules", "rules": [], "behavior": "allow", "destination": "session"}
        for bad_index in (5, -1, "0", True, 1.0):
            self.assertIsNone(self.choose(bad_index, [self.RULE]))
        for entry in (deny_rule, bypass, elsewhere, unknown, "text", None):
            self.assertIsNone(self.choose(0, [entry]))
        self.assertIsNone(self.choose(0, None))

    def test_only_claude_code_takes_suggestions(self):
        self.assertIsNone(self.choose(0, [self.RULE], agent="codex"))
        self.assertIsNone(self.choose(0, [self.RULE], agent="gemini"))


class Transport(unittest.TestCase):
    def serve(self, path, reply):
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server.bind(path)
        server.listen(1)
        received = []

        def accept():
            conn, _ = server.accept()
            received.append(conn.recv(65536))
            if reply is not None:
                conn.sendall(reply)
            conn.close()
            server.close()

        thread = threading.Thread(target=accept)
        thread.start()
        return thread, received

    def test_no_socket_means_no_answer(self):
        self.assertIsNone(hook.talk(None, "{}\n", True, 1))
        self.assertIsNone(hook.talk("/nonexistent/agentbuddy.sock", "{}\n", True, 1))

    def test_permission_round_trip(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "s.sock")
            thread, received = self.serve(path, b"allow\n")
            self.assertEqual(hook.talk(path, '{"a":1}\n', True, 5), "allow")
            thread.join()
            self.assertEqual(received, [b'{"a":1}\n'])

    def test_fire_and_forget_does_not_wait(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "s.sock")
            thread, received = self.serve(path, None)
            self.assertIsNone(hook.talk(path, '{"b":2}\n', False, 5))
            thread.join()
            self.assertEqual(received, [b'{"b":2}\n'])

    def test_socket_path_requires_a_private_runtime_dir(self):
        with tempfile.TemporaryDirectory() as directory:
            os.chmod(directory, 0o700)
            self.assertEqual(hook.socket_path(lambda _: directory), os.path.join(directory, "agentbuddy.sock"))
            os.chmod(directory, 0o755)
            self.assertIsNone(hook.socket_path(lambda _: directory))


if __name__ == "__main__":
    unittest.main()
