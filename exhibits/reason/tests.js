import { assert, equal, near } from '../../assets/js/check.js';
import { rng } from '../../assets/js/kit.js';
import { num, int, sym, add, mul, pow, nadd, nmul, key, expand, same, size, ONE } from './core.js';
import { parse, build } from './parse.js';
import { show, toDisplay, toHTML, toLatex } from './display.js';
import { diff, integrate, simplify } from './calculus.js';
import { ratCoeffs, factorPoly, pmul, pdivmod, pgcd } from './poly.js';
import { agree, checkDerivative, evalReal, quadrature, findRoots } from './numeric.js';
import { run } from './engine.js';
import { CASES } from './cases.js';

const x = sym('x');
const E = (text) => build(parse(text));

/** One test per group of recorded calculations. */
const recorded = Object.entries(CASES).map(([group, list]) => ({
  name: `${group}: ${list.length} recorded answers`,
  fn() {
    for (const [input, expected] of list) {
      const r = run(input);
      assert(r.ok, `${input} failed: ${r.message}`);
      equal(r.text, expected, input);
      assert(!r.check || r.check.state !== 'bad', `${input}: its own numerical check disagrees`);
    }
  },
}));

/** Random expressions in x, built to be defined on most of the real line. */
function randomExpression(r, depth = 3) {
  if (depth <= 0 || r() < 0.2) return r.pick(['x', 'x', 'x', '2', '3', '1/2', 'x^2']);
  const sub = () => randomExpression(r, depth - 1);
  switch (r.int(9)) {
    case 0: return `(${sub()} + ${sub()})`;
    case 1: return `(${sub()} - ${sub()})`;
    case 2: case 3: return `(${sub()})*(${sub()})`;
    case 4: return `(${sub()})/(x^2 + ${1 + r.int(3)})`;
    case 5: return `${r.pick(['sin', 'cos', 'atan'])}(${sub()})`;
    case 6: return `e^(${r.pick(['x', '-x', 'x/2', 'sin(x)'])})`;
    case 7: return `ln(x^2 + ${1 + r.int(4)})`;
    default: return `(${sub()})^${2 + r.int(2)}`;
  }
}

