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
    2: '请求参数有误或登录状态异常，请重新授权后重试',
    4: '登录状态已失效，请重新扫码授权',
    12: '文件不存在或已被删除',
    '-9': '文件不存在或已被删除',
    105: '文件不存在或已被删除',
    31066: '文件不存在或已被删除',
    114: '百度暂时拒绝删除（errno=114，通常是操作频繁或文件状态变化），稍后重试即可',
  };
  return map[String(errno)] || `接口返回错误（errno=${errno}）`;
}

const MISSING_CODES = new Set(['12', '-9', '105', '31066']);
// 114：百度侧的临时拒绝（常见于连续删除过久/过于频繁），不是登录或参数问题
const TRANSIENT_CODES = new Set(['114', '31034', '-1']);
const AUTH_CODES = new Set(['104', '-6', '4', '31045']);

// 文件在网盘上已经不存在（常见于扫描后又被手动删除），此时应直接按已删除记录
function isMissingError(err) {
  if (!err) return false;
  if (err.code !== undefined && err.code !== null && MISSING_CODES.has(String(err.code))) return true;
  return /不存在|已被删除|已删除|not\s*exist|no\s*such/i.test(err.message || '');
}

function verifyRequiredError() {
  const err = new PanError(
    '百度要求完成身份验证：已为你打开网盘页面，请在页面里手动删除任意一个文件并按其提示完成验证，然后回到工具重试',
    132
  );
  err.verifyNeeded = true;
  return err;
}

function preferredChannel() {
  if (process.env.PAN_BROWSER) return String(process.env.PAN_BROWSER);
  const cfg = readConfig();
  if (cfg.browser) return String(cfg.browser);
  return 'msedge';
}

function readConfig() {
  try {
    const file = path.join(__dirname, '..', 'data', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    return cfg && typeof cfg === 'object' ? cfg : {};
  } catch (e) {
    return {};
  }
}

// 百度风控：一次删太多会触发验证，默认每批 10 个、批间稍作停顿
function deleteBatchOptions() {
  const cfg = readConfig();
  const batch = Number(process.env.DELETE_BATCH || cfg.deleteBatch) || 10;
  const delay = Number(process.env.DELETE_DELAY || cfg.deleteDelay);
  const retry = Number(process.env.DELETE_RETRY_DELAY || cfg.deleteRetryDelay);
  return {
    batchSize: Math.max(1, Math.min(50, Math.floor(batch))),
    delayMs: Number.isFinite(delay) && delay >= 0 ? delay : 1200,
    retryDelayMs: Number.isFinite(retry) && retry >= 0 ? retry : 4000,
  };
}

function clearProfileLock(profileDir) {
  for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    try {
      fs.rmSync(path.join(profileDir, name), { force: true });
    } catch (e) {}
  }
}

