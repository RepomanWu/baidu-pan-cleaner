'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const store = require('./core/store');
const jobs = require('./core/jobs');
const pan = require('./core/pan');

const PUBLIC_DIR = path.join(__dirname, 'public');
const HOST = '127.0.0.1';
const BASE_PORT = Number(process.env.PORT) || 5178;
const VALID_TYPES = new Set(['dup', 'rub', 'empty']);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const locks = new Map();

function withLock(key, task) {
  const previous = locks.get(key) || Promise.resolve();
  const next = previous.then(task, task);
  locks.set(
    key,
    next.catch(() => {})
  );
  return next;
}

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size > 80 * 1024 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      // 必须整体按 UTF-8 解码，逐块转字符串会把跨块的中文截断成乱码
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.join(PUBLIC_DIR, relative);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(content);
  });
}

function publicAccount(account) {
  return {
    id: account.id,
    name: account.name,
    uk: account.uk,
    createdAt: account.createdAt,
    lastLoginAt: account.lastLoginAt || null,
    lastScanAt: account.lastScanAt || null,
  };
}

function startJob(kind, meta, runner) {
  const job = jobs.create(kind, meta);
  runner(job)
    .then((result) => jobs.update(job.id, { status: 'done', progress: 100, stage: '完成', result }))
    .catch((err) => {
      const message = err instanceof pan.PanError ? err.message : err.message || String(err);
      jobs.update(job.id, { status: 'failed', stage: '失败', error: message });
    });
  return job;
}

async function runScan(account, type, job) {
  return withLock(account.id, async () => {
    jobs.update(job.id, { stage: '打开浏览器会话', progress: 2 });
    const { context, session } = await pan.openSession(account);
    try {
      if (!session) throw new pan.PanError('账号未登录或登录已失效，请先扫码授权');

      jobs.update(job.id, { stage: '创建扫描任务', progress: 5 });
      const taskid = await session.startScan(type);

      jobs.update(job.id, { stage: '扫描中', progress: 8 });
      const scanResult = await session.waitScan(type, taskid, (p) => {
        jobs.update(job.id, {
          stage: p.status === 'running' ? '扫描中' : p.status,
          progress: Math.min(90, Math.max(8, Math.round(p.progress * 0.9))),
          message: p.info ? `已扫描 ${p.info.storedFileNum || 0} / ${p.info.totalFileNum || 0} 个文件` : '',
        });
      });

      jobs.update(job.id, { stage: '读取扫描结果', progress: 92 });
      const { items, info, truncated } = await session.fetchGarbageList(type, taskid, (p) => {
        jobs.update(job.id, { message: `已加载 ${p.loaded} 项` });
      });

      const report = pan.buildReport(account, type, taskid, items, info, truncated, scanResult.info);
      store.saveReport(report);
      store.updateAccount(account.id, { lastScanAt: Date.now() });

      return {
        reportId: report.id,
        type,
        typeLabel: report.typeLabel,
        summary: report.summary,
        suggestedCount: report.suggested.length,
      };
    } finally {
      try {
        await context.close();
      } catch (e) {}
    }
  });
}

async function runDelete(account, report, paths, job) {
  return withLock(account.id, async () => {
    jobs.update(job.id, { stage: '打开浏览器会话', progress: 3 });
    const { context, session } = await pan.openSession(account);
    let verifyNeeded = false;
    try {
      if (!session) throw new pan.PanError('账号未登录或登录已失效，请先扫码授权');
      jobs.update(job.id, { stage: '提交删除任务', progress: 8 });
      const result = await session.deleteFiles(report.type, report.taskid, paths, (p) => {
        jobs.update(job.id, {
          stage: p.status === 'running' ? '删除中' : p.status,
          progress: Math.min(95, 10 + Math.round((Number(p.progress) || 0) * 0.85)),
          message: p.message || '',
        });
      });
      if (result && Array.isArray(result.deletedPaths) && result.deletedPaths.length) {
        store.markReportDeleted(report.id, result.deletedPaths);
        store.markDeleted(account.id, result.deletedPaths);
      }
      return { ...result, reportId: report.id, type: report.type };
    } catch (err) {
      verifyNeeded = !!err.verifyNeeded;
      throw err;
    } finally {
      try {
        await context.close();
      } catch (e) {}
      if (verifyNeeded) {
        pan.openBrowserWindow(account.profileDir, 'https://pan.baidu.com/disk/main');
      }
    }
  });
}

