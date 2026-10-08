import Gio from 'gi://Gio';
import System from 'system';

import {runAll} from './harness.js';

const dir = Gio.File.new_for_uri(import.meta.url).get_parent();
const names = [];
const enumerator = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
for (let info = enumerator.next_file(null); info; info = enumerator.next_file(null)) {
    if (info.get_name().endsWith('.test.js'))
        names.push(info.get_name());
}
names.sort();

for (const name of names)
    await import(`${dir.get_uri()}/${name}`);

const failed = await runAll();
System.exit(failed ? 1 : 0);
