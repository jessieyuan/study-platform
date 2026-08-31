# Study Platform

带多账号系统、宠物养成、排行榜的学习工作台。

## 环境要求

- **Node.js >= 22.0.0**（需要 `--experimental-sqlite` 支持）
- 零 NPM 依赖，开箱即用

## 快速启动

### macOS / Linux
```bash
# 方式一：使用启动脚本
bash server/start.sh

# 方式二：使用 npm
npm start

# 方式三：直接运行
node --experimental-sqlite server/server.js
```

### Windows
```
双击 server/start.bat
```

启动后在浏览器访问：**http://localhost:3000**

## 项目结构

```
study-platform/
├── index.html            # 主页面（前端 UI）
├── server/
│   ├── server.js         # Node.js 后端服务（含全部 API）
│   ├── start.sh          # macOS/Linux 启动脚本
│   └── start.bat         # Windows 启动脚本
├── pets/                 # 宠物图片资源
│   ├── pokemon/          # 宝可梦系列（6张）
│   └── star/             # 星星系列（6张）
├── img/flowers/          # 十二月花历图片资源（12张）
└── package.json          # 项目配置
```

## 功能模块

- 多账号注册登录（首个注册者自动成为管理员）
- 管理员审批用户
- 排行榜（积分、学习时长、宠物）
- 学习计划打卡（暑假作业、语文、数学、英语）
- 名人名言
- 宠物养成（领养、喂食、洗澡、运动、玩耍）
- 宠物等级系统 & 健康指数
- 宠物命机制（连续3天不喂食饥饿死亡）

## 技术栈

- 前端：纯 HTML/CSS/JS（零框架）
- 后端：Node.js 内置模块（http + sqlite + crypto + fs）
- 数据库：SQLite（零配置，数据文件在 server/data.db）

## 给开发者

- 数据库表会在首次启动时自动创建（`CREATE TABLE IF NOT EXISTS`）
- 前端页面是一个独立 HTML 文件，CSS 和 JS 均内联
- 后端 API 全部在 server/server.js 中，无路由框架

## 部署

本项目支持多种部署方式：

- **火山引擎云服务器**：详见 [部署指南-火山云.md](部署指南-火山云.md)
- **Docker**：项目含 Dockerfile，可直接 `docker build -t study-platform . && docker run -p 3000:3000 study-platform`
- **本地运行**：见上方快速启动

## License

MIT
