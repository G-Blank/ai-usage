// Entrada do app desktop (Electron), com captura de erros para diagnostico.
'use strict';

const { app, BrowserWindow, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const LOG_FILE = path.join(os.tmpdir(), 'ccusage-dashboard-error.log');

function logError(where, err) {
	const msg = '[' + new Date().toISOString() + '] ' + where + '\n' + (err && err.stack || String(err)) + '\n\n';
	try { fs.appendFileSync(LOG_FILE, msg); } catch (_) {}
	console.error(msg);
	try {
		dialog.showErrorBox('ccusage Dashboard - erro', where + '\n\n' + (err && err.message || String(err)) + '\n\nLog completo em:\n' + LOG_FILE);
	} catch (_) {}
}

process.on('uncaughtException', (e) => logError('uncaughtException', e));
process.on('unhandledRejection', (e) => logError('unhandledRejection', e));

if (!app.requestSingleInstanceLock()) {
	app.quit();
} else {
	let win = null;

	app.on('second-instance', () => {
		if (win) {
			if (win.isMinimized()) win.restore();
			win.focus();
		}
	});

	app.whenReady().then(async () => {
		try {
			// Configs editaveis em %APPDATA%/ccusage Dashboard; copia padroes na 1a execucao.
			const userDir = app.getPath('userData');
			fs.mkdirSync(userDir, { recursive: true });
			for (const f of ['config.json', 'ccusage.json']) {
				const dst = path.join(userDir, f);
				if (!fs.existsSync(dst)) {
					try { fs.copyFileSync(path.join(__dirname, f), dst); } catch (e) { logError('copiando ' + f, e); }
				}
			}
			process.env.CCDASH_DIR = userDir;

			const { startServer, CONFIG } = require('./server.js');
			let port = 8384;
			try {
				const r = await startServer();
				port = r.port || CONFIG.port;
			} catch (e) {
				logError('startServer', e);
			}

			win = new BrowserWindow({
				width: 1280,
				height: 880,
				autoHideMenuBar: true,
				backgroundColor: '#0e1116',
				title: 'ccusage Dashboard',
				webPreferences: { contextIsolation: true, nodeIntegration: false }
			});
			win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
			win.loadURL('http://localhost:' + port).catch((e) => logError('loadURL', e));
			win.on('closed', () => { win = null; });
		} catch (e) {
			logError('inicializacao', e);
		}
	}).catch((e) => logError('whenReady', e));

	app.on('window-all-closed', () => app.quit());
}
