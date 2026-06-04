import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldEagerExpandForCodeToken } from '../overlayCodeExpansion.mjs';

describe('overlayCodeExpansion', () => {
  test('eagerly expands for what-to-answer code fences before DOM visibility scan', () => {
    assert.equal(
      shouldEagerExpandForCodeToken('what_to_answer', '```python\nprint(1)\n```'),
      true,
    );
  });

  test('eagerly expands for manual chat code fences before finalize marks isCode', () => {
    assert.equal(
      shouldEagerExpandForCodeToken('chat', '```ts\nconsole.log(1)\n```'),
      true,
    );
  });

  test('eagerly expands when a streamed code fence is split across token boundary', () => {
    assert.equal(shouldEagerExpandForCodeToken('what_to_answer', '`python\nprint(1)', '``'), true);
  });

  test('does not eagerly expand non-answer streams just because they contain code fences', () => {
    assert.equal(shouldEagerExpandForCodeToken('recap', '```text\nnotes\n```'), false);
    assert.equal(shouldEagerExpandForCodeToken('clarify', '```text\nexplain\n```'), false);
  });

  test('does not eagerly expand plain answer text', () => {
    assert.equal(shouldEagerExpandForCodeToken('what_to_answer', 'Use a sliding window.'), false);
    assert.equal(shouldEagerExpandForCodeToken('chat', 'Use a sliding window.'), false);
  });
});
