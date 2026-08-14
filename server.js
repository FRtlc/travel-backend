/**
 * 旅游指南后端 API
 * 部署到 CloudBase 云托管 (Cloud Run)
 * 支持本地 SQLite (开发) 和 CloudBase 数据库 (生产)
 */

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const https = require('https');

// 加载 .env 环境变量（内置加载器，无需 dotenv 依赖）
(function loadEnv() {
    const envPath = path.join(__dirname, '.env');
    try {
        if (fs.existsSync(envPath)) {
            const content = fs.readFileSync(envPath, 'utf8');
            content.split('\n').forEach(line => {
                line = line.trim();
                if (!line || line.startsWith('#')) return;
                const idx = line.indexOf('=');
                if (idx === -1) return;
                const key = line.substring(0, idx).trim();
                const val = line.substring(idx + 1).trim().replace(/^["']|["']$/g, '');
                if (key && !process.env[key]) process.env[key] = val;
            });
            console.log('[ENV] .env 文件已加载');
        }
    } catch (e) { /* 忽略 .env 加载错误 */ }
})();

// 腾讯云 SMS 短信服务
const sms = require('./sms');

const app = express();

// --- CORS 白名单（仅允许本应用的来源访问） ---
const ALLOWED_ORIGINS = [
    'capacitor://localhost',      // Android App (Capacitor)
    'ionic://localhost',          // iOS App (Capacitor)
    'https://localhost',          // Capacitor 新版本
    null,                         // Electron file:// 协议（Origin: null）
];
// 额外白名单：WEB_ORIGIN 环境变量（逗号分隔，部署 Web 版时配置）
if (process.env.WEB_ORIGIN) {
    process.env.WEB_ORIGIN.split(',').map(o => o.trim()).filter(Boolean).forEach(o => ALLOWED_ORIGINS.push(o));
}
app.use(cors({
    origin(origin, callback) {
        // 无 Origin 头（同源请求 / 服务器健康检查 / curl）直接放行
        if (!origin) return callback(null, true);
        // localhost / 127.0.0.1 任意端口放行（本地开发）
        if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return callback(null, true);
        if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
        console.warn('[CORS] 拒绝来源:', origin);
        return callback(null, false);
    },
    credentials: false,
}));
app.use(express.json({ limit: '10mb' }));

// --- 接口频率限制（防刷） ---
const rateBuckets = new Map(); // key -> { count, resetAt }
function rateLimit(key, limit, windowMs) {
    const now = Date.now();
    let b = rateBuckets.get(key);
    if (!b || now > b.resetAt) {
        b = { count: 0, resetAt: now + windowMs };
        rateBuckets.set(key, b);
    }
    b.count++;
    // 顺带清理过期桶，防止内存膨胀
    if (rateBuckets.size > 10000) {
        for (const [k, v] of rateBuckets) if (now > v.resetAt) rateBuckets.delete(k);
    }
    return b.count <= limit;
}
function clientIP(req) {
    const xf = req.headers['x-forwarded-for'];
    if (xf) return String(xf).split(',')[0].trim();
    return req.ip || req.socket.remoteAddress || 'unknown';
}
// 全局限流：100 次/分钟/IP
app.use((req, res, next) => {
    if (!rateLimit('global:' + clientIP(req), 100, 60 * 1000)) {
        return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
    }
    next();
});
// 登录注册限流：10 次/分钟/IP
const authRateLimit = (req, res, next) => {
    if (!rateLimit('auth:' + clientIP(req), 10, 60 * 1000)) {
        return res.status(429).json({ error: '尝试次数过多，请 1 分钟后再试' });
    }
    next();
};
// 短信限流：5 次/小时/IP + 5 次/小时/手机号
const smsRateLimit = (req, res, next) => {
    const phone = req.body && req.body.phone;
    if (!rateLimit('sms:ip:' + clientIP(req), 5, 60 * 60 * 1000) ||
        (phone && !rateLimit('sms:phone:' + phone, 5, 60 * 60 * 1000))) {
        return res.status(429).json({ error: '验证码发送过于频繁，请 1 小时后再试' });
    }
    next();
};

// ============================================================
// 数据库适配层：CloudBase Database (生产) / 内存 (本地开发)
// ============================================================

let db = null;           // CloudBase 数据库实例
let useCloudBase = false; // 是否使用 CloudBase 数据库
let localDB = {           // 本地开发用内存数据库
    users: [],
    checkins: [],
    orders: [],
    aiHistory: [],
    verifyCodes: {},      // { phone: { code, expires } }
    spotsData: [],
    initialized: false,
};

// 初始化 CloudBase SDK
function initCloudBase() {
    const envId = process.env.TCB_ENV_ID;
    if (!envId) {
        console.log('[DB] 未设置 TCB_ENV_ID，使用本地内存数据库（开发模式）');
        return false;
    }
    try {
        const tcb = require('@cloudbase/node-sdk');
        app.tcbApp = tcb.init({ env: envId });
        db = app.tcbApp.database();
        console.log('[DB] CloudBase 数据库已连接，环境 ID:', envId);
        return true;
    } catch (e) {
        console.warn('[DB] CloudBase SDK 加载失败，回退到内存数据库:', e.message);
        return false;
    }
}

useCloudBase = initCloudBase();

// 初始化 SMS 短信服务
const smsReady = sms.initSMS();

// --- 数据库操作封装 ---

async function dbGet(collection, query) {
    if (useCloudBase) {
        const cmd = db.command;
        let q = db.collection(collection);
        if (query) {
            const where = {};
            for (const [k, v] of Object.entries(query)) {
                if (v !== undefined && v !== null) where[k] = v;
            }
            if (Object.keys(where).length) q = q.where(where);
        }
        const res = await q.limit(1000).get();
        return res.data || [];
    } else {
        return localDB[collection] ? localDB[collection].filter(item => {
            if (!query) return true;
            for (const [k, v] of Object.entries(query)) {
                if (v !== undefined && v !== null && item[k] !== v) return false;
            }
            return true;
        }) : [];
    }
}

async function dbGetById(collection, id) {
    if (useCloudBase) {
        const res = await db.collection(collection).doc(id).get();
        return res.data && res.data[0];
    } else {
        const list = localDB[collection] || [];
        return list.find(item => String(item._id || item.id) === String(id));
    }
}

async function dbInsert(collection, doc) {
    const _id = crypto.randomUUID();
    const record = { ...doc, _id, created_at: new Date().toISOString() };
    if (useCloudBase) {
        const res = await db.collection(collection).add({ ...doc, created_at: new Date() });
        return { ...record, _id: res.id || _id };
    } else {
        if (!localDB[collection]) localDB[collection] = [];
        localDB[collection].push(record);
        return record;
    }
}

async function dbUpdate(collection, id, update) {
    if (useCloudBase) {
        await db.collection(collection).doc(id).update(update);
    } else {
        const list = localDB[collection] || [];
        const item = list.find(i => String(i._id || i.id) === String(id));
        if (item) Object.assign(item, update);
    }
}

async function dbDelete(collection, id) {
    if (useCloudBase) {
        await db.collection(collection).doc(id).remove();
    } else {
        const list = localDB[collection] || [];
        const idx = list.findIndex(i => String(i._id || i.id) === String(id));
        if (idx >= 0) list.splice(idx, 1);
    }
}

// --- 景点数据初始化 ---

async function initSpotsData() {
    if (useCloudBase) {
        const existing = await dbGet('spots', {});
        if (existing.length === 0) {
            const spotsData = require('./data/spots.js');
            for (const spot of spotsData) {
                await dbInsert('spots', { ...spot, likes: 0 });
            }
            console.log('[DB] 景点种子数据已导入', spotsData.length, '条');
        }
    } else {
        if (!localDB.initialized) {
            const spotsData = require('./data/spots.js');
            localDB.spotsData = spotsData.map((s, i) => ({ ...s, _id: String(i + 1), likes: 0 }));
            localDB.initialized = true;
            console.log('[DB] 本地景点数据已加载', localDB.spotsData.length, '条');
        }
    }
}

// ============================================================
// 安全：密码哈希（scrypt 加盐）+ 登录令牌
// ============================================================

const SCRYPT_N = 16384, SCRYPT_KEYLEN = 64;

// 加盐 scrypt 哈希，格式: scrypt$<盐hex>$<哈希hex>
function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN, { N: SCRYPT_N });
    return 'scrypt$' + salt.toString('hex') + '$' + hash.toString('hex');
}

