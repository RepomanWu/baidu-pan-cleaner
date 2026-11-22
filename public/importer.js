(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PanImporter = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const TYPE_LABEL = { dup: '重复文件', rub: '垃圾视频', empty: '空文件夹' };

  function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    const src = String(text || '').replace(/^\uFEFF/, '');
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (quoted) {
        if (ch === '"') {
          if (src[i + 1] === '"') {
            field += '"';
            i++;
          } else {
            quoted = false;
          }
        } else {
          field += ch;
        }
      } else if (ch === '"') {
        quoted = true;
      } else if (ch === ',') {
        row.push(field);
        field = '';
      } else if (ch === '\n') {
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
      } else if (ch !== '\r') {
        field += ch;
      }
    }
    if (field.length || row.length) {
      row.push(field);
      rows.push(row);
    }
    return rows.filter((cells) => cells.some((cell) => String(cell).trim() !== ''));
  }

  function parseCsvTime(value) {
    const match = String(value || '').match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})[ T](\d{1,2}):(\d{2}):(\d{2})/);
    if (!match) return 0;
    return Math.floor(new Date(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +match[6]).getTime() / 1000);
  }

  function reportFromCsv(text, account) {
    const rows = parseCsv(text);
    if (rows.length < 2) throw new Error('CSV 内容为空');
    const header = rows[0].map((cell) => String(cell).trim());
    const indexOf = (name) => header.indexOf(name);
    const iType = indexOf('类型');
    const iPath = indexOf('路径');
    const iSize = indexOf('大小(字节)');
    const iTime = indexOf('修改时间');
    const iGroup = indexOf('重复组');
    if (iPath < 0) throw new Error('CSV 缺少「路径」列，请使用工具导出的 CSV');

    const typeMap = { 重复文件: 'dup', 垃圾视频: 'rub', 空文件夹: 'empty' };
    let type = null;
    const files = [];
    for (let i = 1; i < rows.length; i++) {
      const cells = rows[i];
      const label = String(iType >= 0 ? cells[iType] || '' : '').trim();
      if (typeMap[label]) type = type || typeMap[label];
      const path = String(cells[iPath] || '').trim();
      if (!path) continue;
      const groupText = iGroup >= 0 ? String(cells[iGroup] || '').trim() : '';
      files.push({
        path,
        name: path.split('/').pop(),
        size: Number(iSize >= 0 ? cells[iSize] : 0) || 0,
        mtime: iTime >= 0 ? parseCsvTime(cells[iTime]) : 0,
        isdir: label.includes('文件夹'),
        group: groupText === '' ? null : Number(groupText),
      });
    }
    if (!files.length) throw new Error('CSV 中没有可导入的行');
    if (!type) type = files.some((file) => file.isdir) ? 'empty' : 'rub';

    const size = files.reduce((sum, file) => sum + file.size, 0);
    const base = {
      id: '',
      accountId: account.id,
      accountName: account.name,
      uk: account.uk || '',
      type,
      typeLabel: TYPE_LABEL[type],
      taskid: null,
      createdAt: Date.now(),
      imported: true,
      summary: { count: files.length, groupCount: 0, size },
    };

    if (type === 'dup') {
      const map = new Map();
      files.forEach((file, index) => {
        const key = file.group == null ? `row-${index}` : file.group;
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(file);
      });
      const groups = [...map.entries()].map(([group, list]) => ({ group, files: list }));
      const suggested = [];
      for (const group of groups) {
        let keep = 0;
        group.files.forEach((file, index) => {
          if (file.mtime > group.files[keep].mtime) keep = index;
        });
        group.files.forEach((file, index) => {
          if (index !== keep) suggested.push(file.path);
        });
      }
      return { ...base, summary: { ...base.summary, groupCount: groups.length }, groups, suggested };
    }
    return { ...base, files, suggested: files.map((file) => file.path) };
  }

  return { parseCsv, parseCsvTime, reportFromCsv };
});
