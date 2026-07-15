// ccusage dashboard - servidor zero-dependencia (Node.js 18+) e reutilizavel pelo Electron.
// Configs: config.json (painel) e ccusage.json (pricing overrides), lidos de CCDASH_DIR ou da pasta do projeto.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = __dirname;
const CONFIG_DIR = process.env.CCDASH_DIR || ROOT;

function readJson(p) {
	return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
}

function loadConfig() {
	const defaults = { port: 8384, refreshSeconds: 60, agent: 'all', offline: false };
	let cfg = defaults;
	try {
		cfg = Object.assign(defaults, readJson(path.join(CONFIG_DIR, 'config.json')));
	} catch (e) {
		console.warn('[dashboard] config.json ausente ou invalido, usando padroes.', e.message);
	}
	// config.local.json (opcional, fora do git): sobrepoe o config.json.
	// Ideal para segredos (SAS token, headers de webhook) e ajustes por maquina.
	try {
		cfg = Object.assign(cfg, readJson(path.join(CONFIG_DIR, 'config.local.json')));
	} catch (_) {}
	return cfg;
}

const CONFIG = loadConfig();

// ---------------- ccusage ----------------
// Preferencia: CLI do ccusage instalado como dependencia local (funciona dentro do
// Electron sem Node no sistema). Fallback: npx (baixa sozinho na primeira vez).
function resolveCcusageCli() {
	try {
		const pkgPath = require.resolve('ccusage/package.json', { paths: [ROOT] });
		const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
		let bin = pkg.bin;
		if (bin && typeof bin === 'object') bin = bin.ccusage || Object.values(bin)[0];
		if (!bin) return null;
		// Dentro de um pacote Electron (asar), binarios precisam estar em asar.unpacked
		return path.join(path.dirname(pkgPath), bin).replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
	} catch (e) {
		return null;
	}
}

function buildArgs(since, until) {
	const agent = (CONFIG.agent || 'all').toLowerCase();
	const args = [];
	if (agent !== 'all') args.push(agent);
	args.push('daily', '--json', '--breakdown', '--config', path.join(CONFIG_DIR, 'ccusage.json'));
	if (CONFIG.offline) args.push('--offline');
	if (since) args.push('--since', since);
	if (until) args.push('--until', until);
	return args;
}

function collect(child, resolve, reject) {
	let out = '';
	let err = '';
	child.stdout.on('data', (d) => (out += d));
	child.stderr.on('data', (d) => (err += d));
	child.on('error', (e) => reject(new Error('Falha ao executar o ccusage: ' + e.message)));
	child.on('close', (code) => {
		const start = out.indexOf('{');
		if (start === -1) return reject(new Error('ccusage nao retornou JSON (code ' + code + '). stderr: ' + err.slice(0, 500)));
		try {
			resolve(JSON.parse(out.slice(start)));
		} catch (e) {
			reject(new Error('JSON invalido do ccusage: ' + e.message));
		}
	});
}

