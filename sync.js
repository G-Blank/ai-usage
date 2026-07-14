// Modulo de sincronizacao (opcional e desacoplado do painel). Zero dependencias.
//
// Persistencia: mantem um historico local (usage-history.json) com merge upsert
// por data+agente+modelo. Dias que sairem da janela de retencao do ccusage
// permanecem no historico -> os dados exportados ficam consistentes no tempo.
//
// Envio incremental: hash por mes; so os meses alterados sao reenviados.
// A camada "delta" carrega apenas as linhas novas/alteradas de cada sync.
//
// Camadas (config.sync.targets[].layers):
//   "raw"   -> JSON bruto do ccusage da rodada atual, intocado
//   "table" -> JSONL do historico consolidado, um arquivo por mes (so os alterados)
//   "delta" -> JSONL append-only com as linhas novas/alteradas deste sync
//
// Adaptadores: "file", "azureBlob" (SAS URL, fetch puro), "webhook" (POST JSON).
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

function withTimeout(promise, ms) {
	return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout ' + ms + 'ms')), ms))]);
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const rowKey = (r) => r.date + '|' + r.agent + '|' + r.model;
const stableRow = ({ exported_at, ...r }) => JSON.stringify(r);

// ---------------- linhas a partir do ccusage ----------------
function toRows(data, meta, exportedAt) {
	const rows = [];
	(data.daily || []).forEach((d) => {
		const date = d.period || d.date;
		(d.modelBreakdowns || []).forEach((m) => {
			rows.push({
				date,
				machine: meta.machine,
				user: meta.user,
				agent: meta.agent,
				model: m.modelName,
				tag: m.tag || null,
				base_model: m.baseModel || m.modelName,
				input_tokens: m.inputTokens || 0,
				output_tokens: m.outputTokens || 0,
				cache_creation_tokens: m.cacheCreationTokens || 0,
				cache_read_tokens: m.cacheReadTokens || 0,
				total_tokens: (m.totalTokens != null)
					? m.totalTokens
					: (m.inputTokens || 0) + (m.outputTokens || 0) + (m.cacheCreationTokens || 0) + (m.cacheReadTokens || 0),
				cost_usd: +(m.cost || 0).toFixed(6),
				exported_at: exportedAt
			});
		});
	});
	return rows;
}

// ---------------- historico persistente ----------------
// Merge upsert: linhas que sumiram do ccusage sao mantidas; se a linha nova
// vier com menos tokens que a guardada (purge parcial de log), mantem a maior.
function mergeHistory(history, incoming) {
	const delta = [];
	for (const row of incoming) {
		const k = rowKey(row);
		const old = history[k];
		if (!old) {
			history[k] = row;
			delta.push(row);
		} else if (stableRow(old) !== stableRow(row)) {
			if (row.total_tokens >= old.total_tokens) {
				history[k] = row;
				delta.push(row);
			}
			// senao: regressao (log purgado no meio do dia) -> preserva o historico
		}
	}
	return delta;
}

function monthsOf(history) {
	const byMonth = {};
	for (const k of Object.keys(history)) {
		const r = history[k];
		const month = String(r.date).slice(0, 7);
		(byMonth[month] = byMonth[month] || []).push(r);
	}
	for (const m of Object.keys(byMonth)) {
		byMonth[m].sort((a, b) => (rowKey(a) < rowKey(b) ? -1 : 1));
	}
	return byMonth;
}

const toJsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');

// ---------------- adaptadores ----------------
// artifacts: [{ name, body, contentType, layer }]
const adapters = {
	async file(target, artifacts) {
		if (!target.dir) throw new Error('target file: "dir" obrigatorio');
		fs.mkdirSync(target.dir, { recursive: true });
		for (const a of artifacts) {
			const full = path.join(target.dir, a.name);
			fs.mkdirSync(path.dirname(full), { recursive: true });
			fs.writeFileSync(full, a.body);
		}
		return 'gravado ' + artifacts.map((a) => a.name).join(', ');
	},

	async azureBlob(target, artifacts) {
		if (!target.sasUrl) throw new Error('target azureBlob: "sasUrl" obrigatorio');
		const u = new URL(target.sasUrl);
		for (const a of artifacts) {
			const blobUrl = u.origin + u.pathname.replace(/\/$/, '') + '/' + a.name + u.search;
			const res = await withTimeout(fetch(blobUrl, {
				method: 'PUT',
				headers: { 'x-ms-blob-type': 'BlockBlob', 'x-ms-version': '2021-08-06', 'Content-Type': a.contentType },
				body: a.body,
				signal: AbortSignal.timeout(20000)
			}), 22000);
			if (!res.ok) {
				const body = await res.text().catch(() => '');
				throw new Error('azureBlob [' + a.name + '] HTTP ' + res.status + ': ' + body.slice(0, 300));
			}
		}
		return 'enviado ' + artifacts.map((a) => a.name).join(', ');
	},

	async webhook(target, artifacts, ctx) {
		if (!target.url) throw new Error('target webhook: "url" obrigatorio');
		const layers = artifacts.map((a) => a.layer);
		const payload = { meta: Object.assign({}, ctx.meta, { layers: [...new Set(layers)], deltaCount: ctx.delta.length }) };
		if (layers.includes('delta')) payload.delta = ctx.delta;
		if (layers.includes('table')) payload.months = ctx.changedMonths.map((m) => ({ month: m, rows: ctx.byMonth[m] }));
		if (layers.includes('raw')) payload.raw = ctx.rawData;
		const res = await withTimeout(fetch(target.url, {
			method: 'POST',
			headers: Object.assign({ 'Content-Type': 'application/json' }, target.headers || {}),
			body: JSON.stringify(payload),
			signal: AbortSignal.timeout(20000)
		}), 22000);
		if (!res.ok) {
			const body = await res.text().catch(() => '');
			throw new Error('webhook HTTP ' + res.status + ': ' + body.slice(0, 300));
		}
		return 'POST ok [' + [...new Set(layers)].join(', ') + ']';
	}
};

function layersOf(target, defaults) {
	const ls = Array.isArray(target.layers) && target.layers.length ? target.layers : defaults;
	return ls.filter((l) => l === 'raw' || l === 'table' || l === 'delta');
}

// identidade configuravel: "auto" (padrao) usa o valor da maquina;
// "off" envia vazio (privacidade); qualquer outro texto e usado literalmente.
function resolveIdentity(setting, autoFn) {
	if (setting === undefined || setting === null || setting === 'auto') return autoFn();
	if (setting === 'off' || setting === false) return '';
	return String(setting);
}

// ---------------- orquestracao ----------------
function createSync({ config, configDir, getUsage, log }) {
	const cfg = config.sync || {};
	const statePath = path.join(configDir, 'sync-state.json');
	const historyPath = path.join(configDir, 'usage-history.json');
	const logger = log || console;

	const loadJson = (p, fallback) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return fallback; } };
	const saveJson = (p, o) => { try { fs.writeFileSync(p, JSON.stringify(o)); } catch (e) { logger.warn('[sync] falha ao salvar ' + path.basename(p) + ':', e.message); } };

	let running = false;
	let status = Object.assign({ enabled: !!cfg.enabled, lastRun: null, monthHashes: {}, results: [] }, loadJson(statePath, {}));
	status.enabled = !!cfg.enabled;

	async function run(force) {
		if (!cfg.enabled || running) return status;
		running = true;
		try {
			// janela ampla: pega tudo que o ccusage ainda tem nos logs
			const data = await getUsage('', '');
			const exportedAt = new Date().toISOString();
			const meta = {
				machine: resolveIdentity(cfg.machine, () => os.hostname()),
				user: resolveIdentity(cfg.user, () => (os.userInfo && os.userInfo().username) || ''),
				agent: config.agent || 'all',
				exportedAt
			};

			const history = loadJson(historyPath, {});
			const incoming = toRows(data, meta, exportedAt);
			const delta = mergeHistory(history, incoming);
			saveJson(historyPath, history);

			const byMonth = monthsOf(history);
			const monthHashes = {};
			for (const m of Object.keys(byMonth)) monthHashes[m] = sha(byMonth[m].map(stableRow).join('\n'));
			const prev = status.monthHashes || {};
			const changedMonths = Object.keys(byMonth).filter((m) => force || monthHashes[m] !== prev[m]).sort();

			if (!force && !changedMonths.length && !delta.length) {
				status.lastRun = new Date().toISOString();
				status.skipped = true;
				saveJson(statePath, status);
				return status;
			}

			const stamp = exportedAt.replace(/[-:]/g, '').replace('.', '').replace('Z', '') + '_' + sha(exportedAt + Math.random()).slice(0, 6);
			const ctx = { meta, delta, byMonth, changedMonths, rawData: data };
			const results = [];
			for (const target of (cfg.targets || [])) {
				const fn = adapters[target.type];
				if (!fn) { results.push({ type: target.type, ok: false, detail: 'tipo desconhecido: ' + target.type }); continue; }
				const layers = layersOf(target, target.type === 'webhook' ? ['delta'] : ['raw', 'table', 'delta']);
				const prefix = target.prefix || '';
				const artifacts = [];
				if (layers.includes('table')) {
					for (const m of changedMonths) {
						artifacts.push({ layer: 'table', contentType: 'application/x-ndjson',
							name: prefix + 'table/ccusage_table_' + meta.machine + '_' + m + '.jsonl', body: toJsonl(byMonth[m]) });
					}
				}
				if (layers.includes('delta') && delta.length) {
					artifacts.push({ layer: 'delta', contentType: 'application/x-ndjson',
						name: prefix + 'delta/ccusage_delta_' + meta.machine + '_' + stamp + '.jsonl', body: toJsonl(delta) });
				}
				if (layers.includes('raw')) {
					artifacts.push({ layer: 'raw', contentType: 'application/json',
						name: prefix + 'raw/ccusage_raw_' + meta.machine + '_' + stamp + '.json', body: JSON.stringify(data) });
				}
				if (!artifacts.length) { results.push({ type: target.type, ok: true, detail: 'nada novo para este destino' }); continue; }
				try {
					const detail = await fn(target, artifacts, ctx);
					results.push({ type: target.type, ok: true, detail });
				} catch (e) {
					results.push({ type: target.type, ok: false, detail: e.message });
					logger.warn('[sync] ' + target.type + ':', e.message);
				}
			}

			// so consolida os hashes se todos os destinos aceitaram (senao, retenta no proximo)
			const allOk = results.every((r) => r.ok);
			status = {
				enabled: true,
				lastRun: new Date().toISOString(),
				monthHashes: allOk ? monthHashes : prev,
				historyRows: Object.keys(history).length,
				deltaCount: delta.length,
				changedMonths,
				skipped: false,
				results
			};
			saveJson(statePath, status);
			logger.log('[sync] concluido: ' + results.map((r) => r.type + (r.ok ? ' ok' : ' ERRO')).join(', ') +
				' | delta: ' + delta.length + ' linha(s), meses alterados: ' + (changedMonths.join(', ') || 'nenhum'));
			return status;
		} finally {
			running = false;
		}
	}

	function start() {
		if (!cfg.enabled) return;
		const minutes = Math.max(1, cfg.intervalMinutes || 30);
		const firstDelay = Math.max(0, cfg.initialDelaySeconds != null ? cfg.initialDelaySeconds : 10) * 1000;
		setTimeout(() => run(false).catch((e) => logger.warn('[sync] erro:', e.message)), firstDelay);
		setInterval(() => run(false).catch((e) => logger.warn('[sync] erro:', e.message)), minutes * 60 * 1000);
		logger.log('[sync] ativo: a cada ' + minutes + ' min, destinos: ' + (cfg.targets || []).map((t) => t.type).join(', '));
	}

	return { run, start, getStatus: () => status };
}

module.exports = { createSync, adapters, mergeHistory, toRows };