function allPathsOfReport(report) {
  const set = new Set();
  if (report.type === 'dup') {
    for (const group of report.groups || []) {
      for (const file of group.files || []) if (file.path) set.add(file.path);
    }
  } else {
    for (const file of report.files || []) if (file.path) set.add(file.path);
  }
  return set;
}

function aliveFilesOf(group, deletedBefore) {
  return (group.files || []).filter((file) => file.path && !file.deleted && !deletedBefore.has(file.path));
}

// 重复组内只剩一份时，这一份必须保留，否则整组会被删空
function protectedPathsOfReport(report, deletedBefore) {
  const set = new Set();
  if (report.type !== 'dup') return set;
  for (const group of report.groups || []) {
    const alive = aliveFilesOf(group, deletedBefore);
    if (alive.length <= 1) for (const file of alive) set.add(file.path);
  }
  return set;
}

function toCSV(report) {
  const rows = [['类型', '路径', '大小(字节)', '修改时间', '重复组']];
  const fmt = (ts) => (ts ? new Date(ts * 1000).toLocaleString('zh-CN') : '');
  if (report.type === 'dup') {
    for (const group of report.groups || []) {
      for (const file of group.files || []) {
        rows.push([report.typeLabel, file.path, file.size, fmt(file.mtime), group.group]);
      }
    }
  } else {
    for (const file of report.files || []) {
      rows.push([report.typeLabel, file.path, file.size, fmt(file.mtime), '']);
    }
  }
  const escape = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  return '\uFEFF' + rows.map((r) => r.map(escape).join(',')).join('\r\n');
}

