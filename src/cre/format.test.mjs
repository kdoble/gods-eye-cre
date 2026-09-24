import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatMoney,
  formatPercent,
  formatSignedPercent,
  formatUnitValue,
  isRentMonthlyLabel,
  formatRentMonthlyAnnual,
  formatLabeledValue,
} from './format.js';

test('formatMoney: whole dollars, comma grouped, parenthesized when negative', () => {
  assert.equal(formatMoney(105767), '$105,767');
  assert.equal(formatMoney(1858), '$1,858');
  assert.equal(formatMoney(-500), '($500)');
  assert.equal(formatMoney(0), '$0');
});

test('formatPercent: no space before the % sign, parenthesized when negative', () => {
  assert.equal(formatPercent(43), '43%');
  assert.equal(formatPercent(-1.3, { digits: 1 }), '(1.3%)');
  assert.equal(formatPercent(71.4, { digits: 1 }), '71.4%');
});

test('formatSignedPercent: always carries a sign', () => {
  assert.equal(formatSignedPercent(3.2), '+3.2%');
  assert.equal(formatSignedPercent(-1.3), '(1.3%)');
  assert.equal(formatSignedPercent(0), '0.0%');
});

test('formatUnitValue: money units render as "$X" / "$X/mo" / "$X/yr", never "USD/month"', () => {
  assert.equal(formatUnitValue(105767, 'USD'), '$105,767');
  assert.equal(formatUnitValue(812, 'USD/month'), '$812/mo');
  assert.equal(formatUnitValue(4200, 'USD/year'), '$4,200/yr');
  assert.equal(formatUnitValue(950, 'USD/week'), '$950/wk');
  assert.equal(formatUnitValue(1858, '$/mo'), '$1,858/mo');
  assert.equal(formatUnitValue(300, '$/yr'), '$300/yr');
  assert.equal(formatUnitValue(31250, '$'), '$31,250');
});

test('formatUnitValue: percent has no space; negative percent is parenthesized', () => {
  assert.equal(formatUnitValue(43, '%'), '43%');
  assert.equal(formatUnitValue(-1.3, '%'), '(1.3%)');
});

test('formatUnitValue: non-money units keep "value unit"', () => {
  assert.equal(formatUnitValue(61234, 'jobs'), '61,234 jobs');
  assert.equal(formatUnitValue(1.2, 'mi'), '1.2 mi');
  assert.equal(formatUnitValue('X', ''), 'X');
});

test('formatUnitValue: negative non-percent, non-money numbers still render, not throw', () => {
  assert.equal(formatUnitValue(-2, 'ft'), '-2 ft');
});

test('isRentMonthlyLabel: matches ACS gross rent, Zillow and FMR labels, not the ACS change row', () => {
  assert.ok(isRentMonthlyLabel('Median gross rent (tract 47179060902)'));
  assert.ok(isRentMonthlyLabel('Zillow rent index (ZORI), ZIP 37604, Aug 2026'));
  assert.ok(isRentMonthlyLabel('Typical asking rent, ZIP 37604'));
  assert.ok(isRentMonthlyLabel('HUD Fair Market Rent, 2BR'));
  assert.ok(!isRentMonthlyLabel('Median gross rent change'));
  assert.ok(!isRentMonthlyLabel('Median household income (tract 123)'));
});

test('formatRentMonthlyAnnual: monthly and annual per unit, annual rounded from the unrounded monthly value', () => {
  assert.equal(formatRentMonthlyAnnual(1858), '$1,858/mo ($22,296/yr per unit)');
  assert.equal(formatRentMonthlyAnnual(812), '$812/mo ($9,744/yr per unit)');
  // Unrounded monthly value produces a rounded annual figure.
  assert.equal(
    formatRentMonthlyAnnual(1858.33),
    '$1,858/mo ($22,300/yr per unit)',
  );
});

test('formatRentMonthlyAnnual: annual must come from the UNROUNDED index, not the rounded monthly display value', () => {
  // $2,078.65 x 12 = $24,943.80, which rounds to $24,944 -- never $24,948
  // ($2,079, the rounded monthly figure, x 12).
  assert.equal(
    formatRentMonthlyAnnual(2078.65),
    '$2,079/mo ($24,944/yr per unit)',
  );
});

test('formatRentMonthlyAnnual: an explicit annualOverride wins over monthly x 12', () => {
  // The rounded monthly value (2079) would otherwise give $24,948; the
  // override is the row's own precomputed, unrounded-then-rounded figure.
  assert.equal(
    formatRentMonthlyAnnual(2079, { annualOverride: 24944 }),
    '$2,079/mo ($24,944/yr per unit)',
  );
});

test('formatLabeledValue: prefers the row\'s explicit annualPerUnit field over the rounded value x 12, even when the note wording changes underneath it (S5 negative: this must fail if the value is ever re-derived by parsing note text instead of reading the field)', () => {
  assert.equal(
    formatLabeledValue({
      label: 'Zillow rent index (ZORI), ZIP 30308, Aug 2026',
      value: 2079,
      unit: '$/mo',
      annualPerUnit: 24944,
      // Deliberately reworded so it no longer matches the retired
      // "$X per unit per year" note-parsing pattern -- the annual figure
      // must still come through via the field alone.
      note: 'Smoothed typical asking rent, all homes plus multifamily. Annualized, this pencils to roughly two years of rent x 12ish, give or take.',
    }),
    '$2,079/mo ($24,944/yr per unit)',
  );
});

test('formatLabeledValue: a rent-monthly label with a monthly money unit gets the annualized form', () => {
  assert.equal(
    formatLabeledValue({
      label: 'Median gross rent (tract 47179060902)',
      value: 812,
      unit: 'USD/month',
    }),
    '$812/mo ($9,744/yr per unit)',
  );
  assert.equal(
    formatLabeledValue({
      label: 'Median gross rent change',
      value: -1.3,
      unit: '%',
    }),
    '(1.3%)',
  );
  assert.equal(
    formatLabeledValue({
      label: 'Median household income (tract 123)',
      value: 31250,
      unit: 'USD',
    }),
    '$31,250',
  );
});
