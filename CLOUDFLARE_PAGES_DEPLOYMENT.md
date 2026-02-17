# Email Explorer Cloudflare Pages 部署指南（从 Fork 到上线）

> 目标：你只需要在 Cloudflare Pages 网页控制台配置 **Build command = `pnpm run build`**，就可以把本项目部署为可直接访问和登录的版本。

---

## 1. 前置准备

在开始前，请确认你有：

- 一个 GitHub 账号。
- 一个 Cloudflare 账号（已开通 Pages）。
- （可选）自己的域名（如果要绑定自定义域名）。

---

## 2. Fork 项目到你的 GitHub

1. 打开原仓库页面（例如 `G4brym/email-explorer`）。
2. 点击右上角 **Fork**。
3. 选择你的账号作为目标，完成 Fork。

完成后，你会得到自己的仓库，例如：

- `https://github.com/<your-name>/email-explorer`

---

## 3. 在 Cloudflare Pages 创建项目

1. 登录 Cloudflare Dashboard。
2. 进入 **Workers & Pages**。
3. 选择 **Create application** → **Pages** → **Connect to Git**。
4. 授权并选择你 Fork 后的仓库（`<your-name>/email-explorer`）。
5. 进入构建配置页面，填写：

- **Production branch**: `main`（或你的默认分支）
- **Build command**: `pnpm run build`
- **Build output directory**: `dist`
- **Deploy command**: 留空（默认）

> 说明：该项目已配置为将前端与 Worker 统一产物输出到根目录 `dist/`，其中 Worker 入口是 `dist/_worker.js`。

---

## 4. 在 Pages 项目中绑定资源（重点）

创建完成后，进入 Pages 项目设置并添加 Bindings。

路径：**Pages 项目 → Settings → Bindings**

### 4.1 D1 数据库绑定

- Type: **D1 database**
- Variable name: **`DB`**（必须一致）
- Database: 选择你创建的 D1（建议命名 `email-explorer`）

### 4.2 R2 存储桶绑定

- Type: **R2 bucket**
- Variable name: **`BUCKET`**
- Bucket: 选择你的 R2 bucket（建议命名 `email-explorer`）

### 4.3 Durable Object 绑定

- Type: **Durable Object Namespace**
- Variable name: **`MAILBOX`**
- Class name: **`MailboxDO`**
- Script name: 选择当前 Pages 项目对应的 Worker（通常同项目名）

> 如果你在 Pages 中看到“Durable Objects 需要 script_name”，就在这里绑定并选择脚本即可。

---

## 5. 初始化数据库（users 等表）

本项目的用户、会话等鉴权数据由 `AUTH` 对应的 Durable Object 内部 SQLite 维护，
首次请求会执行迁移并在空表时自动注入默认管理员账号。

默认管理员账号（首次空库自动创建）：

1. `admin@email.230406.xyz` / `admin`
2. `admin@230406.xyz` / `admin`

> 若你使用的是全新环境，通常不需要手动建 `users` 表；访问站点并触发 API 后会自动完成。

---

## 6. 触发首次部署

完成第 3、4 步后：

1. 回到 Pages 项目首页。
2. 点击 **Retry deployment**（或向 GitHub push 一次新 commit）。
3. 等待 Build + Deploy 完成。

你会获得一个默认访问地址，例如：

- `https://<project-name>.pages.dev`

---

## 7. 首次登录与验证

部署成功后：

1. 打开 `https://<project-name>.pages.dev/login`
2. 使用任一默认管理员登录：
   - `admin@email.230406.xyz` / `admin`
   - `admin@230406.xyz` / `admin`
3. 登录后建议立即进入后台修改密码。

建议做以下快速验证：

- 登录是否成功。
- 首页/邮件列表是否能正常打开。
- 后台用户管理中是否能看到管理员账号。
- 后台是否可修改用户密码。

---

## 8. 绑定自定义域名（可选）

1. Pages 项目 → **Custom domains**。
2. 添加你的域名（如 `mail.example.com`）。
3. 按提示在 DNS 中添加/确认记录。
4. 等待 SSL 证书自动签发完成。

完成后可通过你的业务域名访问。

---

## 9. 后续更新发布流程

后续每次更新代码的标准流程：

1. 推送代码到 GitHub（你的 Fork）。
2. Cloudflare Pages 自动触发新部署。
3. 在 Deployments 页面检查状态与日志。

如果你想手动控制发布，可在 Pages 中使用“Retry deployment”或回滚到历史版本。

---

## 10. 常见问题排查

### Q1: Pages 构建报 `Unknown argument: main`

- 原因：把 Worker CLI 参数方式用于 Pages。
- 处理：Pages 里只保留构建命令 `pnpm run build`，不要额外传 `--main` / `--assets`。

### Q2: Bindings 页面看不到 D1

- 检查是否在 **Pages 项目**（不是单独 Worker 项目）里设置。
- 确认变量名是 **`DB`**。
- 重新部署一次让最新配置生效。

### Q3: 提示“仅静态资产”，API 不工作

- 确认输出目录是 `dist`。
- 确认构建后有 `dist/_worker.js`。
- 确认项目不是纯静态模式，且已绑定 DO/D1。

### Q4: 首次登录失败

- 确认已正确绑定 `MAILBOX` DO。
- 确认已触发过至少一次 API 请求（用于初始化）。
- 尝试使用默认管理员：`admin@email.230406.xyz` / `admin`。

---

## 11. 安全建议（上线后务必做）

- 第一时间修改默认管理员密码。
- 为 Cloudflare 与 GitHub 账号启用 2FA。
- 生产域名启用访问策略（如 Cloudflare Zero Trust，可选）。
- 定期备份关键数据（D1/R2）。

---

## 12. 推荐的最小上线清单（Checklist）

- [ ] 已 Fork 仓库到自己账号
- [ ] Pages 连接了 Fork 仓库
- [ ] Build command = `pnpm run build`
- [ ] Output directory = `dist`
- [ ] D1 绑定变量名 = `DB`
- [ ] R2 绑定变量名 = `BUCKET`
- [ ] DO 绑定变量名 = `MAILBOX`，Class = `MailboxDO`
- [ ] 已成功部署并可打开 `*.pages.dev`
- [ ] 已用默认管理员登录
- [ ] 已修改默认管理员密码

---

如果你希望，我还可以再补一份「**截图版部署 SOP**」（每一步对应 Cloudflare 页面按钮位置），方便交给不懂技术的同事照着点。
