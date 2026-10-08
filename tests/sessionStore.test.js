import {Mood, SessionStore, State, MAX_STEPS, parseQuestion, suggestionOptions, summarizeTool} from '../model/sessionStore.js';
import {assertEqual, assertTrue, test} from './harness.js';

function makeStore() {
    const clock = {t: 1_000_000};
    const store = new SessionStore({now: () => clock.t, decisionTimeout: 100, finishedLinger: 60});
    return {store, clock};
}

const ev = (name, extra = {}) => ({hook_event_name: name, session_id: 's1', cwd: '/home/me/app', ...extra});

test('summarizeTool: command, file and bare tool', () => {
    assertEqual(summarizeTool('Bash', {command: 'npm   test'}), 'Bash · npm test');
    assertEqual(summarizeTool('Edit', {file_path: '/a/b/c.ts'}), 'Edit · c.ts');
    assertEqual(summarizeTool('Task', {}), 'Task');
    assertEqual(summarizeTool('', null), 'tool');
});

test('parseQuestion: only AskUserQuestion with usable questions', () => {
    assertEqual(parseQuestion('Bash', {questions: []}), null);
    assertEqual(parseQuestion('AskUserQuestion', {questions: []}), null);
    const q = parseQuestion('AskUserQuestion', {questions: [{question: 'Which?', options: [{label: 'A'}]}]});
    assertEqual(q[0].options[0].label, 'A');
    assertEqual(q[0].multiSelect, false);
});

test('prompt then tools: working session with a bounded ticker', () => {
    const {store} = makeStore();
    store.handleEvent(ev('UserPromptSubmit', {prompt: 'fix it'}));
    for (let i = 0; i < 10; i++)
        store.handleEvent(ev('PreToolUse', {tool_name: 'Bash', tool_input: {command: `cmd${i}`}}));
    const s = store.list()[0];
    assertEqual(s.state, State.WORKING);
    assertEqual(s.project, 'app');
    assertEqual(s.steps.length, MAX_STEPS);
    assertEqual(s.steps[MAX_STEPS - 1], 'Bash · cmd9');
    assertEqual(store.mood(), Mood.WORKING);
});

test('permission request: waits, resolves once, back to working', () => {
    const {store} = makeStore();
    const answers = [];
    const request = store.handleEvent(
        ev('PermissionRequest', {tool_name: 'Bash', tool_input: {command: 'rm x'}}), d => answers.push(d));
    assertTrue(request.canDecide);
    assertEqual(store.mood(), Mood.ALERT);
    assertEqual(store.list()[0].state, State.WAITING);
    assertTrue(store.resolve(request.id, 'allow'));
    assertEqual(answers, ['allow']);
    assertEqual(store.resolve(request.id, 'deny'), false);
    assertEqual(answers, ['allow']);
    assertEqual(store.list()[0].state, State.WORKING);
});

test('agents the relay cannot answer for get no buttons', () => {
    const {store} = makeStore();
    const request = store.handleEvent(
        {...ev('PermissionRequest', {tool_name: 'Bash'}), agentbuddy_agent: 'gemini'});
    assertEqual(request.canDecide, false);
    assertEqual(request.agent, 'gemini');
});

test('answered in the terminal: next tool event drops the card without a decision', () => {
    const {store} = makeStore();
    const answers = [];
    store.handleEvent(ev('PermissionRequest', {tool_name: 'Bash'}), d => answers.push(d));
    store.handleEvent(ev('PostToolUse', {tool_name: 'Bash'}));
    assertEqual(store.pending.length, 0);
    assertEqual(answers, [null]);
    assertEqual(store.list()[0].state, State.WORKING);
});

test('cancel: relay hung up, nobody is answered', () => {
    const {store} = makeStore();
    const answers = [];
    const request = store.handleEvent(ev('PermissionRequest', {tool_name: 'Bash'}), d => answers.push(d));
    store.cancel(request.id);
    assertEqual(answers, []);
    assertEqual(store.pending.length, 0);
});

test('suggestionOptions: labels like Claude Code, only entries the relay would accept', () => {
    const options = suggestionOptions([
        {type: 'addRules', rules: [{toolName: 'Bash', ruleContent: 'node --check'}], behavior: 'allow', destination: 'localSettings'},
        {type: 'setMode', mode: 'auto', destination: 'session'},
        {type: 'setMode', mode: 'bypassPermissions', destination: 'session'},
        {type: 'addRules', rules: [{toolName: 'Bash'}], behavior: 'deny', destination: 'session'},
        {type: 'addDirectories', directories: ['/srv/app'], destination: 'session'},
        {type: 'replaceRules', rules: [], behavior: 'allow', destination: 'session'},
        null,
    ]);
    assertEqual(options, [
        {index: 0, label: "Yes, and don't ask again for: node --check"},
        {index: 1, label: 'Yes, and switch to auto mode'},
        {index: 4, label: 'Yes, and allow access to /srv/app'},
    ]);
    assertEqual(suggestionOptions(undefined), []);
});

test('a request lists the agents own suggestions as options', () => {
    const {store} = makeStore();
    const request = store.handleEvent(ev('PermissionRequest', {tool_name: 'Bash',
        permission_suggestions: [{type: 'setMode', mode: 'auto', destination: 'session'}]}));
    assertEqual(request.options.length, 1);
    assertEqual(request.options[0].index, 0);
});

