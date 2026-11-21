# Bitwarden_proxy

通过 Cloudflare Workers 代理 Bitwarden 云服务，可使用自定义域名访问 Web Vault 和连接 Bitwarden 客户端。

## 快速开始 

1. fork本仓库到自己的 GitHub 账号。 
2. 在cloudflare workers中创建一个新的worker，选择fork的仓库。 
3. 配置worker的环境变量，包括 `BITWARDEN_REGION` 和 `ALLOWED_ORIGIN`。
4. 保存并部署worker。

## 账户区域

在 [wrangler.jsonc](wrangler.jsonc) 的 `vars.BITWARDEN_REGION` 中填写账户所在区域。默认值 `US` 对应 `vault.bitwarden.com`，欧洲账户使用 `EU`，对应 `vault.bitwarden.eu`。每个部署使用一个区域。[Bitwarden 服务器区域说明](https://bitwarden.com/help/server-geographies/)


### 绑定域名

如果想使用自己的域名，又希望真实地址不出现在公开仓库，可以只在 Cloudflare 控制台填写域名。

1. 在 Cloudflare 接入域名所在的 DNS 区域，确认其状态为 **Active**。
2. 进入 **Workers & Pages → bitwarden-proxy → Settings → Domains & Routes → Add → Custom Domain**，输入专用子域名并保存。Cloudflare 会自动创建 DNS 记录并签发 HTTPS 证书。[自定义域名设置](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
3. 用新域名和你平时使用的登录方式登录一次，再确认密码库能同步。如果只想保留这个入口，在 `wrangler.jsonc` 顶层加入 `"workers_dev": false` 和 `"preview_urls": false`，然后再次运行 `npm run deploy`。省略 `routes` 即可保留控制台中的绑定。

绑定域名后，直接打开该域名下随附的 Web Vault 即可同源访问代理接口，无需设置 `ALLOWED_ORIGIN`。

如需限定哪个网页可以跨域调用代理接口，可将 `ALLOWED_ORIGIN` 设为该网页的 HTTPS 来源，例如 `https://app.example.com`。可以包含端口，只填一个来源。Worker 会在转发前拒绝带有其他网页 `Origin` 的请求，并为匹配来源处理跨域预检和响应头。

如果域名只保存在 Cloudflare 控制台，在 Worker 的 **Settings → Variables and Secrets** 中添加同名 **Secret**，后续 Wrangler 部署会保留它。如果希望随代码管理普通文本变量，填写 `wrangler.jsonc` 的 `vars.ALLOWED_ORIGIN`。[Wrangler 配置保留规则](https://developers.cloudflare.com/workers/wrangler/configuration/#source-of-truth)

未携带 `Origin` 的原生客户端请求会继续转发。浏览器扩展使用自身协议时，以及桌面应用使用 `bw-desktop-file://bundle` 时，均沿用上游策略。域名入口和静态资源由 Cloudflare 管理，账户身份验证由 Bitwarden 处理。

## 本地运行与部署

使用 Node.js 22.12 或更高版本，在仓库根目录执行以下命令。

```sh
npm ci
npm test
npm run check
npm run dev
```

打开 Wrangler 输出的本地 HTTPS 地址。Web Vault 要求 HTTPS 才会发起 API 请求。本地开发证书由 Wrangler 生成，仅用于本机预览。`npm run check` 执行部署预检。

确认账户区域后，登录 Cloudflare 并部署。

```sh
npx wrangler login
npm run deploy
```

默认使用 Cloudflare 提供的公网地址，格式为 `https://bitwarden-proxy.<账户子域名>.workers.dev`。复制部署输出中的实际地址，即可连接网页或客户端，无需提供个人域名。[Cloudflare 默认域名说明](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)
