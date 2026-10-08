import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {AGENTS} from '../lib/hookInstaller.js';
import {State} from '../model/sessionStore.js';

export const agentLabel = id => AGENTS[id]?.label ?? id;

function label(text, styleClass, {lines = 1} = {}) {
    const actor = new St.Label({text, style_class: styleClass, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
    const clutterText = actor.get_clutter_text();
    clutterText.set_ellipsize(Pango.EllipsizeMode.END);
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

/** One single- or multi-select question; calls `onChange(questionText, answer|null)`. */
function buildQuestion(question, onChange) {
    const box = new St.BoxLayout({vertical: true, style_class: 'ab-question'});
    if (question.header)
        box.add_child(label(question.header, 'ab-caption'));
    box.add_child(label(question.question, 'ab-text', {lines: 3}));

    const picked = new Set();
    const buttons = [];
    for (const option of question.options) {
        const optionButton = new St.Button({
            label: option.label, style_class: 'ab-button ab-option', can_focus: true, x_expand: true,
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
export function buildRequestCard(request, onDecision) {
    const card = new St.BoxLayout({vertical: true, style_class: 'ab-card ab-request'});
    const title = request.project ? `${agentLabel(request.agent)} · ${request.project}` : agentLabel(request.agent);
    card.add_child(label(title, 'ab-caption'));
    // The session's name in Claude Code, so several sessions in one project stay apart.
    if (request.title)
        card.add_child(label(request.title, 'ab-session-name'));

    if (request.questions) {
        const answers = new Map();
        const send = button('Send', 'ab-allow', () => {
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
            card.add_child(buildQuestion(question, update));
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

    card.add_child(label(request.summary, 'ab-text ab-mono', {lines: 4}));
    if (request.detail && request.detail !== request.summary.split(' · ')[1])
        card.add_child(label(request.detail, 'ab-hint ab-mono', {lines: 3}));

    if (request.canDecide) {
        // Same choices as Claude Code's own prompt: Yes, its "Yes, and ..." suggestions, No.
        const choices = [
            {text: 'Yes', decision: 'allow', style: 'ab-allow'},
            ...(request.options ?? []).map(o => ({text: o.label, decision: JSON.stringify({suggestion: o.index}), style: ''})),
            {text: 'No', decision: 'deny', style: 'ab-deny'},
        ];
        const list = new St.BoxLayout({vertical: true, style_class: 'ab-choices'});
        choices.forEach((choice, i) => {
            const item = new St.Button({style_class: `ab-button ab-choice ${choice.style}`, can_focus: true, x_expand: true});
            item.set_child(label(`${i + 1}. ${choice.text}`, 'ab-choice-text'));
            item.connect('clicked', () => onDecision(choice.decision));
            list.add_child(item);
        });
        card.add_child(list);
        // Number keys pick a choice (the island forwards them while the card is open).
        card.choose = number => {
            const choice = choices[number - 1];
            if (!choice)
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

/**
 * The session list: one row per session, waiting first. `compact` is the hover
 * peek: a single line per session (state, project, agent), no step text.
 */
export function buildSessionList(sessions, {compact = false} = {}) {
    const list = new St.BoxLayout({vertical: true, style_class: 'ab-card ab-sessions'});
    if (!sessions.length) {
        list.add_child(label('No agent is running.', 'ab-hint'));
        return list;
    }
    const shown = compact ? sessions.slice(0, PEEK_LIMIT) : sessions;
    for (const session of shown) {
        const row = new St.BoxLayout({vertical: true, style_class: 'ab-session'});
        const head = new St.BoxLayout();
        head.add_child(new St.Widget({style_class: `ab-dot ${STATE_CLASS[session.state] ?? ''}`,
            y_align: Clutter.ActorAlign.CENTER}));
        head.add_child(label(session.title || session.project || session.cwd || session.id, 'ab-session-name'));
        // With a title the project moves next to the agent, so neither is lost.
        const origin = session.title && session.project
            ? `${agentLabel(session.agent)} · ${session.project}` : agentLabel(session.agent);
        head.add_child(new St.Label({text: origin, style_class: 'ab-caption', y_align: Clutter.ActorAlign.CENTER}));
        if (compact)
            head.add_child(new St.Label({text: STATE_WORD[session.state] ?? '', style_class: 'ab-caption ab-state',
                y_align: Clutter.ActorAlign.CENTER}));
        row.add_child(head);
        if (compact) {
            list.add_child(row);
            continue;
        }

        const last = session.state === State.DONE && session.summary
            ? session.summary
            : session.steps[session.steps.length - 1] ?? session.prompt;
        if (last)
            row.add_child(label(last, 'ab-hint'));
        list.add_child(row);
    }
    if (compact && sessions.length > PEEK_LIMIT)
        list.add_child(label(`+${sessions.length - PEEK_LIMIT} more`, 'ab-hint'));
    return list;
}