test('session title: resolved from the transcript, refreshed after a prompt, throttled', async () => {
    const {store, clock} = makeStore();
    const calls = [];
    let title = 'First title';
    store.resolveTitle = path => {
        calls.push(path);
        return Promise.resolve(title);
    };
    let changes = 0;
    store.onChange(() => changes++);

    store.handleEvent(ev('SessionStart', {transcript_path: '/h/.claude/projects/p/s.jsonl'}));
    await Promise.resolve();
    await Promise.resolve();
    assertEqual(store.list()[0].title, 'First title');
    assertEqual(calls, ['/h/.claude/projects/p/s.jsonl']);

    // Known title, ordinary event: no lookup. A prompt within 10 s: throttled.
    store.handleEvent(ev('PreToolUse', {tool_name: 'Bash'}));
    store.handleEvent(ev('UserPromptSubmit'));
    assertEqual(calls.length, 1);

    // A prompt later looks again and picks up a rename.
    clock.t += 11_000;
    title = 'Renamed';
    store.handleEvent(ev('UserPromptSubmit'));
    await Promise.resolve();
    await Promise.resolve();
    assertEqual(store.list()[0].title, 'Renamed');
    assertTrue(changes > 2);
});

test('session title: no resolver, no transcript or a failing lookup leave it empty', async () => {
    const {store} = makeStore();
    store.handleEvent(ev('SessionStart', {transcript_path: '/h/.claude/p/s.jsonl'}));
    assertEqual(store.list()[0].title, '');
    store.resolveTitle = () => Promise.reject(new Error('gone'));
    store.handleEvent(ev('SessionStart', {session_id: 'other', transcript_path: '/h/.claude/p/o.jsonl'}));
    await Promise.resolve();
    await Promise.resolve();
    assertEqual(store.sessions.get('claude:other').title, '');
    store.handleEvent(ev('SessionStart', {session_id: 'bare'}));
    assertEqual(store.sessions.get('claude:bare').transcriptPath, '');
});

test('a request carries the session title', () => {
    const {store} = makeStore();
    store.handleEvent(ev('SessionStart'));
    store.sessions.get('claude:s1').title = 'Fix login bug';
    assertEqual(store.handleEvent(ev('PermissionRequest', {tool_name: 'Bash'})).title, 'Fix login bug');
});

test('a request carries the moment the agent takes over in its terminal', () => {
    const {store, clock} = makeStore();
    const request = store.handleEvent(ev('PermissionRequest', {tool_name: 'Bash'}));
    assertEqual(request.expiresAt, clock.t + 100_000);
});

test('prune: a request past the timeout is released with no decision', () => {
    const {store, clock} = makeStore();
    const answers = [];
    store.handleEvent(ev('PermissionRequest', {tool_name: 'Bash'}), d => answers.push(d));
    clock.t += 99_000;
    assertEqual(store.prune(), false);
    clock.t += 2_000;
    assertEqual(store.prune(), true);
    assertEqual(answers, [null]);
    assertEqual(store.pending.length, 0);
});

test('stop: done session is happy, lingers, then goes away', () => {
    const {store, clock} = makeStore();
    store.handleEvent(ev('UserPromptSubmit'));
    store.handleEvent(ev('Stop', {last_assistant_message: 'All done.'}));
    assertEqual(store.list()[0].state, State.DONE);
    assertEqual(store.list()[0].summary, 'All done.');
    assertEqual(store.mood(), Mood.HAPPY);
    clock.t += 10_000;
    assertEqual(store.mood(), Mood.IDLE);
    clock.t += 55_000;
    store.prune();
    assertEqual(store.sessions.size, 0);
    assertEqual(store.mood(), Mood.SLEEPY);
});

test('stop failure is sad; session end removes the session and releases requests', () => {
    const {store} = makeStore();
    store.handleEvent(ev('StopFailure'));
    assertEqual(store.mood(), Mood.SAD);
    const answers = [];
    store.handleEvent(ev('PermissionRequest', {tool_name: 'Bash'}), d => answers.push(d));
    store.handleEvent(ev('SessionEnd'));
    assertEqual(store.sessions.size, 0);
    assertEqual(answers, [null]);
});

test('list: waiting before working before done; two agents never share a session', () => {
    const {store, clock} = makeStore();
    store.handleEvent(ev('Stop', {session_id: 'a'}));
    clock.t += 10;
    store.handleEvent(ev('UserPromptSubmit', {session_id: 'b'}));
    clock.t += 10;
    store.handleEvent(ev('PermissionRequest', {session_id: 'c', tool_name: 'Bash'}));
    assertEqual(store.list().map(s => s.id), ['c', 'b', 'a']);
    store.handleEvent({...ev('UserPromptSubmit', {session_id: 'a'}), agentbuddy_agent: 'codex'});
    assertEqual(store.sessions.size, 4);
});

test('onChange fires for every folded event', () => {
    const {store} = makeStore();
    let count = 0;
    store.onChange(() => count++);
    store.handleEvent(ev('SessionStart'));
    store.handleEvent(ev('UserPromptSubmit'));
    assertEqual(count, 2);
});