// 校验密码；兼容历史 MD5 记录（校验通过后应调用 upgradeLegacyPassword 升级）
function verifyPassword(password, stored) {
    if (typeof stored !== 'string' || !stored) return false;
    if (stored.startsWith('scrypt$')) {
        const [, saltHex, hashHex] = stored.split('$');
        try {
            const hash = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), SCRYPT_KEYLEN, { N: SCRYPT_N });
            // 定长比较防时序攻击
            return hash.length === Buffer.from(hashHex, 'hex').length &&
                crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
        } catch (e) { return false; }
    }
    // 历史 MD5（旧数据迁移用）
    return crypto.createHash('md5').update(String(password)).digest('hex') === stored;
}
function isLegacyHash(stored) { return typeof stored === 'string' && stored !== '' && !stored.startsWith('scrypt$'); }

// --- 登录令牌：服务端签发的随机 token（7 天有效） ---
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const tokenStore = new Map(); // token -> { userId, expires }
function issueToken(userId) {
    const token = crypto.randomBytes(32).toString('hex');
    tokenStore.set(token, { userId, expires: Date.now() + TOKEN_TTL_MS });
    return token;
}
function verifyToken(token) {
    if (!token) return null;
    const t = tokenStore.get(token);
    if (!t) return null;
    if (Date.now() > t.expires) { tokenStore.delete(token); return null; }
    return t.userId;
}
function revokeToken(token) { if (token) tokenStore.delete(token); }

