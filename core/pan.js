'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const CLEAR_URL = 'https://pan.baidu.com/disk/clear?orginal=web_tool';
const LOGIN_URL = 'https://pan.baidu.com/login?redirecturl=https%3A%2F%2Fpan.baidu.com%2Fdisk%2Fclear';
const APP_PARAMS = 'channel=chunlei&web=1&app_id=250528&clienttype=0';

const TYPE_LABEL = { dup: '重复文件', rub: '垃圾视频', empty: '空文件夹' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class PanError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

function errorText(errno) {
  const map = {
    7002: '当前账号没有该清理功能的使用权限（需要会员或试用名额）',
    7001: '当前账号没有该清理功能的使用权限（需要会员或试用名额）',
    131: '百度网盘限制：删除清理项需要超级会员特权，当前账号没有该权限（可以只扫描并导出清单）',
    132: '删除需要验证身份，请在弹出的浏览器窗口中按提示完成验证后重试',
    31160: '扫描失败，请稍后重试',
    102: '无权限操作该目录',
    104: '登录凭证无效，请重新扫码授权',
    '-6': '登录状态已失效，请重新扫码授权',
    2: '登录状态已失效，请重新扫码授权',
    4: '登录状态已失效，请重新扫码授权',
  };
  return map[String(errno)] || `接口返回错误（errno=${errno}）`;
}

async function launchBrowser(profileDir, { visible = false } = {}) {
  fs.mkdirSync(profileDir, { recursive: true });
  const args = [
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
  ];
  if (!visible) args.push('--window-position=-32000,-32000', '--window-size=1280,900');
  return chromium.launchPersistentContext(profileDir, {
    channel: 'chrome',
    headless: false,
    viewport: visible ? undefined : { width: 1280, height: 900 },
    args,
  });
}

async function readSession(page) {
  return page.evaluate(() => {
    const pick = (key) => {
      try {
        if (window.locals && window.locals.get) return window.locals.get(key);
      } catch (e) {}
      try {
        if (window.yunData && window.yunData[key] !== undefined) return window.yunData[key];
      } catch (e) {}
      return null;
    };
    const uk = pick('uk');
    const bdstoken = pick('bdstoken') || pick('MYBDSTOKEN');
    return { uk: uk ? String(uk) : null, bdstoken: bdstoken ? String(bdstoken) : null };
  }).catch(() => ({ uk: null, bdstoken: null }));
}

class Session {
  constructor(context, page, { uk, bdstoken }) {
    this.context = context;
    this.page = page;
    this.uk = uk;
    this.bdstoken = bdstoken;
  }

  params() {
    return `${APP_PARAMS}&bdstoken=${encodeURIComponent(this.bdstoken || '')}`;
  }

  async api(urlPath, { method = 'GET', form } = {}) {
    const body = form ? new URLSearchParams(form).toString() : null;
    const text = await this.page.evaluate(
      async ({ u, m, b }) => {
        const res = await fetch(u, {
          method: m,
          credentials: 'include',
          headers: b ? { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' } : undefined,
          body: b || undefined,
        });
        return await res.text();
      },
      { u: urlPath, m: method, b: body }
    );
    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      throw new PanError('接口返回了非 JSON 内容，可能登录已失效或被风控拦截');
    }
    if (json && json.data && typeof json.data === 'object' && json.errno === undefined) json = json.data;
    if (json && json.errno !== undefined && json.errno !== 0) {
      throw new PanError(errorText(json.errno), json.errno);
    }
    return json;
  }

  async startScan(type, dir = '/') {
    const res = await this.api(
      `/api/garbagescan?${this.params()}&type=${encodeURIComponent(type)}&dir=${encodeURIComponent(dir)}`
    );
    const taskid = res.taskid || (res.info && res.info.taskid);
    if (!taskid) throw new PanError('未能创建扫描任务，请稍后重试');
    return taskid;
  }

  async waitScan(type, taskid, onProgress) {
    const deadline = Date.now() + 40 * 60 * 1000;
    while (Date.now() < deadline) {
      const res = await this.api(
        `/api/garbagetaskquery?${this.params()}&type=${encodeURIComponent(type)}&option=scan&taskid=${taskid}`
      );
      const status = res.status;
      onProgress && onProgress({ status, progress: Number(res.progress) || 0, info: res.info || null });
      if (status === 'success') return res;
      if (status === 'failed') throw new PanError('扫描失败，请稍后重试');
      await sleep(3000);
    }
    throw new PanError('扫描超时（40 分钟）');
  }

  async fetchGarbageList(type, taskid, onProgress) {
    const maxItems = Number(process.env.MAX_ITEMS) || (type === 'dup' ? 6000 : 8000);
    let start = 0;
    let items = [];
    let info = {};
    let guard = 0;
    let retries = 0;
    let truncated = false;
    let previousCrashed = false;

    while (guard++ < 4000) {
      let res;
      try {
        res = await this.api(
          `/api/garbagelist?${this.params()}&taskid=${taskid}&type=${encodeURIComponent(type)}&start=${start}&limit=150`
        );
      } catch (err) {
        // 31034：结果仍在生成 / 请求过快，退避重试
        if (err.code === 31034 && retries < 5) {
          retries++;
          await sleep(3000 * retries);
          continue;
        }
        if (err.code === 31034) {
          truncated = true;
          break;
        }
        throw err;
      }
      retries = 0;
      info = res.info || {};
      let list = res.list || [];

      // 重复文件分页以文件数切分，可能把同一组拆到两页，需要把续页首组并入上一组
      if (type === 'dup' && previousCrashed && items.length && list.length) {
        const target = items[items.length - 1];
        const seen = new Set((target.data || []).map((f) => f.path));
        const extra = (list[0].data || []).filter((f) => !seen.has(f.path));
        target.data = (target.data || []).concat(extra);
        list = list.slice(1);
      }

      items = items.concat(list);
      onProgress && onProgress({ loaded: items.length, hasMore: !!info.has_more });
      if (!info.has_more || list.length === 0) break;
      previousCrashed = !!info.group_crashed;
      start = info.next_index != null ? info.next_index : items.length;
      if (items.length >= maxItems) {
        truncated = true;
        break;
      }
      await sleep(200);
    }
    return { items, info, truncated };
  }

  async deleteFiles(type, taskid, paths, onProgress) {
    const res = await this.api(`/api/garbagedelete?${this.params()}`, {
      method: 'POST',
      form: { type, taskid, filelist: JSON.stringify(paths) },
    });
    const deleteId = res.delete_id;
    if (!deleteId) throw new PanError('删除任务创建失败');
    const deadline = Date.now() + 30 * 60 * 1000;
    while (Date.now() < deadline) {
      const q = await this.api(
        `/api/garbagetaskquery?${this.params()}&taskid=${deleteId}&option=delete&type=${encodeURIComponent(type)}`
      );
      const status = q.status;
      onProgress && onProgress({ status, progress: Number(q.progress) || 0 });
      if (status === 'success') return q;
      if (status === 'failed') throw new PanError('删除失败，请重试');
      await sleep(1500);
    }
    throw new PanError('删除超时（30 分钟）');
  }

  async close() {
    try {
      await this.context.close();
    } catch (e) {}
  }
}

async function openSession(account, { visible = false } = {}) {
  const context = await launchBrowser(account.profileDir, { visible });
  const page = context.pages()[0] || (await context.newPage());
  page.setDefaultTimeout(60000);
  await page.goto(CLEAR_URL, { waitUntil: 'domcontentloaded' });
  const info = await readSession(page);
  if (!info.uk) {
    return { context, page, session: null };
  }
  return { context, page, session: new Session(context, page, info) };
}

async function login(account, { timeoutMs = 10 * 60 * 1000 } = {}) {
  const context = await launchBrowser(account.profileDir, { visible: true });
  try {
    const page = context.pages()[0] || (await context.newPage());
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const info = await readSession(page);
      if (info.uk) {
        return info;
      }
      await sleep(2000);
    }
    throw new PanError('等待扫码登录超时，请重试');
  } finally {
    await context.close().catch(() => {});
  }
}

