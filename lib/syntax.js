/**
 * Syntax highlighting for one line of code, for the diff view. Pure logic (no GNOME
 * imports), unit-tested with gjs. Deliberately small: a line at a time, so a comment or
 * string that spans lines is only coloured where it starts on that line.
 */

const words = list => new Set(list.split(' '));

const C_LIKE = words('if else for while do switch case break continue return function class new this ' +
    'const let var static public private protected void int long float double char bool boolean ' +
    'try catch finally throw throws import export from default async await yield typeof instanceof in of ' +
    'extends implements interface enum struct namespace using package null true false undefined nil');

const PYTHON = words('def class return if elif else for while in not and or is import from as with try except ' +
    'finally raise pass break continue lambda yield async await None True False self global nonlocal del assert');

const SHELL = words('if then else elif fi for while do done case esac in function return exit export local ' +
    'echo cd set unset source true false');

const RUST_GO = words('fn let mut pub struct enum impl trait use mod match if else for while loop return ' +
    'func package import type var const range go defer chan interface map select ' +
    'self Self true false nil None Some Ok Err');

/** Language by file extension: keywords and how a comment starts. */
const LANGUAGES = {
    js: {keywords: C_LIKE, comment: '//'}, jsx: {keywords: C_LIKE, comment: '//'},
    mjs: {keywords: C_LIKE, comment: '//'}, ts: {keywords: C_LIKE, comment: '//'},
    tsx: {keywords: C_LIKE, comment: '//'}, java: {keywords: C_LIKE, comment: '//'},
    c: {keywords: C_LIKE, comment: '//'}, h: {keywords: C_LIKE, comment: '//'},
    cpp: {keywords: C_LIKE, comment: '//'}, cs: {keywords: C_LIKE, comment: '//'},
    php: {keywords: C_LIKE, comment: '//'}, kt: {keywords: C_LIKE, comment: '//'},
    swift: {keywords: C_LIKE, comment: '//'}, scss: {keywords: C_LIKE, comment: '//'},
    css: {keywords: new Set(), comment: null},
    rs: {keywords: RUST_GO, comment: '//'}, go: {keywords: RUST_GO, comment: '//'},
    py: {keywords: PYTHON, comment: '#'}, rb: {keywords: PYTHON, comment: '#'},
    sh: {keywords: SHELL, comment: '#'}, bash: {keywords: SHELL, comment: '#'},
    zsh: {keywords: SHELL, comment: '#'},
    yml: {keywords: new Set(['true', 'false', 'null']), comment: '#'},
    yaml: {keywords: new Set(['true', 'false', 'null']), comment: '#'},
    toml: {keywords: new Set(['true', 'false']), comment: '#'},
    json: {keywords: new Set(['true', 'false', 'null']), comment: null},
    sql: {keywords: words('select from where and or not insert into values update set delete create table ' +
        'drop alter join left right inner outer on group by order limit as null primary key'), comment: '--'},
    xml: {keywords: new Set(), comment: null}, html: {keywords: new Set(), comment: null},
};

export const TokenKind = Object.freeze({
    PLAIN: 'plain', KEYWORD: 'keyword', STRING: 'string', NUMBER: 'number', COMMENT: 'comment',
});

/** The language for a file name, or null when we know nothing about it. */
export function languageFor(file) {
    const dot = String(file).lastIndexOf('.');
    return dot < 0 ? null : LANGUAGES[String(file).slice(dot + 1).toLowerCase()] ?? null;
}

const isWordStart = ch => /[A-Za-z_$]/.test(ch);
const isDigit = ch => /[0-9]/.test(ch);

/**
 * @param {string} line
 * @param {object|null} language from languageFor()
 * @returns {{text: string, kind: string}[]} tokens that join back to `line`
 */
export function tokenize(line, language) {
    if (!language || !line)
        return line ? [{text: line, kind: TokenKind.PLAIN}] : [];
    const tokens = [];
    let plain = '';
    const flush = () => {
        if (plain)
            tokens.push({text: plain, kind: TokenKind.PLAIN});
        plain = '';
    };
    let i = 0;
    while (i < line.length) {
        const ch = line[i];
        if (language.comment && line.startsWith(language.comment, i)) {
            flush();
            tokens.push({text: line.slice(i), kind: TokenKind.COMMENT});
            break;
        }
        if (ch === '"' || ch === '\'' || ch === '`') {
            flush();
            let end = i + 1;
            while (end < line.length && line[end] !== ch)
                end += line[end] === '\\' ? 2 : 1;
            end = Math.min(end + 1, line.length);
            tokens.push({text: line.slice(i, end), kind: TokenKind.STRING});
            i = end;
        } else if (isDigit(ch) && (i === 0 || !isWordStart(line[i - 1]))) {
            flush();
            let end = i + 1;
            while (end < line.length && /[0-9A-Fa-fx._]/.test(line[end]))
                end++;
            tokens.push({text: line.slice(i, end), kind: TokenKind.NUMBER});
            i = end;
        } else if (isWordStart(ch)) {
            let end = i + 1;
            while (end < line.length && /[A-Za-z0-9_$]/.test(line[end]))
                end++;
            const word = line.slice(i, end);
            if (language.keywords.has(word) || language.keywords.has(word.toLowerCase())) {
                flush();
                tokens.push({text: word, kind: TokenKind.KEYWORD});
            } else {
                plain += word;
            }
            i = end;
        } else {
            plain += ch;
            i++;
        }
    }
    flush();
    return tokens;
}
