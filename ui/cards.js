import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {AGENTS} from '../lib/hookInstaller.js';
import {State, displayText} from '../model/sessionStore.js';

export const agentLabel = id => AGENTS[id]?.label ?? id;

function label(text, styleClass, {lines = 1, ellipsize = true} = {}) {
    const actor = new St.Label({text, style_class: styleClass, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
    const clutterText = actor.get_clutter_text();
    clutterText.set_ellipsize(ellipsize ? Pango.EllipsizeMode.END : Pango.EllipsizeMode.NONE);
    if (lines > 1) {
        clutterText.set_line_wrap(true);
        clutterText.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
        clutterText.set_single_line_mode(false);
    }
    return actor;
}

function button(text, styleClass, onClick) {
    const actor = new St.Button({label: text, style_class: `ab-button ${styleClass}`, can_focus: true, x_expand: true});
    actor.connect('clicked', onClick);
    return actor;
}

/** Tools whose input is a plan to read, not something the card can show or approve. */
const PLAN_TOOLS = ['ExitPlanMode'];

/** How long a new card ignores clicks and keys, so a card that replaces another under the pointer cannot be answered by accident. */
const ARM_MS = 400;

/**
 * A card cannot be answered in its first moments. Without this, a click or key aimed at
 * one request (say the previous card, answered in the terminal a heartbeat ago) could
 * land on the next request's Yes before anyone has seen it.
 *
 * `hold(button)` keeps a button dead and dimmed until then; `isArmed()` guards handlers
 * and key shortcuts.
 */
function makeArming(card) {
    let armed = false;
    let source = 0;
    const held = [];
    source = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ARM_MS, () => {
        source = 0;
        armed = true;
        for (const button of held) {
            button.reactive = true;
            button.remove_style_pseudo_class('disabled');
        }
        return GLib.SOURCE_REMOVE;
    });
    GLib.Source.set_name_by_id(source, '[GnomeAgentBuddy] card arming');
    card.connect('destroy', () => {
        if (source)
            GLib.source_remove(source);
    });
    return {
        isArmed: () => armed,
        hold(button) {
            held.push(button);
            if (!armed) {
                button.reactive = false;
                button.add_style_pseudo_class('disabled');
            }
        },
    };
}

/** One single- or multi-select question; calls `onChange(questionText, answer|null)`. */
function buildQuestion(question, onChange, arming) {
    const box = new St.BoxLayout({vertical: true, style_class: 'ab-question'});
    if (question.header)
        box.add_child(label(displayText(question.header), 'ab-caption'));
    box.add_child(label(displayText(question.question), 'ab-text', {lines: 3}));

    const picked = new Set();
    const buttons = [];
    for (const option of question.options) {
        const optionButton = new St.Button({
            label: displayText(option.label), style_class: 'ab-button ab-option', can_focus: true, x_expand: true,
            toggle_mode: true,
        });
        optionButton.connect('clicked', () => {
            if (question.multiSelect) {
                if (optionButton.checked)
                    picked.add(option.label);
                else
                    picked.delete(option.label);
                onChange(question.question, picked.size ? [...picked] : null);
                return;
            }
            // Single choice: the others let go.
            for (const other of buttons)
                other.checked = other === optionButton;
            onChange(question.question, option.label);
        });
        arming.hold(optionButton);
        buttons.push(optionButton);
        box.add_child(optionButton);
    }
    return box;
}

/** Seconds left before the agent asks in its own terminal, from `Date.now()`. */
export const secondsLeft = request => Math.max(0, Math.ceil((request.expiresAt - Date.now()) / 1000));

/** The "agent asks in its terminal in N s" line; `card.updateCountdown()` refreshes it. */
function addCountdown(card, request) {
    const line = label('', 'ab-hint');
    const update = () => {
        // The terminal asks at the same time; the card is only a second place to answer.
        line.text = `Also asked in the terminal · this card closes in ${secondsLeft(request)} s`;
    };
    update();
    card.add_child(line);
    card.updateCountdown = update;
}

/**
 * The card for a pending permission request: Allow / Deny, a question to pick
 * from, or a note when the agent asks in its own terminal.
 *
 * @param {object} request pending request from the SessionStore
 * @param {(decision: string) => void} onDecision
 */
export function buildRequestCard(request, onDecision, {onJump = null} = {}) {
    const card = new St.BoxLayout({vertical: true, style_class: 'ab-card ab-request'});
    const arming = makeArming(card);
    const title = request.project ? `${agentLabel(request.agent)} · ${request.project}` : agentLabel(request.agent);
    card.add_child(label(title, 'ab-caption'));
    // The session's name in Claude Code, so several sessions in one project stay apart.
    if (request.title)
        card.add_child(label(displayText(request.title), 'ab-session-name'));

    if (request.questions) {
        const answers = new Map();
        const send = button('Send', 'ab-allow', () => {
            if (!arming.isArmed())
                return;
            const picked = Object.fromEntries(answers);
            onDecision(JSON.stringify({answers: picked}));
        });
        send.reactive = false;
        send.add_style_pseudo_class('disabled');
        const update = (question, answer) => {
            if (answer === null)
                answers.delete(question);
            else
                answers.set(question, answer);
            const ready = request.questions.every(q => answers.has(q.question));
            send.reactive = ready;
            if (ready)
                send.remove_style_pseudo_class('disabled');
            else
                send.add_style_pseudo_class('disabled');
            // One single-choice question is answered by the click itself.
            const [only] = request.questions;
            if (ready && request.questions.length === 1 && !only.multiSelect)
                send.emit('clicked', 0);
        };
        for (const question of request.questions)
            card.add_child(buildQuestion(question, update, arming));
        if (request.canDecide) {
            const row = new St.BoxLayout({style_class: 'ab-row'});
            row.add_child(send);
            card.add_child(row);
            addCountdown(card, request);
        } else {
            card.add_child(label(`Answer in ${agentLabel(request.agent)}.`, 'ab-hint'));
        }
        return card;
    }

    // What is being approved, in full: every argument, nothing cut, invisible characters
    // written out (model/sessionStore.js describeInput). It scrolls instead of being ellipsized,
    // because a command whose end is hidden is a command nobody has really read.
    card.add_child(label(`Tool: ${displayText(request.tool) || 'unknown'}`, 'ab-caption'));
    // A plan is read in the terminal: the card only points there, and cannot approve it.
    const isPlan = PLAN_TOOLS.includes(request.tool);
    if (isPlan) {
        card.add_child(label('The plan is shown in the terminal.', 'ab-hint'));
        if (onJump) {
            const jump = button('Go to terminal', '', onJump);
            card.add_child(jump);
        }
    } else {
        const inner = new St.BoxLayout({vertical: true});
        inner.add_child(label(request.display || request.summary, 'ab-text ab-mono', {lines: 1000, ellipsize: false}));
        const scroll = new St.ScrollView({
            style_class: 'ab-command', hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC, overlay_scrollbars: true,
        });
        scroll.set_child(inner);
        card.add_child(scroll);
    }
    if (['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(request.tool))
        card.add_child(label('The change itself is shown in the terminal.', 'ab-hint'));

    if (request.canDecide) {
        // Same choices as Claude Code's own prompt: Yes, its "Yes, and ..." suggestions, No.
        // Unless the call could not be shown whole (or is a plan): then only No, since a Yes
        // would approve something nobody saw.
        const choices = request.incomplete || isPlan
            ? [{text: 'No', decision: 'deny', style: 'ab-deny'}]
            : [
                {text: 'Yes', decision: 'allow', style: 'ab-allow'},
                ...(request.options ?? []).map(o => ({text: o.label, decision: JSON.stringify({suggestion: o.index}), style: ''})),
                {text: 'No', decision: 'deny', style: 'ab-deny'},
            ];
        if (request.incomplete && !isPlan)
            card.add_child(label(`Too long to show in full. Answer in ${agentLabel(request.agent)}.`, 'ab-hint ab-warning'));
        const list = new St.BoxLayout({vertical: true, style_class: 'ab-choices'});
        choices.forEach((choice, i) => {
            const item = new St.Button({style_class: `ab-button ab-choice ${choice.style}`, can_focus: true, x_expand: true});
            item.set_child(label(`${i + 1}. ${choice.text}`, 'ab-choice-text'));
            item.connect('clicked', () => {
                if (arming.isArmed())
                    onDecision(choice.decision);
            });
            arming.hold(item);
            list.add_child(item);
        });
        card.add_child(list);
        // Number keys pick a choice (the island forwards them while the card is open).
        card.choose = number => {
            const choice = choices[number - 1];
            if (!choice || !arming.isArmed())
                return false;
            onDecision(choice.decision);
            return true;
        };
        addCountdown(card, request);
    } else {
        card.add_child(label(`Answer in ${agentLabel(request.agent)}.`, 'ab-hint'));
    }
    return card;
}

const STATE_CLASS = {
    [State.WORKING]: 'ab-dot-working',
    [State.WAITING]: 'ab-dot-waiting',
    [State.DONE]: 'ab-dot-done',
    [State.ERROR]: 'ab-dot-error',
    [State.IDLE]: 'ab-dot-idle',
};

const PEEK_LIMIT = 5;
const STATE_WORD = {
    [State.WORKING]: 'working',
    [State.WAITING]: 'waiting',
    [State.DONE]: 'done',
    [State.ERROR]: 'failed',
    [State.IDLE]: 'idle',
};

const DIFF_CLASS = {'+': 'ab-diff-add', '-': 'ab-diff-del', '@': 'ab-diff-gap', ' ': 'ab-diff-ctx'};
/** Edits shown with their lines, newest first; older ones only as a heading. */
const DIFF_EXPANDED = 3;

/** The edits of a session: `file +N −M`, and the changed lines for the newest few. */
function buildDiffView(edits) {
    const view = new St.BoxLayout({vertical: true, style_class: 'ab-diff'});
    [...edits].reverse().forEach((edit, index) => {
        view.add_child(label(`${displayText(edit.file)}  +${edit.added} −${edit.removed}`, 'ab-diff-file'));
        if (index >= DIFF_EXPANDED)
            return;
        for (const line of edit.lines) {
            const text = line.op === '@' ? line.text : `${line.op} ${line.text}`;
            view.add_child(label(text, `ab-mono ${DIFF_CLASS[line.op]}`));
        }
        if (edit.truncated)
            view.add_child(label('… diff cut', 'ab-hint'));
    });
    return view;
}

/**
 * The session list: one row per session, waiting first. `compact` is the hover
 * peek: a single line per session (state, project, agent), no step text.
 */
export function buildSessionList(sessions, {compact = false, openDiff = null, onToggleDiff = null, onJump = null,
    onRemove = null} = {}) {
    const list = new St.BoxLayout({vertical: true, style_class: 'ab-card ab-sessions'});
    if (!sessions.length) {
        list.add_child(label('No agent is running.', 'ab-hint'));
        return list;
    }
    const shown = compact ? sessions.slice(0, PEEK_LIMIT) : sessions;
    for (const session of shown) {
        const row = new St.BoxLayout({vertical: true, style_class: 'ab-session'});
        const head = new St.BoxLayout();
        head.add_child(new St.Widget({style_class: `ab-dot ${session.dead ? 'ab-dot-dead' : STATE_CLASS[session.state] ?? ''}`,
            y_align: Clutter.ActorAlign.CENTER}));
        head.add_child(label(displayText(session.title || session.project || session.cwd || session.id), 'ab-session-name'));
        // With a title the project moves next to the agent, so neither is lost.
        const origin = session.title && session.project
            ? `${agentLabel(session.agent)} · ${session.project}` : agentLabel(session.agent);
        head.add_child(new St.Label({text: origin, style_class: 'ab-caption ab-origin', y_align: Clutter.ActorAlign.CENTER}));
        if (compact)
            head.add_child(new St.Label({text: session.dead ? 'dead' : STATE_WORD[session.state] ?? '',
                style_class: 'ab-caption ab-state', y_align: Clutter.ActorAlign.CENTER}));
        if (!compact && session.pids.length && onJump && !session.dead) {
            // Clicking the session's name brings its terminal (or app) forward.
            const target = new St.Button({style_class: 'ab-session-link', can_focus: true, x_expand: true, child: head});
            target.connect('clicked', () => onJump(session));
            row.add_child(target);
        } else {
            row.add_child(head);
        }
        if (compact) {
            list.add_child(row);
            continue;
        }
        if (session.dead && onRemove) {
            row.add_child(label('The agent is no longer running.', 'ab-hint'));
            const remove = new St.Button({style_class: 'ab-diff-toggle', can_focus: true, x_align: Clutter.ActorAlign.START,
                label: 'Remove'});
            remove.connect('clicked', () => onRemove(session.key));
            row.add_child(remove);
        }

        const last = session.state === State.DONE && session.summary
            ? session.summary
            : session.steps[session.steps.length - 1] ?? session.prompt;
        if (last)
            row.add_child(label(last, 'ab-hint'));
        if (session.edits.length && onToggleDiff) {
            const open = openDiff === session.key;
            const toggle = new St.Button({style_class: 'ab-diff-toggle', can_focus: true, x_align: Clutter.ActorAlign.START,
                label: open ? 'Hide changes' : `Show changes (${session.edits.length})`});
            toggle.connect('clicked', () => onToggleDiff(session.key));
            row.add_child(toggle);
            if (open)
                row.add_child(buildDiffView(session.edits));
        }
        list.add_child(row);
    }
    if (compact && sessions.length > PEEK_LIMIT)
        list.add_child(label(`+${sessions.length - PEEK_LIMIT} more`, 'ab-hint'));
    return list;
}