// ============================================================
// 中间件
// ============================================================

function authMiddleware(req, res, next) {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) {
        return res.status(401).json({ error: '请先登录' });
    }
    const token = auth.replace('Bearer ', '');
    const userId = verifyToken(token);
    if (!userId) {
        return res.status(401).json({ error: '登录已过期，请重新登录' });
    }
    req.userId = userId;
    req.token = token;
    next();
}

function optionalAuth(req, res, next) {
    const auth = req.headers.authorization;
    if (auth && auth.startsWith('Bearer ')) {
        const userId = verifyToken(auth.replace('Bearer ', ''));
        if (userId) {
            req.userId = userId;
            req.token = auth.replace('Bearer ', '');
        }
    }
    next();
}

// ============================================================
// API 路由
// ============================================================

// --- 健康检查 ---
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString(), db: useCloudBase ? 'CloudBase' : 'memory' });
});

// --- 用户注册 ---
app.post('/api/register', authRateLimit, async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || username.length < 3) return res.status(400).json({ error: '用户名至少3个字符' });
        if (!password || password.length < 4) return res.status(400).json({ error: '密码至少4个字符' });

        const existing = await dbGet('users', { username });
        if (existing.length > 0) return res.status(409).json({ error: '用户名已存在' });

        const user = await dbInsert('users', { username, password: hashPassword(password) });
        const token = issueToken(user._id);
        res.json({ success: true, user_id: user._id, username: user.username, token });
    } catch (e) {
        console.error('注册失败:', e);
        res.status(500).json({ error: '服务器错误' });
    }
});

// --- 用户登录 ---
app.post('/api/login', authRateLimit, async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ error: '请输入用户名和密码' });

        const users = await dbGet('users', { username });
        const user = users.find(u => verifyPassword(password, u.password));

        if (!user) return res.status(401).json({ error: '用户名或密码错误' });

        // 旧 MD5 密码自动升级为 scrypt
        if (isLegacyHash(user.password)) {
            await dbUpdate('users', user._id, { password: hashPassword(password) });
            console.log('[AUTH] 已自动升级旧密码哈希为 scrypt:', username);
        }

        const token = issueToken(user._id);
        res.json({ success: true, user_id: user._id, username: user.username, token });
    } catch (e) {
        console.error('登录失败:', e);
        res.status(500).json({ error: '服务器错误' });
    }
});

