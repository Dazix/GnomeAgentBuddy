# Security policy

AgentBuddy answers permission requests of your AI coding agents: an "Allow" in the notch lets an agent run a
command or edit a file. It also edits the agents' hook configuration when you ask it to (see
[What it touches](README.md#what-it-touches-for-reviewers)). A bug that lets anything other than your click grant a
permission is a security issue.

## Supported versions

Only the latest commit on `main` and the latest release on extensions.gnome.org are supported. Fixes are not
backported.

## Reporting a vulnerability

Please **do not open a public issue**. Report it privately through GitHub:
[Security → Report a vulnerability](https://github.com/Dazix/GnomeAgentBuddy/security/advisories/new).

Include what you can of:

- the GNOME Shell version and the extension version or commit,
- which agent (Claude Code, Codex, Copilot CLI, Gemini CLI) is involved,
- the steps to reproduce and what an attacker gains.

This is a project maintained in spare time. You can expect a first reply within a week. Once a fix is released,
the advisory is published and you are credited unless you ask not to be.

## In scope

- The Unix socket `$XDG_RUNTIME_DIR/agentbuddy.sock`: another user connecting, a forged or replayed event being
  accepted, or an answer reaching the wrong session.
- A permission granted without the user's click, or a "Deny" or timeout that ends up allowing.
- The relay (`relay/agentbuddy-hook`, `relay/agentbuddy-hook-core.js`) and its installed copy in
  `~/.local/share/AgentBuddy/bin/`: anything that lets another user replace it or makes it run something other than
  the forwarding.
- The hook installer: an edit to an agent's configuration beyond what the preview showed, or a lost backup.

## Out of scope

- The agents' own permission systems and what an agent does once a permission is granted.
- Attacks that already require running code as your user.
