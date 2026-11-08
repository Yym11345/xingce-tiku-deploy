# 行测真题题库 · 部署包

> 2016–2026 公务员行测真题，**515 套卷 / 58,890 题**，含官方解析与全部配图，纯静态、无框架、无构建步骤，
> 克隆下来就能跑，也可以直接丢给任意静态托管。

在线演示：<https://xingce-tiku.apps.workbuddy.host/?sharecode=UREIK6GW6A>

---

## 里面有什么

| 项 | 数量 |
|---|---|
| 试卷 | 515 套（国考 + 各省省考 / 选调 / 联考） |
| 题目 | 58,890 道（去重后 27,449 道） |
| 模块 | 6 个（政治理论 / 常识判断 / 言语理解与表达 / 数量关系 / 判断推理 / 资料分析） |
| 题型 | 22 个（逻辑填空、图形推理、资料分析-增长…） |
| 考点 | 159 个（资料分析等模块由官方解析抽取） |
| 材料 | 2,049 份（资料分析「一材多题」） |
| 图片 | 39,454 张（题目图 WebP + 公式图 PNG，全部本地化） |

每道题都带：题干、选项、正确答案、官方解析、所属卷/年份/地区/模块/题型/考点。

## 功能

- **套卷模考**：按真实试卷顺序做，交卷前不判分，交卷后统一出分 + 逐题解析，进度自动保存
- **专项练习**：模块 → 题型 → 考点 → 年份 → 地区 五层筛选，边做边判
- **错题本**：做错自动进，重做答对自动出
- **考点地图**：159 个考点按题量排序，一眼看出性价比最高的部分
- **学习统计**：正确率、分模块表现、14 天曲线、连续打卡
- **账号（可选）**：用户名 + 密码，错题/收藏/记录云端同步；只有跑 `server.py` 时可用
- 键盘作答（A–H 选择、← → 翻页、空格下一题）、移动端适配

---

## 部署方式

### 方式 A：静态托管（最简单，推荐）

整个仓库就是一个静态站点，**没有构建步骤**。把仓库根目录直接作为发布目录即可。

| 平台 | 操作 |
|---|---|
| **Vercel** | 导入仓库 → Framework 选 `Other` → Build Command 留空 → Output Directory 填 `.` |
| **Netlify** | 导入仓库 → Build command 留空 → Publish directory 填 `.` |
| **Cloudflare Pages** | 连接仓库 → 构建命令留空 → 输出目录 `/` |
| **GitHub Pages** | Settings → Pages → Source 选 `Deploy from a branch` → 分支 `main`、目录 `/ (root)` |
| **Nginx / Apache** | 把仓库内容拷到站点根目录即可，无需 rewrite（前端用 hash 路由） |

> 静态托管下**没有账号功能**：前端启动时会探测 `/api/auth/me`，探测不到就自动切「本地模式」，
> 记录存在浏览器 localStorage。做题、判分、解析、错题本全部正常。

### 方式 B：Docker（带账号系统）

```bash
docker build -t xingce-tiku .
docker run -d -p 8080:8080 -v $(pwd)/.data:/app/.data --name xingce xingce-tiku
```

`-v .data` 挂载出来，账号库才不会随容器删除而丢失。

### 方式 C：本地 / 任意 VPS

需要 Python 3（仅标准库，无第三方依赖）：

```bash
PORT=8080 python3 server.py
# 打开 http://127.0.0.1:8080/
```

`server.py` 会：绑定 `0.0.0.0`、读 `PORT` 环境变量、对 JSON/JS/CSS 做内存缓存 gzip（分片 1.1MB → 354KB）、
提供 `/api/auth/*` 与 `/api/sync` 账号接口（SQLite 存在 `.data/app.db`）。

---

## 给 AI 智能体 / 自动化脚本的部署指令

```
仓库是纯静态站点，无需安装依赖、无需构建。
1. git clone <repo>
2. 把仓库根目录作为静态站点根发布（index.html 在根目录）
3. 若托管平台支持 Node/Python，可选：PORT=8080 python3 server.py 以获得 gzip 与账号功能
4. 验证：GET / 返回 200 且页面标题含「行测真题库」；GET /data/meta.json 返回 total=58890
```

注意事项（踩过的坑，直接照做即可）：

- **不要**给站点加 SPA rewrite / history fallback —— 前端用的是 hash 路由，加了反而会让缺失的图片返回 HTML。
- `data/*.json` 与 `90-图片/*` 是内容主体（约 220MB），务必配置长缓存；`index.html` / `assets/*` 用 no-cache。
- 仓库内**没有**任何密钥、API key 或私有凭据，可直接公开部署。
- 若只想看效果不想部署：本地 `python3 -m http.server 8080` 也能跑（只是没有 gzip 和账号）。

---

## 目录结构

```
.
├── index.html            入口（hash 路由 SPA）
├── assets/
│   ├── app.js            全部前端逻辑（数据加载 / 做题引擎 / 账号 / 统计）
│   └── app.css
├── data/                 题库数据
│   ├── meta.json         总量与各维度分布
│   ├── papers.json       515 套卷元信息
│   ├── buckets.json      各维度题号桶（筛选用）
│   ├── index.json        qid → 位置映射
│   ├── mat.json          2,049 份材料
│   └── qs/0..98.json     99 个分片，每片 600 题
├── 90-图片/
│   ├── 题目图/           6,145 张 WebP（无损转码，原 PNG 222MB → 85MB）
│   └── 公式图/           33,309 张 PNG（解析里的公式渲染图）
├── server.py             可选：本地/容器服务（gzip + 账号 + 同步）
├── Dockerfile
└── tools/                重建数据用（可选，普通部署用不到）
    ├── build_data.py     从上游 markdown 重新生成 data/
    ├── build_deploy.py   生成发布目录（图片转 WebP + 路径改写）
    ├── deploy_server.py  server.py 的源文件
    └── restore_imgs.py   用 git cat-file 补齐缺失文件
```

---

## 数据来源与声明

- 原始题库来自开源项目 **[ERRRC/xingcezhenti](https://github.com/ERRRC/xingcezhenti)**（2016–2026 行测真题，
  按模块整理的 markdown + 本地化图片）。本仓库在其基础上做了结构化解析、分类、去重、WebP 转码与前端实现。
- 题目内容（题干 / 选项 / 答案 / 解析）版权归原命题机构与整理者所有，本仓库**仅用于学习与研究**，
  不做商业用途。如需商用请自行联系权利人。
- 上游有 2 张公式图本身缺失，对应解析会显示空图位。
- 本仓库的代码部分（前端 + 脚本）可自由使用、修改、再分发。

## 已知边界

- 考点是**自动标注**：资料分析、图形推理的考点来自官方解析正则抽取（可信）；其余为问法规则推断（可解释但不保证全对）。
- 账号库是单机 SQLite，不做多实例共享；水平扩展部署请把账号功能关掉（即纯静态部署）。
- 重复题占 53.4%（同一道题跨省重复出现），专项练习默认开启「去掉重复题」。

---

## 重建数据（仅当你要改解析规则）

```bash
git clone https://github.com/ERRRC/xingcezhenti.git repo
python tools/build_data.py     # 重新生成 data/
python tools/build_deploy.py   # 生成发布目录（图片转 WebP）
```
