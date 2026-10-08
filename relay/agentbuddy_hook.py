#!/usr/bin/env python3
"""agentbuddy-hook: the relay an AI coding agent runs on each hook event.

Reads the hook JSON on stdin, maps the agent's event and field names onto Claude
Code's, and hands it to the GnomeAgentBuddy extension over the Unix socket
$XDG_RUNTIME_DIR/agentbuddy.sock.

Hard rule: never block the agent.
  * No socket (extension off) means we exit 0 at once with only the "no opinion"
    reply the agent expects.
  * Only a PermissionRequest waits for an answer. No answer means no decision and
    the agent asks in its terminal exactly as without the extension.
  * Nothing that allows anything is ever printed without a decision a human clicked.

Usage: agentbuddy-hook [--agent <name>] [<EventName>]

The normalisation and reply tables are a port of the MIT-licensed relay of
Louis-CFM/coucou (windows/hook/src/{normalize,reply}.rs), Copyright (c) 2026 Louis Raille.
"""

import json
import os
import select
import socket
import stat
import struct
import sys
import time

CONNECT_TIMEOUT = 0.3
FIRE_AND_FORGET_BUDGET = 2.0
DECISION_BUDGET = 110.0
MAX_FIELD_LEN = 2000
DROPPED_FIELDS = ("tool_response", "tool_output")
DIFF_TOOLS = ("Edit", "MultiEdit", "Write")
DIFF_FIELDS = ("old_string", "new_string", "content")
MAX_DIFF_FIELD_LEN = 256 * 1024
MAX_DIFF_TOTAL = 512 * 1024
SOCKET_NAME = "agentbuddy.sock"

EVENT_NAMES = {
    # Gemini CLI
    "BeforeTool": "PreToolUse", "BeforeToolSelection": "PreToolUse",
    "AfterTool": "PostToolUse", "AfterModel": "PostToolUse",
    "BeforeAgent": "UserPromptSubmit", "AfterAgent": "Stop",
    "startup": "SessionStart", "exit": "SessionEnd",
    # Antigravity
    "PreInvocation": "UserPromptSubmit", "PostInvocation": "PostToolUse",
    # snake_case relays
    "pre_tool_use": "PreToolUse", "post_tool_use": "PostToolUse",
    "user_prompt_submit": "UserPromptSubmit", "session_start": "SessionStart",
    "session_end": "SessionEnd", "stop": "Stop",
    # Copilot CLI (camelCase), Cursor shares most
    "sessionStart": "SessionStart", "userPromptSubmitted": "UserPromptSubmit",
    "agentStop": "Stop", "notification": "Notification",
    "preToolUse": "PreToolUse", "postToolUse": "PostToolUse",
    "permissionRequest": "PermissionRequest", "sessionEnd": "SessionEnd",
    # Cursor
    "beforeSubmitPrompt": "UserPromptSubmit", "postToolUseFailure": "PostToolUseFailure",
    "subagentStart": "SubagentStart", "subagentStop": "SubagentStop",
}

ARG_ALIASES = (
    ("CommandLine", "command"), ("FilePath", "file_path"), ("Path", "path"),
    ("Url", "url"), ("Query", "query"), ("Pattern", "pattern"),
)

# Agents whose permission requests the island can answer ("" is Claude Code).
DECIDING_AGENTS = ("", "codex", "copilot")
# Agents that read a JSON object on stdout after every hook.
JSON_AGENTS = ("gemini", "antigravity", "copilot")


def canonical_event(name):
    return EVENT_NAMES.get(name, name)


def _non_empty_str(mapping, key):
    value = mapping.get(key)
    return value if isinstance(value, str) and value else None


