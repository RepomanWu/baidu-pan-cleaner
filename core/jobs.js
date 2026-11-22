'use strict';

const crypto = require('crypto');

const jobs = new Map();
const MAX_JOBS = 100;

function create(kind, meta) {
  const job = {
    id: crypto.randomBytes(6).toString('hex'),
    kind,
    status: 'running',
    stage: '',
    progress: 0,
    message: '',
    result: null,
    error: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...meta,
  };
  jobs.set(job.id, job);
  if (jobs.size > MAX_JOBS) {
    const oldest = [...jobs.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
    if (oldest) jobs.delete(oldest.id);
  }
  return job;
}

function update(id, patch) {
  const job = jobs.get(id);
  if (!job) return null;
  Object.assign(job, patch, { updatedAt: Date.now() });
  return job;
}

function get(id) {
  const job = jobs.get(id);
  if (!job) return null;
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    message: job.message,
    result: job.result,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

function list() {
  return [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 20).map((j) => get(j.id));
}

function cancelRunning(kind, accountId) {
  let count = 0;
  for (const job of jobs.values()) {
    if (job.kind === kind && job.status === 'running' && job.accountId === accountId) {
      job.cancelled = true;
      count++;
    }
  }
  return count;
}

module.exports = { create, update, get, list, cancelRunning };
