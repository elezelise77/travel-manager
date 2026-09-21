/* 여행 상황판 - 데스크톱 앱 본체
 * 하는 일: 창 띄우기 / 여행방 목록 저장 / 구글 웹앱과 통신 / 백업 파일 저장
 * 실제 데이터는 전부 사용자 본인 구글시트에 있습니다. 이 앱은 보관하지 않습니다. */

const { app, BrowserWindow, ipcMain, shell, dialog, clipboard, session } = require('electron');
const path = require('path');
const fs = require('fs');

const CONFIG_FILE = () => path.join(app.getPath('userData'), 'config.json');

/* 여행방 목록은 앱을 다시 설치해도 남는 곳(%APPDATA%\trip-board)에 둔다.
 * 쓰다가 꺼져도 날아가지 않게: 임시 파일에 먼저 쓰고 바꿔치기 + 직전본을 .bak 으로 보관. */
function parseCfg(file) {
  const c = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!c || !Array.isArray(c.rooms)) throw new Error('bad');
  return c;
}
function readConfig() {
  for (const f of [CONFIG_FILE(), CONFIG_FILE() + '.bak']) {
    try { return parseCfg(f); } catch (e) {}
  }
  return { rooms: [], current: -1 };
}
function writeConfig(cfg) {
  try {
    if (!cfg || !Array.isArray(cfg.rooms)) return false;
    const file = CONFIG_FILE(), tmp = file + '.tmp';
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
    if (fs.existsSync(file)) { try { fs.copyFileSync(file, file + '.bak'); } catch (e) {} }
    fs.renameSync(tmp, file);
    return true;
  } catch (e) {
    return false;
  }
}

let win = null;
function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 380,
    backgroundColor: '#1E4A3D',
    title: '여행 상황판',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false
    }
  });
  win.loadFile(path.join(__dirname, 'ui', 'app.html'));

  // 앱 안에서 연 외부 링크는 기본 브라우저로
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // 안쪽 화면(iframe)이 못 열렸을 때 화면에 알려준다
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (isMainFrame) return;
    if (code === -3) return;                       // 사용자가 취소한 경우
    try { win.webContents.send('frame:fail', { code, desc, url }); } catch (e) {}
  });
}

/* 안쪽 화면이 막히는 환경에서는 창 자체를 웹 앱으로 띄운다.
 * 이 창은 구글 페이지를 직접 여는 것이라 iframe 제약을 받지 않는다. */
const roomWins = new Map();
function openRoomWindow(url, title) {
  const had = roomWins.get(url);
  if (had && !had.isDestroyed()) { had.focus(); had.reload(); return true; }
  const w = new BrowserWindow({
    width: 1180, height: 820, minWidth: 380,
    backgroundColor: '#1E4A3D',
    title: title || '여행 상황판',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  w.loadURL(url);
  w.webContents.setWindowOpenHandler(({ url: u }) => { shell.openExternal(u); return { action: 'deny' }; });
  w.on('closed', () => roomWins.delete(url));
  roomWins.set(url, w);
  return true;
}

app.whenReady().then(async () => {
  /* 앱을 켤 때마다 옛 화면 찌꺼기를 비운다 (웹앱만 업데이트했을 때 앱 안에 옛날 화면이 남던 문제) */
  try {
    await session.defaultSession.clearCache();
    await session.defaultSession.clearStorageData({ storages: ['cachestorage', 'serviceworkers'] });
  } catch (e) {}
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

/* ---------- 설정(여행방 목록) ---------- */
ipcMain.handle('config:get', () => readConfig());
ipcMain.handle('config:set', (_e, cfg) => writeConfig(cfg));

/* ---------- 구글 웹앱과 통신 ---------- */
ipcMain.handle('api:call', async (_e, { url, payload }) => {
  if (!/^https:\/\/script\.google(usercontent)?\.com\//.test(String(url || ''))) {
    return { ok: false, error: '구글 앱스크립트 주소가 아닙니다.' };
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      redirect: 'follow',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload || {})
    });
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch (e) {
      return { ok: false, error: '주소는 열렸지만 응답이 이상합니다. 웹 앱 배포 설정(액세스: 모든 사용자)을 확인해 주세요.' };
    }
  } catch (err) {
    return { ok: false, error: '연결하지 못했습니다: ' + err.message };
  }
});

/* ---------- 도우미 ---------- */
ipcMain.handle('shell:open', (_e, url) => {
  if (!/^https:\/\//i.test(String(url || ''))) return false;   // 웹 주소만 연다
  shell.openExternal(url);
  return true;
});

ipcMain.handle('room:window', (_e, { url, title }) => {
  if (!/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec/.test(String(url || ''))) return false;
  return openRoomWindow(url, title);
});

/* 앱 안 화면이 옛날 것으로 남아 있을 때 쓰는 청소 */
ipcMain.handle('cache:clear', async () => {
  try {
    await session.defaultSession.clearCache();
    await session.defaultSession.clearStorageData({ storages: ['cachestorage', 'serviceworkers'] });
    return true;
  } catch (e) { return false; }
});

ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  userData: app.getPath('userData')
}));

/* 움직이는 설치 가이드를 기본 브라우저에서 연다 (인터넷 없어도 열림) */
ipcMain.handle('shell:guide', () => {
  shell.openPath(path.join(__dirname, 'ui', 'guide.html'));
  return true;
});
ipcMain.handle('clip:write', (_e, text) => { clipboard.writeText(String(text || '')); return true; });

/* ---------- 구글에 붙여넣을 코드 ----------
 * 앱 안에 Code.gs / Index.html 원문을 넣어두고, 버튼 한 번에 클립보드로 넣어준다.
 * 구매자는 Apps Script 편집기에서 붙여넣기만 하면 된다. */
const CODE_FILES = {
  code : { file: 'Code.gs',     label: 'Code.gs' },
  index: { file: 'Index.html',  label: 'Index.html' }
};
function codePath(which) {
  const d = CODE_FILES[which];
  return d ? path.join(__dirname, 'code', d.file) : null;
}
ipcMain.handle('code:copy', (_e, which) => {
  const p = codePath(which);
  if (!p) return { ok: false, error: '알 수 없는 파일입니다.' };
  try {
    const text = fs.readFileSync(p, 'utf8');
    clipboard.writeText(text);
    return { ok: true, label: CODE_FILES[which].label, bytes: text.length };
  } catch (err) {
    return { ok: false, error: '앱 안에서 코드 파일을 찾지 못했습니다: ' + CODE_FILES[which].file };
  }
});
/** 동봉된 Code.gs 안의 APP_VERSION 을 읽는다 (서버 버전과 비교해 업데이트 안내에 쓴다) */
ipcMain.handle('code:version', () => {
  try {
    const text = fs.readFileSync(codePath('code'), 'utf8');
    const m = text.match(/APP_VERSION\s*=\s*['"]([^'"]+)['"]/);
    return m ? m[1] : '';
  } catch (err) { return ''; }
});

ipcMain.handle('file:saveBackup', async (_e, { name, data }) => {
  const r = await dialog.showSaveDialog(win, {
    title: '백업 저장',
    defaultPath: name,
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (r.canceled || !r.filePath) return { ok: false, canceled: true };
  try {
    fs.writeFileSync(r.filePath, JSON.stringify(data, null, 2), 'utf8');
    return { ok: true, path: r.filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
