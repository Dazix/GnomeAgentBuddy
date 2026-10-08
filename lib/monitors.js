/**
 * Monitors by connector name (`HDMI-1`, `eDP-1`), the one id that survives a
 * re-plug, unlike the index. Shell side only: needs `global.backend`.
 */

const manager = () => global.backend.get_monitor_manager();

/** The display index of the monitor on `connector`, or -1 when it is not connected. */
export function indexForConnector(connector) {
    if (!connector)
        return -1;
    try {
        return manager().get_monitor_for_connector(connector);
    } catch (_e) {
        return -1;
    }
}

/** The connector of the monitor at display index `index`, or '' when unknown. */
export function connectorForIndex(index) {
    try {
        for (const monitor of manager().get_monitors()) {
            const connector = monitor.get_connector();
            if (manager().get_monitor_for_connector(connector) === index)
                return connector;
        }
    } catch (_e) {
        // Fall through: no connector known.
    }
    return '';
}
