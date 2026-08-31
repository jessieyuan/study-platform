/**
 * 学习工作台 — 后端服务器
 * 零外部依赖：仅使用 Node.js 内置模块 (http + sqlite + crypto + fs)
 *
 * 启动方式:
 *   node --experimental-sqlite server/server.js
 *
 * API 列表:
 *   POST /api/register       注册新用户（普通用户需管理员审批）
 *   POST /api/login          登录（检查审批状态）
 *   POST /api/logout         登出
 *   GET  /api/data           获取用户数据
 *   POST /api/data           保存用户数据
 *   GET  /api/leaderboard    获取排行榜
 *   --- 管理员 API ---
 *   GET  /api/admin/users    全部用户列表
 *   POST /api/admin/approve  批准用户注册
 *   POST /api/admin/reject   拒绝/删除用户
 *   GET  /api/admin/stats    统计信息
 */

const http = require('node:http');
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// ==================== 配置 ====================
const PORT = process.env.PORT || 3000;
const PROJECT_DIR = path.join(__dirname, '..');
const HTML_FILE = path.join(PROJECT_DIR, 'index.html');
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.db');
const SESSION_MAX_AGE_DAYS = 30;

// ---- 安全限制 ----
// 头像白名单（与前端 AUTH_AVATARS 一致，防存储型 XSS）
const AVATAR_ALLOWLIST = ['👦','👧','😊','🌟','🐱','🐶','🐼','🦊','🐰','🐨','🦄','🐸','🐵','🐯','🦁','🐮','🐷','🐭','🐹','🐻','🐔','🐧','🐦','🦋'];
// 用户名：字母/数字/下划线/中文，2-20 位
const USERNAME_RE = /^[a-zA-Z0-9_一-龥]{2,20}$/;
const MIN_PASSWORD_LEN = 6;
const MAX_DISPLAY_NAME_LEN = 12;
// 注册节流：同一 IP 两次注册至少间隔（毫秒）
const REGISTER_INTERVAL_MS = 10 * 1000;
const registerLastByIP = new Map();
// 登录防爆破：同一 IP 连续失败 N 次后锁定一段时间（毫秒）
const LOGIN_MAX_FAILS = 5;
const LOGIN_LOCK_MS = 10 * 60 * 1000;
const loginFailByIP = new Map(); // ip -> { fails, lockedUntil }
// POST body 大小上限（字节）：防止超大 JSON 撑爆内存/数据库
const MAX_BODY_BYTES = 2 * 1024 * 1024;
// 定时备份：每天 BACKUP_HOUR 点整备份一次，保留最近 BACKUP_KEEP 份
// 备份目录可用环境变量 BACKUP_DIR 指定，支持相对路径（相对项目根，如 ./backup、../study-backup）
const BACKUP_HOUR = 1;
const BACKUP_KEEP = 14;
const BACKUP_DIR = path.resolve(PROJECT_DIR, process.env.BACKUP_DIR || path.join(__dirname, 'backups'));
// 单日积分涨幅上限 / 单次保存 streak 最大增幅（防客户端任意刷分）
const DAILY_POINTS_GAIN_LIMIT = 2000;
const STREAK_MAX_GAIN_PER_SAVE = 1;