def normalize_fields(payload, env):
    """Fill tool_name, tool_input, session_id and cwd from wherever the agent put
    them. A field the payload already has is never overwritten."""
    tool_call = payload.get("toolCall") if isinstance(payload.get("toolCall"), dict) else None

    if "tool_name" not in payload:
        name = (_non_empty_str(payload, "toolName")
                or (tool_call and _non_empty_str(tool_call, "name"))
                or _non_empty_str(payload, "tool"))
        if name:
            payload["tool_name"] = name

    if "tool_input" not in payload:
        args = None
        tool_args = payload.get("toolArgs")
        if isinstance(tool_args, dict):
            args = dict(tool_args)
        elif isinstance(tool_args, str):
            try:
                parsed = json.loads(tool_args)
                if isinstance(parsed, dict):
                    args = parsed
            except ValueError:
                pass
        if args is None and tool_call is not None and isinstance(tool_call.get("args"), dict):
            args = dict(tool_call["args"])
            for source, target in ARG_ALIASES:
                if source in args:
                    args[target] = args[source]
        if args is not None:
            payload["tool_input"] = args

    if not _non_empty_str(payload, "session_id"):
        sid = None
        for key in ("conversationId", "conversation_id", "sessionId", "GEMINI_SESSION_ID"):
            sid = _non_empty_str(payload, key)
            if sid:
                break
        sid = sid or env("GEMINI_SESSION_ID")
        if sid:
            payload["session_id"] = sid

    if not _non_empty_str(payload, "cwd"):
        cwd = _non_empty_str(payload, "workdir")
        if not cwd:
            for key in ("workspacePaths", "workspace_roots"):
                roots = payload.get(key)
                if isinstance(roots, list) and roots and isinstance(roots[0], str) and roots[0]:
                    cwd = roots[0]
                    break
        if cwd:
            payload["cwd"] = cwd


def refine_event(event, payload):
    """A stop that reports an error (Cursor's status: error) is a StopFailure."""
    if event == "Stop" and payload.get("status") == "error":
        return "StopFailure"
    return event


def _cut(text, limit):
    if len(text.encode("utf-8")) <= limit:
        return text, False
    return text.encode("utf-8")[:limit].decode("utf-8", "ignore") + "…", True


def _truncate_strings(value, limit=MAX_FIELD_LEN):
    if isinstance(value, str):
        return _cut(value, limit)[0]
    if isinstance(value, list):
        return [_truncate_strings(item, limit) for item in value]
    if isinstance(value, dict):
        return {key: _truncate_strings(item, limit) for key, item in value.items()}
    return value


def _cap_diff_strings(value, budget):
    """tool_input of a diff tool: edit strings share the budget, each capped; any
    other string gets the ordinary cap. Returns (value, cut_any)."""
    cut_any = False
    if isinstance(value, dict):
        out = {}
        for key, item in value.items():
            if isinstance(item, str) and key in DIFF_FIELDS:
                text, was_cut = _cut(item, min(MAX_DIFF_FIELD_LEN, budget[0]))
                budget[0] = max(0, budget[0] - len(text.encode("utf-8")))
                cut_any = cut_any or was_cut
                out[key] = text
            else:
                out[key], inner = _cap_diff_strings(item, budget)
                cut_any = cut_any or inner
        return out, cut_any
    if isinstance(value, list):
        out = []
        for item in value:
            capped, inner = _cap_diff_strings(item, budget)
            out.append(capped)
            cut_any = cut_any or inner
        return out, cut_any
    if isinstance(value, str):
        return _cut(value, MAX_FIELD_LEN)[0], False
    return value, False


def truncate_payload(payload, event):
    """Cap every string, except the edit text of a finished Edit/MultiEdit/Write,
    which the live diff needs whole (within its own limits)."""
    keeps_diff = event == "PostToolUse" and payload.get("tool_name") in DIFF_TOOLS
    tool_input = payload.pop("tool_input", None) if keeps_diff else None
    result = _truncate_strings(payload)
    if tool_input is not None:
        capped, cut_any = _cap_diff_strings(tool_input, [MAX_DIFF_TOTAL])
        result["tool_input"] = capped
        if cut_any:
            result["agentbuddy_diff_truncated"] = True
    return result


def terminal_context(payload, env):
    for key, var in (("term_program", "TERM_PROGRAM"), ("term_session_id", "TERM_SESSION_ID"),
                     ("vscode_pid", "VSCODE_PID"), ("session_pid", "CLAUDE_CODE_SSE_PORT")):
        payload.setdefault(key, env(var) or "")


