// Testes unitarios (node --test). Zero dependencias: usa o runner nativo do Node 18+.
// Logica pura do servidor/sync e importada; as funcoes de data do frontend sao
// extraidas do proprio index.html (fonte real) e avaliadas aqui.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { parseModelName, sliceRange, costBreakdownOf, validateSyncConfig } = require('../server.js');
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

test('todayRange: hoje ate hoje', () => {
	const fns = new Function(grabFn('isoLocal') + '\n' + grabFn('todayRange') + '\nreturn { todayRange };')();
	assert.deepEqual(fns.todayRange(new Date(2026, 6, 15)), ['2026-07-15', '2026-07-15']);
});

// ---------------- buildChartData (extraida do index.html) ----------------
function grabBlock(re, what) {
	const m = html.match(re);
	assert.ok(m, what + ' nao encontrado no index.html');
	return m[0];
}
const buildChartData = new Function(
	grabBlock(/^const TOKEN_PARTS = \[[\s\S]*?\];/m, 'TOKEN_PARTS') + '\n' +
	grabBlock(/^function buildChartData[\s\S]*?^\}/m, 'buildChartData') +
	'\nreturn buildChartData;'
)();

const fns = { shortModel: (m) => m.replace(/^claude-/, ''), colorOf: () => '#111', dayLabel: (d) => d.date };
const mkModel = (name, over) => Object.assign({
	name, input: 100, output: 50, cacheW: 10, cacheR: 40, tokens: 200, cost: 0.02,
	costBd: { input: 0.01, output: 0.005, cacheW: 0.001, cacheR: 0.004 }
}, over);
const twoDays = (models) => [
	{ date: '2026-07-01', models: models.map((m) => mkModel(m)) },
	{ date: '2026-07-02', models: models.map((m) => mkModel(m)) }
];

test('buildChartData: varios dias e varios modelos -> um dataset por modelo (byDay)', () => {
	const r = buildChartData(twoDays(['a-x', 'b-y']), ['a-x', 'b-y'], 'tokens', fns);
	assert.equal(r.mode, 'byDay');
	assert.deepEqual(r.labels, ['2026-07-01', '2026-07-02']);
	assert.equal(r.datasets.length, 2);
	assert.deepEqual(r.datasets[0].data, [200, 200]);
});

test('buildChartData: varios dias e um modelo -> tipos de token por dia (byDayType)', () => {
	const r = buildChartData(twoDays(['a-x']), ['a-x'], 'tokens', fns);
	assert.equal(r.mode, 'byDayType');
	assert.equal(r.datasets.length, 4);
	assert.deepEqual(r.datasets.map((d) => d.data[0]), [100, 50, 10, 40]);
});

test('buildChartData: um dia e varios modelos -> eixo X por modelo (byModel)', () => {
	const daily = [{ date: '2026-07-01', models: [mkModel('claude-a', { tokens: 300 }), mkModel('b')] }];
	const r = buildChartData(daily, ['claude-a', 'b'], 'tokens', fns);
	assert.equal(r.mode, 'byModel');
	assert.deepEqual(r.labels, ['a', 'b']);
	assert.equal(r.datasets.length, 1);
	assert.deepEqual(r.datasets[0].data, [300, 200]);
});

test('buildChartData: um dia e um modelo -> eixo X por tipo de token (byType)', () => {
	const daily = [{ date: '2026-07-01', models: [mkModel('a-x')] }];
	const r = buildChartData(daily, ['a-x'], 'tokens', fns);
	assert.equal(r.mode, 'byType');
	assert.deepEqual(r.labels, ['entrada', 'saída', 'cache write', 'cache read']);
	assert.deepEqual(r.datasets[0].data, [100, 50, 10, 40]);
});

test('buildChartData: um dia, um modelo, metrica custo -> usa costBreakdown', () => {
	const daily = [{ date: '2026-07-01', models: [mkModel('a-x')] }];
	const r = buildChartData(daily, ['a-x'], 'cost', fns);
	assert.equal(r.mode, 'byType');
	assert.deepEqual(r.datasets[0].data, [0.01, 0.005, 0.001, 0.004]);
});

test('buildChartData: custo sem costBreakdown cai para barra unica do modelo (byModel)', () => {
	const daily = [{ date: '2026-07-01', models: [mkModel('a-x', { costBd: null })] }];
	const r = buildChartData(daily, ['a-x'], 'cost', fns);
	assert.equal(r.mode, 'byModel');
	assert.deepEqual(r.datasets[0].data, [0.02]);
});

test('buildChartData: sem dias -> byDay vazio, sem quebrar', () => {
	const r = buildChartData([], ['a-x'], 'tokens', fns);
	assert.equal(r.labels.length, 0);
});

// ---------------- validateSyncConfig ----------------
test('validateSyncConfig: config valida e normalizada', () => {
	const v = validateSyncConfig({
		enabled: true, intervalMinutes: '15', user: 'off',
		targets: [
			{ type: 'file', dir: 'C:/lake', layers: ['table', 'delta', 'nope'] },
			{ type: 'azureBlob', sasUrl: 'https://c.blob.core.windows.net/x?sv=1', prefix: 'bronze/' },
			{ type: 'webhook', url: 'https://api/ingest', headers: { 'x-k': '1' } }
		]
	});
	assert.equal(v.ok, true);
	assert.equal(v.config.enabled, true);
	assert.equal(v.config.intervalMinutes, 15);
	assert.equal(v.config.user, 'off');
	assert.equal(v.config.machine, 'auto');
	assert.deepEqual(v.config.targets[0].layers, ['table', 'delta']);
	assert.equal(v.config.targets[1].prefix, 'bronze/');
	assert.deepEqual(v.config.targets[2].headers, { 'x-k': '1' });
});

test('validateSyncConfig: tipo desconhecido e campo obrigatorio faltando', () => {
	const v = validateSyncConfig({ enabled: true, targets: [{ type: 'ftp', dir: 'x' }, { type: 'azureBlob' }] });
	assert.equal(v.ok, false);
	assert.equal(v.errors.length, 3); // tipo desconhecido + sasUrl faltando + nenhum destino valido com sync habilitado
});

test('validateSyncConfig: habilitado sem destino e erro; desabilitado sem destino e ok', () => {
	assert.equal(validateSyncConfig({ enabled: true, targets: [] }).ok, false);
	assert.equal(validateSyncConfig({ enabled: false, targets: [] }).ok, true);
});

test('validateSyncConfig: intervalo minimo 1 e default 30', () => {
	assert.equal(validateSyncConfig({ targets: [] }).config.intervalMinutes, 30);
	assert.equal(validateSyncConfig({ intervalMinutes: -5, targets: [] }).config.intervalMinutes, 1);
});
