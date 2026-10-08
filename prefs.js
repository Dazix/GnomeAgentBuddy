import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {apply, installRelay, isInstalled, plan} from './lib/configFile.js';
import {AGENTS, AGENT_IDS} from './lib/hookInstaller.js';

function spinRow(settings, key, {title, subtitle = '', lower, upper, step, digits = 0}) {
    const row = new Adw.SpinRow({
        title, subtitle, digits,
        adjustment: new Gtk.Adjustment({lower, upper, step_increment: step, page_increment: step * 5}),
    });
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function switchRow(settings, key, {title, subtitle = ''}) {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

/** "Show on": the primary monitor or one of the connected ones, stored by connector name. */
function monitorRow(settings) {
    const choices = [{connector: '', label: 'Primary monitor'}];
    const monitors = Gdk.Display.get_default()?.get_monitors();
    for (let i = 0; monitors && i < monitors.get_n_items(); i++) {
        const monitor = monitors.get_item(i);
        const connector = monitor.get_connector();
        if (connector)
            choices.push({connector, label: monitor.get_model() ? `${connector} · ${monitor.get_model()}` : connector});
    }
    // A monitor chosen earlier that is unplugged now stays visible instead of silently reverting.
    const current = settings.get_string('monitor');
    if (current && !choices.some(c => c.connector === current))
        choices.push({connector: current, label: `${current} (not connected)`});

    const row = new Adw.ComboRow({
        title: 'Show on',
        subtitle: 'Moving the notch with Super+drag to another screen changes this too',
        model: Gtk.StringList.new(choices.map(c => c.label)),
    });
    const sync = () => {
        const index = choices.findIndex(c => c.connector === settings.get_string('monitor'));
        if (index >= 0 && row.selected !== index)
            row.selected = index;
    };
    sync();
    row.connect('notify::selected', () => {
        const choice = choices[row.selected];
        if (choice && choice.connector !== settings.get_string('monitor'))
            settings.set_string('monitor', choice.connector);
    });
    settings.connect('changed::monitor', sync);
    return row;
}

/** Forget a position set by dragging: back to the top centre of the chosen monitor. */
function resetPositionRow(settings) {
    const row = new Adw.ActionRow({
        title: 'Reset position',
        subtitle: 'Move the notch with Super+drag. Super+double-click puts it back',
    });
    const button = new Gtk.Button({label: 'Reset', valign: Gtk.Align.CENTER});
    button.connect('clicked', () => {
        settings.delay();
        settings.reset('position-x');
        settings.reset('position-y');
        settings.apply();
    });
    row.add_suffix(button);
    return row;
}

export default class AgentBuddyPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(620, 720);
        window.add(this._generalPage(settings));
        window.add(this._agentsPage(settings, window));
    }

    _generalPage(settings) {
        const page = new Adw.PreferencesPage({title: 'General', icon_name: 'preferences-system-symbolic'});

        const look = new Adw.PreferencesGroup({title: 'Notch'});
        look.add(spinRow(settings, 'scale', {title: 'Size', lower: 0.75, upper: 1.75, step: 0.05, digits: 2}));
        look.add(spinRow(settings, 'background-opacity', {title: 'Opacity', lower: 0.2, upper: 1, step: 0.05, digits: 2}));
        look.add(switchRow(settings, 'hide-when-idle', {
            title: 'Hide while idle', subtitle: 'Only show the notch while an agent session is running',
        }));
        look.add(switchRow(settings, 'overlay-panel', {
            title: 'Cover the top bar', subtitle: 'Sit over the top bar instead of hanging below it',
        }));
        look.add(monitorRow(settings));
        look.add(spinRow(settings, 'snap-threshold', {
            title: 'Snap distance (px)',
            subtitle: 'Dropped this close to a screen edge, the notch docks to it and flows into it',
            lower: 20, upper: 400, step: 10,
        }));
        look.add(resetPositionRow(settings));
        look.add(switchRow(settings, 'auto-open-requests', {
            title: 'Open on permission requests',
            subtitle: 'Unfold the card by itself. Off: the notch only glows and shows a badge until you click it',
        }));
        page.add(look);

        const timing = new Adw.PreferencesGroup({title: 'Timing'});
        timing.add(spinRow(settings, 'decision-timeout', {
            title: 'Permission card timeout (seconds)',
            subtitle: 'How long the card stays. The question is also asked in the terminal all along, and the agent gives up on the card at about 110 s.',
            lower: 10, upper: 110, step: 5,
        }));
        timing.add(spinRow(settings, 'finished-linger', {
            title: 'Keep finished sessions (seconds)', lower: 5, upper: 600, step: 5,
        }));
        page.add(timing);
        return page;
    }

    _agentsPage(settings, window) {
        const page = new Adw.PreferencesPage({title: 'Agents', icon_name: 'application-x-executable-symbolic'});
        const group = new Adw.PreferencesGroup({
            title: 'Agents',
            description: 'Hooks are written only after you have seen the exact change. A dated backup is taken first, ' +
                'your own hooks are never touched, and removing them deletes only what was added here.',
        });
        page.add(group);

        for (const id of AGENT_IDS)
            group.add(this._agentRow(id, settings, window));
        return page;
    }

    _agentRow(id, settings, window) {
        const agent = AGENTS[id];
        const row = new Adw.ActionRow({title: agent.label});
        const toggle = new Gtk.Switch({valign: Gtk.Align.CENTER});
        const button = new Gtk.Button({valign: Gtk.Align.CENTER});

        const sync = () => {
            const installed = isInstalled(id);
            const approvals = agent.approvals ? 'Allow / Deny in the notch' : 'status only, asks in its own window';
            row.subtitle = `${installed ? 'Hooks installed' : 'Hooks not installed'} · ${approvals}`;
            button.label = installed ? 'Remove hooks…' : 'Install hooks…';
        };

        const enabled = () => settings.get_strv('enabled-agents').includes(id);
        toggle.active = enabled();
        toggle.connect('notify::active', () => {
            const current = settings.get_strv('enabled-agents').filter(a => a !== id);
            if (toggle.active)
                current.push(id);
            settings.set_strv('enabled-agents', current);
        });

        button.connect('clicked', () => this._review(id, !isInstalled(id), window, sync));
        row.add_suffix(button);
        row.add_suffix(toggle);
        sync();
        return row;
    }

    /** Show the exact diff and write it only on an explicit click. */
    _review(id, install, window, onDone) {
        const agent = AGENTS[id];
        let planned;
        try {
            const relayPath = installRelay(this.dir);
            planned = plan(id, install, relayPath);
        } catch (e) {
            this._message(window, `${agent.label}`, e.message);
            return;
        }
        if (!planned.changed) {
            this._message(window, agent.label, 'Nothing to change.');
            onDone();
            return;
        }

        const dialog = new Adw.AlertDialog({
            heading: `${install ? 'Install' : 'Remove'} hooks for ${agent.label}?`,
            body: `${planned.path}\n${planned.backup ? `Backup: ${planned.backup}` : 'The file does not exist yet, no backup needed.'}`,
        });
        const view = new Gtk.TextView({editable: false, monospace: true, cursor_visible: false, top_margin: 8, bottom_margin: 8, left_margin: 8});
        view.buffer.text = planned.diff;
        const scroll = new Gtk.ScrolledWindow({min_content_height: 240, min_content_width: 520, child: view});
        scroll.add_css_class('card');
        dialog.set_extra_child(scroll);
        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('apply', install ? 'Install' : 'Remove');
        dialog.set_response_appearance('apply', Adw.ResponseAppearance.SUGGESTED);
        dialog.set_default_response('cancel');
        dialog.set_close_response('cancel');
        dialog.connect('response', (_dialog, response) => {
            if (response !== 'apply')
                return;
            try {
                apply(planned);
                this._message(window, agent.label, install ? agent.note : 'Hooks removed.');
            } catch (e) {
                this._message(window, agent.label, e.message);
            }
            onDone();
        });
        dialog.present(window);
    }

    _message(window, heading, body) {
        const dialog = new Adw.AlertDialog({heading, body});
        dialog.add_response('ok', 'OK');
        dialog.present(window);
    }
}
