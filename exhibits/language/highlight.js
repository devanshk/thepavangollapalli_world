// Syntax colouring for the editor: source text → HTML with one <span> per coloured token.
import { KEYWORDS, TYPES } from './lexer.js';
import { BUILTINS } from './types.js';

const TOKEN = /(\/\/[^\n]*)|(\d+\.\d+(?:[eE][+-]?\d+)?|0[xX][0-9a-fA-F]+|\d+(?:[eE][+-]?\d+)?)|([A-Za-z_]\w*)|(\s+)|([^\sA-Za-z_\d]+?)/g;
const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const span = (cls, text) => `<span class="language-${cls}">${escape(text)}</span>`;

export function highlight(source) {
  let out = '';
  let m;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(source))) {
    if (m[1]) out += span('c', m[1]);
    else if (m[2]) out += span('n', m[2]);
    else if (m[3]) {
      const w = m[3];
      if (KEYWORDS.includes(w)) out += span('k', w);
      else if (TYPES.includes(w)) out += span('t', w);
      else if (BUILTINS.includes(w)) out += span('b', w);
      else if (source[TOKEN.lastIndex] === '(') out += span('f', w);
      else out += escape(w);
    } else out += escape(m[0]);
  }
  return out;
}
