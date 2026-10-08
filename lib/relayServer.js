import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.DataInputStream.prototype, 'read_line_async', 'read_line_finish_utf8');
Gio._promisify(Gio.OutputStream.prototype, 'write_all_async', 'write_all_finish');
Gio._promisify(Gio.IOStream.prototype, 'close_async', 'close_finish');

export const SOCKET_NAME = 'agentbuddy.sock';
/** The relay never sends more than ~0.5 MiB per event; anything bigger is not ours. */
const MAX_LINE = 1024 * 1024;

/** `$XDG_RUNTIME_DIR/agentbuddy.sock`, must match the relay's `socket_path()`. */
export function defaultSocketPath() {
    return GLib.build_filenamev([GLib.get_user_runtime_dir(), SOCKET_NAME]);
}

/**
 * Listens on a Unix socket for the relay's events and folds them into a
 * SessionStore. A PermissionRequest keeps its connection open until the store
 * resolves it; if the relay hangs up first the request is cancelled.
 */
export class RelayServer {
    /**
     * @param {import('../model/sessionStore.js').SessionStore} store
     * @param {string} [path]
     */
    constructor(store, path = defaultSocketPath()) {
        this._store = store;
        this._path = path;
        this._service = null;
        this._connections = new Set();
    }

    start() {
        // A socket left behind by a crashed shell: nobody listens, so it is safe to replace.
        try {
            Gio.File.new_for_path(this._path).delete(null);
        } catch (_e) {
            // Not there: fine.
        }
        this._service = new Gio.SocketService();
        this._service.add_address(Gio.UnixSocketAddress.new(this._path),
            Gio.SocketType.STREAM, Gio.SocketProtocol.DEFAULT, null);
        this._service.connect('incoming', (_service, connection) => {
            this._serve(connection).catch(e => console.error(`GnomeAgentBuddy: ${e.message}`));
            return true;
        });
        this._service.start();
    }

    stop() {
        if (this._service) {
            this._service.stop();
            this._service.close();
            this._service = null;
        }
        for (const connection of this._connections) {
            try {
                connection.close(null);
            } catch (_e) {
                // Already closed.
            }
        }
        this._connections.clear();
        try {
            Gio.File.new_for_path(this._path).delete(null);
        } catch (_e) {
            // Already gone.
        }
    }

    _isSameUser(connection) {
        try {
            return connection.get_socket().get_credentials().get_unix_user() === this._ownUid();
        } catch (_e) {
            return false;
        }
    }

    _ownUid() {
        if (this._uid === undefined) {
            const info = Gio.File.new_for_path(GLib.get_user_runtime_dir())
                .query_info('unix::uid', Gio.FileQueryInfoFlags.NONE, null);
            this._uid = info.get_attribute_uint32('unix::uid');
        }
        return this._uid;
    }

    async _serve(connection) {
        if (!this._isSameUser(connection)) {
            connection.close(null);
            return;
        }
        this._connections.add(connection);
        const input = new Gio.DataInputStream({base_stream: connection.get_input_stream()});
        let payload;
        try {
            const [raw] = await input.read_line_async(GLib.PRIORITY_DEFAULT, null);
            // Another extension may have promisified this with the byte-array finish function.
            const line = raw instanceof Uint8Array ? new TextDecoder().decode(raw) : raw;
            if (line === null || line.length > MAX_LINE)
                throw new Error('empty or oversized event');
            payload = JSON.parse(line);
            if (payload === null || typeof payload !== 'object' || Array.isArray(payload))
                throw new Error('event is not an object');
        } catch (_e) {
            this._close(connection);
            return;
        }

        const request = this._store.handleEvent(payload, decision => {
            this._reply(connection, decision).catch(() => {});
        });
        if (!request) {
            this._close(connection);
            return;
        }

        // The relay waits for our answer; EOF before that means it gave up.
        try {
            const [rest] = await input.read_line_async(GLib.PRIORITY_DEFAULT, null);
            if (rest === null && !request.answered)
                this._store.cancel(request.id);
        } catch (_e) {
            if (!request.answered)
                this._store.cancel(request.id);
        }
        this._close(connection);
    }

    async _reply(connection, decision) {
        if (decision !== null && decision !== undefined) {
            const bytes = new TextEncoder().encode(`${decision}\n`);
            await connection.get_output_stream().write_all_async(bytes, GLib.PRIORITY_DEFAULT, null);
        }
        this._close(connection);
    }

    _close(connection) {
        if (!this._connections.delete(connection))
            return;
        try {
            connection.close(null);
        } catch (_e) {
            // The relay already left.
        }
    }
}
