'use strict';

const TYPE_LABEL = { dup: '重复文件', rub: '垃圾视频', empty: '空文件夹' };

const state = {
  accounts: [],
  accountId: null,
  jobId: null,
  job: null,
  report: null,
  selected: new Set(),
  reports: [],
  pollTimer: null,
};

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
};

function fmtSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[i]}`;
}

function fmtTime(seconds) {
  if (!seconds) return '-';
  const d = new Date(Number(seconds) * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function toast(message, isError) {
  const node = $('#toast');
  node.textContent = message;
  node.className = `toast show${isError ? ' error' : ''}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    node.className = 'toast';
  }, 3200);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
  return data;
}

/* ---------- 账号 ---------- */

function currentAccount() {
  return state.accounts.find((a) => a.id === state.accountId) || null;
}

async function loadAccounts() {
  const data = await api('/api/accounts');
  state.accounts = data.accounts;
  if (!state.accountId && state.accounts.length) state.accountId = state.accounts[0].id;
  if (state.accountId && !state.accounts.some((a) => a.id === state.accountId)) {
    state.accountId = state.accounts[0] ? state.accounts[0].id : null;
  }
  renderAccounts();
}

function renderAccounts() {
  const list = $('#accountList');
  list.innerHTML = '';
  if (!state.accounts.length) {
    list.appendChild(el('li', 'empty', '还没有账号，点击右上角「+ 添加账号」'));
  }
  for (const account of state.accounts) {
    const item = el('li', `account${account.id === state.accountId ? ' active' : ''}`);
    const nameLine = el('div', 'name');
    nameLine.appendChild(el('span', '', account.name));
    nameLine.appendChild(el('span', `chip${account.uk ? ' logged' : ''}`, account.uk ? '已授权' : '未授权'));
    item.appendChild(nameLine);
    item.appendChild(el('div', 'uk', account.uk ? `UID ${account.uk}` : '尚未扫码登录'));

    const ops = el('div', 'ops');
    const loginBtn = el('button', 'btn sm', account.uk ? '重新授权' : '扫码授权');
    loginBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      loginAccount(account.id);
    });
    const checkBtn = el('button', 'btn sm ghost', '检测');
    checkBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      checkAccount(account.id);
    });
    const delBtn = el('button', 'btn sm ghost', '删除');
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeAccount(account);
    });
    ops.append(loginBtn, checkBtn, delBtn);
    item.appendChild(ops);

    item.addEventListener('click', () => {
      state.accountId = account.id;
      renderAccounts();
      loadReports();
      clearReport();
    });
    list.appendChild(item);
  }
}

function addAccount() {
  const { modal, close } = openModal({
    title: '添加网盘账号',
    body: (container) => {
      container.appendChild(el('p', '', '给这个账号起个名字，例如「主账号」「小号 A」。创建后会打开浏览器扫码授权。'));
      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = `账号 ${state.accounts.length + 1}`;
      input.value = '';
      container.appendChild(input);
      setTimeout(() => input.focus(), 30);
      container._input = input;
    },
    actions: [
      { text: '取消', onClick: (closeFn) => closeFn() },
      {
        text: '创建并扫码授权',
        primary: true,
        onClick: async (closeFn, container) => {
          const name = container._input.value.trim();
          const data = await api('/api/accounts', { method: 'POST', body: { name } });
          closeFn();
          await loadAccounts();
          state.accountId = data.account.id;
          renderAccounts();
          loginAccount(data.account.id);
        },
      },
    ],
  });
  return modal;
}

async function removeAccount(account) {
  const ok = await confirmModal({
    title: '删除账号',
    message: `确定删除账号「${account.name}」吗？本机保存的登录态会一起清除，网盘文件不受影响。`,
    confirmText: '删除账号',
    danger: true,
  });
  if (!ok) return;
  await api(`/api/accounts/${account.id}`, { method: 'DELETE' });
  await loadAccounts();
  loadReports();
  clearReport();
  toast('账号已删除');
}

