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

import { evaluate, fitToField, isPlainNumber, looksLikeExpression } from '../src/core/expr.js';
import { resolveField, isNumericField, isEnter } from '../src/ui/math-fields.js';

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
