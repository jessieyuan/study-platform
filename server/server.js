/**
 * 学习工作台 — 后端服务器
 * 依赖：pg (PostgreSQL 驱动)，其余使用 Node.js 内置模块 (http + crypto + fs)
 *
 * 启动方式:
 *   node server/server.js
 *
 * 环境变量:
 *   DATABASE_URL  PostgreSQL 连接串（必填）
 *   PORT          监听端口（默认 3000）
 *   DB_SSL        是否启用 SSL（云端通常需要，设为 'true'）
 *
 * API 列表:
 *   POST /api/register       注册新用户（普通用户需管理员审批）
 *   POST /api/login          登录（检查审批状态）
 *   POST /api/logout         登出
 *   GET  /api/data           获取用户数据
 *   POST /api/data           保存用户数据
 *   GET  /api/leaderboard    获取排行榜
 *   GET  /api/leaderboard/pets 宠物排行榜
 *   --- 管理员 API ---
 *   GET  /api/admin/users    全部用户列表
 *   POST /api/admin/approve  批准用户注册
 *   POST /api/admin/reject   拒绝/删除用户
 *   POST /api/admin/update-user 更新用户设置
 *   GET  /api/admin/stats    统计信息
 */

const http = require('node:http');
const { Pool } = require('pg');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// ==================== 配置 ====================
const PORT = process.env.PORT || 3000;
const PROJECT_DIR = path.join(__dirname, '..');
const HTML_FILE = path.join(PROJECT_DIR, 'index.html');
const DATABASE_URL = process.env.DATABASE_URL;
const SESSION_MAX_AGE_DAYS = 30;

if (!DATABASE_URL) {
  console.error('❌ 缺少 DATABASE_URL 环境变量！请设置 PostgreSQL 连接串。');
  console.error('   本地开发: export DATABASE_URL=postgres://user:pass@localhost:5432/dbname');
  console.error('   云端部署: 在平台环境变量中配置 DATABASE_URL');
  process.exit(1);
}

// ==================== 数据库连接 ====================
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