function killProfileBrowsers(profileDir) {
  if (process.platform !== 'win32') return;
  const escaped = String(profileDir).replace(/'/g, "''");
  const script =
    `Get-CimInstance Win32_Process -Filter "Name='msedge.exe' or Name='chrome.exe'" | ` +
    `Where-Object { $_.CommandLine -like '*${escaped}*' } | ` +
    `ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
  try {
    require('child_process').execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      stdio: 'ignore',
      timeout: 15000,
    });
  } catch (e) {}
}

let cachedScreen = null;
function getScreenSize() {
  if (cachedScreen) return cachedScreen;
  try {
    const out = require('child_process')
      .execFileSync(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Add-Type -AssemblyName System.Windows.Forms; $w=[System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea; "$($w.Width)x$($w.Height)"',
        ],
        { windowsHide: true, timeout: 8000 }
      )
      .toString()
      .trim();
    const match = out.match(/(\d+)x(\d+)/);
    if (match) cachedScreen = { width: Number(match[1]), height: Number(match[2]) };
  } catch (e) {}
  return cachedScreen || { width: 1366, height: 768 };
}

function centeredWindowArgs() {
  const screen = getScreenSize();
  const width = Math.max(900, Math.min(1280, screen.width - 100));
  const height = Math.max(640, Math.min(900, screen.height - 100));
  const x = Math.max(0, Math.round((screen.width - width) / 2));
  const y = Math.max(0, Math.round((screen.height - height) / 2));
  return [`--window-size=${width},${height}`, `--window-position=${x},${y}`];
}

async function centerBrowserWindow(context, page) {
  try {
    const screen = getScreenSize();
    const width = Math.max(900, Math.min(1200, screen.width - 120));
    const height = Math.max(600, Math.min(820, screen.height - 120));
    const left = Math.max(0, Math.round((screen.width - width) / 2));
    const top = Math.max(0, Math.round((screen.height - height) / 2));
    const cdp = await context.newCDPSession(page);
    const info = await cdp.send('Browser.getWindowForTarget');
    await cdp.send('Browser.setWindowBounds', {
      windowId: info.windowId,
      bounds: { left, top, width, height, windowState: 'normal' },
    });
    await cdp.detach().catch(() => {});
  } catch (e) {}
}

function openBrowserWindow(profileDir, url) {
  if (process.platform !== 'win32') return;
  const candidates = [
    `${process.env['ProgramFiles(x86)'] || ''}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${process.env.ProgramFiles || ''}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${process.env.ProgramFiles || ''}\\Google\\Chrome\\Application\\chrome.exe`,
  ];
  const exe = candidates.find((candidate) => candidate && fs.existsSync(candidate));
  if (!exe) return;
  try {
    require('child_process')
      .spawn(exe, [`--user-data-dir=${profileDir}`, '--new-window', ...centeredWindowArgs(), url], {
        detached: true,
        stdio: 'ignore',
      })
      .unref();
  } catch (e) {}
}

async function launchBrowser(profileDir, { visible = false } = {}) {
  fs.mkdirSync(profileDir, { recursive: true });
  const args = ['--no-first-run', '--no-default-browser-check', '--disable-blink-features=AutomationControlled'];
  if (visible) args.push('--new-window', ...centeredWindowArgs());
  else args.push('--window-position=-32000,-32000', '--window-size=1280,900');

  const preferred = preferredChannel();
  const channels = [preferred, 'msedge', 'chrome'].filter((value, index, list) => value && list.indexOf(value) === index);

  const attempt = async () => {
    let lastError = null;
    for (const channel of channels) {
      try {
        return await withTimeout(
          chromium.launchPersistentContext(profileDir, {
            channel,
            headless: false,
            viewport: visible ? undefined : { width: 1280, height: 900 },
            args,
          }),
          60000,
          '启动浏览器超时'
        );
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError || new Error('未知错误');
  };

  try {
    return await attempt();
  } catch (firstError) {
    // 常见原因：上次授权窗口未关闭 / Chrome 崩溃残留锁，清理后重试一次
    killProfileBrowsers(profileDir);
    clearProfileLock(profileDir);
    await sleep(1200);
    try {
      return await attempt();
    } catch (secondError) {
      killProfileBrowsers(profileDir);
      clearProfileLock(profileDir);
      const message = (secondError && secondError.message) || String(secondError);
      if (/Target page, context or browser has been closed|已在另一个会话|ProcessSingleton/i.test(message)) {
        throw new PanError('授权用的浏览器窗口被占用，已自动清理但未能启动，请稍后重试');
      }
      throw new PanError(`无法启动浏览器（已尝试 ${channels.join(' / ')}）：${message.slice(0, 300)}`);
    }
  }
}

function withTimeout(promise, ms, message) {
  let timer = null;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
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
    try {
      await this.deleteViaGarbage(type, taskid, paths, onProgress);
      return { deleted: paths.length, failed: 0, method: 'garbage', deletedPaths: paths };
    } catch (err) {
      // 131/7002：清理功能的删除受会员限制；132：触发身份验证；文件已不存在：都改走普通文件删除
      if (
        err.code === 131 ||
        err.code === 7002 ||
        err.code === 7001 ||
        err.code === 2 ||
        err.code === 132 ||
        isMissingError(err) ||
        TRANSIENT_CODES.has(String(err.code))
      ) {
        onProgress && onProgress({ status: 'running', progress: 2 });
        return this.deleteViaFileManager(paths, onProgress);
      }
      throw err;
    }
  }

  async deleteViaGarbage(type, taskid, paths, onProgress) {
    const res = await this.api(`/api/garbagedelete?${this.params()}`, {
      method: 'POST',
      form: { type, taskid, filelist: JSON.stringify(paths) },
    });
    const deleteId = res.delete_id;
    if (!deleteId) throw new PanError('删除任务创建失败', 2);
    const deadline = Date.now() + 30 * 60 * 1000;
    while (Date.now() < deadline) {
      const q = await this.api(
        `/api/garbagetaskquery?${this.params()}&taskid=${deleteId}&option=delete&type=${encodeURIComponent(type)}`
      );
      const status = q.status;
      onProgress && onProgress({ status, progress: Number(q.progress) || 0 });
      if (status === 'success') return q;
      // 清理任务失败（常见原因是文件已被删掉）：交给普通删除逐条核对
      if (status === 'failed') throw new PanError('清理删除任务失败，改为普通删除重试', 2);
      await sleep(1500);
    }
    throw new PanError('删除超时（30 分钟）', 2);
  }

  fileManagerQuery() {
    return `async=2&onnest=fail&opera=delete&newVerify=1&clienttype=0&app_id=250528&web=1&bdstoken=${encodeURIComponent(
      this.bdstoken || ''
    )}`;
  }

  async submitFileDelete(chunk) {
    return this.api(`/api/filemanager?${this.fileManagerQuery()}`, {
      method: 'POST',
      form: { filelist: JSON.stringify(chunk) },
    });
  }

  async waitFileDelete(taskid) {
    const deadline = Date.now() + 5 * 60 * 1000;
    while (Date.now() < deadline) {
      let q;
      try {
        q = await this.api(
          `/share/taskquery?taskid=${encodeURIComponent(taskid)}&clienttype=0&app_id=250528&web=1`
        );
      } catch (err) {
        if (err.code === 132 || AUTH_CODES.has(String(err.code))) throw err;
        // 任务查询异常（例如 errno=114 任务已失效）：交给逐条核对，不要中断整批删除
        return 'unknown';
      }
      if (q.status === 'success') return 'success';
      if (q.status === 'failed') return 'failed';
      await sleep(1000);
    }
    return 'unknown';
  }

  // 逐个重试：区分「文件已不存在」与真正的失败，已不存在的按已删除记录
  async deleteIndividually(chunk, state, delayMs) {
    for (const filePath of chunk) {
      try {
        const res = await this.submitFileDelete([filePath]);
        const status = res.taskid ? await this.waitFileDelete(res.taskid) : 'success';
        if (status === 'success') {
          state.deleted++;
          state.deletedPaths.push(filePath);
        } else {
          state.failed++;
        }
      } catch (err) {
        if (err.code === 132) {
          if (!state.deleted) throw verifyRequiredError();
          state.verifyNeeded = true;
          return;
        }
        if (AUTH_CODES.has(String(err.code))) throw err;
        if (isMissingError(err)) {
          state.deleted++;
          state.missing++;
          state.deletedPaths.push(filePath);
        } else {
          state.failed++;
          state.lastError = err.message;
        }
      }
      await sleep(Math.min(300, delayMs));
    }
  }

  async deleteViaFileManager(paths, onProgress) {
    const { batchSize, delayMs, retryDelayMs } = deleteBatchOptions();
    const state = {
      deleted: 0,
      failed: 0,
      missing: 0,
      deletedPaths: [],
      verifyNeeded: false,
      stopped: false,
      lastError: null,
    };
    let emptyBatches = 0;

    const runBatch = async (chunk) => {
      const res = await this.submitFileDelete(chunk);
      if (!res.taskid) return 'success';
      return this.waitFileDelete(res.taskid);
    };

    for (let i = 0; i < paths.length; i += batchSize) {
      const chunk = paths.slice(i, i + batchSize);
      const before = state.deleted;
      try {
        const status = await runBatch(chunk);
        if (status === 'success') {
          state.deleted += chunk.length;
          state.deletedPaths.push(...chunk);
        } else {
          // 任务失败/查询不到时逐条核对，已经删掉/不存在的不会重复报错
          await this.deleteIndividually(chunk, state, delayMs);
        }
      } catch (err) {
        if (err.code === 132) {
          if (!state.deleted) throw verifyRequiredError();
          state.verifyNeeded = true;
        } else if (AUTH_CODES.has(String(err.code))) {
          throw err;
        } else if (isMissingError(err)) {
          await this.deleteIndividually(chunk, state, delayMs);
        } else if (TRANSIENT_CODES.has(String(err.code))) {
          // 百度临时拒绝（如 errno=114）：暂停几秒后重试这一批，仍不行就计入失败继续
          state.lastError = err.message;
          await sleep(retryDelayMs + Math.round(Math.random() * 1000));
          try {
            const status = await runBatch(chunk);
            if (status === 'success') {
              state.deleted += chunk.length;
              state.deletedPaths.push(...chunk);
            } else {
              await this.deleteIndividually(chunk, state, delayMs);
            }
          } catch (err2) {
            if (err2.code === 132) {
              if (!state.deleted) throw verifyRequiredError();
              state.verifyNeeded = true;
            } else if (AUTH_CODES.has(String(err2.code))) {
              throw err2;
            } else if (isMissingError(err2)) {
              await this.deleteIndividually(chunk, state, delayMs);
            } else {
              state.failed += chunk.length;
              state.lastError = err2.message;
            }
          }
        } else {
          throw err;
        }
      }
      onProgress &&
        onProgress({
          status: 'running',
          progress: Math.round((state.deleted / paths.length) * 100),
          method: 'filemanager',
          message: state.missing
            ? `已处理 ${state.deleted} / ${paths.length} 项（其中 ${state.missing} 项此前已不存在）`
            : `已删除 ${state.deleted} / ${paths.length} 项`,
        });
      if (state.verifyNeeded) break;
      // 连续 3 个批次都没删掉任何文件，多半是被限流了：先停下，保留已删记录
      if (state.deleted === before) emptyBatches++;
      else emptyBatches = 0;
      if (emptyBatches >= 3) {
        state.stopped = true;
        break;
      }
      if (i + batchSize < paths.length) await sleep(delayMs + Math.round(Math.random() * 800));
    }
    if (!state.deleted && (state.failed || state.stopped)) {
      throw new PanError(state.lastError || '删除失败，请稍后重试或在网页版手动删除');
    }
    if (state.verifyNeeded) {
      return {
        deleted: state.deleted,
        failed: paths.length - state.deleted,
        method: 'filemanager',
        deletedPaths: state.deletedPaths,
        missing: state.missing,
        verifyNeeded: true,
        remaining: paths.length - state.deleted,
      };
    }
    if (state.stopped) {
      return {
        deleted: state.deleted,
        failed: paths.length - state.deleted,
        method: 'filemanager',
        deletedPaths: state.deletedPaths,
        missing: state.missing,
        stopped: true,
        stopReason: state.lastError || '百度连续拒绝删除',
        remaining: paths.length - state.deleted,
      };
    }
    if (state.failed && onProgress) {
      onProgress({ status: 'running', progress: 100, message: `有 ${state.failed} 项删除失败` });
    }
    return {
      deleted: state.deleted,
      failed: state.failed,
      method: 'filemanager',
      deletedPaths: state.deletedPaths,
      missing: state.missing,
    };
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
  if (visible) await centerBrowserWindow(context, page);
  await page.goto(CLEAR_URL, { waitUntil: 'domcontentloaded' });
  const info = await readSession(page);
  if (!info.uk) {
    return { context, page, session: null };
  }
  const session = new Session(context, page, info);
  session.profileDir = account.profileDir;
  return { context, page, session };
}

async function login(account, { timeoutMs = 10 * 60 * 1000, onStage, shouldStop } = {}) {
  const stage = (text) => onStage && onStage(text);
  stage('正在打开授权窗口');
  // 上一次授权窗口刚关闭时，Chrome 进程可能还没完全退出，稍等一下避免复用同一个配置目录冲突
  await sleep(700);
  const context = await launchBrowser(account.profileDir, { visible: true });
  let userClosed = false;
  context.on('close', () => {
    userClosed = true;
  });
  try {
    const page = context.pages()[0] || (await context.newPage());
    page.setDefaultTimeout(30000);
    await centerBrowserWindow(context, page);
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.bringToFront().catch(() => {});

    let info = await readSession(page);
    if (!info.uk) {
      // 登录页默认是官网落地页，需要点「去登录」才会弹出二维码
      stage('等待扫码授权');
      const entry = page.getByRole('button', { name: '去登录' });
      const entryCount = await entry.count().catch(() => 0);
      if (entryCount > 0) {
        await entry.first().click({ timeout: 8000 }).catch(() => {});
        await sleep(1200);
      }
      await page.bringToFront().catch(() => {});
    }

    const deadline = Date.now() + timeoutMs;
    const launchedAt = Date.now();
    while (Date.now() < deadline) {
      if (shouldStop && shouldStop()) throw new PanError('授权已取消');
      // 刚启动的窗口可能还在初始化，给 3 秒缓冲再判断是否被关闭
      if (Date.now() - launchedAt > 3000 && (userClosed || context.pages().length === 0)) {
        throw new PanError('授权窗口已关闭，请重新点击「扫码授权」');
      }
      info = await readSession(page);
      if (info.uk) {
        stage('授权成功');
        return info;
      }
      await sleep(1500);
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
  openBrowserWindow,
  buildReport,
  sleep,
};