export default [
  ...recorded,
  {
    name: 'rational arithmetic is exact and obeys the field laws',
    fn() {
      const r = rng(5);
      const q = () => num(BigInt(r.int(41) - 20), BigInt(1 + r.int(12)));
      for (let i = 0; i < 200; i++) {
        const [a, b, c] = [q(), q(), q()];
        equal(key(nadd(a, b)), key(nadd(b, a)), 'a + b = b + a');
        equal(key(nmul(a, nadd(b, c))), key(nadd(nmul(a, b), nmul(a, c))), 'a(b + c) = ab + ac');
        equal(key(nadd(nadd(a, b), c)), key(nadd(a, nadd(b, c))), '(a + b) + c = a + (b + c)');
      }
      equal(show(E('1/3 + 1/6 + 1/2')), '1');
      equal(String(E('30!').n), '265252859812191058636308480000000');
      equal(String(E('2^200').n).length, 61);
    },
  },
  {
    name: 'the same expression written differently has one canonical form',
    fn() {
      const pairs = [['x + y', 'y + x'], ['x*y*x', 'x^2*y'], ['2(x + 1)', '2x + 2'], ['x - x', '0'], ['x/x', '1'], ['(x*y)^2', 'x^2 y^2'], ['sqrt(8)', '2 sqrt(2)'], ['e^x*e^-x', '1'], ['x^(1/2)*x^(1/2)', 'x'], ['a - (b - c)', 'a - b + c']];
      for (const [p, q] of pairs) equal(key(E(p)), key(E(q)), `${p} and ${q}`);
      assert(key(E('sqrt(x^2)')) !== key(E('x')), '√(x²) is |x|, not x, and must not collapse to x');
    },
  },
  {
    name: 'derivatives of 60 random expressions match finite differences',
    fn() {
      const r = rng(101);
      let checked = 0;
      for (let i = 0; i < 60; i++) {
        const text = randomExpression(r);
        const f = E(text);
        const result = checkDerivative(f, diff(f, x), 'x');
        assert(result.ok !== false, `d/dx ${text} is wrong at x = ${result.at && result.at.x}`);
        if (result.ok) checked++;
      }
      assert(checked >= 50, `only ${checked} of 60 could be checked`);
    },
  },
  {
    name: 'simplify and expand never change the value of an expression',
    fn() {
      const r = rng(202);
      for (let i = 0; i < 50; i++) {
        const text = randomExpression(r);
        const f = E(text);
        assert(agree(f, simplify(f)).ok !== false, `simplify changed ${text}`);
        assert(agree(f, expand(f)).ok !== false, `expand changed ${text}`);
        assert(size(simplify(f)) <= size(f), `simplify made ${text} larger`);
      }
    },
  },
  {
    name: 'every antiderivative found differentiates back to its integrand',
    fn() {
      const integrands = ['x^5 - 3x + 2', 'x^3 e^(2x)', 'x^2 sin(3x)', 'x^3 ln(x)', '1/(x^2 + 6x + 13)', '(3x + 2)/(x^2 - 5x + 6)', 'sin(2x) cos(2x)', 'e^(3x) cos(2x)', 'x sqrt(x^2 + 1)', 'cos(x) e^(sin(x))', '1/(x ln(x))', 'x^2/(x^2 + 1)', '(x + 1)^3/x', 'sinh(2x) + cosh(x/2)', 'atan(x)', 'x/(x^4 + 1)', 'cos(x)^2', '1/cos(x)^2', 'e^x/(e^x + 1)', '(x^2 + 1)^2'];
      let found = 0;
      for (const text of integrands) {
        const f = E(text);
        const F = integrate(f, x);
        if (!F) continue;
        found++;
        const back = agree(diff(F, x), f);
        assert(back.ok === true, `the antiderivative of ${text} does not differentiate back (${show(F)})`);
      }
      assert(found >= 18, `only ${found} of ${integrands.length} were integrated`);
    },
  },
  {
    name: 'an integral with no elementary answer is declined, not invented',
    fn() {
      for (const text of ['e^(x^2)', 'sin(x)/x', 'sqrt(1 + x^4)', 'x^x']) equal(integrate(E(text), x), null, text);
      const r = run('integrate(e^(x^2), x)');
      assert(r.ok && !r.answer && /No antiderivative found/.test(r.message));
      const d = run('integrate(1/x^2, x, -1, 1)');
      assert(d.ok && !d.answer && /did not converge/.test(d.message), 'an improper integral must not be given a value');
    },
  },
  {
    name: 'factoring 40 random polynomials multiplies back exactly',
    fn() {
      const r = rng(303);
      for (let i = 0; i < 40; i++) {
        const pieces = Array.from({ length: 2 + r.int(3) }, () => (r() < 0.7 ? [int(r.int(13) - 6), int(1 + r.int(3))] : [int(1 + r.int(5)), int(r.int(5) - 2), int(1)]));
        const p = pieces.reduce((acc, f) => pmul(acc, f), [int(1 + r.int(4))]);
        const { content, factors } = factorPoly(p);
        const back = factors.reduce((acc, f) => { for (let k = 0; k < f.mult; k++) acc = pmul(acc, f.p); return acc; }, [content]);
        equal(back.map(key), p.map(key), 'product of the factors');
        const linear = pieces.filter((f) => f.length === 2).length;
        assert(factors.reduce((n, f) => n + (f.p.length === 2 ? f.mult : 0), 0) >= linear, 'every rational root is found');
      }
    },
  },
  {
    name: 'polynomial division and gcd satisfy their defining identities',
    fn() {
      const a = ratCoeffs(E('(x - 1)(x + 2)(x^2 + 3)'), x);
      const b = ratCoeffs(E('(x - 1)(x - 5)'), x);
      const [q, rem] = pdivmod(a, b);
      const back = pmul(q, b).map((c, i) => nadd(c, rem[i] || int(0)));
      equal(back.map(key), a.map(key), 'a = q·b + r');
      equal(pgcd(a, b).map(key), [int(-1), ONE].map(key), 'gcd is x − 1');
    },
  },
  {
    name: 'solutions satisfy their equations',
    fn() {
      for (const eq of ['x^2 - 5x + 6 = 0', '2x^3 - 3x^2 - 11x + 6 = 0', 'x^2 + 4x + 13 = 0', 'x^4 - 10x^2 + 9 = 0', 'e^(2x) = 7', '3^x = 81', 'x^3 - 2x - 5 = 0', 'x = cos(x)', 'ln(x) + x = 3']) {
        const r = run(eq);
        assert(r.ok && r.answer, `${eq} has no answer`);
        assert(r.check && r.check.state === 'ok', `${eq}: the solutions do not check`);
      }
      equal(run('3^x = 81').text, 'x = 4');
      equal(run('x^2 + 4x + 13 = 0').text, 'x = -2 + 3i, x = -2 - 3i');
    },
  },
  {
    name: 'quadrature and root-finding agree with closed forms',
    fn() {
      near(quadrature(Math.sin, 0, Math.PI).value, 2, 1e-9);
      near(quadrature((t) => Math.exp(-t * t), -6, 6).value, Math.sqrt(Math.PI), 1e-9);
      near(quadrature((t) => 1 / (1 + t * t), 0, 1).value, Math.PI / 4, 1e-10);
      equal(quadrature((t) => 1 / (t * t), -1, 1).ok, false, 'a divergent integral is reported, not returned');
      const roots = findRoots((t) => t * t * t - t, -3, 3);
      equal(roots.map((v) => Math.round(v * 1e6) / 1e6 + 0), [-1, 0, 1]);
      equal(findRoots((t) => 1 / t, -1, 1.5).length, 0, 'a sign change across a pole is not a root');
    },
  },
  {
    name: 'mistakes get a plain message and a position',
    fn() {
      const bad = [['2 +', /ends too soon/, 3], ['sin(', /ends too soon/, 4], ['x $ y', /"\$"/, 2], ['(1 + 2', /"\)"/, 6], ['3.4.5', /two decimal points/, 3], ['diff(x^2, 3)', /single letter/, null], ['1/0', /division by zero/, null], ['ln(0)', /undefined/, null], ['(-3)!', /factorial/, null], ['series(x, x, 99)', /0 to 16/, null]];
      for (const [input, pattern, pos] of bad) {
        const r = run(input);
        assert(!r.ok, `${input} should be refused`);
        assert(pattern.test(r.message), `${input}: "${r.message}" should match ${pattern}`);
        if (pos != null) equal(r.pos, pos, `${input}: position`);
      }
    },
  },
  {
    name: 'huge or pathological inputs are refused quickly instead of hanging',
    fn() {
      const t0 = Date.now();
      for (const input of ['2^(10^9)', '9999!', 'expand((x + y + z + 1)^60)', `${'('.repeat(400)}x${')'.repeat(400)}`, 'expand((a + b + c + d)^30)']) {
        const r = run(input);
        assert(r.ok === false || r.text.length < 5000, `${input.slice(0, 30)} should be refused or small`);
      }
      assert(Date.now() - t0 < 3000, 'the refusals took too long');
    },
  },
  {
    name: 'typesetting produces balanced HTML and valid-looking LaTeX',
    fn() {
      for (const text of ['(x^2 + 1)/(x - 1)', 'sqrt(x^2 + 1/4)', 'sin(x)^2 e^(-x/2)', '|x - 1|/(1 + sqrt(2))', 'x^(1/3) + 2/3']) {
        const d = toDisplay(E(text));
        const html = toHTML(d);
        equal((html.match(/<span/g) || []).length, (html.match(/<\/span>/g) || []).length, `${text}: spans are balanced`);
        const latex = toLatex(d);
        equal((latex.match(/{/g) || []).length, (latex.match(/}/g) || []).length, `${text}: braces are balanced`);
        equal((latex.match(/\\left/g) || []).length, (latex.match(/\\right/g) || []).length, `${text}: delimiters are balanced`);
      }
      equal(toLatex(toDisplay(E('(x^2 + 1)/(2x)'))), '\\frac{x^{2} + 1}{2 x}');
      assert(same(E(show(E('3x^2 sin(x)/(x + 1) - sqrt(2)/2'))), E('3x^2 sin(x)/(x + 1) - sqrt(2)/2')), 'printed text parses back to the same expression');
    },
  },
  {
    name: 'the notebook renders worked cards with typeset answers',
    browser: true,
    async fn() {
      const { mount } = await import('./index.js');
      const root = document.createElement('div');
      root.className = 'stage';
      root.dataset.exhibit = 'reason';
      root.style.cssText = 'position:absolute;left:-9999px;width:600px';
      document.body.append(root);
      try {
        const ctl = await mount(root, { reducedMotion: false, coarse: false, small: false });
        assert(root.querySelectorAll('.reason-card').length >= 3, 'opening cards are present');
        const input = root.querySelector('.reason-input');
        input.value = 'integrate(x cos(x), x)';
        root.querySelector('form').dispatchEvent(new Event('submit', { cancelable: true }));
        const first = root.querySelector('.reason-card');
        assert(first.querySelector('.reason-check[data-state="ok"]'), 'the new card carries a passed check');
        assert(first.querySelector('.reason-m-f') && first.querySelector('canvas'), 'typeset functions and a plot');
        ctl.destroy();
      } finally {
        root.remove();
      }
    },
  },
];