async function loginAccount(accountId) {
  try {
    const data = await api(`/api/accounts/${accountId}/login`, { method: 'POST' });
    watchJob(data.jobId, {
      title: '扫码授权',
      onDone: async (job) => {
        await loadAccounts();
        if (job.status === 'done') toast('授权成功，可以开始扫描了');
        else toast(`授权失败：${job.error}`, true);
      },
    });
    toast('授权窗口已打开，请用百度网盘 App 扫码（窗口可能在浏览器后面）', false);
  } catch (err) {
    toast(err.message, true);
  }
}

async function checkAccount(accountId) {
  try {
    const data = await api(`/api/accounts/${accountId}/check`, { method: 'POST' });
    watchJob(data.jobId, {
      title: '检测登录状态',
      silent: true,
      onDone: async (job) => {
        if (job.status !== 'done') return toast(`检测失败：${job.error}`, true);
        await loadAccounts();
        toast(job.result.loggedIn ? `登录有效（UID ${job.result.uk}）` : '登录已失效，请重新扫码授权', !job.result.loggedIn);
      },
    });
  } catch (err) {
    toast(err.message, true);
  }
}

/* ---------- 扫描 ---------- */

async function startScan(type) {
  const account = currentAccount();
  if (!account) return toast('请先添加账号', true);
  if (!account.uk) return toast('该账号还没扫码授权', true);
  setScanButtonsDisabled(true);
  try {
    const data = await api('/api/scan', { method: 'POST', body: { accountId: account.id, type } });
    watchJob(data.jobId, {
      title: `扫描${TYPE_LABEL[type]}`,
      onDone: async (job) => {
        setScanButtonsDisabled(false);
        await loadAccounts();
        await loadReports();
        if (job.status === 'done') {
          await openReport(job.result.reportId);
          toast(`扫描完成：${job.result.summary.count} 项，${fmtSize(job.result.summary.size)}`);
        } else {
          toast(`扫描失败：${job.error}`, true);
        }
      },
    });
  } catch (err) {
    setScanButtonsDisabled(false);
    toast(err.message, true);
  }
}

function setScanButtonsDisabled(disabled) {
  document.querySelectorAll('[data-scan]').forEach((btn) => {
    btn.disabled = disabled;
  });
}

function watchJob(jobId, options = {}) {
  state.jobId = jobId;
  state.job = null;
  $('#jobPanel').classList.remove('hidden');
  $('#jobTitle').textContent = options.title || '任务进行中';
  updateJobView({ status: 'running', stage: '准备中', progress: 0, message: '' });
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(async () => {
    try {
      const { job } = await api(`/api/jobs/${jobId}`);
      state.job = job;
      if (!options.silent) updateJobView(job);
      updateJobBadge(job);
      if (job.status !== 'running') {
        clearInterval(state.pollTimer);
        state.pollTimer = null;
        setTimeout(() => {
          if (job.status === 'done' && !options.keepPanel) $('#jobPanel').classList.add('hidden');
        }, 1500);
        if (options.onDone) {
          Promise.resolve()
            .then(() => options.onDone(job))
            .catch((err) => toast(err.message, true));
        }
      }
    } catch (err) {
      clearInterval(state.pollTimer);
      toast(err.message, true);
    }
  }, 1200);
}

function updateJobView(job) {
  const percent = Math.max(0, Math.min(100, Number(job.progress) || 0));
  $('#jobPercent').textContent = `${percent}%`;
  $('#jobBar').style.width = `${percent}%`;
  const parts = [job.stage, job.message].filter(Boolean);
  $('#jobText').textContent = job.status === 'failed' ? `失败：${job.error}` : parts.join(' · ');
}

function updateJobBadge(job) {
  const badge = $('#jobBadge');
  if (!job || job.status === 'done') {
    badge.classList.add('hidden');
    return;
  }
  badge.classList.remove('hidden');
  badge.className = `badge ${job.status}`;
  badge.textContent = job.status === 'failed' ? `失败：${job.error}` : `${job.stage || '进行中'} ${job.progress || 0}%`;
}