function runCcusage(since, until) {
	return new Promise((resolve, reject) => {
		// Modo mock para testes: CCUSAGE_MOCK=caminho/para/usage.json
		if (process.env.CCUSAGE_MOCK) {
			try {
				const txt = fs.readFileSync(process.env.CCUSAGE_MOCK, 'utf8').replace(/^\uFEFF/, '');
				return resolve(JSON.parse(txt));
			} catch (e) {
				return reject(new Error('Falha ao ler mock: ' + e.message));
			}
		}

		const args = buildArgs(since, until);
		const cli = resolveCcusageCli();

		if (cli) {
			// spawn sem shell: array de args lida com espacos/acentos nativamente.
			// No Electron, process.execPath e o proprio app; ELECTRON_RUN_AS_NODE o faz agir como Node.
			const env = Object.assign({}, process.env);
			if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
			const child = spawn(process.execPath, [cli, ...args], { env });
			return collect(child, resolve, reject);
		}

		// Fallback: npx com shell. Aspas em cada argumento para sobreviver a
		// caminhos com espaco (ex.: "OneDrive - Empresa").
		const isWin = process.platform === 'win32';
		const quote = (a) => (/[\s"]/.test(a) ? '"' + a.replace(/"/g, isWin ? '""' : '\\"') + '"' : a);
		const cmdLine = 'npx ' + ['-y', 'ccusage@latest', ...args].map(quote).join(' ');
		const child = spawn(cmdLine, { shell: true });
		collect(child, resolve, reject);
	});
}


// ---------------- tags e mapeamento automatico ----------------
// Um nome como "tax-claude-sonnet-4-6-2" vira: tag "tax", modelo base "claude-sonnet-4-6".
// A tag e a divisao de projetos; o modelo base serve para resolver preco automaticamente.
const FAMILIES = ['claude', 'gpt', 'grok', 'deepseek', 'kimi', 'gemini', 'qwen', 'glm', 'llama', 'mistral', 'sonnet', 'opus', 'haiku', 'codex', 'o1', 'o3', 'o4', 'minimax'];

function parseModelName(name) {
	let tag = null;
	let base = name;
	const lower = name.toLowerCase();
	const startsWithFamily = FAMILIES.some((f) => lower.startsWith(f));
	if (!startsWithFamily) {
		const i = name.indexOf('-');
		if (i > 0) {
			const rest = name.slice(i + 1);
			if (FAMILIES.some((f) => rest.toLowerCase().startsWith(f))) {
				tag = name.slice(0, i);
				base = rest;
			}
		}
	}
	// sufixo de instancia: "-N" (um digito) no final, quando ja ha uma versao (d-d ou d.d) antes.
	// Ex.: claude-sonnet-4-6-2 -> claude-sonnet-4-6 | gpt-5.5-2 -> gpt-5.5
	// Nao afeta versoes puras como claude-haiku-4-5 nem datas como -20251001.
	const m = base.match(/^(.*\d[-.]\d.*)-(\d)$/);
	if (m) base = m[1];
	return { tag, base };
}

function enrichUsage(data) {
	if (!data || !Array.isArray(data.daily)) return;
	data.daily.forEach((d) => (d.modelBreakdowns || []).forEach((mb) => {
		const p = parseModelName(mb.modelName || '');
		mb.tag = p.tag;
		mb.baseModel = p.base;
	}));
}

// Tabela de precos publica do LiteLLM (a mesma fonte do ccusage), com cache local de 7 dias.
const LITELLM_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const LITELLM_CACHE = path.join(CONFIG_DIR, 'litellm-prices.json');

async function loadLitellm() {
	try {
		const st = fs.statSync(LITELLM_CACHE);
		if (Date.now() - st.mtimeMs < 7 * 24 * 3600 * 1000) {
			return JSON.parse(fs.readFileSync(LITELLM_CACHE, 'utf8'));
		}
	} catch (_) {}
	try {
		const res = await withTimeout(fetch(LITELLM_URL, { signal: AbortSignal.timeout(15000) }), 16000);
		const json = await withTimeout(res.json(), 10000);
		fs.writeFileSync(LITELLM_CACHE, JSON.stringify(json));
		return json;
	} catch (e) {
		console.warn('[dashboard] tabela LiteLLM indisponivel:', e.message);
		try { return JSON.parse(fs.readFileSync(LITELLM_CACHE, 'utf8')); } catch (_) { return null; }
	}
}

function litellmLookup(prices, name) {
	if (!prices || !name) return null;
	if (prices[name]) return prices[name];
	const lower = name.toLowerCase();
	for (const k of Object.keys(prices)) {
		const kl = k.toLowerCase();
		if (kl === lower || kl.endsWith('/' + lower)) return prices[k];
	}
	return null;
}

let LAST_AUTOMAP = [];
let automapRunning = false;

// Para cada modelo dos logs sem preco conhecido, tenta resolver pelo modelo base
// e grava o override no ccusage.json (sem sobrescrever o que o usuario ja definiu).
async function autoMapPricing(data) {
	if (CONFIG.autoPricing === false || automapRunning) return;
	automapRunning = true;
	try {
		const cfgPath = path.join(CONFIG_DIR, 'ccusage.json');
		let cfg = {};
		try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8').replace(/^\uFEFF/, '')); } catch (_) {}
		cfg.defaults = cfg.defaults || {};
		const ov = (cfg.defaults.pricingOverrides = cfg.defaults.pricingOverrides || {});

		const names = new Set();
		(data.daily || []).forEach((d) => (d.modelBreakdowns || []).forEach((mb) => names.add(mb.modelName)));
		const candidates = [...names].filter((n) => n && !ov[n]);
		if (!candidates.length) return;

		const prices = await loadLitellm();
		if (!prices) return;

		const added = [];
		for (const n of candidates) {
			if (litellmLookup(prices, n)) continue; // ccusage ja resolve esse sozinho
			const { base } = parseModelName(n);
			if (!base || base === n) continue;
			const e = litellmLookup(prices, base);
			if (!e) continue;
			const o = {};
			if (e.input_cost_per_token) o.inputCostPerToken = e.input_cost_per_token;
			if (e.output_cost_per_token) o.outputCostPerToken = e.output_cost_per_token;
			if (e.cache_creation_input_token_cost) o.cacheCreationInputTokenCost = e.cache_creation_input_token_cost;
			if (e.cache_read_input_token_cost) o.cacheReadInputTokenCost = e.cache_read_input_token_cost;
			if (Object.keys(o).length) {
				ov[n] = o;
				added.push(n + ' -> ' + base);
			}
		}
		if (added.length) {
			cfg.$schema = cfg.$schema || 'https://ccusage.com/config-schema.json';
			fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, '\t'));
			// precos mudaram: invalida o cache e recalcula em segundo plano
			usageCache = {};
			saveUsageCache();
			refreshUsage(CONFIG.agent);
			LAST_AUTOMAP = added;
			console.log('[dashboard] precos automapeados: ' + added.join(', '));
		}
	} finally {
		automapRunning = false;
	}
}

