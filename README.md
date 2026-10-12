# AgentBuddy

A small blob that lives in a notch at the top of your GNOME screen, watches your AI coding agents, and lets you
approve permissions and answer questions without leaving what you are doing.

It is a GNOME Shell extension (GNOME 50) inspired by [Coucou](https://github.com/Louis-CFM/coucou), which does the
same on macOS in the MacBook notch. The mascot, the name and all artwork here are original; some of the hook logic is
ported from Coucou's MIT-licensed code (see [License](#license)).

## Features

- **Session overview.** The notch shows what your agents are doing (working, waiting for you, done, failed) with a
  blob that changes mood. Hover for a one-line-per-session peek, click for the full list. Sessions show their Claude
  Code title.
- **Permission cards.** When an agent asks for permission the notch glows and shows a badge. Open it for the same
  choices Claude Code offers in its own prompt: *Yes*, *Yes, and don't ask again for …*, *Yes, and switch to … mode*,
  *No*. Number keys `1`-`9` pick a choice. The question is also asked in the terminal all the time, so the card is just
  a second place to answer.
- **Questions.** An agent's multiple-choice question can be answered from the notch.
- **Agents.** Claude Code, Codex, GitHub Copilot CLI (with Allow / Deny in the notch) and Gemini CLI (status only).
- **Organic notch.** Drag it with `Super` + left button. Dropped near a screen edge it docks and flows into it, like
  the notch in [GnomeCodeNotchBar](https://github.com/Dazix/GnomeCodeNotchBar). `Super` + double-click puts it back.
  The monitor and position are remembered.
- **Safe by design.** Nothing is ever allowed without a click. With the extension off, slow, or crashed, the relay
  exits at once and the agent asks in its terminal as usual. Hooks are installed only after you have seen the exact
  diff, a dated backup is taken first, your own hooks are never touched, and removing them deletes only what was added.

## Requirements

- GNOME Shell 50
- `glib-compile-schemas` (package `libglib2.0-bin` / `glib2`)

## Install

```sh
git clone git@github.com:Dazix/GnomeAgentBuddy.git \
  ~/.local/share/gnome-shell/extensions/buddyagent@dazix.github.io
cd ~/.local/share/gnome-shell/extensions/buddyagent@dazix.github.io
glib-compile-schemas schemas/
gnome-extensions enable buddyagent@dazix.github.io
```

On Wayland, log out and back in so the shell picks up a new extension. Then open the settings
(`gnome-extensions prefs buddyagent@dazix.github.io`, or right-click the notch), go to **Agents** and press **Install hooks…**
for each agent you use. Start a new agent session to pick the hooks up. Codex asks you to trust new hooks once with
`/hooks`.

## How it works

```
agent hook ──► agentbuddy-hook (GJS) ──► Unix socket ──► extension ──► notch
                      ▲                                                     │
                      └────────────── your answer (Allow / Deny / …) ◄──────┘
```

- `relay/agentbuddy-hook` (with `relay/agentbuddy-hook-core.js`) is what the agents run on every hook event. It maps each agent's event and field names
  onto Claude Code's, forwards the event to `$XDG_RUNTIME_DIR/agentbuddy.sock` and, only for a permission request,
  waits for your answer. It is copied to `~/.local/share/AgentBuddy/bin/agentbuddy-hook` so hooks keep working
  across extension updates.
- `lib/relayServer.js` listens on the socket (same user only), `model/sessionStore.js` folds events into sessions and
  pending requests, `ui/` draws the notch, the blob and the cards.

## What it touches (for reviewers)

- **No network, no subprocess.** The extension never connects to a remote host and never spawns a process. Its
  only IPC is the Unix socket `$XDG_RUNTIME_DIR/agentbuddy.sock` (mode 0600, peer uid checked).
- **The relay is written in GJS and is not run by the extension.** Agents run hooks as plain commands, so the relay
  (`relay/agentbuddy-hook` and the module `relay/agentbuddy-hook-core.js` it imports) has to be an executable file that
  survives extension updates. Both are copied to `~/.local/share/AgentBuddy/bin/` only when you press
  **Install hooks…** (and refreshed on enable only if they are already there). It exits at once when the extension
  is not listening.
- **Agent configs are edited only on request.** In the settings you see the exact diff first; a dated backup is
  made, a file that changed since the preview is refused, and removing the hooks deletes only our entries.
- **Everything created in `enable()` is removed in `disable()`**: widget, socket, timers, signal handlers,
  stylesheet. Nothing is created at import time.
- `prefs.js` is the only file that imports GTK/Adwaita; the shell side imports no GTK.

## Development

Run the extension in a nested shell:

```sh
dbus-run-session gnome-shell --devkit --wayland
```

Run the tests (no dependencies besides `gjs`):

```sh
gjs -m tests/run.js
```

Pack the extension for extensions.gnome.org (only what it needs at run time: no tests or CI files):

```sh
gnome-extensions pack --force \
  --extra-source=lib --extra-source=model --extra-source=ui \
  --extra-source=relay --extra-source=LICENSE --extra-source=NOTICE
```

Tests live in `tests/*.test.js`. They cover the pure logic (relay, session model, placement,
notch geometry, hook installer, mascot drawing), the relay-to-extension round trip over a real socket, and that no
mascot pose is ever clipped by its box. UI that needs a running shell is checked by hand.

CI runs the `test` job (GSettings schema validation and the
tests above) on every pull request.

## License

The code is under the [MIT License](LICENSE). Parts of the relay (`relay/agentbuddy-hook-core.js`: event and field
normalisation, reply formats) and of the hook installer (`lib/hookInstaller.js`) are ported from
[Coucou](https://github.com/Louis-CFM/coucou), Copyright (c) 2026 Louis Raillé, also MIT; see [NOTICE](NOTICE).
The Coucou name, the Mochi character and its artwork are not part of this project.