// ==================== 数据库初始化 ====================
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id                SERIAL PRIMARY KEY,
      username          TEXT UNIQUE NOT NULL,
      password_hash     TEXT NOT NULL,
      password_salt     TEXT NOT NULL,
      display_name      TEXT DEFAULT '小学霸',
      avatar            TEXT DEFAULT '👦',
      points            INTEGER DEFAULT 200,
      streak            INTEGER DEFAULT 0,
      last_active       TEXT,
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      role              TEXT DEFAULT 'user',
      status            TEXT DEFAULT 'pending',
      leaderboard_access INTEGER DEFAULT 0,
      groups            TEXT DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token       TEXT PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS user_data (
      user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      data        TEXT NOT NULL,
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_users_points ON users(points DESC);
    CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
  `);

  // 迁移：已有用户（status为NULL或pending的旧数据）标记为已批准
  await pool.query(`UPDATE users SET status = 'approved' WHERE status IS NULL OR status = ''`);

  // 首个用户自动成为管理员
  const { rows: firstUsers } = await pool.query('SELECT id FROM users ORDER BY id ASC LIMIT 1');
  if (firstUsers.length > 0) {
    await pool.query('UPDATE users SET role = $1, status = $2 WHERE id = $3', ['admin', 'approved', firstUsers[0].id]);
  }

  // 迁移：管理员默认拥有排行榜权限
  await pool.query(`UPDATE users SET leaderboard_access = 1 WHERE role = 'admin'`);

  console.log('✅ 数据库初始化完成');
}

// ==================== 工具函数 ====================

/** scrypt 密码哈希 */
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

/** 生成随机 token */
function generateToken() {
  return crypto.randomUUID() + crypto.randomUUID().replace(/-/g, '');
}

/** 解析 POST body */
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
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

/** 发送 JSON 响应 */
function sendJSON(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  });
  res.end(JSON.stringify(data));
}

/** 安全解析 JSON */
function safeParseJSON(str, fallback) {
  try { return JSON.parse(str); } catch(e) { return fallback; }
}

/** 从请求头提取 user_id（异步，需 await） */
async function getAuthUserId(req) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  const { rows } = await pool.query('SELECT user_id, created_at FROM sessions WHERE token = $1', [token]);
  if (rows.length === 0) return null;
  // 检查 session 是否过期
  const createdAt = rows[0].created_at;
  if (createdAt) {
    const ageDays = (Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60 * 24);
    if (ageDays > SESSION_MAX_AGE_DAYS) {
      await pool.query('DELETE FROM sessions WHERE token = $1', [token]);
      return null;
    }
  }
  return rows[0].user_id;
}

/** 获取完整用户信息（含 role、status） */
async function getAuthUser(req) {
  const userId = await getAuthUserId(req);
  if (!userId) return null;
  const { rows } = await pool.query('SELECT id, username, display_name, avatar, role, status FROM users WHERE id = $1', [userId]);
  return rows[0] || null;
}

/** 检查是否管理员 */
async function isAdmin(req) {
  const user = await getAuthUser(req);
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

/** 将 user_data JSON 中的关键字段同步到 users 表（用于排行榜查询） */
async function syncUserFields(userId, data) {
  await pool.query(`
    UPDATE users SET
      points = $1,
      streak = $2,
      display_name = $3,
      avatar = $4,
      last_active = $5
    WHERE id = $6
  `, [
    data.points || 0,
    data.streak || 0,
    (data.profile && data.profile.name) || '小学霸',
    (data.profile && data.profile.avatar) || '👦',
    data.lastActive || null,
    userId
  ]);
}

// ==================== API 处理器 ====================

/** POST /api/register */
async function handleRegister(req, res) {
  const body = await parseBody(req);
  const username = (body.username || '').trim();
  const password = body.password || '';
  const displayName = (body.displayName || '').trim() || '小学霸';
  const avatar = body.avatar || '👦';

  if (!username || username.length < 2) {
    return sendJSON(res, 400, { error: '用户名至少2个字符' });
  }
  if (!password || password.length < 4) {
    return sendJSON(res, 400, { error: '密码至少4个字符' });
  }

  // 检查用户名是否已存在
  const { rows: existing } = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
  if (existing.length > 0) {
    return sendJSON(res, 409, { error: '用户名已存在' });
  }

  // 判断是否首个用户 → 自动成为管理员
  const { rows: countRows } = await pool.query('SELECT COUNT(*)::int as cnt FROM users');
  const isFirstUser = countRows[0].cnt === 0;
  const role = isFirstUser ? 'admin' : 'user';
  const status = isFirstUser ? 'approved' : 'pending';

  // 创建用户
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPassword(password, salt);
  const { rows: insertRows } = await pool.query(`
    INSERT INTO users (username, password_hash, password_salt, display_name, avatar, role, status)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING id
  `, [username, hash, salt, displayName, avatar, role, status]);
  const userId = insertRows[0].id;

  // 创建默认数据
  const defaultData = defaultUserData();
  defaultData.profile.name = displayName;
  defaultData.profile.avatar = avatar;
  await pool.query('INSERT INTO user_data (user_id, data) VALUES ($1, $2)', [userId, JSON.stringify(defaultData)]);

  if (isFirstUser) {
    // 首个用户（管理员）直接生成 session 并返回
    const token = generateToken();
    await pool.query('INSERT INTO sessions (token, user_id) VALUES ($1, $2)', [token, userId]);
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

/** POST /api/login */
async function handleLogin(req, res) {
  const body = await parseBody(req);
  const username = (body.username || '').trim();
  const password = body.password || '';

  if (!username || !password) {
    return sendJSON(res, 400, { error: '请输入用户名和密码' });
  }

  const { rows } = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
  const user = rows[0];
  if (!user) {
    return sendJSON(res, 401, { error: '用户名不存在' });
  }

  const hash = hashPassword(password, user.password_salt);
  if (hash !== user.password_hash) {
    return sendJSON(res, 401, { error: '密码错误' });
  }

  // 检查审批状态
  if (user.status === 'pending') {
    return sendJSON(res, 403, { error: '您的账号正在等待管理员审批，请稍后再试。' });
  }
  if (user.status === 'rejected') {
    return sendJSON(res, 403, { error: '您的账号已被管理员拒绝，请联系管理员。' });
  }

  // 生成 session
  const token = generateToken();
  await pool.query('INSERT INTO sessions (token, user_id) VALUES ($1, $2)', [token, user.id]);

  // 获取用户数据
  const { rows: dataRows } = await pool.query('SELECT data FROM user_data WHERE user_id = $1', [user.id]);
  let data;
  if (dataRows.length > 0) {
    data = JSON.parse(dataRows[0].data);
  } else {
    data = defaultUserData();
    await pool.query('INSERT INTO user_data (user_id, data) VALUES ($1, $2)', [user.id, JSON.stringify(data)]);
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
    await pool.query('DELETE FROM sessions WHERE token = $1', [token]);
  }
  sendJSON(res, 200, { ok: true });
}

/** GET /api/data */
async function handleGetData(req, res) {
  const userId = await getAuthUserId(req);
  if (!userId) {
    return sendJSON(res, 401, { error: '未登录或登录已过期' });
  }

  const { rows: dataRows } = await pool.query('SELECT data FROM user_data WHERE user_id = $1', [userId]);
  let data;
  if (dataRows.length > 0) {
    data = JSON.parse(dataRows[0].data);
  } else {
    data = defaultUserData();
    await pool.query('INSERT INTO user_data (user_id, data) VALUES ($1, $2)', [userId, JSON.stringify(data)]);
  }

  // 附带用户基本信息（含 role）
  const { rows: userRows } = await pool.query('SELECT id, username, display_name, avatar, role, status, leaderboard_access, groups FROM users WHERE id = $1', [userId]);
  const userRow = userRows[0];
  sendJSON(res, 200, { data, user: { id: userRow.id, username: userRow.username, displayName: userRow.display_name, avatar: userRow.avatar, role: userRow.role, status: userRow.status, leaderboardAccess: userRow.leaderboard_access, groups: safeParseJSON(userRow.groups, []) } });
}

/** POST /api/data */
async function handleSaveData(req, res) {
  const userId = await getAuthUserId(req);
  if (!userId) {
    return sendJSON(res, 401, { error: '未登录或登录已过期' });
  }

  const body = await parseBody(req);
  const dataStr = JSON.stringify(body);

  // 更新 user_data（UPSERT）
  await pool.query(`
    INSERT INTO user_data (user_id, data, updated_at) VALUES ($1, $2, NOW())
    ON CONFLICT(user_id) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at
  `, [userId, dataStr]);

  // 同步关键字段到 users 表
  await syncUserFields(userId, body);

  sendJSON(res, 200, { ok: true });
}

/** GET /api/leaderboard */
async function handleLeaderboard(req, res) {
  const userId = await getAuthUserId(req);
  let currentUser = null;
  if (userId) {
    const { rows } = await pool.query('SELECT id, role, leaderboard_access, groups FROM users WHERE id = $1', [userId]);
    currentUser = rows[0] || null;
  }

  // 管理员看全部
  if (currentUser && currentUser.role === 'admin') {
    const { rows } = await pool.query('SELECT id, username, display_name, avatar, points, streak FROM users ORDER BY streak DESC LIMIT 50');
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
  const { rows: allRows } = await pool.query('SELECT id, username, display_name, avatar, points, streak, groups, role, leaderboard_access FROM users ORDER BY streak DESC');
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
  const userId = await getAuthUserId(req);
  let currentUser = null;
  if (userId) {
    const { rows } = await pool.query('SELECT id, role, leaderboard_access, groups FROM users WHERE id = $1', [userId]);
    currentUser = rows[0] || null;
  }

  const { rows } = await pool.query(`
    SELECT u.id, u.username, u.display_name, u.avatar, u.role, u.groups, u.leaderboard_access, ud.data
    FROM users u
    LEFT JOIN user_data ud ON ud.user_id = u.id
    ORDER BY u.id
  `);

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
  if (!await isAdmin(req)) {
    return sendJSON(res, 403, { error: '无权限，仅管理员可访问' });
  }
  const { rows } = await pool.query(`
    SELECT id, username, display_name, avatar, role, status, points, streak, created_at, leaderboard_access, groups
    FROM users
    ORDER BY
      CASE status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 WHEN 'rejected' THEN 2 END,
      created_at DESC
  `);

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
  if (!await isAdmin(req)) {
    return sendJSON(res, 403, { error: '无权限，仅管理员可访问' });
  }
  const body = await parseBody(req);
  const userId = body.userId;
  if (!userId) {
    return sendJSON(res, 400, { error: '缺少 userId' });
  }

  const { rows } = await pool.query('SELECT id, role FROM users WHERE id = $1', [userId]);
  const user = rows[0];
  if (!user) {
    return sendJSON(res, 404, { error: '用户不存在' });
  }
  if (user.role === 'admin') {
    return sendJSON(res, 400, { error: '不能修改管理员状态' });
  }

  await pool.query('UPDATE users SET status = $1 WHERE id = $2', ['approved', userId]);
  sendJSON(res, 200, { ok: true });
}

/** POST /api/admin/update-user — 管理员更新用户设置（排行榜权限、组别） */
async function handleAdminUpdateUser(req, res) {
  if (!await isAdmin(req)) {
    return sendJSON(res, 403, { error: '无权限，仅管理员可访问' });
  }
  const body = await parseBody(req);
  const userId = body.userId;
  if (!userId) {
    return sendJSON(res, 400, { error: '缺少 userId' });
  }

  const { rows } = await pool.query('SELECT id, role FROM users WHERE id = $1', [userId]);
  const user = rows[0];
  if (!user) {
    return sendJSON(res, 404, { error: '用户不存在' });
  }

  if (body.leaderboardAccess !== undefined) {
    await pool.query('UPDATE users SET leaderboard_access = $1 WHERE id = $2', [body.leaderboardAccess ? 1 : 0, userId]);
  }
  if (body.groups !== undefined) {
    await pool.query('UPDATE users SET groups = $1 WHERE id = $2', [JSON.stringify(body.groups), userId]);
  }

  sendJSON(res, 200, { ok: true });
}

/** POST /api/admin/reject — 管理员拒绝/删除用户 */
async function handleAdminReject(req, res) {
  if (!await isAdmin(req)) {
    return sendJSON(res, 403, { error: '无权限，仅管理员可访问' });
  }
  const body = await parseBody(req);
  const userId = body.userId;
  if (!userId) {
    return sendJSON(res, 400, { error: '缺少 userId' });
  }

  const { rows } = await pool.query('SELECT id, role FROM users WHERE id = $1', [userId]);
  const user = rows[0];
  if (!user) {
    return sendJSON(res, 404, { error: '用户不存在' });
  }
  if (user.role === 'admin') {
    return sendJSON(res, 400, { error: '不能删除管理员账号' });
  }

  // 彻底删除用户及其数据（外键 ON DELETE CASCADE 会自动清理 sessions 和 user_data）
  await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  sendJSON(res, 200, { ok: true });
}

/** GET /api/admin/stats — 管理员获取统计信息 */
async function handleAdminStats(req, res) {
  if (!await isAdmin(req)) {
    return sendJSON(res, 403, { error: '无权限，仅管理员可访问' });
  }
  const { rows } = await pool.query(`
    SELECT
      COUNT(*)::int FILTER (WHERE status = 'pending')  AS pending,
      COUNT(*)::int FILTER (WHERE status = 'approved') AS approved,
      COUNT(*)::int FILTER (WHERE status = 'rejected') AS rejected,
      COUNT(*)::int                                    AS total
    FROM users
  `);
  const stats = rows[0];
  sendJSON(res, 200, {
    pending: stats.pending,
    approved: stats.approved,
    rejected: stats.rejected,
    total: stats.total,
  });
}

// ==================== 静态文件服务 ====================
function serveStaticFile(req, res) {
  // 其他 HTML 文件（预览页等）
  if (req.url.endsWith('.html') && !req.url.includes('..')) {
    const filePath = path.join(PROJECT_DIR, req.url);
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
      const filePath = path.join(PROJECT_DIR, req.url);
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
  // 处理 OPTIONS 预检
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

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
    sendJSON(res, 500, { error: '服务器内部错误: ' + e.message });
  }
});

// 全局错误捕获，防止静默崩溃
process.on('uncaughtException', (err) => {
  console.error('FATAL uncaughtException:', err.message, err.stack);
});
process.on('unhandledRejection', (reason) => {
  console.error('FATAL unhandledRejection:', reason);
});

// ==================== 启动 ====================
async function start() {
  await initDB();
  server.listen(PORT, '0.0.0.0', () => {
    console.log('═══════════════════════════════════════════');
    console.log('  学习工作台服务器已启动');
    console.log('  地址: http://localhost:' + PORT);
    console.log('  数据库: PostgreSQL');
    console.log('═══════════════════════════════════════════');
    console.log('');
    console.log('API 列表:');
    console.log('  POST /api/register       注册（普通用户需审批）');
    console.log('  POST /api/login          登录（检查审批状态）');
    console.log('  POST /api/logout         登出');
    console.log('  GET  /api/data           获取数据');
    console.log('  POST /api/data           保存数据');
    console.log('  GET  /api/leaderboard    排行榜');
    console.log('  GET  /api/leaderboard/pets 宠物排行榜');
    console.log('  --- 管理员 API ---');
    console.log('  GET  /api/admin/users    全部用户列表');
    console.log('  POST /api/admin/approve  批准用户');
    console.log('  POST /api/admin/reject   拒绝/删除用户');
    console.log('  POST /api/admin/update-user 更新用户设置');
    console.log('  GET  /api/admin/stats    统计信息');
    console.log('');
    console.log('按 Ctrl+C 停止服务器');
  });
}

start().catch(err => {
  console.error('❌ 启动失败:', err.message);
  process.exit(1);
});