// ---------------- cache de uso (historico completo, persistente) ----------------
// O ccusage le TODO o historico de logs a cada execucao (o recorte de datas so
// filtra a saida, nao reduz a leitura), entao trocar o periodo no painel dispararia
// sempre uma execucao cara (~varios segundos). Estrategia: guardamos o historico ja
// agregado em disco e servimos qualquer periodo filtrando na memoria (instantaneo).
// Dias passados nunca mudam; so o dia atual precisa de dados novos, e isso e feito em
// segundo plano (stale-while-revalidate) para o clique em "aplicar" nunca travar.
const USAGE_TTL_MS = Math.max(20, CONFIG.refreshSeconds - 5) * 1000;
const USAGE_CACHE_FILE = path.join(CONFIG_DIR, 'usage-cache.json');
const refreshingAgents = new Set();

let usageCache = {};
try { usageCache = readJson(USAGE_CACHE_FILE); } catch (_) { usageCache = {}; }

function saveUsageCache() {
	try { fs.writeFileSync(USAGE_CACHE_FILE, JSON.stringify(usageCache)); }
	catch (e) { console.warn('[dashboard] falha ao gravar cache de uso:', e.message); }
}

function localToday() {
	const d = new Date();
	return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// Filtra o historico completo para o periodo pedido, sem tocar no ccusage.
function sliceRange(data, since, until) {
	const daily = (data && Array.isArray(data.daily)) ? data.daily : [];
	if (!since && !until) return Object.assign({}, data, { daily });
	const toIso = (s) => (s && s.length === 8 ? s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8) : s);
	const lo = toIso(since) || '0000-00-00';
	const hi = toIso(until) || '9999-99-99';
	const filtered = daily.filter((d) => {
		const day = d.period || d.date || '';
		return day >= lo && day <= hi;
	});
	return Object.assign({}, data, { daily: filtered });
}

// Roda o ccusage para TODO o historico e atualiza o cache (usado no boot e no
// refresh em segundo plano). Nunca roda duas vezes ao mesmo tempo por agente.
async function refreshUsage(agent) {
	if (refreshingAgents.has(agent)) return;
	refreshingAgents.add(agent);
	try {
		const data = await runCcusage('', '');
		enrichUsage(data);
		autoMapPricing(data).catch((e) => console.warn('[dashboard] automap falhou:', e.message));
		usageCache[agent] = { at: Date.now(), asOf: localToday(), data };
		saveUsageCache();
	} catch (e) {
		console.warn('[dashboard] refresh do cache de uso falhou:', e.message);
	} finally {
		refreshingAgents.delete(agent);
	}
}

async function getUsage(since, until) {
	const agent = CONFIG.agent;
	const entry = usageCache[agent];

	// Cold start (nenhum cache ainda): busca uma vez, de forma bloqueante.
	if (!entry || !entry.data) {
		await refreshUsage(agent);
		const e = usageCache[agent];
		return sliceRange(e && e.data ? e.data : { daily: [] }, since, until);
	}

	// Ja ha cache: serve na hora. Revalida em segundo plano se o dia virou
	// (os dados de ontem viraram finais) ou se passou o TTL de atualizacao.
	const stale = entry.asOf !== localToday() || (Date.now() - entry.at) >= USAGE_TTL_MS;
	if (stale) refreshUsage(agent); // sem await: stale-while-revalidate

	return sliceRange(entry.data, since, until);
}

// ---------------- cotacao USD-BRL ----------------
let rateCache = { at: 0, rate: null, source: null };
const RATE_TTL_MS = 30 * 60 * 1000;

function withTimeout(promise, ms) {
	return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout ' + ms + 'ms')), ms))]);
}

async function getRate() {
	if (rateCache.rate && Date.now() - rateCache.at < RATE_TTL_MS) return rateCache;
	try {
		const res = await withTimeout(
			fetch('https://economia.awesomeapi.com.br/json/last/USD-BRL', { signal: AbortSignal.timeout(4000) }),
			5000
		);
		const json = await withTimeout(res.json(), 3000);
		const bid = parseFloat(json && json.USDBRL && json.USDBRL.bid);
		if (Number.isFinite(bid) && bid > 0) {
			rateCache = { at: Date.now(), rate: bid, source: 'AwesomeAPI (economia.awesomeapi.com.br)' };
			return rateCache;
		}
		throw new Error('resposta sem bid valido');
	} catch (e) {
		console.warn('[dashboard] cotacao indisponivel:', e.message);
		return rateCache;
	}
}

