// Testes unitarios (node --test). Zero dependencias: usa o runner nativo do Node 18+.
// Logica pura do servidor/sync e importada; as funcoes de data do frontend sao
// extraidas do proprio index.html (fonte real) e avaliadas aqui.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { parseModelName, sliceRange, costBreakdownOf, validateSyncConfig, fillRateGaps } = require('../server.js');
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
	// grafico principal fica limpo: sem nome de modelo dentro das barras
	assert.equal(r.datasets[0].barLabel, undefined);
});

test('buildChartData: varios dias e um modelo -> tipos de token por dia (byDayType)', () => {
	const r = buildChartData(twoDays(['a-x']), ['a-x'], 'tokens', fns);
	assert.equal(r.mode, 'byDayType');
	assert.equal(r.datasets.length, 4);
	assert.deepEqual(r.datasets.map((d) => d.data[0]), [100, 50, 10, 40]);
	// nenhuma barra leva texto dentro: nomes so nas pizzas, via chamadas externas
	assert.equal(r.datasets[0].barLabel, undefined);
});

test('buildChartData: modos de um dia usam barra larga', () => {
	const daily = [{ date: '2026-07-01', models: [mkModel('a-x'), mkModel('b-y')] }];
	const byModel = buildChartData(daily, ['a-x', 'b-y'], 'tokens', fns);
	assert.ok(byModel.datasets[0].maxBarThickness > 34, 'barra de dia unico deveria ser mais larga');
	const byType = buildChartData(daily, ['a-x'], 'tokens', fns);
	assert.ok(byType.datasets[0].maxBarThickness > 34);
});

// ---------------- tooltip diario das barras ----------------
const dayTooltipLines = new Function(
	grabBlock(/^function dayTooltipLines[\s\S]*?^\}/m, 'dayTooltipLines') + '\nreturn dayTooltipLines;'
)();
const tfmt = {
	num: (n) => 'N' + n, usd: (n) => 'U' + n.toFixed(2), brl: (n) => 'R' + n.toFixed(2),
	shortModel: (m) => m.replace(/^claude-/, '')
};

test('dayTooltipLines: um modelo ativo mostra nome + tokens + US$ + R$', () => {
	const day = { date: '2026-07-01', models: [mkModel('claude-a', { tokens: 100, cost: 2 }), mkModel('b', { tokens: 999, cost: 9 })] };
	const lines = dayTooltipLines(day, ['claude-a'], 5, tfmt);
	assert.deepEqual(lines, ['a', 'N100 tokens', 'U2.00', 'R10.00']);
});

test('dayTooltipLines: varios modelos ativos omitem o nome e somam o dia', () => {
	const day = { date: '2026-07-01', models: [mkModel('a', { tokens: 100, cost: 2 }), mkModel('b', { tokens: 50, cost: 1 })] };
	const lines = dayTooltipLines(day, ['a', 'b'], 2, tfmt);
	assert.deepEqual(lines, ['N150 tokens', 'U3.00', 'R6.00']);
});

test('dayTooltipLines: sem cambio omite a linha em reais', () => {
	const day = { date: '2026-07-01', models: [mkModel('a', { tokens: 10, cost: 1 })] };
	const lines = dayTooltipLines(day, ['a'], null, tfmt);
	assert.deepEqual(lines, ['a', 'N10 tokens', 'U1.00']);
});

// ---------------- buildAnalysis (tela de analise) ----------------
const buildAnalysis = new Function(
	grabBlock(/^function buildAnalysis[\s\S]*?^\}/m, 'buildAnalysis') + '\nreturn buildAnalysis;'
)();

test('buildAnalysis: agrega o periodo por modelo com custo por milhao e participacao', () => {
	const daily = [
		{ date: '2026-07-01', models: [mkModel('caro', { tokens: 1000000, cost: 10 }), mkModel('barato', { tokens: 4000000, cost: 1 })] },
		{ date: '2026-07-02', models: [mkModel('caro', { tokens: 1000000, cost: 10 })] }
	];
	const a = buildAnalysis(daily, ['caro', 'barato']);
	assert.equal(a.rows.length, 2);
	const caro = a.rows.find((r) => r.name === 'caro');
	assert.equal(caro.tokens, 2000000);
	assert.equal(caro.cost, 20);
	assert.equal(caro.costPerM, 10);      // 20 USD / 2M tokens
	assert.equal(caro.sharePct, 95.2);    // 20 de 21
	assert.equal(a.cheapest.name, 'barato');       // 0.5 USD/M
	assert.equal(a.biggestSpender.name, 'caro');
	assert.equal(a.biggestConsumer.name, 'barato');
});