function normalize(type, rawItems) {
  const fileOf = (f) => ({
    path: f.path,
    name: f.server_filename || String(f.path || '').split('/').pop(),
    size: Number(f.size) || 0,
    isdir: !!f.isdir,
    mtime: Number(f.server_mtime) || 0,
    fs_id: f.fs_id != null ? String(f.fs_id) : '',
    smartChoose: f.smart_choose != null ? Number(f.smart_choose) : null,
  });

  if (type === 'dup') {
    return rawItems.map((group, index) => ({
      group: group.group_index != null ? group.group_index : index,
      files: (group.data || []).map(fileOf),
    }));
  }
  return rawItems.map(fileOf);
}

function buildReport(account, type, taskid, items, info, truncated, scanInfo) {
  const now = Date.now();
  const groups = normalize(type, items);
  const flat = type === 'dup' ? groups.flatMap((g) => g.files) : groups;

  const totalSize = flat.reduce((sum, f) => sum + (f.size || 0), 0);
  const stats = scanInfo && typeof scanInfo === 'object' ? scanInfo : {};

  const suggested = [];
  if (type === 'dup') {
    for (const g of groups) {
      const files = g.files.filter((f) => !f.isdelete);
      if (files.length < 2) continue;
      let keepIndex = 0;
      for (let i = 1; i < files.length; i++) {
        if (files[i].mtime > files[keepIndex].mtime) keepIndex = i;
      }
      files.forEach((f, i) => {
        if (i !== keepIndex) suggested.push(f.path);
      });
    }
  } else {
    for (const f of flat) if (!f.isdelete) suggested.push(f.path);
  }

  const stamp = (() => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  })();

  return {
    id: `${account.id}-${type}-${stamp}-${Math.random().toString(36).slice(2, 6)}`,
    accountId: account.id,
    accountName: account.name,
    uk: account.uk || '',
    type,
    typeLabel: TYPE_LABEL[type],
    taskid,
    createdAt: now,
    scannedFileNum: Number(stats.totalFileNum) || (info && info.totalFileNum ? info.totalFileNum : flat.length),
    truncated: !!truncated,
    meta: {
      totalGroupNum: stats.totalGroupNum != null ? Number(stats.totalGroupNum) : null,
      totalFileNum: stats.totalFileNum != null ? Number(stats.totalFileNum) : null,
      totalSize: stats.totalSize != null ? Number(stats.totalSize) : null,
      storedGroupNum: stats.storedGroupNum != null ? Number(stats.storedGroupNum) : null,
    },
    summary: {
      count: flat.length,
      groupCount: type === 'dup' ? groups.length : 0,
      size: totalSize,
    },
    groups: type === 'dup' ? groups : undefined,
    files: type === 'dup' ? undefined : groups,
    suggested,
  };
}

module.exports = {
  CLEAR_URL,
  TYPE_LABEL,
  PanError,
  Session,
  login,
  openSession,
  buildReport,
  sleep,
};