// ---------------- HTTP ----------------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function sendJson(res, status, obj) {
	res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
	res.end(JSON.stringify(obj));
}

// ---------------- sync (opcional, desacoplado) ----------------
let SYNC = null;
if (CONFIG.sync && CONFIG.sync.enabled) {
	try {
		SYNC = require('./sync.js').createSync({ config: CONFIG, configDir: CONFIG_DIR, getUsage, log: console });
	} catch (e) {
		console.warn('[dashboard] sync desativado (falha ao carregar):', e.message);
	}
}

function createServer() {
	return http.createServer(async (req, res) => {
		const url = new URL(req.url, 'http://localhost');
		try {
			if (url.pathname === '/api/usage') {
				const since = (url.searchParams.get('since') || '').replace(/\D/g, '');
				const until = (url.searchParams.get('until') || '').replace(/\D/g, '');
				const data = await getUsage(since, until);
				return sendJson(res, 200, { ok: true, agent: CONFIG.agent, refreshSeconds: CONFIG.refreshSeconds, autoMapped: LAST_AUTOMAP, data });
			}
			if (url.pathname === '/api/sync/status') {
				return sendJson(res, 200, { ok: true, status: SYNC ? SYNC.getStatus() : { enabled: false } });
			}
			if (url.pathname === '/api/sync/run' && req.method === 'POST') {
				if (!SYNC) return sendJson(res, 400, { ok: false, error: 'sync desativado no config.json' });
				const status = await SYNC.run(true);
				return sendJson(res, 200, { ok: true, status });
			}
			if (url.pathname === '/api/rate') {
				const r = await getRate();
				return sendJson(res, 200, { ok: true, rate: r.rate, source: r.source, fetchedAt: r.at || null });
			}
			let file = url.pathname === '/' ? '/index.html' : url.pathname;
			file = path.normalize(file).replace(/^([.][.][/\\])+/, '');
			const pubDir = path.join(ROOT, 'public');
			const full = path.join(pubDir, file);
			// exige o separador apos a base: um irmao "public-x" nao pode passar como "public"
			if (full !== pubDir && !full.startsWith(pubDir + path.sep)) {
				res.writeHead(403);
				return res.end('Forbidden');
			}
			fs.readFile(full, (err, buf) => {
				if (err) {
					res.writeHead(404);
					return res.end('Not found');
				}
				res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
				res.end(buf);
			});
		} catch (e) {
			console.error('[dashboard]', e);
			sendJson(res, 500, { ok: false, error: e.message });
		}
	});
}

function writePidFile() {
	const pidPath = path.join(CONFIG_DIR, 'server.pid');
	try {
		fs.writeFileSync(pidPath, String(process.pid));
		const clean = () => { try { fs.unlinkSync(pidPath); } catch (_) {} };
		process.on('exit', clean);
		process.on('SIGINT', () => { clean(); process.exit(0); });
		process.on('SIGTERM', () => { clean(); process.exit(0); });
	} catch (_) {}
}

const HEADLESS = CONFIG.headless === true || process.argv.includes('--headless');

function startServer() {
	writePidFile();

	if (HEADLESS) {
		return new Promise((resolve) => {
			if (!SYNC) {
				console.error('[dashboard] modo headless requer sync.enabled = true no config. Nada a fazer.');
				process.exit(1);
			}
			SYNC.start();
			console.log('');
			console.log('  ccusage em modo HEADLESS: sem painel, coletando e sincronizando em segundo plano.');
			console.log('  agente: ' + CONFIG.agent + '  |  destinos: ' + (CONFIG.sync.targets || []).map((t) => t.type).join(', '));
			console.log('');
			resolve({ headless: true });
		});
	}

	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once('error', (e) => {
			if (e.code === 'EADDRINUSE') {
				// Outra instancia ja esta rodando: nao e erro fatal para quem so quer abrir a tela.
				console.warn('[dashboard] porta ' + CONFIG.port + ' ja em uso (painel provavelmente ja aberto).');
				return resolve({ port: CONFIG.port, alreadyRunning: true });
			}
			reject(e);
		});
		server.listen(CONFIG.port, () => {
			if (SYNC) SYNC.start();
			console.log('');
			console.log('  ccusage dashboard rodando em  http://localhost:' + CONFIG.port);
			console.log('  agente: ' + CONFIG.agent + '  |  refresh: ' + CONFIG.refreshSeconds + 's');
			console.log('');
			resolve({ port: CONFIG.port, alreadyRunning: false, server });
		});
	});
}

module.exports = { startServer, CONFIG };

if (require.main === module) {
	startServer().catch((e) => {
		console.error('[dashboard] falha ao iniciar:', e.message);
		process.exit(1);
	});
}
