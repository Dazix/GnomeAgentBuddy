import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.File.prototype, 'read_async', 'read_finish');
Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async', 'read_bytes_finish');
Gio._promisify(Gio.InputStream.prototype, 'close_async', 'close_finish');

/** Bytes read from the end of the transcript; the title is rewritten as the session goes on. */
const TAIL_BYTES = [256 * 1024, 4 * 1024 * 1024];

const TITLE_LINE = /"type":"(ai-title|custom-title)"[^\n]*?"(?:aiTitle|customTitle)":("(?:[^"\\]|\\.)*")/g;

/**
 * The session title in a chunk of a Claude Code transcript: the last name the
 * user gave it (`custom-title`, /rename), else the last one Claude generated
 * (`ai-title`). Null when the chunk has none.
 */
export function titleFromText(text) {
    let custom = null;
    let generated = null;
    for (const [, kind, quoted] of text.matchAll(TITLE_LINE)) {
        let title;
        try {
            title = JSON.parse(quoted);
        } catch (_e) {
            continue;
        }
        if (typeof title !== 'string' || !title.trim())
            continue;
        if (kind === 'custom-title')
            custom = title.trim();
        else
            generated = title.trim();
    }
    return custom ?? generated;
}

/**
 * Only Claude Code's own transcripts are read, whatever the relay sent: an
 * absolute `.jsonl` under `~/.claude/`, with no `..` tricks.
 */
export function isTranscriptPath(path, home = GLib.get_home_dir()) {
    if (typeof path !== 'string' || !path.endsWith('.jsonl') || !GLib.path_is_absolute(path))
        return false;
    return GLib.canonicalize_filename(path, null).startsWith(`${GLib.canonicalize_filename(home, null)}/.claude/`);
}

/** The title of the session whose transcript is at `path`, or null. Never throws. */
export async function readTitle(path, home = GLib.get_home_dir()) {
    if (!isTranscriptPath(path, home))
        return null;
    try {
        const file = Gio.File.new_for_path(GLib.canonicalize_filename(path, null));
        const size = file.query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null).get_size();
        for (const tail of TAIL_BYTES) {
            const start = Math.max(0, size - tail);
            const stream = await file.read_async(GLib.PRIORITY_DEFAULT, null);
            try {
                stream.seek(start, GLib.SeekType.SET, null);
                const bytes = await stream.read_bytes_async(size - start, GLib.PRIORITY_DEFAULT, null);
                const title = titleFromText(new TextDecoder().decode(bytes.toArray()));
                if (title)
                    return title;
            } finally {
                stream.close(null);
            }
            if (start === 0)
                break;
        }
    } catch (_e) {
        // A vanished or unreadable transcript is just no title.
    }
    return null;
}
