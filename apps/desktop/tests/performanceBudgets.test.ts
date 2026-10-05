import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

type Ceiling = { value: number; reason?: string };
const file = path.resolve(import.meta.dirname, '../performance-budgets.json');
const budgets = JSON.parse(fs.readFileSync(file, 'utf8')) as { budgets: Record<string, { ceilings: Ceiling[] }> };

test('performance ceilings only go down unless a raise says why', () => {
  assert.ok(Object.keys(budgets.budgets).length > 0);
  for (const [name, budget] of Object.entries(budgets.budgets)) {
    assert.ok(budget.ceilings.length > 0, `${name} needs a ceiling`);
    budget.ceilings.forEach((ceiling, index) => {
      assert.ok(Number.isFinite(ceiling.value) && ceiling.value > 0, `${name} ceiling ${index} must be a positive number`);
      const previous = budget.ceilings[index - 1];
      if (previous && ceiling.value > previous.value) {
        assert.ok(ceiling.reason?.trim(), `${name}: raising ${previous.value} to ${ceiling.value} needs a reason`);
      }
    });
  }
});
