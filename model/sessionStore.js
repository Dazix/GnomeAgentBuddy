/**
 * Session model: what the relay tells us, folded into sessions and pending
 * permission requests. Pure logic (no GNOME imports) so it is unit-tested with gjs.
 */

import {editFromTool} from './editDiff.js';

export const MAX_STEPS = 6;
/** Finished edits kept per session for the diff view. */
export const MAX_EDITS = 10;
const DEFAULT_AGENT = 'claude';

/** Agents whose permission requests the island can answer (relay `takes_decisions`). */
const DECIDING_AGENTS = new Set(['claude', 'codex', 'copilot']);

export const State = Object.freeze({
    IDLE: 'idle',
    WORKING: 'working',
    WAITING: 'waiting',
    DONE: 'done',
    ERROR: 'error',
});

export const Mood = Object.freeze({
    SLEEPY: 'sleepy',
    IDLE: 'idle',
    WORKING: 'working',
    ALERT: 'alert',
    HAPPY: 'happy',
    SAD: 'sad',
});

const short = (text, max = 80) => {
    const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

const basename = path => String(path ?? '').split('/').filter(Boolean).pop() ?? '';

/** One line describing a tool call, for the ticker and the permission card. */
export function summarizeTool(tool, input = {}) {
    const name = tool || 'tool';
    const i = input && typeof input === 'object' ? input : {};
    const target = i.file_path ?? i.path ?? i.url ?? i.pattern ?? i.query;
    if (i.command)
        return `${name} · ${short(i.command)}`;
    if (target)
        return `${name} · ${short(basename(target) || target)}`;
    return name;
}

/**
 * Characters that change how text looks without showing up themselves: control
 * characters, soft hyphen, zero-width and bidirectional marks and overrides, the
 * invisible tag block. In a command they could make what the card shows differ from
 * what runs, so they are written out as `<U+202E>`. Newline and tab stay.
 */
const INVISIBLE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F­؜​-‏‪-‮⁠-⁯﻿]|[\u{E0000}-\u{E007F}]/gu;

/** `text` made safe to show: nothing in it is invisible. */
export function displayText(text) {
    return String(text ?? '').replace(INVISIBLE, ch =>
        `<U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}>`);
}

/** What the relay does to a string past this many bytes: cut it and add an ellipsis. */
const RELAY_CUT_BYTES = 1990;
const SECONDARY_LIMIT = 300;
const PRIMARY_KEYS = ['command', 'file_path', 'path', 'url', 'pattern', 'query'];

const looksCut = text => text.endsWith('…') && new TextEncoder().encode(text).length >= RELAY_CUT_BYTES;

/**
 * Everything a tool call asks for, as text for the permission card: the main
 * argument (command, path, url...) in full, then every other argument as
 * `name: value`. `complete` is false when something could not be shown whole (the
 * relay cut it, or a side argument is long), so the card must not offer approval.
 *
 * @returns {{text: string, complete: boolean}}
 */
export function describeInput(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input))
        return {text: '', complete: true};
    let complete = true;
    const lines = [];
    const primary = PRIMARY_KEYS.find(key => typeof input[key] === 'string' && input[key] !== '');
    if (primary) {
        lines.push(input[primary]);
        complete = !looksCut(input[primary]);
    }
    for (const [key, value] of Object.entries(input)) {
        if (key === primary)
            continue;
        const shown = typeof value === 'string' ? value : JSON.stringify(value);
        if (shown === undefined || shown === '')
            continue;
        if (shown.length > SECONDARY_LIMIT || looksCut(shown))
            complete = false;
        lines.push(`${key}: ${shown.length > SECONDARY_LIMIT ? `${shown.slice(0, SECONDARY_LIMIT)}…` : shown}`);
    }
    return {text: displayText(lines.join('\n')), complete};
}

