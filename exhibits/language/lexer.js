// Lexer: source text → tokens, each carrying its position for diagnostics.

export class SableError extends Error {
  /** span: { start, end, line, col } (line and col are 1-based); hint: optional advice. */
  constructor(message, span, hint = null) {
    super(message);
    this.name = 'SableError';
    this.span = span;
    this.hint = hint;
  }
}

export const KEYWORDS = ['fn', 'let', 'var', 'const', 'array', 'if', 'else', 'while', 'for', 'in', 'break', 'continue', 'return', 'true', 'false'];
export const TYPES = ['int', 'float', 'bool'];
// longest first, so ">>" wins over ">"
const OPERATORS = ['..', '->', '==', '!=', '<=', '>=', '&&', '||', '<<', '>>', '+=', '-=', '*=', '/=', '%=',
  '+', '-', '*', '/', '%', '&', '|', '^', '~', '!', '<', '>', '=', '(', ')', '{', '}', '[', ']', ',', ';', ':'];

const isDigit = (c) => c >= '0' && c <= '9';
const isHex = (c) => isDigit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
const isNameStart = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
const isNamePart = (c) => isNameStart(c) || isDigit(c);

export function lex(source) {
  const tokens = [];
  const n = source.length;
  let i = 0;
  let line = 1;
  let lineStart = 0;
  while (i < n) {
    const c = source[i];
    if (c === '\n') {
      i++;
      line++;
      lineStart = i;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      i++;
      continue;
    }
    if (c === '/' && source[i + 1] === '/') {
      while (i < n && source[i] !== '\n') i++;
      continue;
    }
    const start = i;
    const col = start - lineStart + 1;
    const push = (type, extra) => tokens.push({ type, text: source.slice(start, i), span: { start, end: i, line, col }, ...extra });
    if (isDigit(c)) {
      let float = false;
      let hex = false;
      if (c === '0' && (source[i + 1] === 'x' || source[i + 1] === 'X') && isHex(source[i + 2])) {
        hex = true;
        i += 2;
        while (isHex(source[i])) i++;
      } else {
        while (isDigit(source[i])) i++;
        // "0..n" is a range, so a dot only belongs to the number when a digit follows it
        if (source[i] === '.' && isDigit(source[i + 1])) {
          float = true;
          i++;
          while (isDigit(source[i])) i++;
        }
        if (source[i] === 'e' || source[i] === 'E') {
          let j = i + 1;
          if (source[j] === '+' || source[j] === '-') j++;
          if (isDigit(source[j])) {
            float = true;
            i = j;
            while (isDigit(source[i])) i++;
          }
        }
      }
      if (isNamePart(source[i])) {
        while (isNamePart(source[i])) i++;
        throw new SableError(`"${source.slice(start, i)}" is not a number`, { start, end: i, line, col }, 'a name cannot begin with a digit');
      }
      const text = source.slice(start, i);
      push(float ? 'float' : 'int', { value: Number(text), hex });
      continue;
    }
    if (isNameStart(c)) {
      while (isNamePart(source[i])) i++;
      const text = source.slice(start, i);
      push(KEYWORDS.includes(text) ? 'kw' : TYPES.includes(text) ? 'type' : 'name');
      continue;
    }
    const op = OPERATORS.find((o) => source.startsWith(o, i));
    if (op) {
      i += op.length;
      push('op');
      continue;
    }
    throw new SableError(`unexpected character ${JSON.stringify(c)}`, { start, end: start + 1, line, col });
  }
  tokens.push({ type: 'eof', text: '', span: { start: n, end: n, line, col: n - lineStart + 1 } });
  return tokens;
}
