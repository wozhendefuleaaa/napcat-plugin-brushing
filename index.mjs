import fs from 'fs';
import path from 'path';

const API_URL = 'http://222.186.150.90:11111/ccc.php';
const INTERVAL_12H = 12 * 60 * 60 * 1000;
const INTERVAL_10M = 10 * 60 * 1000;
const HELP_CMD = '#互刷帮助';
const HELP_MSG = `【官机互刷插件帮助】
作者：蛙蛙
功能：自动与在线官机互刷提升DAU

使用步骤：
1. 访问 http://222.186.150.90:11111/ 绑定野机QQ和官机QQ
2. 安装本插件后自动运行

运行机制：
- Bot连接时自动启动
- 每10分钟更新在线状态
- 每12小时执行一次互刷（每天仅一次）

帮助/需求群
- 649909855

命令：
${HELP_CMD} - 显示本帮助`;

let logger = null;
let ctx = null;
let selfQQ = '';
let recordPath = '';
let timers = { run: null, hook: null };
let initialized = false;

// Protobuf编码
function encodeVarint(v) {
  const b = [];
  while (v > 0x7f) { b.push((v & 0x7f) | 0x80); v >>>= 7; }
  b.push(v & 0x7f);
  return b;
}

function pbField(f, t, d) { return [...encodeVarint((f << 3) | t), ...d]; }
function pbVarint(f, v) { return pbField(f, 0, encodeVarint(v)); }
function pbBytes(f, d) { return pbField(f, 2, [...encodeVarint(d.length), ...d]); }
function pbString(f, s) { return pbBytes(f, [...Buffer.from(s)]); }

function buildAddFriendHex(uin) {
  const inner = pbVarint(1, uin);
  const pkt = [
    ...pbVarint(1, 36984),
    ...pbVarint(2, 1),
    ...pbBytes(4, inner),
    ...pbString(6, 'android 9.0.90')
  ];
  return Buffer.from(pkt).toString('hex');
}

function today() { return new Date().toISOString().slice(0, 10); }

function readRecord() {
  try { return fs.existsSync(recordPath) ? JSON.parse(fs.readFileSync(recordPath, 'utf-8')) : {}; } catch { return {}; }
}

function writeRecord(r) {
  try { fs.writeFileSync(recordPath, JSON.stringify(r, null, 2)); } catch {}
}

function hasRunToday() { return readRecord()[selfQQ] === today(); }

function markRunToday() {
  const r = readRecord();
  const keys = Object.keys(r).sort();
  while (keys.length > 7) delete r[keys.shift()];
  r[selfQQ] = today();
  writeRecord(r);
}

