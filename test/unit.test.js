// Testes unitarios (node --test). Zero dependencias: usa o runner nativo do Node 18+.
// Logica pura do servidor/sync e importada; as funcoes de data do frontend sao
// extraidas do proprio index.html (fonte real) e avaliadas aqui.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { parseModelName, sliceRange, costBreakdownOf } = require('../server.js');
const { mergeHistory } = require('../sync.js');

// ---------------- parseModelName ----------------
test('parseModelName: tag e modelo base', () => {
	const cases = [
		['claude-sonnet-4-6', null, 'claude-sonnet-4-6'],
		['acme-claude-sonnet-4-6', 'acme', 'claude-sonnet-4-6'],
		['acme-claude-sonnet-4-6-2', 'acme', 'claude-sonnet-4-6'],
		['claude-haiku-4-5', null, 'claude-haiku-4-5'],
		['claude-opus-4-6-2', null, 'claude-opus-4-6'],
		['gpt-5.5-2', null, 'gpt-5.5'],
		['acme-gpt-5.5', 'acme', 'gpt-5.5'],
		['claude-sonnet-4-5-20250929', null, 'claude-sonnet-4-5-20250929'],
		['acme-Kimi-K2.7-Code', 'acme', 'Kimi-K2.7-Code'],
		['foo-bar', null, 'foo-bar'],
		['acme-DeepSeek-V4-Pro', 'acme', 'DeepSeek-V4-Pro'],
		['o3-mini', null, 'o3-mini']
	];
	for (const [name, tag, base] of cases) {
		const r = parseModelName(name);
		assert.equal(r.tag, tag, name + ' (tag)');
		assert.equal(r.base, base, name + ' (base)');
	}
});

// ---------------- sliceRange ----------------
const sampleData = () => ({
	daily: [
		{ date: '2026-07-01', total: 1 },
		{ period: '2026-07-10', total: 2 },
		{ date: '2026-07-20', total: 3 }
	],
	totals: { x: 1 }
});

test('sliceRange: filtra inclusivo por since/until (yyyymmdd)', () => {
	const r = sliceRange(sampleData(), '20260705', '20260720');
	assert.deepEqual(r.daily.map((d) => d.total), [2, 3]);
});

test('sliceRange: sem since/until retorna tudo', () => {
	const r = sliceRange(sampleData(), '', '');
	assert.equal(r.daily.length, 3);
});

test('sliceRange: so since / so until', () => {
	assert.deepEqual(sliceRange(sampleData(), '20260710', '').daily.map((d) => d.total), [2, 3]);
	assert.deepEqual(sliceRange(sampleData(), '', '20260701').daily.map((d) => d.total), [1]);
});

test('sliceRange: nao muta o objeto original', () => {
	const data = sampleData();
	sliceRange(data, '20260720', '20260720');
	assert.equal(data.daily.length, 3);
});

// ---------------- costBreakdownOf ----------------
test('costBreakdownOf: multiplica tokens pelo preco unitario de cada tipo', () => {
	const mb = { inputTokens: 1000, outputTokens: 500, cacheCreationTokens: 200, cacheReadTokens: 10000 };
	const p = { input: 0.000003, output: 0.000015, cacheW: 0.00000375, cacheR: 0.0000003 };
	const r = costBreakdownOf(mb, p);
	assert.ok(Math.abs(r.input - 0.003) < 1e-9);
	assert.ok(Math.abs(r.output - 0.0075) < 1e-9);
	assert.ok(Math.abs(r.cacheW - 0.00075) < 1e-9);
	assert.ok(Math.abs(r.cacheR - 0.003) < 1e-9);
});

test('costBreakdownOf: sem precos retorna null', () => {
	const mb = { inputTokens: 10, outputTokens: 10 };
	assert.equal(costBreakdownOf(mb, null), null);
	assert.equal(costBreakdownOf(mb, {}), null);
	assert.equal(costBreakdownOf(mb, { cacheR: 0.001 }), null);
});