// --- 发送手机验证码 ---
app.post('/api/send_code', smsRateLimit, async (req, res) => {
    try {
        const { phone } = req.body;
        if (!phone || !/^1[3-9]\d{9}$/.test(phone)) {
            return res.status(400).json({ error: '请输入正确的手机号' });
        }

        // 生成 6 位验证码
        const code = String(Math.floor(100000 + Math.random() * 900000));
        const expireMinutes = 5;

        // 存储验证码，5 分钟过期
        if (useCloudBase) {
            await dbInsert('verify_codes', {
                phone, code,
                expires: new Date(Date.now() + expireMinutes * 60 * 1000),
                used: false,
            });
        } else {
            localDB.verifyCodes[phone] = { code, expires: Date.now() + expireMinutes * 60 * 1000, used: false };
        }

        // 发送短信验证码
        const smsResult = await sms.sendVerifyCodeSMS(phone, code, expireMinutes);

        if (smsResult.success) {
            if (smsResult.dev_mode) {
                // 开发模式：验证码只打到控制台，不返回给客户端
                console.log('[SMS] [开发模式] 验证码: ' + phone + ' -> ' + code);
                res.json({ success: true, message: '验证码已发送（开发模式，见服务端控制台）' });
            } else {
                // 生产模式：真实短信已发送
                console.log('[SMS] 短信已发送: ' + phone + ' (MsgId: ' + smsResult.msgId + ')');
                res.json({ success: true, message: '验证码已发送至手机' });
            }
        } else {
            console.error('[SMS] 发送失败:', smsResult.error);
            // 短信发送失败：不再把验证码返回给客户端（防绕过短信直接拿码）
            res.status(502).json({ error: '短信服务暂时不可用，请稍后再试' });
        }
    } catch (e) {
        console.error('发送验证码失败:', e);
        res.status(500).json({ error: '服务器错误' });
    }
});

// --- 手机号验证码登录 ---
app.post('/api/phone_login', authRateLimit, async (req, res) => {
    try {
        const { phone, code } = req.body;
        if (!phone || !code) return res.status(400).json({ error: '请输入手机号和验证码' });

        // 验证验证码
        let validCode = false;
        if (useCloudBase) {
            const records = await dbGet('verify_codes', { phone, used: false });
            const record = records.find(r => r.code === code && new Date(r.expires) > new Date());
            if (record) {
                validCode = true;
                await dbUpdate('verify_codes', record._id, { used: true });
            }
        } else {
            const stored = localDB.verifyCodes[phone];
            if (stored && stored.code === code && stored.expires > Date.now() && !stored.used) {
                validCode = true;
                stored.used = true;
            }
        }

        if (!validCode) return res.status(401).json({ error: '验证码错误或已过期' });

        // 查找或创建用户
        let users = await dbGet('users', { phone });
        let user;
        if (users.length === 0) {
            user = await dbInsert('users', {
                username: '用户' + phone.slice(-4),
                phone,
                password: '',
            });
        } else {
            user = users[0];
        }

        const token = issueToken(user._id);
        res.json({ success: true, user_id: user._id, username: user.username, token });
    } catch (e) {
        console.error('手机登录失败:', e);
        res.status(500).json({ error: '服务器错误' });
    }
});

// --- 获取全部景点 ---
app.get('/api/spots', async (req, res) => {
    try {
        let spots;
        if (useCloudBase) {
            spots = await dbGet('spots', {});
        } else {
            spots = localDB.spotsData;
        }
        res.json(spots);
    } catch (e) {
        console.error('获取景点失败:', e);
        res.status(500).json({ error: '服务器错误' });
    }
});

// --- 获取省份列表 ---
app.get('/api/provinces', async (req, res) => {
    try {
        let spots;
        if (useCloudBase) {
            spots = await dbGet('spots', {});
        } else {
            spots = localDB.spotsData;
        }
        const provinces = [...new Set(spots.map(s => s.province))];
        res.json(provinces);
    } catch (e) {
        console.error('获取省份失败:', e);
        res.status(500).json({ error: '服务器错误' });
    }
});

// --- 获取单个景点详情 ---
app.get('/api/spots/:id', async (req, res) => {
    try {
        const id = req.params.id;
        let spot;
        if (useCloudBase) {
            spot = await dbGetById('spots', id);
        } else {
            spot = localDB.spotsData.find(s => String(s._id) === String(id));
        }
        if (!spot) return res.status(404).json({ error: '景点不存在' });
        res.json(spot);
    } catch (e) {
        console.error('获取景点详情失败:', e);
        res.status(500).json({ error: '服务器错误' });
    }
});