/* ---------- 报告 ---------- */

async function loadReports() {
  const query = state.accountId ? `?accountId=${encodeURIComponent(state.accountId)}` : '';
  const data = await api(`/api/reports${query}`);
  state.reports = data.reports;
  renderReports();
  updateLastScanLabels();
}

function updateLastScanLabels() {
  const lastByType = {};
  for (const report of state.reports) {
    if (!lastByType[report.type]) lastByType[report.type] = report;
  }
  document.querySelectorAll('[data-last]').forEach((node) => {
    const report = lastByType[node.dataset.last];
    node.textContent = report ? `上次：${new Date(report.createdAt).toLocaleDateString('zh-CN')}` : '';
  });
}

function renderReports() {
  const box = $('#reportList');
  box.innerHTML = '';
  $('#reportCount').textContent = String(state.reports.length);
  if (!state.reports.length) {
    box.appendChild(el('div', 'empty', '暂无历史报告'));
    return;
  }
  for (const report of state.reports) {
    const row = el('div', 'report-item');
    const main = el('div', 'main');
    main.appendChild(el('div', '', `${report.typeLabel} · ${report.summary.count} 项 · ${fmtSize(report.summary.size)}`));
    main.appendChild(
      el('div', 'sub', `${new Date(report.createdAt).toLocaleString('zh-CN')} · 建议可删 ${report.suggestedCount} 项`)
    );
    row.appendChild(main);
    const openBtn = el('button', 'btn sm', '查看');
    openBtn.addEventListener('click', () => openReport(report.id));
    const csvBtn = el('button', 'btn sm ghost', 'CSV');
    csvBtn.addEventListener('click', () => window.open(`/api/reports/${report.id}/download?format=csv`, '_blank'));
    row.append(openBtn, csvBtn);
    box.appendChild(row);
  }
}

function clearReport() {
  state.report = null;
  state.selected = new Set();
  $('#resultArea').innerHTML = '';
  $('#reportMeta').textContent = '还没有选择结果。';
  updateDeleteButton();
}

async function openReport(reportId) {
  const data = await api(`/api/reports/${reportId}`);
  state.report = data.report;
  state.selected = new Set(state.report.suggested || []);
  renderReport();
}

function renderReport() {
  const report = state.report;
  const area = $('#resultArea');
  area.innerHTML = '';
  if (!report) return clearReport();

  const meta = $('#reportMeta');
  meta.innerHTML = '';
  const line1 = el(
    'div',
    '',
    `${report.typeLabel} · 共 ${report.summary.count} 项 · 占用 ${fmtSize(report.summary.size)}` +
      (report.type === 'dup' ? ` · ${report.summary.groupCount} 组重复` : '')
  );
  const line2 = el('div', '', `账号：${report.accountName}（UID ${report.uk || '-'}）· 扫描时间：${new Date(report.createdAt).toLocaleString('zh-CN')}`);
  meta.append(line1, line2);
  if (report.meta && report.meta.totalSize) {
    meta.appendChild(
      el(
        'div',
        '',
        `账号侧统计：${report.meta.totalGroupNum ? report.meta.totalGroupNum + ' 组 / ' : ''}${report.meta.totalFileNum || 0} 个文件，占用 ${fmtSize(report.meta.totalSize)}`
      )
    );
  }
  if (report.truncated) {
    meta.appendChild(
      el('div', 'warn', '结果数量过多，本报告只包含已加载的部分（可用环境变量 MAX_ITEMS 调大上限后重新扫描）。')
    );
  }
  if (report.type === 'dup') {
    meta.appendChild(el('div', 'warn', '默认每组只勾选「保留最新一份」之外的文件；删除前请再核对。'));
  }

  if (!report.summary.count) {
    area.appendChild(el('div', 'empty', '没有扫描到可清理的内容'));
    updateDeleteButton();
    return;
  }

  const RENDER_LIMIT = 1500;
  let rendered = 0;
  if (report.type === 'dup') {
    for (const group of report.groups || []) {
      if (rendered >= RENDER_LIMIT) break;
      const head = el('div', 'group-head', `重复组 ${group.group} · ${group.files.length} 个文件`);
      area.appendChild(head);
      for (const file of group.files) {
        if (rendered >= RENDER_LIMIT) break;
        area.appendChild(renderRow(file));
        rendered++;
      }
    }
  } else {
    for (const file of report.files || []) {
      if (rendered >= RENDER_LIMIT) break;
      area.appendChild(renderRow(file));
      rendered++;
    }
  }
  if (rendered >= RENDER_LIMIT) {
    area.appendChild(el('div', 'empty', `仅显示前 ${RENDER_LIMIT} 项，完整数据请导出 CSV 查看`));
  }
  if (state.selected.size > rendered) {
    const note = el(
      'div',
      'empty',
      `当前已选中 ${state.selected.size} 项，其中 ${state.selected.size - rendered} 项未显示在列表中（包括整组自动勾选的项）。`
    );
    note.style.color = '#b3261e';
    area.appendChild(note);
  }
  updateDeleteButton();
}

