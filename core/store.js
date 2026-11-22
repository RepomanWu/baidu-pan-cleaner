'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const PROJECT_DATA_DIR = path.join(ROOT, 'data');

function isWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.write-test-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe, { force: true });
    return true;
  } catch (e) {
    return false;
  }
}

// 程序目录不可写时（例如放在受保护/受限目录），把数据放到用户目录，浏览器配置也需要可写
function resolveDataDir() {
  if (process.env.BDPAN_DATA_DIR) return path.resolve(process.env.BDPAN_DATA_DIR);
  const fallback = path.join(
    process.env.LOCALAPPDATA || process.env.USERPROFILE || ROOT,
    'bdpan-clean',
    'data'
  );
  if (fs.existsSync(path.join(fallback, '.migrated'))) return fallback;
  if (isWritable(PROJECT_DATA_DIR)) return PROJECT_DATA_DIR;
  return fallback;
}

const DATA_DIR = resolveDataDir();
process.env.BDPAN_DATA_DIR = DATA_DIR;

function migrateFromProjectData() {
  if (DATA_DIR === PROJECT_DATA_DIR) return;
  const marker = path.join(DATA_DIR, '.migrated');
  if (fs.existsSync(marker)) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    for (const name of ['accounts.json', 'deleted.json', 'config.json', 'reports', 'profiles']) {
      const source = path.join(PROJECT_DATA_DIR, name);
      const target = path.join(DATA_DIR, name);
      if (!fs.existsSync(source) || fs.existsSync(target)) continue;
      console.log(`[数据迁移] ${source} -> ${target}`);
      fs.cpSync(source, target, { recursive: true });
    }
    // 账号里的配置目录也要指向新位置，否则浏览器仍然打不开
    const accountFile = path.join(DATA_DIR, 'accounts.json');
    try {
      const list = JSON.parse(fs.readFileSync(accountFile, 'utf8').replace(/^\uFEFF/, ''));
      if (Array.isArray(list)) {
        let changed = false;
        for (const account of list) {
          if (account && typeof account.profileDir === 'string' && account.profileDir.startsWith(PROJECT_DATA_DIR)) {
            account.profileDir = path.join(DATA_DIR, 'profiles', account.id);
            changed = true;
          }
        }
        if (changed) fs.writeFileSync(accountFile, JSON.stringify(list, null, 2), 'utf8');
      }
    } catch (e) {}
    fs.writeFileSync(marker, new Date().toISOString(), 'utf8');
  } catch (e) {
    console.error(`[数据迁移] 失败：${e.message}`);
  }
}

migrateFromProjectData();

const PROFILE_DIR = path.join(DATA_DIR, 'profiles');
const REPORT_DIR = path.join(DATA_DIR, 'reports');
const ACCOUNT_FILE = path.join(DATA_DIR, 'accounts.json');
const LEDGER_FILE = path.join(DATA_DIR, 'deleted.json');

function ensureDirs() {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  fs.mkdirSync(REPORT_DIR, { recursive: true });
}

function readJSON(file, fallback) {
  try {
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(text);
  } catch (e) {
    return fallback;
  }
}