test('buildAnalysis: modelo sem custo nao concorre a mais barato mas aparece no ranking', () => {
	const daily = [{ date: '2026-07-01', models: [mkModel('gratis', { tokens: 500, cost: 0 }), mkModel('pago', { tokens: 100, cost: 1 })] }];
	const a = buildAnalysis(daily, ['gratis', 'pago']);
	assert.equal(a.cheapest.name, 'pago');
	const gratis = a.rows.find((r) => r.name === 'gratis');
	assert.equal(gratis.costPerM, null);
});

test('buildAnalysis: respeita a lista de modelos e ordena por custo desc', () => {
	const daily = [{ date: '2026-07-01', models: [mkModel('a', { cost: 1 }), mkModel('b', { cost: 5 }), mkModel('fora', { cost: 99 })] }];
	const a = buildAnalysis(daily, ['a', 'b']);
	assert.deepEqual(a.rows.map((r) => r.name), ['b', 'a']);
});

test('buildAnalysis: vazio nao quebra', () => {
	const a = buildAnalysis([], []);
	assert.deepEqual(a.rows, []);
	assert.equal(a.cheapest, null);
});

// ---------------- fillRateGaps (cambio de fechamento) ----------------
test('fillRateGaps: fim de semana herda o fechamento anterior', () => {
	const out = fillRateGaps(['2026-07-03', '2026-07-04', '2026-07-05', '2026-07-06'],
		{ '2026-07-03': 5.1, '2026-07-06': 5.3 });
	assert.deepEqual(out, { '2026-07-03': 5.1, '2026-07-04': 5.1, '2026-07-05': 5.1, '2026-07-06': 5.3 });
});

test('fillRateGaps: data anterior ao primeiro fechamento conhecido fica sem valor', () => {
	const out = fillRateGaps(['2026-07-01', '2026-07-02'], { '2026-07-02': 5.2 });
	assert.deepEqual(out, { '2026-07-02': 5.2 });
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

// ---------------- pizzas do carrossel (extraidas do index.html) ----------------
const pieFns = new Function(
	grabBlock(/^const TOKEN_PARTS = \[[\s\S]*?\];/m, 'TOKEN_PARTS') + '\n' +
	grabBlock(/^function buildPieByModel[\s\S]*?^\}/m, 'buildPieByModel') + '\n' +
	grabBlock(/^function buildPieByType[\s\S]*?^\}/m, 'buildPieByType') +
	'\nreturn { buildPieByModel, buildPieByType };'
)();

test('buildPieByModel: soma o periodo por modelo e descarta zerados', () => {
	const daily = [
		{ date: '2026-07-01', models: [mkModel('a-x', { tokens: 100, cost: 0.01 }), mkModel('b-y', { tokens: 0, cost: 0 })] },
		{ date: '2026-07-02', models: [mkModel('a-x', { tokens: 50, cost: 0.02 })] }
	];
	const r = pieFns.buildPieByModel(daily, ['a-x', 'b-y'], 'tokens', fns);
	assert.deepEqual(r.labels, ['a-x']);
	assert.deepEqual(r.data, [150]);
	assert.deepEqual(r.models, ['a-x']); // nome completo preservado para o clique filtrar
});

test('buildPieByModel: metrica custo soma cost com arredondamento', () => {
	const daily = [
		{ date: '2026-07-01', models: [mkModel('a-x', { cost: 0.015 }), mkModel('b-y', { cost: 0.005 })] }
	];
	const r = pieFns.buildPieByModel(daily, ['a-x', 'b-y'], 'cost', fns);
	assert.deepEqual(r.data, [0.015, 0.005]);
});

test('buildPieByType: soma tipos so dos modelos ativos', () => {
	const daily = [
		{ date: '2026-07-01', models: [mkModel('a-x'), mkModel('b-y', { input: 999 })] },
		{ date: '2026-07-02', models: [mkModel('a-x')] }
	];
	const r = pieFns.buildPieByType(daily, ['a-x'], 'tokens');
	assert.deepEqual(r.labels, ['entrada', 'saída', 'cache write', 'cache read']);
	assert.deepEqual(r.data, [200, 100, 20, 80]); // 2 dias de a-x, b-y fora
	assert.equal(r.usedCost, false);
});

