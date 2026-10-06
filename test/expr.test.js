/*
 * The expression evaluator, and the decision layer above it.
 *
 * These get more attention than their size suggests, because this is the one
 * part of the app that changes a number an operator typed before a switcher
 * sees it. A parser that is merely usually right would be worse than none: the
 * failure mode is a plausible wrong value on air, with nothing to notice.
 *
 * So the emphasis here is less on "does 2+2 work" and more on everything the
 * evaluator must REFUSE.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluate, fitToField, isPlainNumber, looksLikeExpression, variablesIn } from '../src/core/expr.js';
import { evaluateExpression as mynahEvaluate } from '../src/vendor/mynah-lang.mjs';
import { resolveField, isNumericField, isEnter } from '../plugins/arithmetic/math-fields.js';

const value = (s) => {
  const r = evaluate(s);
  assert.ok(r.ok, `expected ${s} to evaluate, got ${r.error}`);
  return r.value;
};
const rejects = (s) => assert.equal(evaluate(s).ok, false, `expected ${s} to be refused`);

test('the case this feature exists for', () => {
  assert.equal(value('1080-80'), 1000);
});

test('arithmetic, with correct precedence and associativity', () => {
  assert.equal(value('1+2*3'), 7);
  assert.equal(value('(1+2)*3'), 9);
  assert.equal(value('1920/2'), 960);
  assert.equal(value('100-10-5'), 85);      // left-associative, not 95
  assert.equal(value('100/10/2'), 5);
  assert.equal(value('2*3+4*5'), 26);
  assert.equal(value('((1920-40)/2)'), 940);
});

test('unary signs, including stacked ones', () => {
  assert.equal(value('-100'), -100);
  assert.equal(value('+100'), 100);
  assert.equal(value('-(100+50)'), -150);
  assert.equal(value('--100'), 100);
  assert.equal(value('1920+-20'), 1900);
});

test('decimals, with or without a leading digit', () => {
  assert.equal(value('.5+.5'), 1);
  assert.equal(value('1.5*2'), 3);
  assert.equal(value('0.1+0.2').toFixed(10), '0.3000000000');
});

test('whitespace is irrelevant', () => {
  assert.equal(value('  1080 - 80  '), 1000);
  assert.equal(value('1920 / 2'), 960);
});

test('division by zero is refused, not returned as Infinity', () => {
  /* Infinity would survive to the clamp and land as the field's max — a
     plausible-looking wrong answer, which is the whole thing to avoid. */
  rejects('1/0');
  rejects('1920/(10-10)');
});

test('malformed input is refused rather than guessed at', () => {
  for (const bad of ['2+', '*2', '(1+2', '1+2)', '()', '.', '1..2', '1 2', '--', '/', '']) {
    rejects(bad);
  }
});

test('anything that is not arithmetic is refused', () => {
  /* These are real values from real Web RCS fields. */
  for (const bad of ['1920x1080', '00:01.000', 'Main LED', '1e3', '0x10', '50%', 'NaN', 'Infinity']) {
    rejects(bad);
  }
});

test('no expression can reach the host environment', () => {
  /* There is no eval here and these must not become one by accident. */
  for (const bad of [
    'process.exit(1)',
    'globalThis',
    'constructor',
    '(()=>1)()',
    '1;2',
    '`1`',
    'alert(1)'
  ]) {
    rejects(bad);
  }
});

test('runaway input is bounded', () => {
  rejects('1+'.repeat(200) + '1');          // over the length cap
  rejects('('.repeat(50) + '1' + ')'.repeat(50));  // over the depth cap
  assert.equal(value('((((1+1))))'), 2);    // but ordinary nesting is fine
});

test('isPlainNumber separates a value from an expression', () => {
  for (const s of ['100', '-960', '+5', '1.5', '.5', ' 42 ']) {
    assert.ok(isPlainNumber(s), `${s} is a plain number`);
  }
  for (const s of ['1080-80', '1+1', '', 'abc', '1920x1080']) {
    assert.equal(isPlainNumber(s), false, `${s} is not a plain number`);
  }
});

test('looksLikeExpression gates on arithmetic and nothing else', () => {
  assert.ok(looksLikeExpression('1080-80'));
  assert.ok(looksLikeExpression('(100)'));
  /* A bare value is not an expression: there is nothing to substitute, and a
     needless write is a needless chance to be wrong. */
  assert.equal(looksLikeExpression('-960'), false);
  assert.equal(looksLikeExpression('100'), false);
  assert.equal(looksLikeExpression('00:01.000'), false);
  assert.equal(looksLikeExpression('Main LED'), false);
});

