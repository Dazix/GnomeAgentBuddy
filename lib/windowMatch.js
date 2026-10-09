/**
 * Which window belongs to an agent session: the one a process in the agent's chain of
 * parents owns. Pure logic (no GNOME imports), unit-tested with gjs.
 */

const MAX_PIDS = 16;

/** The pids the relay sent, as a short list of positive integers (it is untrusted input). */
export function cleanPids(value) {
    if (!Array.isArray(value))
        return [];
    const pids = [];
    for (const pid of value) {
        if (Number.isInteger(pid) && pid > 1 && !pids.includes(pid))
            pids.push(pid);
        if (pids.length >= MAX_PIDS)
            break;
    }
    return pids;
}

/**
 * @param {{pid: number, title: string}[]} windows most recently used first
 * @param {number[]} pids the agent and its parents, nearest first
 * @param {{project?: string}} hints
 * @returns the window to bring forward, or null
 */
export function pickWindow(windows, pids, {project = ''} = {}) {
    for (const pid of pids) {
        const owned = windows.filter(w => w.pid === pid);
        if (!owned.length)
            continue;
        // One terminal process often owns every window; the title says which is the session's.
        const wanted = String(project).toLowerCase();
        const byTitle = wanted ? owned.find(w => String(w.title ?? '').toLowerCase().includes(wanted)) : null;
        return byTitle ?? owned[0];
    }
    return null;
}
