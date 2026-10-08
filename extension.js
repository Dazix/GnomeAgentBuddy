import GLib from 'gi://GLib';
import St from 'gi://St';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {installRelay} from './lib/configFile.js';
import {RelayServer} from './lib/relayServer.js';
import {readTitle} from './lib/transcriptTitle.js';
import {SessionStore} from './model/sessionStore.js';
import {Island} from './ui/island.js';

/** How often stale requests and finished sessions are swept. */
const PRUNE_SECONDS = 5;

/** Settings keys that change what the store accepts or how the notch looks. */
const LIVE_KEYS = ['scale', 'background-opacity', 'compact-height', 'hide-when-idle', 'overlay-panel', 'auto-open-requests',
    'monitor', 'position-x', 'position-y', 'snap-threshold',
    'enabled-agents', 'decision-timeout', 'finished-linger'];

export default class AgentBuddyExtension extends Extension {
    enable() {
        this._settings = this.getSettings();

        this._stylesheet = this.dir.get_child('stylesheet.css');
        St.ThemeContext.get_for_stage(global.stage).get_theme().load_stylesheet(this._stylesheet);

        // Keep the relay the agents' configs point at in step with this version.
        try {
            installRelay(this.dir);
        } catch (e) {
            console.error(`GnomeAgentBuddy: could not install the relay: ${e.message}`);
        }

        this._store = new SessionStore();
        this._store.resolveTitle = readTitle;
        this._applyStoreSettings();

        this._island = new Island(this._store, this._settings, () => this.openPreferences());
        Main.layoutManager.addChrome(this._island, {trackFullscreen: false});
        this._store.onChange(() => this._island?.refresh());

        // Other chrome or a fullscreen window can end up above the notch: lift it back.
        this._restackedId = global.display.connect('restacked', () => this._raise());
        this._raise();

        this._server = new RelayServer(this._store);
        try {
            this._server.start();
        } catch (e) {
            console.error(`GnomeAgentBuddy: could not listen for the relay: ${e.message}`);
        }

        this._pruneId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, PRUNE_SECONDS, () => {
            this._store.prune();
            return GLib.SOURCE_CONTINUE;
        });
        GLib.Source.set_name_by_id(this._pruneId, '[GnomeAgentBuddy] prune');

        this._settingsIds = LIVE_KEYS.map(key => this._settings.connect(`changed::${key}`, () => {
            this._applyStoreSettings();
            this._island.applySettings();
        }));
    }

    _applyStoreSettings() {
        const enabled = new Set(this._settings.get_strv('enabled-agents'));
        this._store.isEnabled = agent => enabled.has(agent);
        this._store.decisionTimeout = this._settings.get_int('decision-timeout');
        this._store.finishedLinger = this._settings.get_int('finished-linger');
    }

    _raise() {
        // Above the other chrome, but just below the modal dialogs (system dialogs stay on top).
        const {uiGroup, modalDialogGroup} = Main.layoutManager;
        if (this._island?.get_parent() === uiGroup && modalDialogGroup?.get_parent() === uiGroup)
            uiGroup.set_child_below_sibling(this._island, modalDialogGroup);
    }

    disable() {
        if (this._restackedId) {
            global.display.disconnect(this._restackedId);
            this._restackedId = null;
        }
        if (this._pruneId) {
            GLib.source_remove(this._pruneId);
            this._pruneId = null;
        }
        for (const id of this._settingsIds ?? [])
            this._settings.disconnect(id);
        this._settingsIds = null;

        // Closing the relay's connections first: a waiting agent falls back to its own prompt.
        this._server?.stop();
        this._server = null;

        if (this._island) {
            Main.layoutManager.removeChrome(this._island);
            this._island.destroy();
            this._island = null;
        }
        this._store = null;

        if (this._stylesheet) {
            St.ThemeContext.get_for_stage(global.stage).get_theme().unload_stylesheet(this._stylesheet);
            this._stylesheet = null;
        }
        this._settings = null;
    }
}