def agent_tag(arg, env):
    if arg:
        return arg
    return "claude-desktop" if env("CLAUDE_CODE_ENTRYPOINT") == "claude-desktop" else None


def prepare(raw, agent, event_arg, env, cwd):
    """The event to forward from the raw stdin bytes, or None when unreadable.
    Returns (line, event_name, question)."""
    if raw.startswith(b"\xef\xbb\xbf"):
        raw = raw[3:]
    try:
        payload = json.loads(raw.decode("utf-8", "replace"))
    except ValueError:
        return None
    if not isinstance(payload, dict):
        return None

    tag = agent_tag(agent, env)
    if tag:
        payload["agentbuddy_agent"] = tag

    raw_event = _non_empty_str(payload, "hook_event_name") or event_arg
    normalize_fields(payload, env)
    name = refine_event(canonical_event(raw_event), payload)
    payload["hook_event_name"] = name

    for field in DROPPED_FIELDS:
        payload.pop(field, None)
    if not _non_empty_str(payload, "cwd") and cwd:
        payload["cwd"] = cwd
    terminal_context(payload, env)

    # Kept whole: what goes back to Claude Code must be its own input.
    question = None
    if payload.get("tool_name") == "AskUserQuestion":
        question = payload.get("tool_input")

    # Also kept whole: a suggestion the user picks is echoed back verbatim, so a cut
    # copy must never be what goes into the agent's permission rules.
    suggestions = payload.get("permission_suggestions")
    if not isinstance(suggestions, list):
        suggestions = None

    payload = truncate_payload(payload, name)
    return json.dumps(payload, ensure_ascii=False) + "\n", name, question, suggestions


def takes_decisions(agent):
    return agent in DECIDING_AGENTS


def _answers_fit(question, answers):
    items = question.get("questions") if isinstance(question, dict) else None
    if not isinstance(items, list) or not items or len(items) != len(answers):
        return False
    for item in items:
        text = item.get("question") if isinstance(item, dict) else None
        if not isinstance(text, str):
            return False
        labels = [o.get("label") for o in item.get("options", []) if isinstance(o, dict)]
        multi = item.get("multiSelect") is True
        pick = answers.get(text)
        if isinstance(pick, str) and not multi:
            if pick not in labels:
                return False
        elif isinstance(pick, list) and multi:
            if not pick or len(set(pick)) != len(pick) or not all(p in labels for p in pick):
                return False
        else:
            return False
    return True


SUGGESTION_DESTINATIONS = ("session", "localSettings", "projectSettings", "userSettings")


def _usable_suggestion(entry):
    """A permission update the agent itself suggested, safe to hand back as accepted:
    it may only add an allow rule, change to a mode below bypass, or add a directory."""
    if not isinstance(entry, dict) or entry.get("destination") not in SUGGESTION_DESTINATIONS:
        return False
    kind = entry.get("type")
    if kind == "addRules":
        return entry.get("behavior") == "allow" and isinstance(entry.get("rules"), list) and bool(entry["rules"])
    if kind == "setMode":
        return isinstance(entry.get("mode"), str) and entry["mode"] != "bypassPermissions"
    if kind == "addDirectories":
        return isinstance(entry.get("directories"), list) and bool(entry["directories"])
    return False


def decision_json(decision, question, suggestions=None):
    """The documented PermissionRequest output; anything unrecognised prints nothing."""
    decision = decision.strip()
    if decision.startswith("{"):
        try:
            reply = json.loads(decision)
        except ValueError:
            return None
        if isinstance(reply, dict) and "suggestion" in reply:
            # "Yes, and don't ask again...": only the index travels; the rule is the agent's own.
            index = reply["suggestion"]
            if (isinstance(index, bool) or not isinstance(index, int) or not isinstance(suggestions, list)
                    or not 0 <= index < len(suggestions) or not _usable_suggestion(suggestions[index])):
                return None
            return json.dumps({"hookSpecificOutput": {
                "hookEventName": "PermissionRequest",
                "decision": {"behavior": "allow", "updatedPermissions": [suggestions[index]]}}})
        answers = reply.get("answers") if isinstance(reply, dict) else None
        if not isinstance(answers, dict) or not isinstance(question, dict):
            return None
        if not _answers_fit(question, answers):
            return None
        updated = dict(question)
        updated["answers"] = answers
        return json.dumps({"hookSpecificOutput": {
            "hookEventName": "PermissionRequest",
            "decision": {"behavior": "allow", "updatedInput": updated}}})
    if decision in ("allow", "always"):
        behavior = {"behavior": "allow"}
    elif decision == "deny":
        behavior = {"behavior": "deny", "message": "Denied from GnomeAgentBuddy"}
    else:
        return None
    return json.dumps({"hookSpecificOutput": {
        "hookEventName": "PermissionRequest", "decision": behavior}})