test('costBreakdownOf: campos de token ausentes contam como zero', () => {
	const r = costBreakdownOf({}, { input: 0.001, output: 0.002 });
	assert.deepEqual([r.input, r.output, r.cacheW, r.cacheR], [0, 0, 0, 0]);
});

// ---------------- mergeHistory (sync) ----------------
const row = (over) => Object.assign({
	date: '2026-07-01', agent: 'all', model: 'claude-sonnet-4-6',
	total_tokens: 100, cost_usd: 0.01, exported_at: 'x'
}, over);

test('mergeHistory: linha nova entra no historico e no delta', () => {
	const h = {};
	const delta = mergeHistory(h, [row()]);
	assert.equal(delta.length, 1);
	assert.equal(Object.keys(h).length, 1);
});

test('mergeHistory: atualizacao com mais tokens substitui e gera delta', () => {
	const h = {};
	mergeHistory(h, [row()]);
	const delta = mergeHistory(h, [row({ total_tokens: 150 })]);
	assert.equal(delta.length, 1);
	assert.equal(h['2026-07-01|all|claude-sonnet-4-6'].total_tokens, 150);
});

test('mergeHistory: regressao de tokens (purge parcial) preserva o maior', () => {
	const h = {};
	mergeHistory(h, [row({ total_tokens: 150 })]);
	const delta = mergeHistory(h, [row({ total_tokens: 50 })]);
	assert.equal(delta.length, 0);
	assert.equal(h['2026-07-01|all|claude-sonnet-4-6'].total_tokens, 150);
});

test('mergeHistory: linha identica nao gera delta (exported_at ignorado)', () => {
	const h = {};
	mergeHistory(h, [row()]);
	const delta = mergeHistory(h, [row({ exported_at: 'outro' })]);
	assert.equal(delta.length, 0);
});

// ---------------- funcoes de data do frontend (extraidas do index.html) ----------------
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
function grabFn(name) {
	const m = html.match(new RegExp('^function ' + name + '\\(.*$', 'm'));
	assert.ok(m, 'funcao ' + name + ' (em uma linha) nao encontrada no index.html');
	return m[0];
}
const dateFns = new Function(
	grabFn('isoLocal') + '\n' + grabFn('weekRange') + '\n' + grabFn('last7Range') +
	'\nreturn { isoLocal, weekRange, last7Range };'
)();

test('isoLocal: formata no fuso local', () => {
	assert.equal(dateFns.isoLocal(new Date(2026, 6, 5)), '2026-07-05');
	assert.equal(dateFns.isoLocal(new Date(2026, 0, 1)), '2026-01-01');
});

test('weekRange: domingo a sabado da semana atual', () => {
	// 2026-07-15 e uma quarta-feira -> semana de 12/07 (dom) a 18/07 (sab)
	assert.deepEqual(dateFns.weekRange(new Date(2026, 6, 15)), ['2026-07-12', '2026-07-18']);
	// no proprio domingo, a semana comeca nele
	assert.deepEqual(dateFns.weekRange(new Date(2026, 6, 12)), ['2026-07-12', '2026-07-18']);
	// sabado e o ultimo dia da mesma semana
	assert.deepEqual(dateFns.weekRange(new Date(2026, 6, 18)), ['2026-07-12', '2026-07-18']);
	// virada de mes: 2026-08-01 e sabado -> semana 26/07 a 01/08
	assert.deepEqual(dateFns.weekRange(new Date(2026, 7, 1)), ['2026-07-26', '2026-08-01']);
	// virada de ano: 2026-01-01 e quinta -> semana 28/12/2025 a 03/01/2026
	assert.deepEqual(dateFns.weekRange(new Date(2026, 0, 1)), ['2025-12-28', '2026-01-03']);
});

test('last7Range: hoje-6 ate hoje, inclusive viradas de mes', () => {
	assert.deepEqual(dateFns.last7Range(new Date(2026, 6, 15)), ['2026-07-09', '2026-07-15']);
	assert.deepEqual(dateFns.last7Range(new Date(2026, 7, 3)), ['2026-07-28', '2026-08-03']);
	assert.deepEqual(dateFns.last7Range(new Date(2026, 0, 2)), ['2025-12-27', '2026-01-02']);
});