function writeJSON(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function listAccounts() {
  ensureDirs();
  const list = readJSON(ACCOUNT_FILE, []);
  return Array.isArray(list) ? list : [];
}

function saveAccounts(list) {
  ensureDirs();
  writeJSON(ACCOUNT_FILE, list);
}

function getAccount(id) {
  return listAccounts().find((a) => a.id === id) || null;
}

function createAccount(name) {
  ensureDirs();
  const list = listAccounts();
  const id = crypto.randomBytes(4).toString('hex');
  const account = {
    id,
    name: name || `账号 ${list.length + 1}`,
    uk: '',
    createdAt: Date.now(),
    profileDir: path.join(PROFILE_DIR, id),
  };
  list.push(account);
  saveAccounts(list);
  return account;
}

function updateAccount(id, patch) {
  const list = listAccounts();
  const index = list.findIndex((a) => a.id === id);
  if (index < 0) return null;
  list[index] = { ...list[index], ...patch };
  saveAccounts(list);
  return list[index];
}

function removeAccount(id) {
  const list = listAccounts();
  const account = list.find((a) => a.id === id);
  if (!account) return false;
  saveAccounts(list.filter((a) => a.id !== id));
  try {
    fs.rmSync(account.profileDir, { recursive: true, force: true });
  } catch (e) {}
  return true;
}

function saveReport(report) {
  ensureDirs();
  writeJSON(path.join(REPORT_DIR, `${report.id}.json`), report);
  return report;
}

function listReports(accountId) {
  ensureDirs();
  const files = fs.readdirSync(REPORT_DIR).filter((f) => f.endsWith('.json'));
  const reports = files.map((f) => {
    const data = readJSON(path.join(REPORT_DIR, f), null);
    if (!data) return null;
    return {
      id: data.id,
      accountId: data.accountId,
      accountName: data.accountName,
      type: data.type,
      typeLabel: data.typeLabel,
      createdAt: data.createdAt,
      summary: data.summary,
      suggestedCount: (data.suggested || []).length,
      imported: !!data.imported,
      hasTask: !!data.taskid,
    };
  });
  return reports
    .filter(Boolean)
    .filter((r) => !accountId || r.accountId === accountId)
    .sort((a, b) => b.createdAt - a.createdAt);
}

function getReport(id) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) return null;
  return readJSON(path.join(REPORT_DIR, `${id}.json`), null);
}

function removeReport(id) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) return false;
  try {
    fs.rmSync(path.join(REPORT_DIR, `${id}.json`), { force: true });
    return true;
  } catch (e) {
    return false;
  }
}

function loadLedger() {
  const data = readJSON(LEDGER_FILE, {});
  return data && typeof data === 'object' ? data : {};
}

function markDeleted(accountId, paths) {
  if (!accountId || !Array.isArray(paths) || !paths.length) return;
  const ledger = loadLedger();
  const bucket = ledger[accountId] || (ledger[accountId] = {});
  const now = Date.now();
  for (const filePath of paths) bucket[filePath] = now;
  writeJSON(LEDGER_FILE, ledger);
}

function deletedPathsFor(accountId) {
  const bucket = loadLedger()[accountId] || {};
  return new Set(Object.keys(bucket));
}

function protectLastCopies(report) {
  if (!report || report.type !== 'dup') return report;
  const protectedPaths = new Set();
  for (const group of report.groups || []) {
    const alive = (group.files || []).filter((file) => !file.deleted);
    for (const file of group.files || []) {
      if (!file.deleted && alive.length <= 1) {
        file.protected = true;
        protectedPaths.add(file.path);
      } else {
        delete file.protected;
      }
    }
  }
  report.suggested = (report.suggested || []).filter((filePath) => !protectedPaths.has(filePath));
  return report;
}

function markReportDeleted(reportId, paths) {
  const report = getReport(reportId);
  if (!report || !Array.isArray(paths) || !paths.length) return null;
  const deleted = new Set(paths);
  const now = Date.now();
  const apply = (file) => {
    if (file && deleted.has(file.path)) {
      file.deleted = true;
      file.deletedAt = now;
    }
  };
  if (report.type === 'dup') {
    for (const group of report.groups || []) (group.files || []).forEach(apply);
  } else {
    (report.files || []).forEach(apply);
  }
  report.suggested = (report.suggested || []).filter((filePath) => !deleted.has(filePath));
  protectLastCopies(report);
  saveReport(report);
  return report;
}

module.exports = {
  DATA_DIR,
  ensureDirs,
  listAccounts,
  getAccount,
  createAccount,
  updateAccount,
  removeAccount,
  saveReport,
  listReports,
  getReport,
  removeReport,
  markDeleted,
  deletedPathsFor,
  markReportDeleted,
  protectLastCopies,
};