// ==================== 数据库初始化 ====================
const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    display_name  TEXT DEFAULT '小学霸',
    avatar        TEXT DEFAULT '👦',
    points        INTEGER DEFAULT 200,
    streak        INTEGER DEFAULT 0,
    last_active   TEXT,
    created_at    TEXT DEFAULT (datetime('now','localtime')),
    role          TEXT DEFAULT 'user',
    status        TEXT DEFAULT 'pending'
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token       TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL,
    created_at  TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS user_data (
    user_id     INTEGER PRIMARY KEY,
    data        TEXT NOT NULL,
    updated_at  TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_users_points ON users(points DESC);
  CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
`);

// ---- 数据库迁移：为旧表添加新列 ----
try {
  db.exec(`ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'user'`);
} catch(e) { /* 列已存在，忽略 */ }
try {
  db.exec(`ALTER TABLE users ADD COLUMN status TEXT DEFAULT 'pending'`);
} catch(e) { /* 列已存在，忽略 */ }
try {
  db.exec(`ALTER TABLE users ADD COLUMN leaderboard_access INTEGER DEFAULT 0`);
} catch(e) { /* 列已存在，忽略 */ }
try {
  db.exec(`ALTER TABLE users ADD COLUMN groups TEXT DEFAULT '[]'`);
} catch(e) { /* 列已存在，忽略 */ }
try {
  db.exec(`ALTER TABLE users ADD COLUMN points_base INTEGER DEFAULT 0`);
} catch(e) { /* 列已存在，忽略 */ }
try {
  db.exec(`ALTER TABLE users ADD COLUMN base_date TEXT DEFAULT ''`);
} catch(e) { /* 列已存在，忽略 */ }

// 迁移：已有用户（status为NULL或pending的旧数据）标记为已批准
db.exec(`UPDATE users SET status = 'approved' WHERE status IS NULL OR status = ''`);
// 首个用户自动成为管理员
const firstUser = db.prepare('SELECT id FROM users ORDER BY id ASC LIMIT 1').get();
if (firstUser) {
  db.prepare('UPDATE users SET role = ?, status = ? WHERE id = ?').run('admin', 'approved', firstUser.id);
}

// 迁移：管理员默认拥有排行榜权限
db.exec(`UPDATE users SET leaderboard_access = 1 WHERE role = 'admin'`);

// ==================== 工具函数 ====================

/** scrypt 密码哈希 */
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

/** 生成随机 token */
function generateToken() {
  return crypto.randomUUID() + crypto.randomUUID().replace(/-/g, '');
}

/** 解析 POST body（超过 MAX_BODY_BYTES 拒收，reject 带 statusCode=413） */
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    let overLimit = false;
    req.on('data', c => {
      if (overLimit) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        overLimit = true;
        chunks = [];
        const err = new Error('Request body too large');
        err.statusCode = 413;
        reject(err); // 响应由统一 catch 发出，这里只停止收集、不断连接
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (overLimit) return;
      try {
        const raw = Buffer.concat(chunks).toString('utf-8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

/** 发送 JSON 响应（前后端同源部署，无需 CORS 头） */
function sendJSON(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
  });
  res.end(JSON.stringify(data));
}

/** 安全解析 JSON */
function safeParseJSON(str, fallback) {
  try { return JSON.parse(str); } catch(e) { return fallback; }
}

/** 从请求头提取 user_id */
function getAuthUserId(req) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  const row = db.prepare('SELECT user_id, created_at FROM sessions WHERE token = ?').get(token);
  if (!row) return null;
  // 检查 session 是否过期
  if (row.created_at) {
    const ageDays = (Date.now() - new Date(row.created_at).getTime()) / (1000 * 60 * 60 * 24);
    if (ageDays > SESSION_MAX_AGE_DAYS) {
      db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
      return null;
    }
  }
  return row.user_id;
}

/** 获取完整用户信息（含 role、status） */
function getAuthUser(req) {
  const userId = getAuthUserId(req);
  if (!userId) return null;
  const user = db.prepare('SELECT id, username, display_name, avatar, role, status FROM users WHERE id = ?').get(userId);
  return user;
}

/** 检查是否管理员 */
function isAdmin(req) {
  const user = getAuthUser(req);
  return user && user.role === 'admin';
}

/** 生成默认用户数据 */
function defaultUserData() {
  function todayStr() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  return {
    tasks: [
      { id: '1', name: '古诗+练字+阅读', subject: '语文', note: '背诵古诗，练字一页，课外阅读20分钟', done: false, date: todayStr(), points: 5 },
      { id: '2', name: '口算+应用题', subject: '数学', note: '口算100题，应用题5道', done: false, date: todayStr(), points: 5 },
      { id: '3', name: '单词+听力+阅读', subject: '英语', note: '单词默写，听力练习', done: false, date: todayStr(), points: 5 },
      { id: '4', name: '跳绳/跑步', subject: '体育', note: '跳绳500个，跑步10分钟', done: false, date: todayStr(), points: 5 },
    ],
    plans: [
      { id: 'p1', subject: '语文', name: '古诗背诵', frequency: 'daily', days: [], points: 5 },
      { id: 'p2', subject: '语文', name: '练字一页', frequency: 'daily', days: [], points: 3 },
      { id: 'p3', subject: '数学', name: '口算练习', frequency: 'daily', days: [], points: 5 },
      { id: 'p4', subject: '英语', name: '单词默写', frequency: 'daily', days: [], points: 5 },
      { id: 'p5', subject: '体育', name: '跳绳500个', frequency: 'daily', days: [], points: 3 },
    ],
    streak: 0,
    points: 200,
    lastActive: todayStr(),
    profile: { name: '小学霸', avatar: '👦' },
    pet: { owned: false, style: 'pokemon', petId: 0, name: '', boughtDate: null, lastFedDate: null, lastBathDate: null, lastExerciseDate: null, lastPlayDate: null, clothes: 'default', alive: true, todayEarned: 0, level: 1, xp: 0 },
    subjectTabs: { chinese: 'daily', math: 'daily', english: 'daily', sport: 'daily', reading: 'daily', labor: 'daily' },
    studyProgress: {},
    recitedLessons: [],
    currentUnit: 0,
    currentChineseType: '古诗',
    selectedLessonId: null,
    currentLessonMode: 'read',
    showPinyin: true,
    showTranslation: true,
    chineseView: 'backmo',
  };
}

/** 服务器本地日期字符串 YYYY-MM-DD */
function serverTodayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/** 将 user_data JSON 中的关键字段同步到 users 表（用于排行榜查询）。
 *  points/streak 由调用方先做涨幅限制后传入；points_base/base_date 记录当日涨幅基准。 */
function syncUserFields(userId, data, pointsBase, baseDate) {
  db.prepare(`
    UPDATE users SET
      points = ?,
      streak = ?,
      display_name = ?,
      avatar = ?,
      last_active = ?,
      points_base = ?,
      base_date = ?
    WHERE id = ?
  `).run(
    data.points || 0,
    data.streak || 0,
    (data.profile && data.profile.name) || '小学霸',
    (data.profile && data.profile.avatar) || '👦',
    data.lastActive || null,
    pointsBase,
    baseDate,
    userId
  );
}

// ==================== API 处理器 ====================

/** POST /api/register */
async function handleRegister(req, res) {
  const body = await parseBody(req);
  const username = (body.username || '').trim();
  const password = body.password || '';
  // 昵称：去掉危险字符 + 限长（防存储型 XSS，前端渲染仍会转义，此为第一道防线）
  const displayName = (body.displayName || '').replace(/[<>&"'`]/g, '').trim().slice(0, MAX_DISPLAY_NAME_LEN) || '小学霸';
  // 头像：白名单校验，非法值回退默认
  const avatar = AVATAR_ALLOWLIST.includes(body.avatar) ? body.avatar : '👦';

  // 注册节流：同一 IP 间隔限制
  const clientIP = req.socket.remoteAddress || 'unknown';
  const lastReg = registerLastByIP.get(clientIP) || 0;
  if (Date.now() - lastReg < REGISTER_INTERVAL_MS) {
    return sendJSON(res, 429, { error: '注册太频繁，请稍后再试' });
  }

  if (!USERNAME_RE.test(username)) {
    return sendJSON(res, 400, { error: '用户名需为 2-20 位字母、数字、下划线或中文' });
  }
  if (!password || password.length < MIN_PASSWORD_LEN) {
    return sendJSON(res, 400, { error: '密码至少' + MIN_PASSWORD_LEN + '个字符' });
  }

  // 检查用户名是否已存在
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) {
    return sendJSON(res, 409, { error: '用户名已存在' });
  }

  // 判断是否首个用户 → 自动成为管理员
  const userCount = db.prepare('SELECT COUNT(*) as cnt FROM users').get();
  const isFirstUser = userCount.cnt === 0;
  const role = isFirstUser ? 'admin' : 'user';
  const status = isFirstUser ? 'approved' : 'pending';

  // 创建用户
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPassword(password, salt);
  registerLastByIP.set(clientIP, Date.now());
  const result = db.prepare(`
    INSERT INTO users (username, password_hash, password_salt, display_name, avatar, role, status)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(username, hash, salt, displayName, avatar, role, status);
  const userId = result.lastInsertRowid;

  // 创建默认数据
  const defaultData = defaultUserData();
  defaultData.profile.name = displayName;
  defaultData.profile.avatar = avatar;
  db.prepare('INSERT INTO user_data (user_id, data) VALUES (?, ?)').run(userId, JSON.stringify(defaultData));

  if (isFirstUser) {
    // 首个用户（管理员）直接生成 session 并返回
    const token = generateToken();
    db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(token, userId);
    sendJSON(res, 200, {
      token,
      data: defaultData,
      user: { id: userId, username, displayName, avatar, role, status }
    });
  } else {
    // 普通用户需等待审批
    sendJSON(res, 200, {
      pending: true,
      message: '注册成功！请等待管理员审批后即可登录使用。'
    });
  }
}

/** 记录一次登录失败；达到上限则锁定 LOGIN_LOCK_MS */
function recordLoginFail(ip, rec) {
  rec.fails += 1;
  if (rec.fails >= LOGIN_MAX_FAILS) {
    rec.lockedUntil = Date.now() + LOGIN_LOCK_MS;
    rec.fails = 0; // 锁定到期后重新计数
  }
  loginFailByIP.set(ip, rec);
}

/** POST /api/login */
async function handleLogin(req, res) {
  // 防爆破：同 IP 连续失败达到上限后锁定一段时间
  const clientIP = req.socket.remoteAddress || 'unknown';
  const failRec = loginFailByIP.get(clientIP) || { fails: 0, lockedUntil: 0 };
  if (Date.now() < failRec.lockedUntil) {
    return sendJSON(res, 429, { error: '登录失败次数过多，请 10 分钟后再试' });
  }

  const body = await parseBody(req);
  const username = (body.username || '').trim();
  const password = body.password || '';

  if (!username || !password) {
    return sendJSON(res, 400, { error: '请输入用户名和密码' });
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) {
    recordLoginFail(clientIP, failRec);
    return sendJSON(res, 401, { error: '用户名不存在' });
  }

  const hash = hashPassword(password, user.password_salt);
  if (hash !== user.password_hash) {
    recordLoginFail(clientIP, failRec);
    return sendJSON(res, 401, { error: '密码错误' });
  }

  // 登录成功，清除该 IP 的失败计数
  loginFailByIP.delete(clientIP);

  // 检查审批状态
  if (user.status === 'pending') {
    return sendJSON(res, 403, { error: '您的账号正在等待管理员审批，请稍后再试。' });
  }
  if (user.status === 'rejected') {
    return sendJSON(res, 403, { error: '您的账号已被管理员拒绝，请联系管理员。' });
  }

  // 生成 session
  const token = generateToken();
  db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(token, user.id);

  // 获取用户数据
  const dataRow = db.prepare('SELECT data FROM user_data WHERE user_id = ?').get(user.id);
  let data;
  if (dataRow) {
    data = JSON.parse(dataRow.data);
  } else {
    data = defaultUserData();
    db.prepare('INSERT INTO user_data (user_id, data) VALUES (?, ?)').run(user.id, JSON.stringify(data));
  }

  sendJSON(res, 200, {
    token,
    data,
    user: { id: user.id, username: user.username, displayName: user.display_name, avatar: user.avatar, role: user.role, status: user.status, leaderboardAccess: user.leaderboard_access, groups: safeParseJSON(user.groups, []) }
  });
}

/** POST /api/logout */
async function handleLogout(req, res) {
  const auth = req.headers['authorization'];
  if (auth && auth.startsWith('Bearer ')) {
    const token = auth.slice(7);
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  }
  sendJSON(res, 200, { ok: true });
}

/** GET /api/data */
async function handleGetData(req, res) {
  const userId = getAuthUserId(req);
  if (!userId) {
    return sendJSON(res, 401, { error: '未登录或登录已过期' });
  }

  const dataRow = db.prepare('SELECT data FROM user_data WHERE user_id = ?').get(userId);
  let data;
  if (dataRow) {
    data = JSON.parse(dataRow.data);
  } else {
    data = defaultUserData();
    db.prepare('INSERT INTO user_data (user_id, data) VALUES (?, ?)').run(userId, JSON.stringify(data));
  }

  // 附带用户基本信息（含 role）
  const userRow = db.prepare('SELECT id, username, display_name, avatar, role, status, leaderboard_access, groups FROM users WHERE id = ?').get(userId);
  sendJSON(res, 200, { data, user: { id: userRow.id, username: userRow.username, displayName: userRow.display_name, avatar: userRow.avatar, role: userRow.role, status: userRow.status, leaderboardAccess: userRow.leaderboard_access, groups: safeParseJSON(userRow.groups, []) } });
}

/** POST /api/data */
async function handleSaveData(req, res) {
  const userId = getAuthUserId(req);
  if (!userId) {
    return sendJSON(res, 401, { error: '未登录或登录已过期' });
  }

  const body = await parseBody(req);

  // ---- 防刷分：points 单日涨幅上限，streak 单次保存最多 +1 ----
  const userRow = db.prepare('SELECT points, streak, points_base, base_date FROM users WHERE id = ?').get(userId);
  const today = serverTodayStr();
  // 跨天后以当前值为当日基准重新起算
  let pointsBase = Number.isFinite(userRow.points_base) ? userRow.points_base : userRow.points;
  if (userRow.base_date !== today) pointsBase = userRow.points;

  let newPoints = Number(body.points);
  if (!Number.isFinite(newPoints)) newPoints = userRow.points;
  if (newPoints < 0) newPoints = 0;
  if (newPoints > pointsBase + DAILY_POINTS_GAIN_LIMIT) newPoints = pointsBase + DAILY_POINTS_GAIN_LIMIT;
  body.points = newPoints;

  let newStreak = Number(body.streak);
  if (!Number.isFinite(newStreak)) newStreak = userRow.streak;
  if (newStreak < 0) newStreak = 0;
  if (newStreak > userRow.streak + STREAK_MAX_GAIN_PER_SAVE) newStreak = userRow.streak + STREAK_MAX_GAIN_PER_SAVE;
  body.streak = newStreak;

  const dataStr = JSON.stringify(body);

  // 更新 user_data
  db.prepare(`
    INSERT INTO user_data (user_id, data, updated_at) VALUES (?, ?, datetime('now','localtime'))
    ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
  `).run(userId, dataStr);

  // 同步关键字段到 users 表
  syncUserFields(userId, body, pointsBase, today);

  sendJSON(res, 200, { ok: true });
}

/** GET /api/leaderboard */
async function handleLeaderboard(req, res) {
  const userId = getAuthUserId(req);
  const currentUser = userId ? db.prepare('SELECT id, role, leaderboard_access, groups FROM users WHERE id = ?').get(userId) : null;
  
  // 管理员看全部
  if (currentUser && currentUser.role === 'admin') {
    const rows = db.prepare(`SELECT id, username, display_name, avatar, points, streak FROM users ORDER BY streak DESC LIMIT 50`).all();
    const leaderboard = rows.map((r, i) => ({ rank: i + 1, id: r.id, username: r.username, displayName: r.display_name, avatar: r.avatar, points: r.points, streak: r.streak }));
    return sendJSON(res, 200, { leaderboard });
  }
  
  // 无权限或未登录：返回空
  if (!currentUser || !currentUser.leaderboard_access) {
    return sendJSON(res, 200, { leaderboard: [] });
  }
  
  const userGroups = safeParseJSON(currentUser.groups, []);
  // 无组别：看不到任何人
  if (userGroups.length === 0) {
    return sendJSON(res, 200, { leaderboard: [] });
  }
  
  // 获取所有用户，过滤同组别的
  const allRows = db.prepare(`SELECT id, username, display_name, avatar, points, streak, groups, role, leaderboard_access FROM users ORDER BY streak DESC`).all();
  const filtered = allRows.filter(r => {
    if (r.id === currentUser.id) return true; // 总是能看到自己
    if (!r.leaderboard_access) return false; // 无排行榜权限的用户不显示
    if (r.role === 'admin') return true; // 管理员总是可见
    const otherGroups = safeParseJSON(r.groups, []);
    return userGroups.some(g => otherGroups.includes(g));
  });
  
  const leaderboard = filtered.slice(0, 50).map((r, i) => ({
    rank: i + 1,
    id: r.id,
    username: r.username,
    displayName: r.display_name,
    avatar: r.avatar,
    points: r.points,
    streak: r.streak,
  }));

  sendJSON(res, 200, { leaderboard });
}

/** GET /api/leaderboard/pets — 宠物排行榜 */
async function handlePetLeaderboard(req, res) {
  const userId = getAuthUserId(req);
  const currentUser = userId ? db.prepare('SELECT id, role, leaderboard_access, groups FROM users WHERE id = ?').get(userId) : null;
  
  const rows = db.prepare(`
    SELECT u.id, u.username, u.display_name, u.avatar, u.role, u.groups, u.leaderboard_access, ud.data
    FROM users u
    LEFT JOIN user_data ud ON ud.user_id = u.id
    ORDER BY u.id
  `).all();

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  function daysSince(dateStr) {
    if (!dateStr) return 999;
    const d = new Date(dateStr + 'T00:00:00');
    return Math.floor((today - d) / (1000 * 60 * 60 * 24));
  }

  function calcHealth(pet) {
    if (!pet || !pet.owned || !pet.alive) return -1;
    const notFedDays = daysSince(pet.lastFedDate);
    if (notFedDays >= 3) return 0;
    let health = 70;
    if (notFedDays === 1) health = 45;
    else if (notFedDays === 2) health = 20;
    if (notFedDays === 0) {
      if (daysSince(pet.lastExerciseDate) === 0) health += 20;
      if (daysSince(pet.lastPlayDate) === 0) health += 15;
      if (daysSince(pet.lastBathDate) <= 7) health += 15;
    }
    return Math.min(100, Math.max(0, health));
  }

  const pets = [];
  for (const r of rows) {
    if (!r.data) continue;
    let appData;
    try { appData = JSON.parse(r.data); } catch (e) { continue; }
    const pet = appData.pet;
    if (!pet || !pet.owned || !pet.alive) continue;
    const health = calcHealth(pet);
    pets.push({
      userId: r.id,
      username: r.username,
      displayName: r.display_name,
      avatar: r.avatar,
      role: r.role,
      groups: safeParseJSON(r.groups, []),
      petName: pet.name || '小宠物',
      petStyle: pet.style || 'pokemon',
      petId: pet.petId || 0,
      level: pet.level || 1,
      xp: pet.xp || 0,
      health: health,
      fedToday: daysSince(pet.lastFedDate) === 0,
    });
  }

  // 按组别过滤
  let filteredPets = pets;
  if (currentUser && currentUser.role === 'admin') {
    // 管理员看全部
  } else if (!currentUser || !currentUser.leaderboard_access) {
    filteredPets = [];
  } else {
    const userGroups = safeParseJSON(currentUser.groups, []);
    if (userGroups.length === 0) {
      filteredPets = [];
    } else {
      filteredPets = pets.filter(p => {
        if (p.userId === currentUser.id) return true;
        const otherUser = rows.find(r => r.id === p.userId);
        if (otherUser && !otherUser.leaderboard_access) return false;
        if (otherUser && otherUser.role === 'admin') return true;
        const otherGroups = safeParseJSON(otherUser ? otherUser.groups : '[]', []);
        return userGroups.some(g => otherGroups.includes(g));
      });
    }
  }
  
  filteredPets.sort((a, b) => b.level !== a.level ? b.level - a.level : b.health - a.health);
  sendJSON(res, 200, { pets: filteredPets.slice(0, 50) });
}

/** GET /api/admin/users — 管理员获取全部用户列表 */
async function handleAdminGetUsers(req, res) {
  if (!isAdmin(req)) {
    return sendJSON(res, 403, { error: '无权限，仅管理员可访问' });
  }
  const rows = db.prepare(`
    SELECT id, username, display_name, avatar, role, status, points, streak, created_at, leaderboard_access, groups
    FROM users
    ORDER BY
      CASE status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 WHEN 'rejected' THEN 2 END,
      created_at DESC
  `).all();

  const users = rows.map(r => ({
    id: r.id,
    username: r.username,
    displayName: r.display_name,
    avatar: r.avatar,
    role: r.role,
    status: r.status,
    points: r.points,
    streak: r.streak,
    createdAt: r.created_at,
    leaderboardAccess: r.leaderboard_access,
    groups: safeParseJSON(r.groups, []),
  }));

  sendJSON(res, 200, { users });
}

/** POST /api/admin/approve — 管理员批准用户 */
async function handleAdminApprove(req, res) {
  if (!isAdmin(req)) {
    return sendJSON(res, 403, { error: '无权限，仅管理员可访问' });
  }
  const body = await parseBody(req);
  const userId = body.userId;
  if (!userId) {
    return sendJSON(res, 400, { error: '缺少 userId' });
  }
  
  const user = db.prepare('SELECT id, role FROM users WHERE id = ?').get(userId);
  if (!user) {
    return sendJSON(res, 404, { error: '用户不存在' });
  }
  if (user.role === 'admin') {
    return sendJSON(res, 400, { error: '不能修改管理员状态' });
  }
  
  db.prepare('UPDATE users SET status = ? WHERE id = ?').run('approved', userId);
  sendJSON(res, 200, { ok: true });
}

/** POST /api/admin/update-user — 管理员更新用户设置（排行榜权限、组别） */
async function handleAdminUpdateUser(req, res) {
  if (!isAdmin(req)) {
    return sendJSON(res, 403, { error: '无权限，仅管理员可访问' });
  }
  const body = await parseBody(req);
  const userId = body.userId;
  if (!userId) {
    return sendJSON(res, 400, { error: '缺少 userId' });
  }
  
  const user = db.prepare('SELECT id, role FROM users WHERE id = ?').get(userId);
  if (!user) {
    return sendJSON(res, 404, { error: '用户不存在' });
  }
  
  if (body.leaderboardAccess !== undefined) {
    db.prepare('UPDATE users SET leaderboard_access = ? WHERE id = ?').run(body.leaderboardAccess ? 1 : 0, userId);
  }
  if (body.groups !== undefined) {
    db.prepare('UPDATE users SET groups = ? WHERE id = ?').run(JSON.stringify(body.groups), userId);
  }
  
  sendJSON(res, 200, { ok: true });
}

/** POST /api/admin/reject — 管理员拒绝/删除用户 */
async function handleAdminReject(req, res) {
  if (!isAdmin(req)) {
    return sendJSON(res, 403, { error: '无权限，仅管理员可访问' });
  }
  const body = await parseBody(req);
  const userId = body.userId;
  if (!userId) {
    return sendJSON(res, 400, { error: '缺少 userId' });
  }
  
  const user = db.prepare('SELECT id, role FROM users WHERE id = ?').get(userId);
  if (!user) {
    return sendJSON(res, 404, { error: '用户不存在' });
  }
  if (user.role === 'admin') {
    return sendJSON(res, 400, { error: '不能删除管理员账号' });
  }
  
  // 彻底删除用户及其数据
  db.prepare('DELETE FROM user_data WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  sendJSON(res, 200, { ok: true });
}

/** GET /api/admin/stats — 管理员获取统计信息 */
async function handleAdminStats(req, res) {
  if (!isAdmin(req)) {
    return sendJSON(res, 403, { error: '无权限，仅管理员可访问' });
  }
  const pending = db.prepare("SELECT COUNT(*) as cnt FROM users WHERE status = 'pending'").get();
  const approved = db.prepare("SELECT COUNT(*) as cnt FROM users WHERE status = 'approved'").get();
  const rejected = db.prepare("SELECT COUNT(*) as cnt FROM users WHERE status = 'rejected'").get();
  const total = db.prepare("SELECT COUNT(*) as cnt FROM users").get();
  sendJSON(res, 200, {
    pending: pending.cnt,
    approved: approved.cnt,
    rejected: rejected.cnt,
    total: total.cnt,
  });
}

// ==================== 静态文件服务 ====================
/** 解析 URL 对应的项目内绝对路径；越出项目目录（路径穿越）返回 null */
function safeResolve(urlPath) {
  const filePath = path.join(PROJECT_DIR, decodeURIComponent(urlPath));
  if (!filePath.startsWith(PROJECT_DIR + path.sep)) return null;
  return filePath;
}

function serveStaticFile(req, res) {
  // 其他 HTML 文件（预览页等）
  if (req.url.endsWith('.html') && !req.url.includes('..')) {
    const filePath = safeResolve(req.url);
    if (!filePath) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return true;
    }
    try {
      const html = fs.readFileSync(filePath, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (e) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
    }
    return true;
  }

  // 根路径 → index.html
  if (req.url === '/' || req.url === '/index.html') {
    try {
      const html = fs.readFileSync(HTML_FILE, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (e) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('找不到 学习工作台.html 文件');
    }
    return true;
  }

 // 宠物图片静态文件
 if (req.url.startsWith('/pets/')) {
   const ext = path.extname(req.url).toLowerCase();
   const mime = {
     '.png': 'image/png',
     '.jpg': 'image/jpeg',
     '.jpeg': 'image/jpeg',
     '.gif': 'image/gif',
     '.svg': 'image/svg+xml',
     '.webp': 'image/webp',
   }[ext];
   if (mime) {
     const filePath = safeResolve(req.url);
     if (!filePath) {
       res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
       res.end('Forbidden');
       return true;
     }
     try {
       const data = fs.readFileSync(filePath);
       res.writeHead(200, { 'Content-Type': mime });
       res.end(data);
     } catch (e) {
       res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
       res.end('文件未找到');
     }
     return true;
   }
 }

  // 花卉等图片静态文件
  if (req.url.startsWith('/img/')) {
    const ext = path.extname(req.url).toLowerCase();
    const mime = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.svg': 'image/svg+xml',
      '.webp': 'image/webp',
    }[ext];
    if (mime) {
      const filePath = safeResolve(req.url);
      if (!filePath) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Forbidden');
        return true;
      }
      try {
        const data = fs.readFileSync(filePath);
        res.writeHead(200, { 'Content-Type': mime });
        res.end(data);
      } catch (e) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('文件未找到');
      }
      return true;
    }
  }

  return false;
}

// ==================== 主路由 ====================
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // POST 请求 Content-Length 预检：声明超大直接拒绝，不读 body
  if (req.method === 'POST') {
    const declared = Number(req.headers['content-length'] || 0);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      return sendJSON(res, 413, { error: '请求数据过大（上限 2MB）' });
    }
  }

  try {
    // API 路由
    if (pathname === '/api/register' && req.method === 'POST') {
      return await handleRegister(req, res);
    }
    if (pathname === '/api/login' && req.method === 'POST') {
      return await handleLogin(req, res);
    }
    if (pathname === '/api/logout' && req.method === 'POST') {
      return await handleLogout(req, res);
    }
    if (pathname === '/api/data' && req.method === 'GET') {
      return await handleGetData(req, res);
    }
    if (pathname === '/api/data' && req.method === 'POST') {
      return await handleSaveData(req, res);
    }
    if (pathname === '/api/leaderboard' && req.method === 'GET') {
      return await handleLeaderboard(req, res);
    }
    if (pathname === '/api/leaderboard/pets' && req.method === 'GET') {
      return await handlePetLeaderboard(req, res);
    }

    // 管理员 API
    if (pathname === '/api/admin/users' && req.method === 'GET') {
      return await handleAdminGetUsers(req, res);
    }
    if (pathname === '/api/admin/approve' && req.method === 'POST') {
      return await handleAdminApprove(req, res);
    }
    if (pathname === '/api/admin/reject' && req.method === 'POST') {
      return await handleAdminReject(req, res);
    }
    if (pathname === '/api/admin/update-user' && req.method === 'POST') {
      return await handleAdminUpdateUser(req, res);
    }
    if (pathname === '/api/admin/stats' && req.method === 'GET') {
      return await handleAdminStats(req, res);
    }

    // 静态文件
    if (serveStaticFile(req, res)) return;

    // 404
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  } catch (e) {
    console.error('Server error:', e);
    // body 超限等场景已发过响应（或连接已被销毁），避免二次写头
    if (res.headersSent || res.destroyed) return;
    if (e.statusCode === 413) {
      return sendJSON(res, 413, { error: '请求数据过大（上限 2MB）' });
    }
    sendJSON(res, 500, { error: '服务器内部错误: ' + e.message });
  }
});

// ==================== 定时备份 ====================

/** 计算距下一个 BACKUP_HOUR 点整的毫秒数 */
function msUntilNextBackup() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(BACKUP_HOUR, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next - now;
}

/** 备份数据库（VACUUM INTO 生成一致性快照，服务运行中也可安全执行），并清理超出保留数的旧备份 */
function backupDatabase() {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const d = new Date();
    const p2 = n => String(n).padStart(2, '0');
    const stamp = '' + d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + '-' + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds());
    const target = path.join(BACKUP_DIR, 'data-' + stamp + '.db');
    db.exec("VACUUM INTO '" + target + "'");
    // 清理旧备份，只保留最近 BACKUP_KEEP 份
    const files = fs.readdirSync(BACKUP_DIR).filter(f => /^data-\d{8}-\d{6}\.db$/.test(f)).sort();
    while (files.length > BACKUP_KEEP) {
      fs.unlinkSync(path.join(BACKUP_DIR, files.shift()));
    }
    console.log('[备份] 已备份到 ' + target);
  } catch (e) {
    console.error('[备份] 失败: ' + e.message);
  }
}

/** 循环定时：到点备份，再安排下一个 */
function scheduleBackup() {
  setTimeout(() => {
    backupDatabase();
    scheduleBackup();
  }, msUntilNextBackup());
}

// 全局错误捕获，防止静默崩溃
process.on('uncaughtException', (err) => {
  console.error('FATAL uncaughtException:', err.message, err.stack);
});
process.on('unhandledRejection', (reason) => {
  console.error('FATAL unhandledRejection:', reason);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('═══════════════════════════════════════════');
  console.log('  学习工作台服务器已启动');
  console.log('  地址: http://localhost:' + PORT);
  console.log('  数据库: ' + DB_PATH);
  console.log('  备份: 每天 ' + BACKUP_HOUR + ':00 → ' + BACKUP_DIR + '（保留 ' + BACKUP_KEEP + ' 份，BACKUP_DIR 可改目录）');
  scheduleBackup();   // 每天定时备份（BACKUP_HOUR 点）
  console.log('═══════════════════════════════════════════');
  console.log('');
  console.log('API 列表:');
  console.log('  POST /api/register       注册（普通用户需审批）');
  console.log('  POST /api/login          登录（检查审批状态）');
  console.log('  POST /api/logout         登出');
  console.log('  GET  /api/data           获取数据');
  console.log('  POST /api/data           保存数据');
  console.log('  GET  /api/leaderboard    排行榜');
  console.log('  --- 管理员 API ---');
  console.log('  GET  /api/admin/users    全部用户列表');
  console.log('  POST /api/admin/approve  批准用户');
  console.log('  POST /api/admin/reject   拒绝/删除用户');
  console.log('  GET  /api/admin/stats    统计信息');
  console.log('');
  console.log('按 Ctrl+C 停止服务器');
});