/** The AskUserQuestion input, normalised for the UI, or null when it is not one. */
export function parseQuestion(tool, input) {
    if (tool !== 'AskUserQuestion' || !input || !Array.isArray(input.questions))
        return null;
    const questions = input.questions
        .filter(q => q && typeof q.question === 'string')
        .map(q => ({
            question: q.question,
            header: q.header ?? '',
            multiSelect: q.multiSelect === true,
            options: (q.options ?? []).filter(o => o && typeof o.label === 'string')
                .map(o => ({label: o.label, description: o.description ?? ''})),
        }));
    return questions.length ? questions : null;
}

/**
 * The "Yes, and ..." choices Claude Code itself suggests for a request
 * (`permission_suggestions`), as `{index, label}`. The index is what travels back
 * to the relay, which echoes the agent's own entry: the UI never writes a rule.
 * Only entries the relay would accept are listed (see `_usable_suggestion`).
 */
export function suggestionOptions(suggestions) {
    if (!Array.isArray(suggestions))
        return [];
    const options = [];
    suggestions.forEach((entry, index) => {
        if (!entry || typeof entry !== 'object')
            return;
        if (entry.type === 'addRules' && entry.behavior === 'allow' && Array.isArray(entry.rules) && entry.rules.length) {
            const what = entry.rules.map(r => r.ruleContent || r.toolName).join(', ');
            options.push({index, label: `Yes, and don't ask again for: ${short(what, 70)}`});
        } else if (entry.type === 'setMode' && typeof entry.mode === 'string' && entry.mode !== 'bypassPermissions') {
            options.push({index, label: `Yes, and switch to ${entry.mode} mode`});
        } else if (entry.type === 'addDirectories' && Array.isArray(entry.directories) && entry.directories.length) {
            options.push({index, label: `Yes, and allow access to ${short(entry.directories.join(', '), 60)}`});
        }
    });
    return options;
}

export class SessionStore {
    /**
     * @param {object} [options]
     * @param {() => number} [options.now] clock in ms
     * @param {number} [options.decisionTimeout] seconds a request may wait
     * @param {number} [options.finishedLinger] seconds a finished session stays
     */
    constructor({now = () => Date.now(), decisionTimeout = 100, finishedLinger = 60} = {}) {
        this._now = now;
        this.decisionTimeout = decisionTimeout;
        this.finishedLinger = finishedLinger;
        /** @type {(agent: string) => boolean} */
        this.isEnabled = () => true;
        /** Looks a session's title up from its transcript: `(path) => Promise<string|null>`. */
        this.resolveTitle = null;
        /** @type {Map<string, object>} */
        this.sessions = new Map();
        /** @type {object[]} pending requests, oldest first */
        this.pending = [];
        this._nextId = 1;
        this._listeners = [];
        /** Last time an agent finished a turn, for the happy mood. */
        this._lastDoneAt = 0;
        this._lastErrorAt = 0;
    }

    onChange(listener) {
        this._listeners.push(listener);
    }

    _changed() {
        for (const listener of this._listeners)
            listener();
    }