// --- 购票下单 ---
app.post('/api/ticket/order', authMiddleware, async (req, res) => {
    try {
        const { spot_id, spot_name, price } = req.body;
        const order = await dbInsert('orders', {
            user_id: req.userId,
            spot_id, spot_name, price,
            status: 'paid',
            order_type: 'ticket',
        });
        res.json({ success: true, order_id: order._id });
    } catch (e) {
        console.error('购票失败:', e);
        res.status(500).json({ error: '服务器错误' });
    }
});

// --- 周边商品列表 ---
app.post('/api/merch/list', authMiddleware, async (req, res) => {
    try {
        const { spot_name } = req.body;
        const items = [
            { name: spot_name + ' 明信片', price: 15 },
            { name: spot_name + ' 纪念徽章', price: 25 },
            { name: spot_name + ' 钥匙扣', price: 18 },
            { name: spot_name + ' 冰箱贴', price: 12 },
        ];
        res.json({ success: true, items });
    } catch (e) {
        res.status(500).json({ error: '服务器错误' });
    }
});

// --- 搜索附近酒店 ---
app.post('/api/hotel/search', authMiddleware, async (req, res) => {
    try {
        const { spot_name } = req.body;
        const hotels = [
            { name: '如家酒店(' + spot_name + '店)', price: 268, rating: 4.2 },
            { name: '汉庭酒店(' + spot_name + '店)', price: 189, rating: 4.0 },
            { name: '全季酒店(' + spot_name + '店)', price: 359, rating: 4.5 },
        ];
        res.json({ success: true, hotels });
    } catch (e) {
        res.status(500).json({ error: '服务器错误' });
    }
});

// --- 预约导游 ---
app.post('/api/guide/search', authMiddleware, async (req, res) => {
    try {
        const { spot_name } = req.body;
        const guide = {
            guide_name: '金牌导游·李师傅',
            spot: spot_name,
            experience: '8年',
            languages: ['普通话', '英语'],
            price: 300,
        };
        res.json({ success: true, ...guide });
    } catch (e) {
        res.status(500).json({ error: '服务器错误' });
    }
});

// --- AI 生成打卡文案 ---
app.post('/api/ai/generate_copy', authMiddleware, async (req, res) => {
    try {
        const { spot_name, mood, template } = req.body;
        const templates = {
            '人像': `在${spot_name}，遇见了最美的${mood || '笑容'}时光。人物与风景融为一体，每一帧都是故事。#旅行打卡 #${spot_name}`,
            '风景': `${spot_name}的${mood || '自然'}之美，令人心旷神怡。天地之间，唯有此刻的宁静与壮阔。#旅行打卡 #${spot_name}`,
            '美食': `${spot_name}的${mood || '美味'}，是旅途最温暖的记忆。舌尖上的旅行，从这里开始。#美食打卡 #${spot_name}`,
            '街拍': `漫步${spot_name}街头，${mood || '感受'}城市的脉搏与温度。每一条巷弄都藏着故事。#街拍 #${spot_name}`,
            '夜景': `${spot_name}的夜，${mood || '璀璨'}如星河。万家灯火间，是最真实的城市烟火。#夜景 #${spot_name}`,
            '情侣': `和你一起在${spot_name}，${mood || '幸福'}是最好的滤镜。旅行的意义，就是和你在一起。#情侣打卡 #${spot_name}`,
        };
        const copyText = templates[template] || `在${spot_name}，遇见了最美的${mood || '旅行'}时光。#旅行打卡 #${spot_name}`;
        res.json({ success: true, copy: copyText });
    } catch (e) {
        console.error('生成文案失败:', e);
        res.status(500).json({ error: '服务器错误' });
    }
});