async function handleApi(req, res, url) {
  const { pathname, searchParams } = url;
  const method = req.method;

  if (pathname === '/api/accounts' && method === 'GET') {
    return sendJSON(res, 200, { accounts: store.listAccounts().map(publicAccount) });
  }

  if (pathname === '/api/accounts' && method === 'POST') {
    const body = await readBody(req);
    const name = String(body.name || '').trim().slice(0, 30);
    const account = store.createAccount(name);
    return sendJSON(res, 200, { account: publicAccount(account) });
  }

  const accountMatch = pathname.match(/^\/api\/accounts\/([a-f0-9]{4,32})(\/[a-z]+)?$/);
  if (accountMatch) {
    const account = store.getAccount(accountMatch[1]);
    if (!account) return sendJSON(res, 404, { error: '账号不存在' });
    const action = accountMatch[2];

    if (method === 'DELETE' && !action) {
      store.removeAccount(account.id);
      return sendJSON(res, 200, { ok: true });
    }

    if (method === 'PATCH' && !action) {
      const body = await readBody(req);
      const name = String(body.name || '').trim().slice(0, 30);
      if (!name) return sendJSON(res, 400, { error: '名称不能为空' });
      return sendJSON(res, 200, { account: publicAccount(store.updateAccount(account.id, { name })) });
    }

    if (method === 'POST' && action === '/login') {
      jobs.cancelRunning('login', account.id);
      const job = startJob('login', { accountId: account.id }, (j) =>
        withLock(account.id, async () => {
          const info = await pan.login(account, {
            onStage: (stage) => jobs.update(j.id, { stage, message: '' }),
            shouldStop: () => j.cancelled === true,
          });
          store.updateAccount(account.id, { uk: info.uk, lastLoginAt: Date.now() });
          return { uk: info.uk };
        })
      );
      return sendJSON(res, 200, { jobId: job.id });
    }

    if (method === 'POST' && action === '/check') {
      const job = startJob('check', { accountId: account.id }, (j) =>
        withLock(account.id, async () => {
          jobs.update(j.id, { stage: '检测登录状态' });
          const { context, session } = await pan.openSession(account);
          try {
            if (!session) return { loggedIn: false };
            store.updateAccount(account.id, { uk: session.uk });
            return { loggedIn: true, uk: session.uk };
          } finally {
            session ? session.close() : context.close().catch(() => {});
          }
        })
      );
      return sendJSON(res, 200, { jobId: job.id });
    }
  }

  if (pathname === '/api/scan' && method === 'POST') {
    const body = await readBody(req);
    const account = store.getAccount(body.accountId);
    if (!account) return sendJSON(res, 404, { error: '账号不存在' });
    const type = String(body.type || '');
    if (!VALID_TYPES.has(type)) return sendJSON(res, 400, { error: '未知的扫描类型' });
    const job = startJob('scan', { accountId: account.id, type }, (j) => runScan(account, type, j));
    return sendJSON(res, 200, { jobId: job.id });
  }

  if (pathname === '/api/delete' && method === 'POST') {
    const body = await readBody(req);
    if (body.confirm !== true) return sendJSON(res, 400, { error: '缺少二次确认' });
    const account = store.getAccount(body.accountId);
    if (!account) return sendJSON(res, 404, { error: '账号不存在' });
    const report = store.getReport(String(body.reportId || ''));
    if (!report || report.accountId !== account.id) return sendJSON(res, 404, { error: '报告不存在' });
    if (!report.taskid) return sendJSON(res, 400, { error: '该报告没有扫描任务 ID（CSV 导入），无法删除，只能查看或导出' });
    const allowed = allPathsOfReport(report);
    const paths = (Array.isArray(body.paths) ? body.paths : []).filter((p) => typeof p === 'string');
    if (!paths.length) return sendJSON(res, 400, { error: '没有选择要删除的文件' });
    const illegal = paths.filter((p) => !allowed.has(p));
    if (illegal.length) {
      return sendJSON(res, 400, {
        error: `有 ${illegal.length} 个路径不在当前报告中（报告可能已过期或被重新扫描），请重新打开报告后再试`,
      });
    }
    const deletedBefore = store.deletedPathsFor(account.id);
    const pending = paths.filter((p) => !deletedBefore.has(p));
    if (!pending.length) return sendJSON(res, 400, { error: '所选文件之前已经删除过，无需重复删除' });

    if (report.type === 'dup') {
      const protectedSet = protectedPathsOfReport(report, deletedBefore);
      const hitProtected = pending.filter((p) => protectedSet.has(p));
      if (hitProtected.length) {
        return sendJSON(res, 400, {
          error: `有 ${hitProtected.length} 个文件是所在重复组的最后一个副本，已阻止删除（每组至少保留一份）`,
        });
      }
      const pendingSet = new Set(pending);
      const emptied = (report.groups || []).find((group) => {
        const alive = aliveFilesOf(group, deletedBefore);
        return alive.length > 1 && alive.every((file) => pendingSet.has(file.path));
      });
      if (emptied) {
        return sendJSON(res, 400, {
          error: `重复组「${emptied.group || '未命名'}」的副本会被全部删除，已阻止操作（每组至少保留一份），请取消勾选其中一个`,
        });
      }
    }

    const job = startJob('delete', { accountId: account.id, type: report.type }, (j) =>
      runDelete(account, report, pending, j)
    );
    return sendJSON(res, 200, { jobId: job.id, count: pending.length, skipped: paths.length - pending.length });
  }

  if (pathname === '/api/jobs' && method === 'GET') {
    return sendJSON(res, 200, { jobs: jobs.list() });
  }

  const jobMatch = pathname.match(/^\/api\/jobs\/([a-f0-9]+)$/);
  if (jobMatch && method === 'GET') {
    const job = jobs.get(jobMatch[1]);
    if (!job) return sendJSON(res, 404, { error: '任务不存在' });
    return sendJSON(res, 200, { job });
  }

  if (pathname === '/api/reports' && method === 'GET') {
    return sendJSON(res, 200, { reports: store.listReports(searchParams.get('accountId') || '') });
  }

  if (pathname === '/api/reports/import' && method === 'POST') {
    const body = await readBody(req);
    const incoming = body.report;
    if (!incoming || typeof incoming !== 'object' || !VALID_TYPES.has(incoming.type)) {
      return sendJSON(res, 400, { error: '报告格式不正确，需要本工具导出的 JSON 或 CSV' });
    }
    const account = store.getAccount(String(body.accountId || incoming.accountId || ''));
    if (!account) return sendJSON(res, 404, { error: '账号不存在，请先在左侧添加账号' });
    const rows = incoming.type === 'dup' ? incoming.groups : incoming.files;
    if (!Array.isArray(rows)) return sendJSON(res, 400, { error: '报告缺少结果数据，可能不是本工具导出的文件' });

    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const report = {
      ...incoming,
      id: `${account.id}-${incoming.type}-${stamp}-${Math.random().toString(36).slice(2, 6)}`,
      accountId: account.id,
      accountName: account.name,
      uk: incoming.uk || account.uk || '',
      taskid: incoming.taskid || null,
      imported: true,
      createdAt: Number(incoming.createdAt) || Date.now(),
      suggested: Array.isArray(incoming.suggested) ? incoming.suggested : [],
    };

    // 用本地删除记录标注历史已删除的文件，避免导入后又去删一遍
    const deletedSet = store.deletedPathsFor(account.id);
    if (deletedSet.size) {
      let marked = 0;
      const applyDeleted = (file) => {
        if (file && deletedSet.has(file.path)) {
          if (!file.deleted) marked++;
          file.deleted = true;
        }
      };
      if (report.type === 'dup') {
        for (const group of report.groups || []) (group.files || []).forEach(applyDeleted);
      } else {
        (report.files || []).forEach(applyDeleted);
      }
      report.suggested = report.suggested.filter((filePath) => !deletedSet.has(filePath));
      report.meta = { ...(report.meta || {}), previouslyDeleted: marked };
    }
    // 组内只剩一个副本时自动保护，导入后也不会被勾选删除
    store.protectLastCopies(report);
    const protectedCount =
      report.type === 'dup'
        ? (report.groups || []).reduce(
            (sum, group) => sum + (group.files || []).filter((file) => file.protected).length,
            0
          )
        : 0;
    if (protectedCount) report.meta = { ...(report.meta || {}), protectedCount };
    store.saveReport(report);
    return sendJSON(res, 200, {
      report: {
        id: report.id,
        type: report.type,
        typeLabel: report.typeLabel,
        createdAt: report.createdAt,
        summary: report.summary,
        suggestedCount: report.suggested.length,
        imported: true,
        hasTask: !!report.taskid,
      },
    });
  }

  const reportMatch = pathname.match(/^\/api\/reports\/([a-zA-Z0-9_-]+)(\/download)?$/);
  if (reportMatch) {
    const report = store.getReport(reportMatch[1]);
    if (!report) return sendJSON(res, 404, { error: '报告不存在' });
    if (reportMatch[2]) {
      const format = searchParams.get('format') || 'json';
      if (format === 'csv') {
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${report.id}.csv"`,
        });
        return res.end(toCSV(report));
      }
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${report.id}.json"`,
      });
      return res.end(JSON.stringify(report, null, 2));
    }
    if (method === 'DELETE') {
      store.removeReport(report.id);
      return sendJSON(res, 200, { ok: true });
    }
    return sendJSON(res, 200, { report });
  }

  return sendJSON(res, 404, { error: '接口不存在' });
}

function createServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url, `http://${HOST}`);
    if (url.pathname.startsWith('/api/')) {
      handleApi(req, res, url).catch((err) => {
        sendJSON(res, 500, { error: err.message || '服务器内部错误' });
      });
      return;
    }
    serveStatic(req, res, url.pathname);
  });
}

function listen(port, attemptsLeft = 10) {
  const server = createServer();
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
      listen(port + 1, attemptsLeft - 1);
      return;
    }
    console.error('启动失败：', err.message);
    process.exit(1);
  });
  server.listen(port, HOST, () => {
    const address = `http://${HOST}:${port}`;
    console.log(`百度网盘清理工具已启动：${address}`);
    if (process.platform === 'win32' && !process.env.NO_OPEN) {
      exec(`start "" "${address}"`);
    }
  });
}

store.ensureDirs();
listen(BASE_PORT);