test('fitToField clamps to the range the vendor declared', () => {
  const width = { min: '0', max: '8192', step: '1' };
  assert.equal(fitToField(1000, width), 1000);
  assert.equal(fitToField(9000, width), 8192);
  assert.equal(fitToField(-5, width), 0);

  const posX = { min: '-960', max: '2880', step: '1' };
  assert.equal(fitToField(-2000, posX), -960);
  assert.equal(fitToField(-960, posX), -960);
});

test('fitToField rounds to the precision step implies', () => {
  /* Every geometry field on a LivePremier reports step="1", so this is the
     path that actually runs. */
  assert.equal(fitToField(1000.4, { step: '1' }), 1000);
  assert.equal(fitToField(1000.6, { step: '1' }), 1001);
  assert.equal(fitToField(1000, { step: '1' }), 1000);

  assert.equal(fitToField(1.567, { step: '0.01' }), 1.57);
  assert.equal(fitToField(1.5, { step: null }), 1.5);   // no step, no rounding
  assert.equal(fitToField(1.5, { step: '' }), 1.5);
});

test('fractional steps inherit binary floating point, and that is accepted', () => {
  /* 1.005 is really 1.00499…, so toFixed(2) gives "1.00" rather than "1.01".
     Pinned rather than worked around: no LivePremier field uses a fractional
     step, and a half-ulp difference on a hypothetical one does not justify
     hand-rolled decimal rounding in the path that writes to a switcher. */
  assert.equal(fitToField(1.005, { step: '0.01' }), 1);
});

test('fitToField never produces negative zero', () => {
  /* "-0" in a position field looks like a bug in the app. */
  assert.equal(Object.is(fitToField(-0.2, { step: '1' }), -0), false);
  assert.equal(fitToField(-0.2, { step: '1' }), 0);
});

test('resolveField substitutes only when there is something to substitute', () => {
  const width = { min: '0', max: '8192', step: '1' };

  assert.deepEqual(resolveField('1080-80', width), { apply: true, value: 1000, text: '1000' });
  assert.deepEqual(resolveField('9000+1000', width), { apply: true, value: 8192, text: '8192' });

  assert.equal(resolveField('1080', width).apply, false);
  assert.equal(resolveField('-960', width).apply, false);
  assert.equal(resolveField('00:01.000', width).apply, false);
  assert.equal(resolveField('Main LED', width).apply, false);
  assert.equal(resolveField('100/0', width).apply, false);
  assert.equal(resolveField('2+', width).apply, false);
});

test('resolveField leaves a field alone when the result reads the same', () => {
  /* `(1000)` evaluates to 1000, but the field already says 1000. */
  assert.equal(resolveField('1000', { step: '1' }).apply, false);
});

test('isNumericField accepts only the vendor fields marked numeric', () => {
  /* Web RCS puts min/max/step on its geometry inputs and nothing else, which
     is what makes this safe without matching a per-build class hash. */
  const field = (props) => ({
    tagName: 'INPUT', type: 'text', disabled: false, readOnly: false,
    hasAttribute: (n) => n in props, ...props
  });

  assert.ok(isNumericField(field({ step: '1', min: '0', max: '8192' })));
  assert.equal(isNumericField(field({})), false, 'a label field has no step');
  assert.equal(isNumericField({ ...field({ step: '1' }), disabled: true }), false);
  assert.equal(isNumericField({ ...field({ step: '1' }), readOnly: true }), false);
  assert.equal(isNumericField({ ...field({ step: '1' }), type: 'number' }), false,
    'number inputs are excluded — they discard the expression before we can read it');
  assert.equal(isNumericField({ ...field({ step: '1' }), tagName: 'TEXTAREA' }), false);
  assert.equal(isNumericField(null), false);
});

test('Enter is recognised however the event spells it', () => {
  /* `key` is not always populated — some synthetic and remote-input paths
     leave it empty while still carrying `code` or the legacy `keyCode`. */
  assert.ok(isEnter({ key: 'Enter' }));
  assert.ok(isEnter({ key: '', code: 'Enter' }));
  assert.ok(isEnter({ key: '', code: 'NumpadEnter' }));
  assert.ok(isEnter({ key: '', keyCode: 13 }));
  assert.equal(isEnter({ key: 'a', keyCode: 65 }), false);
  assert.equal(isEnter({ key: '' }), false);
});

/* ------------------------------------------------------------- variables */

/*
 * The resolver is injected, so the module stays pure. A Map, not an object:
 * `$constructor` must be unknown, not Object's own constructor.
 */
