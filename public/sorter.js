(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PanSorter = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const SORT_FILE = {
    'mtime-desc': (a, b) => (b.mtime || 0) - (a.mtime || 0),
    'mtime-asc': (a, b) => (a.mtime || 0) - (b.mtime || 0),
    'size-desc': (a, b) => (b.size || 0) - (a.size || 0),
    'size-asc': (a, b) => (a.size || 0) - (b.size || 0),
    'path-asc': (a, b) => String(a.path || '').localeCompare(String(b.path || ''), 'zh-CN'),
    'path-desc': (a, b) => String(b.path || '').localeCompare(String(a.path || ''), 'zh-CN'),
  };

  function groupMetrics(group) {
    const files = group.files || [];
    let newest = 0;
    let oldest = Number.MAX_SAFE_INTEGER;
    let maxSize = 0;
    let totalSize = 0;
    let firstPath = null;
    for (const file of files) {
      const mtime = file.mtime || 0;
      if (mtime > newest) newest = mtime;
      if (mtime && mtime < oldest) oldest = mtime;
      if ((file.size || 0) > maxSize) maxSize = file.size || 0;
      totalSize += file.size || 0;
      if (firstPath == null || String(file.path) < firstPath) firstPath = String(file.path);
    }
    return {
      newest,
      oldest: oldest === Number.MAX_SAFE_INTEGER ? 0 : oldest,
      maxSize,
      totalSize,
      count: group.total != null ? group.total : files.length,
      firstPath: firstPath || '',
    };
  }

  function applySort(view, sort, type) {
    if (!sort) return view;
    const fileCmp = SORT_FILE[sort];

    if (type === 'dup') {
      if (fileCmp) view.groups.forEach((group) => group.files.sort(fileCmp));
      const entries = view.groups.map((group) => ({ group, metrics: groupMetrics(group) }));
      let cmp = null;
      if (sort === 'count-desc') cmp = (a, b) => b.metrics.count - a.metrics.count;
      else if (sort === 'count-asc') cmp = (a, b) => a.metrics.count - b.metrics.count;
      else if (sort === 'groupsize-desc') cmp = (a, b) => b.metrics.totalSize - a.metrics.totalSize;
      else if (sort === 'groupsize-asc') cmp = (a, b) => a.metrics.totalSize - b.metrics.totalSize;
      else if (sort.indexOf('mtime') === 0)
        cmp = (a, b) => (sort.endsWith('desc') ? b.metrics.newest - a.metrics.newest : a.metrics.oldest - b.metrics.oldest);
      else if (sort.indexOf('size') === 0)
        cmp = (a, b) => (sort.endsWith('desc') ? b.metrics.maxSize - a.metrics.maxSize : a.metrics.maxSize - b.metrics.maxSize);
      else if (sort.indexOf('path') === 0)
        cmp = (a, b) =>
          sort.endsWith('desc')
            ? b.metrics.firstPath.localeCompare(a.metrics.firstPath, 'zh-CN')
            : a.metrics.firstPath.localeCompare(b.metrics.firstPath, 'zh-CN');
      if (cmp) entries.sort(cmp);
      view.groups = entries.map((entry) => entry.group);
      return view;
    }

    if (fileCmp) view.files.sort(fileCmp);
    return view;
  }

  return { applySort, groupMetrics, SORT_FILE };
});