function renderRow(file) {
  const row = el('div', 'row');
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = state.selected.has(file.path);
  box.addEventListener('change', () => {
    if (box.checked) state.selected.add(file.path);
    else state.selected.delete(file.path);
    updateDeleteButton();
  });
  const pathNode = el('div', 'path', file.path);
  pathNode.title = file.path;
  const sizeNode = el('div', 'size', fmtSize(file.size));
  const timeNode = el('div', 'time', fmtTime(file.mtime));
  row.append(box, pathNode, sizeNode, timeNode);
  return row;
}

function updateDeleteButton() {
  const btn = $('#btnDelete');
  const count = state.selected.size;
  btn.disabled = count === 0 || !state.report;
  btn.textContent = count ? `删除选中（${count}）` : '删除选中';
}

function selectSuggested() {
  if (!state.report) return;
  state.selected = new Set(state.report.suggested || []);
  refreshCheckboxes();
}

function selectNone() {
  state.selected = new Set();
  refreshCheckboxes();
}

function refreshCheckboxes() {
  document.querySelectorAll('#resultArea .row').forEach((row) => {
    const pathNode = row.querySelector('.path');
    const box = row.querySelector('input[type="checkbox"]');
    if (pathNode && box) box.checked = state.selected.has(pathNode.textContent);
  });
  updateDeleteButton();
}

/* ---------- 删除 ---------- */

