// 飞书文档转换器 - Background Service Worker
// v2.9 新增：start_conversion 超时保护(60s Promise.race)、getTasks/saveTasks 错误降级

const STORAGE_KEY = 'conversion_tasks';
const TASK_TTL_MS = 30 * 60 * 1000; // 30 分钟过期
let lockChain = Promise.resolve(); // 串行锁链表

// === 存储（带降级） ===

async function getTasks() {
  try {
    const data = await chrome.storage.local.get(STORAGE_KEY);
    return data[STORAGE_KEY] || {};
  } catch (e) {
    console.warn('[飞书转换器] 读取任务存储失败:', e?.message || e);
    return {}; // 降级：返回空对象，允许系统继续运行
  }
}

async function saveTasks(tasks) {
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: tasks });
  } catch (e) {
    console.warn('[飞书转换器] 保存任务存储失败:', e?.message || e);
    // 静默降级：下次启动或清理时会自动恢复
  }
}

// === 串行锁（防止 getTasks→modify→saveTasks 竞态） ===

function withLock(fn) {
  lockChain = lockChain.then(fn, fn);
  return lockChain;
}

// === 任务管理 ===

async function setTask(taskId, updates) {
  return withLock(async () => {
    const tasks = await getTasks();
    tasks[taskId] = { ...(tasks[taskId] || {}), ...updates, updatedAt: Date.now() };
    await saveTasks(tasks);
  });
}

async function deleteTask(taskId) {
  return withLock(async () => {
    const tasks = await getTasks();
    delete tasks[taskId];
    await saveTasks(tasks);
  });
}

async function cleanupOldTasks() {
  return withLock(async () => {
    const tasks = await getTasks();
    const now = Date.now();
    let changed = false;
    for (const [id, task] of Object.entries(tasks)) {
      if (now - task.updatedAt > TASK_TTL_MS) {
        delete tasks[id];
        changed = true;
      }
    }
    if (changed) await saveTasks(tasks);
  });
}

// === 监听器 ===

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'start_conversion') {
    const { tabId, options } = request;
    const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // 异步处理，不阻塞 sendResponse
    (async () => {
      const task = {
        id: taskId,
        tabId,
        status: 'running',
        options,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      await setTask(taskId, task);

      // 向对应 tab 的 content script 发送转换请求（60s 超时保护）
      const CONVERT_TIMEOUT_MS = 60000;
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('转换超时 (60s)：Content script 无响应')), CONVERT_TIMEOUT_MS)
      );

      try {
        const result = await Promise.race([
          chrome.tabs.sendMessage(tabId, { action: 'convert', options }),
          timeoutPromise,
        ]);

        if (result && result.error) {
          task.status = 'error';
          task.error = result.error;
        } else {
          task.status = 'done';
          task.result = result;
        }
      } catch (err) {
        task.status = 'error';
        task.error = `Content script 无响应: ${err.message}`;
      }
      await setTask(taskId, task);

      sendResponse({ taskId });
    })();
    return true;
  }

  if (request.action === 'poll_task') {
    (async () => {
      const tasks = await getTasks();
      const task = tasks[request.taskId];
      sendResponse(task || { status: 'not_found' });
    })();
    return true;
  }

  if (request.action === 'list_active_tasks') {
    (async () => {
      const tasks = await getTasks();
      const active = Object.values(tasks).filter(t => t.status === 'running');
      sendResponse({ tasks: active });
    })();
    return true;
  }
});

// === 定时清理 ===

chrome.alarms.create('cleanup', { periodInMinutes: 10 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'cleanup') {
    cleanupOldTasks();
  }
});
