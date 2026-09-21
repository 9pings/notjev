'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../lib/calibration');

test('calibration: T = 1 ne change rien', () => {
	assert.deepEqual(C.applyTemperature([0.7, 0.3], 1).map(( x ) => +x.toFixed(9) ), [0.7, 0.3]);
});
test('calibration: T > 1 aplatit, T < 1 durcit', () => {
	const flat = C.applyTemperature([0.9, 0.1], 3), sharp = C.applyTemperature([0.9, 0.1], 0.5);
	assert.ok(flat[0] < 0.9 && sharp[0] > 0.9);
	assert.ok(Math.abs(flat[0] + flat[1] - 1) < 1e-12);
});
test('calibration: un jeu sur-confiant reçoit T > 1 et un ECE qui baisse', () => {
	// 100 lignes à p=0,95 dont 70 % justes : sur-confiant
	const rows = []; for ( let i = 0; i < 100; i++ ) rows.push({ probabilities: [0.95, 0.05], label: i < 70 ? 0 : 1 });
	const r = C.fitTemperature(rows, { split: 'calib' });
	assert.ok(r.T > 1, 'T=' + r.T);
	assert.ok(r.eceAfter < r.eceBefore);
	assert.equal(r.split, 'calib'); assert.equal(r.n, 100);
});
test('calibration: calibrated() recalcule la marge et la bande d\'une décision', () => {
	const readout = require('../lib/readout');
	const d = readout.decide({ probabilities: [0.95, 0.05], options: ['a', 'b'], theta: 0.5 });
	const c = C.calibrated(Object.assign({ probabilities: [0.95, 0.05], options: ['a', 'b'], theta: 0.5 }, d), 3);
	assert.ok(c.margin < d.margin); assert.equal(c.T, 3); assert.equal(c.top, 'a');
});