// --- 提交打卡 ---
app.post('/api/checkins', authMiddleware, async (req, res) => {
    try {
        const { spot_name, copy, mood, template, is_public, photo, photo_consent } = req.body;

        // 照片授权：携带照片时必须明确勾选授权，否则拒绝（个人信息保护要求）
        if (photo && photo_consent !== true) {
            return res.status(400).json({ error: '上传照片前需勾选照片使用授权' });
        }

        const checkin = await dbInsert('checkins', {
            user_id: req.userId,
            spot_name, copy, mood, template,
            is_public: is_public !== false,
            photo: photo || '',
            photo_consent: photo ? true : false,
            likes: 0,
        });

        // 如果有照片，可以上传到 CloudBase 存储
        if (photo && useCloudBase && photo.startsWith('data:image')) {
            // TODO: 上传到 CloudBase 云存储
            // const base64 = photo.split(',')[1];
            // const buffer = Buffer.from(base64, 'base64');
            // await app.tcbApp.uploadFile({ cloudPath: `checkins/${checkin._id}.jpg`, fileContent: buffer });
        }

        res.json({ success: true, checkin_id: checkin._id, checkin });
    } catch (e) {
        console.error('提交打卡失败:', e);
        res.status(500).json({ error: '服务器错误' });
    }
});

// --- 获取打卡列表 ---
app.get('/api/checkins', optionalAuth, async (req, res) => {
    try {
        let checkins;
        if (useCloudBase) {
            checkins = await dbGet('checkins', {});
        } else {
            checkins = localDB.checkins || [];
        }

        // 如果用户已登录，优先返回自己的打卡 + 公开打卡
        if (req.userId) {
            checkins = checkins.filter(c => c.user_id === req.userId || c.is_public !== false);
        } else {
            checkins = checkins.filter(c => c.is_public !== false);
        }

        // 按时间倒序
        checkins.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

        res.json(checkins);
    } catch (e) {
        console.error('获取打卡列表失败:', e);
        res.status(500).json({ error: '服务器错误' });
    }
});

// --- 删除自己的打卡（含照片，用户数据被遗忘权） ---
app.delete('/api/checkins/:id', authMiddleware, async (req, res) => {
    try {
        const id = req.params.id;
        const checkin = await dbGetById('checkins', id);
        if (!checkin) return res.status(404).json({ error: '打卡不存在' });
        // 只允许删除自己的打卡
        if (String(checkin.user_id) !== String(req.userId)) {
            return res.status(403).json({ error: '只能删除自己的打卡' });
        }
        await dbDelete('checkins', id);
        res.json({ success: true });
    } catch (e) {
        console.error('删除打卡失败:', e);
        res.status(500).json({ error: '服务器错误' });
    }
});

// --- 退出登录（吊销令牌） ---
app.post('/api/logout', authMiddleware, (req, res) => {
    revokeToken(req.token);
    res.json({ success: true });
});

// ============================================================
// DeepSeek AI 集成（可选）：设置环境变量 DEEPSEEK_API_KEY 后启用真实 AI
// 未设置时自动回退到本地模板回复，不影响其他功能
// ============================================================
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';

function aiEnabled() {
    return !!DEEPSEEK_API_KEY;
}

/**
 * 调用 DeepSeek Chat API（使用 Node 内置 https，无需额外依赖）
 * @param {Array} messages - OpenAI 格式的 messages
 * @param {number} maxTokens
 * @returns {Promise<string>} 回复文本
 */
function callDeepSeek(messages, maxTokens) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify({
            model: DEEPSEEK_MODEL,
            messages: messages,
            temperature: 0.7,
            max_tokens: maxTokens || 1500
        });
        const req = https.request({
            hostname: 'api.deepseek.com',
            path: '/v1/chat/completions',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + DEEPSEEK_API_KEY,
                'Content-Length': Buffer.byteLength(payload)
            },
            timeout: 30000
        }, (res) => {
            let body = '';
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => {
                try {
                    const data = JSON.parse(body);
                    if (data.choices && data.choices[0] && data.choices[0].message) {
                        resolve(data.choices[0].message.content || '');
                    } else if (data.error) {
                        reject(new Error('DeepSeek 错误: ' + (data.error.message || JSON.stringify(data.error))));
                    } else {
                        reject(new Error('DeepSeek 响应格式异常'));
                    }
                } catch (e) {
                    reject(new Error('DeepSeek 响应解析失败: ' + e.message));
                }
            });
        });
        req.on('timeout', () => { req.destroy(new Error('DeepSeek 请求超时')); });
        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

