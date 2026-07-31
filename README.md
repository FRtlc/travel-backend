# 旅游指南后端 API - CloudBase 部署指南

## 项目结构

```
cloudbase-backend/
├── server.js          # 主服务文件 (Express, 16 个 API 端点)
├── package.json       # 依赖配置
├── Dockerfile         # Docker 镜像构建文件
├── .env.example       # 环境变量模板
├── data/
│   └── spots.js       # 40+ 景点种子数据
└── README.md          # 本文件
```

## 前端改动

前端只需改一行代码，将 `旅游.html` 中的：

```javascript
const API_BASE = 'http://47.250.211.42:5000/api';
```

改为你的 CloudBase 云托管地址：

```javascript
const API_BASE = 'https://your-service.tcloudbase.com/api';
```

---

## 部署方式一：CloudBase 云托管 (推荐)

### 第 1 步：开通 CloudBase

1. 打开 [腾讯云 CloudBase 控制台](https://console.cloud.tencent.com/tcb)
2. 点击「新建环境」，填写环境名称（如 `travel-app`），选择按量付费
3. 创建完成后，记下你的 **环境 ID**（形如 `travel-app-xxxxx`）

### 第 2 步：开通云托管

1. 在 CloudBase 控制台左侧选择「云托管」
2. 点击「立即开通」，等待服务开通

### 第 3 步：创建服务并部署

#### 方式 A：控制台上传部署

1. 在云托管页面点击「新建服务」
2. 服务名称填 `travel-api`
3. 上传方式选择「代码包」或「Docker 镜像」
4. 如果选择代码包：将 `cloudbase-backend/` 目录打包为 zip 上传
5. 监听端口设为 `5000`
6. 环境变量添加：`TCB_ENV_ID = 你的环境ID`
7. 点击「部署」

#### 方式 B：CLI 命令行部署

1. 安装 CloudBase CLI：
```bash
npm install -g @cloudbase/cli
```

2. 登录：
```bash
tcb login
```

3. 在 `cloudbase-backend/` 目录下部署：
```bash
cd cloudbase-backend
tcb fn deploy --name travel-api
```

### 第 4 步：获取访问地址

部署成功后，CloudBase 会给你一个访问地址，形如：
```
https://travel-api-xxxxx.tcloudbase.com
```

### 第 5 步：配置自定义路径 (可选)

如果需要 `/api/*` 路径前缀：
1. 在云托管服务设置中配置「访问路径」为 `/api`
2. 或在前端 `API_BASE` 中包含完整路径

---

## 部署方式二：本地开发 / 自有服务器

### 本地运行

```bash
cd cloudbase-backend
npm install
node server.js
```

不设置 `TCB_ENV_ID` 环境变量时，自动使用内存数据库（开发模式）。
验证码会打印在控制台日志中，方便测试。

### 自有服务器运行 (Docker)

```bash
cd cloudbase-backend
docker build -t travel-backend .
docker run -d -p 5000:5000 -e TCB_ENV_ID=your-env-id travel-backend
```

---

## API 端点列表 (共 16 个)

| 端点 | 方法 | 认证 | 功能 |
|------|------|------|------|
| `/api/health` | GET | 否 | 健康检查 |
| `/api/register` | POST | 否 | 用户注册 |
| `/api/login` | POST | 否 | 账号密码登录 |
| `/api/send_code` | POST | 否 | 发送手机验证码 |
| `/api/phone_login` | POST | 否 | 手机号验证码登录 |
| `/api/spots` | GET | 否 | 获取全部景点 |
| `/api/spots/:id` | GET | 否 | 获取景点详情 |
| `/api/provinces` | GET | 否 | 获取省份列表 |
| `/api/checkins` | GET | 可选 | 获取打卡列表 |
| `/api/checkins` | POST | 是 | 提交打卡 |
| `/api/ticket/order` | POST | 是 | 购票下单 |
| `/api/merch/list` | POST | 是 | 周边商品列表 |
| `/api/hotel/search` | POST | 是 | 搜索附近酒店 |
| `/api/guide/search` | POST | 是 | 预约导游 |
| `/api/ai/generate_copy` | POST | 是 | AI 生成文案 |
| `/api/ai/ask` | POST | 可选 | AI 问答 (SSE 流式) |
| `/api/ai/history` | GET | 是 | AI 对话历史 |

---

## 数据库集合

CloudBase 数据库需要创建以下集合（首次请求时自动创建）：

| 集合名 | 用途 | 主要字段 |
|--------|------|---------|
| `users` | 用户表 | username, password, phone |
| `spots` | 景点表 | name, province, city, price, rating, category, description, tips, image |
| `checkins` | 打卡记录 | user_id, spot_name, copy, mood, template, photo, is_public, likes |
| `orders` | 订单表 | user_id, spot_id, spot_name, price, status, order_type |
| `verify_codes` | 验证码 | phone, code, expires, used |
| `ai_history` | AI 对话 | user_id, question, answer, created_at |

### 数据库安全规则

在 CloudBase 控制台为每个集合设置权限规则：

- `users`: 仅创建者可读写
- `spots`: 所有用户可读
- `checkins`: 所有用户可读，仅创建者可写
- `orders`: 仅创建者可读写
- `verify_codes`: 仅服务端可读写
- `ai_history`: 仅创建者可读写

---

## 注意事项

1. **短信验证码**: 当前验证码打印在服务端日志中。生产环境需接入腾讯云 SMS 服务，在 `server.js` 的 `/api/send_code` 路由中添加发送短信逻辑。

2. **照片存储**: 打卡照片目前以 base64 存储。生产环境建议接入 CloudBase 云存储，将照片上传后返回 URL。

3. **AI 问答**: 当前使用模板回复。如需接入真实大模型，在 `server.js` 中配置 `AI_API_KEY` 和 `AI_API_URL`。

4. **自动伸缩**: CloudBase 云托管支持自动伸缩，请求量小时缩容到 0 实例（不产生费用），有请求时自动启动。
