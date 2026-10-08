const cases = [];

export function test(name, fn) {
    cases.push({name, fn});
}

export function assertEqual(actual, expected, message = '') {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e)
        throw new Error(`${message}expected ${e}, got ${a}`);
}

export function assertTrue(value, message = 'expected truthy value') {
    if (!value)
        throw new Error(message);
}

/** Runs all registered cases; returns the number of failures. */
export async function runAll() {
    let failed = 0;
    for (const {name, fn} of cases) {
        try {
            await fn();
            print(`ok    ${name}`);
        } catch (e) {
            failed++;
            print(`FAIL  ${name}\n      ${e.message}`);
        }
    }
    print(`\n${cases.length - failed}/${cases.length} passed`);
    return failed;
}