def reply_stdout(agent, event, decision, question, suggestions=None):
    """The line to print for `event` from `agent`; None means print nothing."""
    if event != "PermissionRequest":
        # Antigravity reads "{}" on PreToolUse as a denial; "ask" keeps its own prompt.
        if agent.lower() == "antigravity" and event == "PreToolUse":
            return '{"decision":"ask"}'
        return "{}" if agent in JSON_AGENTS else None
    if not takes_decisions(agent):
        decision = None
    if agent == "copilot":
        word = {"allow": "allow", "always": "allow", "deny": "deny"}.get((decision or "").strip())
        return json.dumps({"permissionDecision": word or "ask"}, separators=(",", ":"))
    if decision is None:
        return None
    # Only Claude Code asks questions and takes its own permission suggestions.
    return decision_json(decision, question if agent == "" else None,
                         suggestions if agent == "" else None)


def socket_path(env=os.environ.get):
    directory = env("XDG_RUNTIME_DIR")
    if not directory or not os.path.isabs(directory):
        directory = "/run/user/%d" % os.getuid()
    try:
        info = os.lstat(directory)
    except OSError:
        return None
    private = (stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid()
               and info.st_mode & 0o077 == 0)
    return os.path.join(directory, SOCKET_NAME) if private else None


def _server_is_same_user(sock):
    try:
        cred = sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
        return struct.unpack("3i", cred)[1] == os.getuid()
    except OSError:
        return False


def connect(path, timeout=CONNECT_TIMEOUT):
    if path is None:
        return None
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(timeout)
    try:
        sock.connect(path)
    except OSError:
        sock.close()
        return None
    if not _server_is_same_user(sock):
        sock.close()
        return None
    return sock


def talk(path, line, waits_for_answer, budget):
    """Send the event; for a permission request wait for the island's word."""
    deadline = time.monotonic() + budget
    sock = connect(path)
    if sock is None:
        return None
    try:
        sock.settimeout(max(0.05, deadline - time.monotonic()))
        sock.sendall(line.encode("utf-8"))
        if not waits_for_answer:
            return None
        buf = b""
        while b"\n" not in buf:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            ready, _, _ = select.select([sock], [], [], remaining)
            if not ready:
                break
            chunk = sock.recv(4096)
            if not chunk:
                break
            buf += chunk
        answer = buf.decode("utf-8", "replace").strip()
        return answer or None
    except OSError:
        return None
    finally:
        sock.close()


def parse_args(argv):
    agent, event = "", ""
    it = iter(argv)
    for arg in it:
        if arg == "--agent":
            agent = next(it, "")
        elif not event:
            event = arg
    return agent, event


def main(argv=None, stdin=None, stdout=None):
    argv = sys.argv[1:] if argv is None else argv
    stdin = stdin or sys.stdin.buffer
    stdout = stdout or sys.stdout
    agent, event_arg = parse_args(argv)
    raw = stdin.read()
    prepared = prepare(raw, agent, event_arg, os.environ.get, os.getcwd())
    if prepared is None:
        out = reply_stdout(agent, canonical_event(event_arg), None, None)
    else:
        line, name, question, suggestions = prepared
        waits = name == "PermissionRequest" and takes_decisions(agent)
        budget = DECISION_BUDGET if waits else FIRE_AND_FORGET_BUDGET
        decision = talk(socket_path(), line, waits, budget)
        out = reply_stdout(agent, name, decision, question, suggestions)
    if out:
        stdout.write(out + "\n")
        stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