    /**
     * Fold one relay event in.
     *
     * @param {object} payload normalised hook payload
     * @param {(decision: string|null) => void} [respond] answers a waiting relay
     * @returns {object|null} the pending request when the event is a permission request
     */
    handleEvent(payload, respond = () => {}) {
        const event = payload.hook_event_name;
        const agent = payload.agentbuddy_agent || DEFAULT_AGENT;
        const id = payload.session_id || `${agent}-${payload.cwd ?? 'unknown'}`;
        const key = `${agent}:${id}`;
        const now = this._now();

        // A disabled agent is dropped; its relay then gets no answer and the agent asks as usual.
        if (!this.isEnabled(agent))
            return null;

        if (event === 'SessionEnd') {
            this._dropSession(key);
            this._changed();
            return null;
        }

        let session = this.sessions.get(key);
        if (!session) {
            session = {
                key, agent, id, cwd: payload.cwd ?? '', project: basename(payload.cwd),
                state: State.IDLE, steps: [], edits: [], prompt: '', summary: '', startedAt: now, updatedAt: now,
                title: '', transcriptPath: '', titleCheckedAt: 0,
            };
            this.sessions.set(key, session);
        }
        session.updatedAt = now;
        if (typeof payload.transcript_path === 'string')
            session.transcriptPath = payload.transcript_path;
        this._refreshTitle(session, event, now);
        if (payload.cwd) {
            session.cwd = payload.cwd;
            session.project = basename(payload.cwd);
        }

        let request = null;
        switch (event) {
        case 'SessionStart':
            session.state = State.IDLE;
            break;
        case 'UserPromptSubmit':
            session.state = State.WORKING;
            session.prompt = short(payload.prompt ?? '', 120);
            session.summary = '';
            break;
        case 'PreToolUse':
            session.state = State.WORKING;
            this._clearPending(key, null);
            this._pushStep(session, summarizeTool(payload.tool_name, payload.tool_input));
            break;
        case 'PostToolUse':
            this._recordEdit(session, payload);
        // fall through
        case 'PostToolUseFailure':
            // The agent went on: whatever was pending was answered elsewhere (terminal).
            this._clearPending(key, null);
            if (session.state === State.WAITING)
                session.state = State.WORKING;
            break;
        case 'PermissionRequest':
            request = this._addRequest(session, payload, respond);
            break;
        case 'Notification':
            if (payload.message)
                this._pushStep(session, short(payload.message));
            break;
        case 'Stop':
            this._clearPending(key, null);
            session.state = State.DONE;
            session.summary = short(payload.last_assistant_message ?? payload.message ?? '', 140);
            this._lastDoneAt = now;
            break;
        case 'StopFailure':
            this._clearPending(key, null);
            session.state = State.ERROR;
            this._lastErrorAt = now;
            break;
        default:
            break;
        }

        this._changed();
        return request;
    }

    /**
     * Ask for the session's title (its name in Claude Code) without waiting: the
     * first time a transcript is known, and again after each prompt and answer,
     * since it is generated and renamed as the session goes on. At most every 10 s.
     */
    _refreshTitle(session, event, now) {
        if (!this.resolveTitle || !session.transcriptPath)
            return;
        const refresh = ['UserPromptSubmit', 'Stop'].includes(event);
        if ((session.title && !refresh) || now - session.titleCheckedAt < 10_000)
            return;
        session.titleCheckedAt = now;
        this.resolveTitle(session.transcriptPath).then(title => {
            if (!title || title === session.title || this.sessions.get(session.key) !== session)
                return;
            session.title = title;
            this._changed();
        }).catch(() => {});
    }

    _addRequest(session, payload, respond) {
        const tool = payload.tool_name ?? '';
        const questions = parseQuestion(tool, payload.tool_input);
        const shown = describeInput(payload.tool_input);
        const agent = session.agent;
        const request = {
            id: this._nextId++,
            sessionKey: session.key,
            agent,
            project: session.project,
            title: session.title,
            tool,
            summary: displayText(summarizeTool(tool, payload.tool_input)),
            detail: this._detail(payload.tool_input),
            // All of the call's arguments, safe to show, and whether they fit the card whole.
            display: shown.text,
            incomplete: !shown.complete,
            questions,
            options: suggestionOptions(payload.permission_suggestions),
            // Only an agent whose reply the relay can honour gets Allow/Deny buttons.
            canDecide: DECIDING_AGENTS.has(agent),
            createdAt: this._now(),
            // After this the card is dropped and the agent asks in its own terminal.
            expiresAt: this._now() + this.decisionTimeout * 1000,
            respond,
            answered: false,
        };
        session.state = State.WAITING;
        this.pending.push(request);
        return request;
    }

    _detail(input) {
        if (!input || typeof input !== 'object')
            return '';
        return String(input.command ?? input.file_path ?? input.url ?? input.pattern ?? '');
    }

