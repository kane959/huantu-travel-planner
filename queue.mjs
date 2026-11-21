/**
 * 寰途任务队列
 *
 * 目的：把「研究目的地 + 编排行程」这种可能超过网关时限的长任务从 HTTP 请求里挪出去。
 * 请求只负责创建任务并立刻返回 jobId，前端按 2 秒轮询状态。
 *
 * 当前实现是本地内存队列（单进程、重启即失，符合本机版的隐私取向）。
 * Redis 适配器只留接口与明确报错，不提供半成品实现——避免有人以为它可以持久化。
 */

export const JOB_STATUS = {
  PENDING: 'pending',
  RESEARCHING: 'researching',
  PLANNING: 'planning',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

export const TERMINAL_STATUS = new Set([
  JOB_STATUS.COMPLETED,
  JOB_STATUS.FAILED,
  JOB_STATUS.CANCELLED,
]);

export const STAGE_LABEL = {
  pending: '任务已创建，等待开始',
  researching: '正在研究目的地',
  planning: '正在编排行程',
  completed: '已完成',
  failed: '生成失败',
  cancelled: '已取消',
};

function createMemoryQueue({ ttlMs = 30 * 60 * 1000, maxPerSession = 10, now = () => Date.now() } = {}) {
  const jobs = new Map();

  function prune() {
    const cutoff = now() - ttlMs;
    for (const [id, job] of jobs) {
      if (job.finishedAt && Date.parse(job.finishedAt) < cutoff) jobs.delete(id);
    }
    // 同一会话积压过多时丢掉最老的已完成任务
    const bySession = new Map();
    for (const [id, job] of jobs) {
      const list = bySession.get(job.sessionId) || [];
      list.push(id);
      bySession.set(job.sessionId, list);
    }
    for (const list of bySession.values()) {
      if (list.length <= maxPerSession) continue;
      const removable = list.filter((id) => TERMINAL_STATUS.has(jobs.get(id)?.status)).slice(0, list.length - maxPerSession);
      for (const id of removable) jobs.delete(id);
    }
  }

  return {
    kind: 'memory',
    create(job) {
      prune();
      // 刻意保存同一个对象引用：执行器持有 job 后，状态更新与取消标记能立刻互相可见
      jobs.set(job.id, job);
      return job;
    },
    get(id) {
      return jobs.get(id) || null;
    },
    update(id, patch) {
      const job = jobs.get(id);
      if (!job) return null;
      Object.assign(job, patch);
      return job;
    },
    delete(id) {
      return jobs.delete(id);
    },
    listBySession(sessionId) {
      return [...jobs.values()].filter((job) => job.sessionId === sessionId);
    },
    prune,
    get size() {
      return jobs.size;
    },
  };
}

/**
 * Redis 适配器占位。
 *
 * 真正实现时需要保证：任务状态、阶段耗时、错误信息、结果 planId 都能持久化，
 * 并且取消信号能跨进程传递（一般是 redis pub/sub + 执行端订阅）。
 * 在那之前，选择 redis 会直接报错，而不是悄悄退回内存队列。
 */
export function createRedisQueue({ url = '' } = {}) {
  const notImplemented = () => {
    throw Object.assign(
      new Error('Redis 队列尚未实现：当前版本只提供本地内存队列。请设置 HUANTU_QUEUE=memory，或先补齐 Redis 适配器的持久化与取消语义。'),
      { status: 501 },
    );
  };
  return {
    kind: 'redis',
    url,
    create: notImplemented,
    get: notImplemented,
    update: notImplemented,
    delete: notImplemented,
    listBySession: notImplemented,
    prune: () => {},
    get size() {
      return 0;
    },
  };
}

export function createQueue({ driver = 'memory', ...options } = {}) {
  if (driver === 'redis') return createRedisQueue(options);
  if (driver !== 'memory') {
    throw Object.assign(new Error(`不支持的队列类型：${driver}`), { status: 500 });
  }
  return createMemoryQueue(options);
}
