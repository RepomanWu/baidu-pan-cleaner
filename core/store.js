'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
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
};