async function apiCall(action, params = {}) {
  logger?.info(`[互刷] API调用: action=${action}, params=${JSON.stringify(params)}`);
  try {
    const p = new URLSearchParams();
    p.append('action', String(action));
    for (const [k, v] of Object.entries(params)) p.append(k, String(v));
    
    const res = await fetch(API_URL, {
      method: 'POST',
      body: p,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    const result = await res.json();
    logger?.info(`[互刷] API响应: ${JSON.stringify(result)}`);
    return result;
  } catch (e) {
    logger?.error(`[互刷] API调用失败: ${e.message}`);
    return { code: -1 };
  }
}

async function updateOnline() {
  logger?.info(`[互刷] 更新在线状态: QQ=${selfQQ}`);
  const r = await apiCall(2, { qq: selfQQ });
  if (r.code !== 0) logger?.warn(`[互刷] 更新在线状态失败: ${JSON.stringify(r)}`);
}

async function getOnlineBots() {
  logger?.info(`[互刷] 获取在线bot列表: QQ=${selfQQ}`);
  const r = await apiCall(3, { qq: selfQQ });
  if (r.code === 0) {
    logger?.info(`[互刷] 在线bot列表: ${JSON.stringify(r.data || [])}`);
    return r.data || [];
  }
  logger?.warn(`[互刷] 获取在线bot列表失败: ${JSON.stringify(r)}`);
  return [];
}

async function sendPacket(cmd, hex) {
  logger?.info(`[互刷] 发送数据包: cmd=${cmd}`);
  try {
    await ctx.actions.call('send_packet', { cmd, data: hex, rsp: false }, ctx.adapterName, ctx.pluginManager.config);
    logger?.info(`[互刷] 数据包发送成功`);
  } catch (e) {
    // "No data returned" 是正常的，因为rsp=false不需要返回
    if (e.message?.includes('No data returned')) {
      logger?.info(`[互刷] 数据包已发送（无返回数据）`);
    } else {
      logger?.error(`[互刷] 发送数据包失败: ${e.message}`);
    }
  }
}

async function sendPrivateMsg(userId, msg) {
  logger?.info(`[互刷] 发送私聊消息: userId=${userId}, msg=${msg}`);
  try {
    await ctx.actions.call('send_private_msg', { user_id: String(userId), message: msg }, ctx.adapterName, ctx.pluginManager.config);
    logger?.info(`[互刷] 私聊消息发送成功`);
  } catch (e) {
    logger?.error(`[互刷] 发送私聊消息失败: ${e.message}`);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function run() {
  logger?.info(`[互刷] 开始执行run函数`);
  if (hasRunToday()) {
    logger?.info(`[互刷] 今日已执行过，QQ: ${selfQQ}，跳过`);
    return;
  }
  
  await updateOnline();
  const onlineBots = await getOnlineBots();
  
  if (onlineBots.length === 0) {
    logger?.info('[互刷] 没有在线的bot，跳过处理');
    return;
  }
  
  logger?.info(`[互刷] 开始互刷，共${onlineBots.length}个bot`);
  for (const bot_uin of onlineBots) {
    logger?.info(`[互刷] 处理bot: ${bot_uin}`);
    const hex = buildAddFriendHex(Number(bot_uin));
    await sendPacket('OidbSvcTrpcTcp.0x9078_1', hex);
    await sleep(1000);
    await sendPrivateMsg(bot_uin, '菜单');
    await sleep(6000);
  }
  
  markRunToday();
  logger?.info('[互刷] 互刷完成');
}

async function hookOnline() {
  logger?.info(`[互刷] 执行hookOnline`);
  await updateOnline();
}

async function startBrush() {
  logger?.info(`[互刷] 启动互刷流程，QQ: ${selfQQ}`);
  
  if (timers.run) clearInterval(timers.run);
  if (timers.hook) clearInterval(timers.hook);
  
  await hookOnline();
  await run();
  
  timers.hook = setInterval(hookOnline, INTERVAL_10M);
  timers.run = setInterval(async () => {
    if (!hasRunToday()) await run();
  }, INTERVAL_12H);
  
  logger?.info(`[互刷] 定时器已设置`);
}

const plugin_init = async (c) => {
  logger = c.logger;
  ctx = c;
  recordPath = path.join(path.dirname(c.configPath), 'brush_record.json');
  logger.info('[互刷] 官机互刷插件已初始化');
  logger.info(`[互刷] 记录文件路径: ${recordPath}`);
  initialized = true;
};

const plugin_onmessage = async (c, event) => {
  logger?.info(`[互刷] 收到消息事件: ${event.raw_message}`);
  if (event.post_type !== 'message') return;
  
  // 帮助命令
  if (event.raw_message === HELP_CMD) {
    ctx = c;
    const params = {
      message: HELP_MSG,
      message_type: event.message_type,
      ...(event.message_type === 'group' && event.group_id ? { group_id: String(event.group_id) } : {}),
      ...(event.message_type === 'private' && event.user_id ? { user_id: String(event.user_id) } : {})
    };
    await ctx.actions.call('send_msg', params, ctx.adapterName, ctx.pluginManager.config);
    return;
  }
  
  // 首次收到消息时启动（备用方案）
  if (!selfQQ && event.self_id) {
    ctx = c;
    selfQQ = String(event.self_id);
    logger?.info(`[互刷] 通过消息事件获取到self_id: ${selfQQ}`);
    await startBrush();
  }
};

const plugin_onevent = async (c, event) => {
  logger?.info(`[互刷] 收到事件: post_type=${event.post_type}, meta_event_type=${event.meta_event_type}, sub_type=${event.sub_type}`);
  
  ctx = c;
  
  // 监听连接事件
  if (event.post_type === 'meta_event' && event.meta_event_type === 'lifecycle' && event.sub_type === 'connect') {
    selfQQ = String(event.self_id);
    logger?.info(`[互刷] Bot ${selfQQ} 已连接`);
    await startBrush();
    return;
  }
  
  // 监听心跳事件作为备用
  if (event.post_type === 'meta_event' && event.meta_event_type === 'heartbeat' && !selfQQ && event.self_id) {
    selfQQ = String(event.self_id);
    logger?.info(`[互刷] 通过心跳事件获取到self_id: ${selfQQ}`);
    await startBrush();
  }
};

export { plugin_init, plugin_onmessage, plugin_onevent };