/**
 * 生成 AI 问答回复：有 DEEPSEEK_API_KEY 时调用真实 DeepSeek，否则用本地模板兜底
 */
async function generateAIReplyAsync(question) {
    if (!aiEnabled()) return generateAIReply(question);
    try {
        const reply = await callDeepSeek([
            { role: 'system', content: '你是"游指南"旅行应用的智能助手，用简洁、实用、友好的中文回答用户的旅行问题，包括目的地推荐、行程攻略、美食、预算、最佳旅行时间等。回答控制在300字以内，可使用要点列表。' },
            { role: 'user', content: question }
        ]);
        return reply || generateAIReply(question);
    } catch (e) {
        console.error('DeepSeek 调用失败，回退模板:', e.message);
        return generateAIReply(question);
    }
}

// --- AI 问答（SSE 流式） ---
app.post('/api/ai/ask', optionalAuth, async (req, res) => {
    try {
        const { question } = req.body;
        if (!question) return res.status(400).json({ error: '请输入问题' });

        // 保存到历史
        if (req.userId) {
            await dbInsert('ai_history', { user_id: req.userId, question, answer: '' });
        }

        // SSE 流式响应
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        // 生成回复（配置 DEEPSEEK_API_KEY 时为真实 AI，否则模板兜底）
        const reply = await generateAIReplyAsync(question);
        const words = reply.split('');

        for (let i = 0; i < words.length; i++) {
            res.write('data: ' + JSON.stringify({ content: words[i] }) + '\n\n');
            await new Promise(resolve => setTimeout(resolve, 30));
        }
        res.write('data: [DONE]\n\n');
        res.end();

        // 更新 AI 历史记录的 answer
        if (req.userId && useCloudBase) {
            const history = await dbGet('ai_history', { user_id: req.userId, question, answer: '' });
            if (history.length > 0) {
                await dbUpdate('ai_history', history[history.length - 1]._id, { answer: reply });
            }
        }
    } catch (e) {
        console.error('AI 问答失败:', e);
        if (!res.headersSent) {
            res.status(500).json({ error: '服务器错误' });
        } else {
            res.end();
        }
    }
});

// --- 路线规划 AI（JSON 非流式，供前端 callAI 使用）---
app.post('/api/ai/plan', optionalAuth, async (req, res) => {
    try {
        const { prompt, context } = req.body;
        if (!prompt) return res.status(400).json({ error: '缺少 prompt' });

        let reply = '';
        if (aiEnabled()) {
            try {
                const ctx = context || {};
                const spotsInfo = (ctx.spots || []).map(s => `${s.name}(${s.city || ''},${s.category || '景点'},¥${s.price || 0})`).join('、');
                const sysMsg = '你是专业的旅游行程规划助手。用户已选景点: ' + spotsInfo +
                    '。旅行天数: ' + (ctx.days || 1) + '天，节奏: ' + (ctx.pace || '适中') +
                    '，预算: ' + (ctx.budget || '中等') +
                    '。请给出优化建议，包括行程顺序、时间分配、餐饮和交通建议，300字以内，用要点列出。';
                reply = await callDeepSeek([
                    { role: 'system', content: sysMsg },
                    { role: 'user', content: prompt }
                ], 1500);
            } catch (e) {
                console.error('DeepSeek 规划失败，回退模板:', e.message);
            }
        }
        // 未配置 DeepSeek 或调用失败时返回空 reply，由前端本地模板兜底
        res.json({ reply: reply || '' });
    } catch (e) {
        console.error('AI 规划失败:', e);
        res.status(500).json({ error: '服务器错误' });
    }
});

// --- 获取 AI 对话历史 ---
app.get('/api/ai/history', authMiddleware, async (req, res) => {
    try {
        let history = await dbGet('ai_history', { user_id: req.userId });
        history.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        res.json(history);
    } catch (e) {
        console.error('获取 AI 历史失败:', e);
        res.status(500).json({ error: '服务器错误' });
    }
});

