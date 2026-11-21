# Bitwarden_proxy

通过 Cloudflare Workers 代理 Bitwarden 云服务，可使用自定义域名访问 Web Vault 和连接 Bitwarden 服务器。

## 快速开始 

1. fork本仓库到自己的 GitHub 账号。 
2. 在cloudflare workers中创建一个新的worker，选择fork的仓库。 
3. 设置 `BITWARDEN_REGION`。`US` 对应 `vault.bitwarden.com`，欧洲账户使用 `EU`，对应 `vault.bitwarden.eu`。
4. 如果只允许通过已绑定的自定义域名访问，请将 `ALLOWED_ORIGIN` 设为该域名的完整 HTTPS 地址。
5. 保存并部署worker。

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