test('buildPieByType: metrica custo usa costBreakdown quando existe', () => {
	const daily = [{ date: '2026-07-01', models: [mkModel('a-x')] }];
	const r = pieFns.buildPieByType(daily, ['a-x'], 'cost');
	assert.equal(r.usedCost, true);
	assert.deepEqual(r.data, [0.01, 0.005, 0.001, 0.004]);
	assert.equal(r.costPartial, false);
});

test('buildPieByType: custo sem nenhum costBreakdown cai para tokens', () => {
	const daily = [{ date: '2026-07-01', models: [mkModel('a-x', { costBd: null })] }];
	const r = pieFns.buildPieByType(daily, ['a-x'], 'cost');
	assert.equal(r.usedCost, false);
	assert.deepEqual(r.data, [100, 50, 10, 40]);
});

test('buildPieByType: custo parcial (modelo com uso e sem preco) sinaliza costPartial', () => {
	const daily = [{ date: '2026-07-01', models: [mkModel('a-x'), mkModel('b-y', { costBd: null })] }];
	const r = pieFns.buildPieByType(daily, ['a-x', 'b-y'], 'cost');
	assert.equal(r.usedCost, true);
	assert.equal(r.costPartial, true);
	assert.deepEqual(r.data, [0.01, 0.005, 0.001, 0.004]); // so o a-x entra na soma
});

// ---------------- fitLabel (rotulo dentro da barra) ----------------
const fitLabel = new Function(grabBlock(/^function fitLabel[\s\S]*?^\}/m, 'fitLabel') + '\nreturn fitLabel;')();
const measure6 = (s) => s.length * 6; // medidor fake: 6px por caractere

test('fitLabel: texto que cabe volta inteiro', () => {
	assert.equal(fitLabel('sonnet-4-6', 100, measure6), 'sonnet-4-6');
});

test('fitLabel: texto longo e truncado com reticencias', () => {
	const r = fitLabel('sonnet-4-6-experimental', 60, measure6);
	assert.ok(r.endsWith('…'), 'esperava reticencias: ' + r);
	assert.ok(measure6(r) <= 60, 'truncado ainda nao cabe');
});

test('fitLabel: espaco minusculo demais retorna null', () => {
	assert.equal(fitLabel('sonnet', 10, measure6), null);
});

test('fitLabel: texto vazio retorna null', () => {
	assert.equal(fitLabel('', 100, measure6), null);
	assert.equal(fitLabel(null, 100, measure6), null);
});

// ---------------- callouts da pizza (percentual com linha de chamada) ----------------
const calloutFns = new Function(
	grabBlock(/^function calloutText[\s\S]*?^\}/m, 'calloutText') + '\n' +
	grabBlock(/^function calloutGeometry[\s\S]*?^\}/m, 'calloutGeometry') +
	'\nreturn { calloutText, calloutGeometry };'
)();

test('calloutText: devolve o nome da fatia (modelo/tipo)', () => {
	assert.equal(calloutFns.calloutText('sonnet-4-6', 50, 100), 'sonnet-4-6');
	assert.equal(calloutFns.calloutText('entrada', 1, 3), 'entrada');
});

test('calloutText: fatia minuscula, zero, total invalido ou sem nome nao ganham chamada', () => {
	assert.equal(calloutFns.calloutText('x', 1, 100), null); // < 2%: colidiria com vizinhos
	assert.equal(calloutFns.calloutText('x', 0, 100), null);
	assert.equal(calloutFns.calloutText('x', 10, 0), null);
	assert.equal(calloutFns.calloutText('', 50, 100), null);
});

test('calloutGeometry: fatia a direita ancora a esquerda do texto, e vice-versa', () => {
	const r = calloutFns.calloutGeometry(100, 100, 50, 0); // angulo 0 = direita
	assert.equal(r.align, 'left');
	assert.ok(r.x3 > r.x2 && r.x2 > r.x1, 'linha deve sair para fora, para a direita');
	const l = calloutFns.calloutGeometry(100, 100, 50, Math.PI); // esquerda
	assert.equal(l.align, 'right');
	assert.ok(l.x3 < l.x2 && l.x2 < l.x1, 'linha deve sair para fora, para a esquerda');
});

test('calloutGeometry: comeca na borda da fatia', () => {
	const g = calloutFns.calloutGeometry(100, 100, 50, 0);
	assert.equal(Math.round(g.x1), 150); // centro + raio no angulo 0
	assert.equal(Math.round(g.y1), 100);
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