    /** A finished file edit: keep its diff and put `+N −M` on its ticker line. */
    _recordEdit(session, payload) {
        const edit = editFromTool(payload.tool_name, payload.tool_input);
        if (!edit)
            return;
        edit.truncated = edit.truncated || payload.agentbuddy_diff_truncated === true;
        session.edits.push(edit);
        if (session.edits.length > MAX_EDITS)
            session.edits.splice(0, session.edits.length - MAX_EDITS);

        const step = `${summarizeTool(payload.tool_name, payload.tool_input)} +${edit.added} −${edit.removed}`;
        const started = summarizeTool(payload.tool_name, payload.tool_input);
        if (session.steps[session.steps.length - 1] === started)
            session.steps[session.steps.length - 1] = step;
        else
            this._pushStep(session, step);
    }

    _pushStep(session, step) {
        session.steps.push(step);
        if (session.steps.length > MAX_STEPS)
            session.steps.splice(0, session.steps.length - MAX_STEPS);
    }

    /** Answer a pending request with a decision (`allow` | `deny` | `always` | JSON answers). */
    resolve(requestId, decision) {
        const request = this.pending.find(r => r.id === requestId);
        if (!request)
            return false;
        this._finish(request, decision);
        const session = this.sessions.get(request.sessionKey);
        if (session && !this.pending.some(r => r.sessionKey === session.key))
            session.state = State.WORKING;
        this._changed();
        return true;
    }

    /** The relay hung up (terminal answered, or it timed out): forget the request. */
    cancel(requestId) {
        const request = this.pending.find(r => r.id === requestId);
        if (!request)
            return;
        this._finish(request, null, false);
        const session = this.sessions.get(request.sessionKey);
        if (session && session.state === State.WAITING &&
            !this.pending.some(r => r.sessionKey === session.key))
            session.state = State.WORKING;
        this._changed();
    }

    _finish(request, decision, notify = true) {
        request.answered = true;
        this.pending = this.pending.filter(r => r !== request);
        if (notify)
            request.respond(decision);
    }

    _clearPending(sessionKey, decision) {
        for (const request of this.pending.filter(r => r.sessionKey === sessionKey))
            this._finish(request, decision);
    }

    _dropSession(key) {
        this._clearPending(key, null);
        this.sessions.delete(key);
    }

    /** Expire stale requests and finished sessions. Returns true when something changed. */
    prune() {
        const now = this._now();
        let changed = false;
        for (const request of [...this.pending]) {
            if (now - request.createdAt >= this.decisionTimeout * 1000) {
                this._finish(request, null);
                const session = this.sessions.get(request.sessionKey);
                if (session && session.state === State.WAITING)
                    session.state = State.WORKING;
                changed = true;
            }
        }
        for (const [key, session] of this.sessions) {
            const idleFor = (now - session.updatedAt) / 1000;
            const finished = session.state === State.DONE || session.state === State.ERROR;
            if ((finished && idleFor > this.finishedLinger) || idleFor > 6 * 3600) {
                this._dropSession(key);
                changed = true;
            }
        }
        if (changed)
            this._changed();
        return changed;
    }

    /** Sessions, waiting first, then working, then the most recently active. */
    list() {
        const rank = s => (s.state === State.WAITING ? 0 : s.state === State.WORKING ? 1 : 2);
        return [...this.sessions.values()].sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt);
    }

    /** The oldest request nobody answered yet. */
    get current() {
        return this.pending[0] ?? null;
    }

    /** What the mascot should feel like right now. */
    mood() {
        const now = this._now();
        if (this.pending.length)
            return Mood.ALERT;
        const states = [...this.sessions.values()].map(s => s.state);
        if (states.includes(State.WORKING))
            return Mood.WORKING;
        if (now - this._lastErrorAt < 8000 && this._lastErrorAt)
            return Mood.SAD;
        if (now - this._lastDoneAt < 8000 && this._lastDoneAt)
            return Mood.HAPPY;
        return states.length ? Mood.IDLE : Mood.SLEEPY;
    }
}
