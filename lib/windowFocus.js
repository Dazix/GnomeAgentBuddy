import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {pickWindow} from './windowMatch.js';

/**
 * Bring forward the window the agent of `session` runs in: the one owned by the agent
 * or one of its parents (the terminal). True when a window was found.
 */
export function focusSessionWindow(session) {
    const windows = global.display.get_tab_list(Meta.TabList.NORMAL, null).map(window => ({
        pid: window.get_pid(), title: window.get_title(), window,
    }));
    const found = pickWindow(windows, session.pids ?? [], {project: session.project});
    if (!found)
        return false;
    Main.activateWindow(found.window);
    return true;
}