const TABLE = new Map([
  ['system:s1.width', { ok: true, value: 1920 }],
  ['system:s1.height', { ok: true, value: 1080 }],
  ['system:s1.label', { ok: true, value: 'Main LED' }],
  ['system:s1.pgm.l2.x', { ok: false, error: 'S1 is mid-take' }],
  ['user:gap', { ok: true, value: 40 }],
  ['user:zero', { ok: true, value: 0 }],
  ['user:nan', { ok: true, value: NaN }]
]);
const asked = [];
const resolve = (name, kind) => {
  asked.push([name, kind]);
  return TABLE.get(`${kind}:${name.toLowerCase()}`);
};
const withVars = (s) => {
  const r = evaluate(s, { resolve });
  assert.ok(r.ok, `expected ${s} to evaluate, got ${r.error}`);
  return r.value;
};
const refusedWith = (s, pattern, opts = { resolve }) => {
  const r = evaluate(s, opts);
  assert.equal(r.ok, false, `expected ${s} to be refused`);
  assert.match(r.error, pattern);
};

test('a variable is a primary: alone, in a sum, in brackets, signed', () => {
  assert.equal(withVars('$S1.width'), 1920);
  assert.equal(withVars('$S1.width/2'), 960);
  assert.equal(withVars('@gap*3'), 120);
  assert.equal(withVars('($S1.width - @gap * 2) / 2'), 920);
  assert.equal(withVars('-@gap'), -40);
});

test('the resolver hears the name as typed and which sigil it had', () => {
  asked.length = 0;
  withVars('$S1.Width + @GAP');
  assert.deepEqual(asked, [['S1.Width', 'system'], ['GAP', 'user']]);
});

test('a variable is refused, by name, rather than read as zero or NaN', () => {
  refusedWith('$S1.widht/2', /unknown variable \$S1\.widht/);
  refusedWith('$S1.label', /\$S1\.label is text \("Main LED"\), not a number/);
  refusedWith('$S1.PGM.L2.x + 10', /\$S1\.PGM\.L2\.x: S1 is mid-take/);
  refusedWith('@nan', /not a finite number/);
  refusedWith('1920/@zero', /division by zero/);
  refusedWith('$constructor', /unknown variable/);
  /* No resolver: the Variables plugin is off, or this caller has none. */
  refusedWith('$S1.width/2', /variables are not available/, {});
  /* A resolver that throws is a refusal, not a crash in the vendor's handler. */
  refusedWith('@gap', /boom/, { resolve: () => { throw new Error('boom'); } });
});

test('a sigil needs a name, and a name has a shape', () => {
  for (const bad of ['$', '@', '$ S1', '@9', '$S1..width', '$S1.width.']) {
    assert.equal(evaluate(bad, { resolve }).ok, false, `${bad} is refused`);
  }
});

test('looksLikeExpression counts a bare variable, and still nothing that is not arithmetic', () => {
  assert.ok(looksLikeExpression('$S1.width'));
  assert.ok(looksLikeExpression('@gap'));
  assert.ok(looksLikeExpression('$S1.width/2'));
  assert.equal(looksLikeExpression('$'), false);
  assert.equal(looksLikeExpression('Main LED'), false);
  assert.equal(looksLikeExpression('LIVE_3'), false);
  assert.equal(looksLikeExpression('a@b.com'), false);
  assert.equal(looksLikeExpression('-960'), false);
});

test('variablesIn lists what a line names, without evaluating anything', () => {
  assert.deepEqual(variablesIn('Size ($S1.width / 2) @gap. 50%').map((v) => v.text), ['$S1.width', '@gap']);
  assert.deepEqual(variablesIn('Recall Screen 1 Memory 5'), []);
});

/*
 * Two implementations of one grammar: this file's, for the vendor's fields,
 * and mynah's, for the command line. They were written apart, so agreeing is
 * evidence and disagreeing is a bug in one of them. Every case either
 * evaluates to the same number in both or is refused by both.
 *
 * One known difference is left out on purpose: a leading-dot decimal (`.5`),
 * which this file accepts and mynah's lexer does not — mynah reads a `.` as
 * part of a number only after a digit, so that `50.` ends a sentence.
 */
test('mynah’s evaluateExpression and this one agree', () => {
  const vars = { resolve };
  const cases = [
    '1080-80', '1+2*3', '(1+2)*3', '100-10-5', '100/10/2', '--100', '1920+-20',
    '$S1.width/2', '@gap*3', '($S1.width - @gap * 2) / 2', '-@gap', '((((1+1))))',
    '1/0', '1920/(10-10)', '@zero', '1920/@zero', '$S1.widht', '$S1.label', '$S1.PGM.L2.x',
    '2+', '*2', '(1+2', '1+2)', '()', '1 2', '50%', '1e3', 'Main LED', '$', '@9',
    '('.repeat(30) + '1' + ')'.repeat(30)
  ];
  for (const c of cases) {
    const ours = evaluate(c, { resolve });
    const theirs = mynahEvaluate(c, vars);
    assert.equal(ours.ok, theirs.ok, `${c}: expr.js ${ours.ok ? ours.value : ours.error} vs mynah ${theirs.ok ? theirs.value : theirs.error}`);
    if (ours.ok) assert.equal(ours.value, theirs.value, c);
  }
});