async function deleteSelected() {
  const report = state.report;
  if (!report || !state.selected.size) return;
  const paths = [...state.selected];
  const size = (report.type === 'dup' ? report.groups.flatMap((g) => g.files) : report.files)
    .filter((f) => state.selected.has(f.path))
    .reduce((sum, f) => sum + (f.size || 0), 0);

  let confirmed = false;
  let checked = false;
  await new Promise((resolve) => {
    const { close } = openModal({
      title: `确认删除 ${paths.length} 项`,
      body: (container) => {
        container.appendChild(
          el('p', '', `类型：${report.typeLabel}　数量：${paths.length} 项　占用：${fmtSize(size)}`)
        );
        if (report.type === 'empty') {
          container.appendChild(el('p', '', '空文件夹本身不含文件，删除后目录结构会变化。'));
        }
        const list = el('div', 'results');
        list.style.maxHeight = '180px';
        paths.slice(0, 200).forEach((p) => list.appendChild(el('div', 'row', p)));
        container.appendChild(list);
        const label = el('label', 'checkline');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.addEventListener('change', () => {
          checked = cb.checked;
          const input = container.querySelector('input[type="text"]');
          if (input) input.disabled = !checked;
        });
        label.append(cb, el('span', '', '我已核对以上路径，确认要从网盘删除（删除后可在回收站找回）'));
        container.appendChild(label);
        const input = document.createElement('input');
        input.type = 'text';
        input.placeholder = '输入「删除」以确认';
        input.disabled = true;
        container.appendChild(input);
        container._input = input;
      },
      actions: [
        { text: '取消', onClick: (closeFn) => closeFn() },
        {
          text: '确认删除',
          danger: true,
          onClick: async (closeFn, container) => {
            if (!checked) return toast('请先勾选确认', true);
            if (container._input.value.trim() !== '删除') return toast('请输入「删除」以确认', true);
            confirmed = true;
            closeFn();
          },
        },
      ],
      onClose: () => resolve(),
    });
  });

  if (!confirmed) return;

  try {
    const data = await api('/api/delete', {
      method: 'POST',
      body: { accountId: report.accountId, reportId: report.id, paths, confirm: true },
    });
    watchJob(data.jobId, {
      title: `删除${report.typeLabel}`,
      onDone: async (job) => {
        if (job.status === 'done') {
          toast(`已删除 ${job.result.deleted} 项，建议重新扫描确认`);
          state.selected = new Set();
          await loadReports();
          clearReport();
        } else {
          toast(`删除失败：${job.error}`, true);
          updateDeleteButton();
        }
      },
    });
  } catch (err) {
    toast(err.message, true);
  }
}

/* ---------- 通用弹窗 ---------- */

function openModal({ title, body, actions, onClose }) {
  const mask = el('div', 'modal-mask');
  const modal = el('div', 'modal');
  modal.appendChild(el('h3', '', title));
  const container = el('div');
  if (typeof body === 'function') body(container);
  else if (body) container.appendChild(body);
  modal.appendChild(container);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    mask.remove();
    if (onClose) onClose();
  };

  const buttons = el('div', 'actions');
  for (const action of actions || []) {
    const btn = el('button', `btn${action.primary ? ' primary' : ''}${action.danger ? ' danger' : ''}`, action.text);
    btn.type = 'button';
    btn.addEventListener('click', async () => {
      try {
        await action.onClick(close, container);
      } catch (err) {
        toast(err.message, true);
      }
    });
    buttons.appendChild(btn);
  }
  modal.appendChild(buttons);
  mask.appendChild(modal);
  mask.addEventListener('click', (e) => {
    if (e.target === mask) close();
  });
  $('#modalRoot').appendChild(mask);
  return { modal, container, close };
}

function confirmModal({ title, message, confirmText, danger }) {
  return new Promise((resolve) => {
    let result = false;
    const { close } = openModal({
      title,
      body: (container) => container.appendChild(el('p', '', message)),
      actions: [
        { text: '取消', onClick: (closeFn) => closeFn() },
        {
          text: confirmText || '确定',
          danger,
          primary: !danger,
          onClick: (closeFn) => {
            result = true;
            closeFn();
          },
        },
      ],
      onClose: () => resolve(result),
    });
    void close;
  });
}

/* ---------- 初始化 ---------- */

function bindEvents() {
  $('#btnAddAccount').addEventListener('click', addAccount);
  document.querySelectorAll('[data-scan]').forEach((btn) => {
    btn.addEventListener('click', () => startScan(btn.dataset.scan));
  });
  $('#btnSelectSuggested').addEventListener('click', selectSuggested);
  $('#btnSelectNone').addEventListener('click', selectNone);
  $('#btnDelete').addEventListener('click', deleteSelected);
  $('#btnDownloadCsv').addEventListener('click', () => {
    if (state.report) window.open(`/api/reports/${state.report.id}/download?format=csv`, '_blank');
  });
  $('#btnDownloadJson').addEventListener('click', () => {
    if (state.report) window.open(`/api/reports/${state.report.id}/download?format=json`, '_blank');
  });
}

async function init() {
  bindEvents();
  try {
    await loadAccounts();
    await loadReports();
  } catch (err) {
    toast(err.message, true);
  }
}

init();