// --- AI 回复生成 ---
function generateAIReply(question) {
    const q = question.toLowerCase();

    if (q.includes('推荐') || q.includes('去哪') || q.includes('哪里好玩')) {
        return '推荐你去以下几个地方：1. 云南大理——风花雪月的浪漫之地，洱海边骑行很惬意；2. 湖南张家界——《阿凡达》取景地，石英砂岩峰林震撼；3. 青海湖——中国最大内陆咸水湖，7月油菜花盛开绝美；4. 福建厦门鼓浪屿——文艺清新，万国建筑博览。你可以告诉我你的出发地、预算和偏好，我来给你更精准的推荐！';
    }
    if (q.includes('攻略') || q.includes('怎么玩') || q.includes('路线')) {
        return '旅行攻略建议：1. 提前规划行程，确定主要目的地和天数；2. 预订机票和住宿要趁早，尤其旺季；3. 每天安排2-3个景点即可，不要贪多；4. 带好充电宝、防晒、舒适鞋；5. 下载离线地图以防万一。你可以告诉我具体想去哪里，我给你定制路线！';
    }
    if (q.includes('美食') || q.includes('吃') || q.includes('好吃')) {
        return '各地美食推荐：北京烤鸭、成都火锅、西安肉夹馍、广州早茶、杭州西湖醋鱼、厦门沙茶面、新疆大盘鸡、云南过桥米线、广西螺蛳粉、青岛海鲜。每个地方都有独特的味道，旅行中一定要尝尝当地特色！';
    }
    if (q.includes('预算') || q.includes('多少钱') || q.includes('花费')) {
        return '旅行预算参考：国内短途（3-5天）约2000-5000元，长途（7-10天）约5000-15000元。主要花费：交通30%、住宿25%、餐饮20%、门票10%、购物15%。省钱技巧：提前订票、住民宿青旅、吃当地小馆、避开旺季。';
    }
    if (q.includes('季节') || q.includes('什么时候') || q.includes('几月')) {
        return '最佳旅行时间：春季（3-5月）适合去江南、云南；夏季（6-8月）适合去青海、内蒙、东北避暑；秋季（9-11月）适合去新疆、四川、北京；冬季（12-2月）适合去海南、哈尔滨。告诉我你想去哪里，我给你更具体的时间建议！';
    }
    // 默认回复
    return '我是你的旅行小助手！你可以问我：推荐目的地、旅行攻略、当地美食、预算建议、最佳旅行时间等问题。比如试试问"推荐几个适合秋天去的地方？"或者"去大理怎么玩？"';
}

// ============================================================
// 启动服务
// ============================================================

const PORT = process.env.PORT || 5000;

async function start() {
    await initSpotsData();
    // HTTPS 防护：生产环境禁止裸 HTTP 直接对外
    // CloudBase 云托管 / Render 等平台由平台层终结 TLS，应用内部走 HTTP 属正常情况（以 TCB_ENV_ID / RENDER 判定）
    const isProd = process.env.NODE_ENV === 'production';
    const behindTLSPlatform = !!(process.env.TCB_ENV_ID || process.env.RENDER || process.env.FORCE_INSECURE);
    if (isProd && !behindTLSPlatform) {
        console.error('[安全] 生产环境(NODE_ENV=production)拒绝以裸 HTTP 启动：账号密码将明文传输。');
        console.error('[安全] 请部署到自带 HTTPS 的平台（CloudBase 云托管 / Render 等），');
        console.error('[安全] 或设置 FORCE_INSECURE=1 明确确认风险后重试。');
        process.exit(1);
    }

    app.listen(PORT, '0.0.0.0', () => {
        console.log(`=============================================`);
        console.log(`  旅游指南后端 API 已启动`);
        console.log(`  端口: ${PORT}`);
        console.log(`  数据库: ${useCloudBase ? 'CloudBase' : '内存(开发模式)'}`);
        console.log(`  短信服务: ${sms.isReady() ? '腾讯云SMS(已配置)' : '开发模式(未配置)'}`);
        console.log(`  AI 服务: ${aiEnabled() ? 'DeepSeek(已配置)' : '模板回复(未配置 DEEPSEEK_API_KEY)'}`);
        console.log(`  安全: 密码scrypt加密 / 令牌鉴权 / 限流开启 / CORS白名单`);
        console.log(`  健康检查: http://localhost:${PORT}/api/health`);
        console.log(`=============================================`);
    });
}

start().catch(e => {
    console.error('启动失败:', e);
    process.exit(1);
});
