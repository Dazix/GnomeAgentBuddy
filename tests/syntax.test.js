import {TokenKind, languageFor, tokenize} from '../lib/syntax.js';
import {assertEqual, test} from './harness.js';

const kinds = (line, file) => tokenize(line, languageFor(file)).map(t => `${t.kind}:${t.text}`);

test('syntax: language comes from the extension, unknown is null', () => {
    assertEqual(languageFor('a.py') !== null, true);
    assertEqual(languageFor('README'), null);
    assertEqual(languageFor('x.unknown'), null);
});

test('syntax: keywords, strings, numbers and comments', () => {
    assertEqual(kinds('const a = "x"; // hi', 'a.js'), [
        'keyword:const', 'plain: a = ', 'string:"x"', 'plain:; ', 'comment:// hi',
    ]);
    assertEqual(kinds('return 42', 'a.js'), ['keyword:return', 'plain: ', 'number:42']);
});

test('syntax: a word that contains a keyword is not one', () => {
    assertEqual(kinds('constant1', 'a.js'), ['plain:constant1']);
});

test('syntax: tokens join back to the line; no language is plain', () => {
    const line = 'if (x) { y = \'a\\\'b\'; }';
    assertEqual(tokenize(line, languageFor('a.ts')).map(t => t.text).join(''), line);
    assertEqual(tokenize('anything', null), [{text: 'anything', kind: TokenKind.PLAIN}]);
    assertEqual(tokenize('', languageFor('a.js')), []);
});
