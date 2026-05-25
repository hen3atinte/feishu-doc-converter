// ============================================================
// 飞书文档转换器 - Background Service Worker (v2.6)
// 功能：持久转换（chrome.storage.local 防SW空闲丢失）、状态管理、下载代理
// v2.5 新增：alarm 定时清理过期任务（每5分钟）
// v2.6：版本号同步
// ============================================================

'use strict';

const STORAGE_KEY = 'conv_tasks';
const TASK_TTL_MS = 5 * 60 * 1000; // 任务过期时间：5分钟

// ---- 任务存储（chrome.storage.local 持久化） ----

async function getTasks() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return data[STORAGE_KEY] || {};
}

async function saveTasks(tasks) {
  await chrome.storage.local.set({ [STORAGE_KEY]: tasks });
}

async function getTask(taskId) {
  const tasks = await getTasks();
  return tasks[taskId] || null;
}

async function setTask(taskId, task) {
  const tasks = await getTasks();
  tasks[taskId] = task;
  await saveTasks(tasks);
}

async function deleteTask(taskId) {
  const tasks = await getTasks();
  delete tasks[taskId];
  await saveTasks(tasks);
}

// 清理过期任务
async function cleanupOldTasks() {
  const tasks = await getTasks();
  const now = Date.now();
  let changed = false;
  for (const [id, task] of Object.entries(tasks)) {
    if (now - task.timestamp > TASK_TTL_MS) {
      delete tasks[id];
      changed = true;
    }
  }
  if (changed) await saveTasks(tasks);
}

// 列出所有活跃任务（供 popup 恢复用）
async function listActiveTasks() {
  const tasks = await getTasks();
  const now = Date.now();
  const active = [];
  for (const [id, task] of Object.entries(tasks)) {
    if (task.status === 'pending' && (now - task.timestamp) < TASK_TTL_MS) {
      active.push({ id, tabId: task.tabId, timestamp: task.timestamp });
    }
  }
  return active;
}

// ---- 消息处理 ----

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // ---- 开始转换任务 ----
  if (request.action === 'start_conversion') {
    (async () => {
      await cleanupOldTasks();

      const tabId = request.tabId;
      const options = request.options || {};

      const taskId = `conv_${Date.now()}_${tabId}`;
      const task = {
        id: taskId,
        tabId,
        status: 'pending',
        timestamp: Date.now(),
        result: null,
        error: null,
      };
      await setTask(taskId, task);

      // 向对应 tab 的 content script 发送转换请求
      try {
        const result = await chrome.tabs.sendMessage(tabId, {
          action: 'convert',
          options,
        });

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

  // ---- 查询转换状态 ----
  if (request.action === 'get_status') {
    (async () => {
      const task = await getTask(request.taskId);
      if (!task) {
        sendResponse({ status: 'not_found', error: '任务不存在或已过期' });
      } else {
        sendResponse({
          status: task.status,
          result: task.result,
          error: task.error,
        });
      }
    })();
    return true;
  }

  // ---- 列出活跃任务（popup 恢复用） ----
  if (request.action === 'list_active_tasks') {
    (async () => {
      const active = await listActiveTasks();
      sendResponse({ tasks: active });
    })();
    return true;
  }

  // ---- 下载文件 ----
  if (request.action === 'download_file') {
    const filename = request.filename || 'document.md';
    const content = request.content || '';
    const mimeType = request.mimeType || 'text/markdown';

    // 使用 data URI
    const dataUri = `data:${mimeType};charset=utf-8,${encodeURIComponent(content)}`;

    chrome.downloads.download({
      url: dataUri,
      filename,
      saveAs: false,
    }).then(downloadId => {
      sendResponse({ success: true, downloadId });
    }).catch(err => {
      // data URI 可能超长，尝试用 Blob
      try {
        const blob = new Blob([content], { type: mimeType });
        const reader = new FileReader();
        reader.onload = () => {
          chrome.downloads.download({
            url: reader.result,
            filename,
            saveAs: false,
          }).then(id => {
            sendResponse({ success: true, downloadId: id });
          }).catch(e => {
            sendResponse({ success: false, error: e.message });
          });
        };
        reader.onerror = () => {
          sendResponse({ success: false, error: 'Blob 读取失败' });
        };
        reader.readAsDataURL(blob);
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
    });

    return true;
  }
});

// 启动时清理过期任务
cleanupOldTasks();

// 定时清理：每 5 分钟清理一次过期任务（防止 SW 长时间未重启导致堆积）
chrome.alarms.create('cleanup_tasks', { periodInMinutes: 5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'cleanup_tasks') {
    cleanupOldTasks();
  }
});
