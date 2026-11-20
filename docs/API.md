# Bimage REST API

同源入口 `/api`；内部Node端口6768。响应均为JSON（资产/ZIP除外），错误 `{error:string}`，不回传上游秘密。服务直接 `/` 为404，前端SPA由nginx提供。

## 认证

- `GET /setup` → `{required:boolean}`。未初始化时，服务器运维人员从 `$DATA_DIR/setup-code.txt` 读取一次性初始化码。
- `POST /setup {code,password}`：为内置 `admin` 设置密码，成功后创建会话。初始化只能成功一次，不提供公开注册。
- `POST /login {login,password}`：`login` 为账号邮箱或内置账号 `admin`，返回 `{id,email,name,role,concurrency,csrf}` 并签发 HttpOnly/SameSite=Strict 会话 Cookie。旧访问密钥和 Bearer 认证不再有效。
- `GET /me` → 当前身份及cookie会话CSRF。写请求使用 `x-csrf-token`；退出 additionally 校验同源Origin。代理必须保留Host。
- `POST /logout {}` → `{ok:true}`、过期cookie及服务端会话撤销；失效/禁用身份的原会话仍可退出。客户端独立5秒预算，失败仅短通知、阻止本标签自动恢复，不能保证网络故障时已撤销。
- `GET /site` 为公开站点 `{title,icon}`；`GET /health` 不带 `/api` 返回 `{ok:true}`。

## 设置与模型

| 方法 / 路径 | 请求 / 语义 |
|---|---|
| GET /settings | 当前租户 Settings；空库 `{}` |
| PUT /settings | 保存同一账号的跨浏览器设置，包含 form 与按用途独立的供应商/模型选择 |
| GET /providers | owner/admin管理字段；共享消费者仅脱敏目录及canManage=false，无 API Key、owner 或 baseUrl |
| POST /providers | name/baseUrl/apiKey/kind='mixed'/models/shared；仅允许公网供应商地址 |
| PATCH /providers/:id | owner/admin；空apiKey保留原值，models可修改；共享撤销取消消费者未执行任务 |
| DELETE /providers/:id | owner/admin；不删除已有历史资产 |
| POST /providers/models | 安全发现未保存draft目录；不返回secret；不能借共享配置越权 |
| POST /providers/:id/models | owner/admin发现现有配置或合法draft目录 |
| GET /providers/:id/models | owner/admin刷新并保存目录；共享消费者禁止 |
| POST /rewrite | `{providerId,model,prompt,references?:string[]}` → `{text}`；单次文本/视觉请求，不生图 |

`Model={id,types:('image'|'text')[],reason?}`。模型用途来自目录推断/人工修正；不凭空发明默认模型。客户端一可用供应商按用途回退，多供应商保留有效显式默认。

供应商页中的三个默认用途分别保存为：快速提示词 `quickProvider/quickModel`、提示词优化 `textProvider/textModel`、生图 `imageProvider/imageModel`。前两项只选择文本用途模型，生图只选择图像用途模型。旧设置没有快速提示词字段时沿用原文本选择；保存时保留最新草稿与无关设置。快速提示词和行内优化均调用 `/rewrite`，但使用各自选择的供应商和模型。

## 资产与任务

- `POST /assets {mime,data}`：PNG/JPEG/WebP base64，不含dataURI头。每图8MiB；检查签名，同租户上传去重。返回 `{id,url}`。
- `GET /assets/:id`：认证原件bytes，private/no-store；非owner（且非admin）404。尺寸由实际bytes缓存获取。
- `GET /assets/:id?variant=thumbnail`：相同授权边界的 WebP 缩略图，最长边480像素、不放大原图；历史图片按需生成。原件不被重新编码。无法解码或像素过大返回422，原件仍可下载。缩略图随原件删除。
- `HEAD /assets/:id`（可带相同variant）：仅校验图片存在和当前访问权限，不读取原图BLOB或生成缩略图。浏览器持久缓存命中时仍需在线校验，响应不包含图片正文。
- `POST /jobs`：`{providerId,model,prompt,count,autoSize,size?,ratio?,resolution?,manualSize?,quality,output_format,references}`；count整数1–16，references最多16；旧手动尺寸64–8192，格式宽x高。自动规格省略尺寸字段，manualSize仅用于历史回填，不发送上游。返回完整Job。
- `GET /jobs` / `GET /jobs/:id`：租户历史，`{id,owner,form,status,created,startedAt,finishedAt,tasks}`；Task含status/attempts/error/asset及实际width/height/mime。不以请求规格冒充实际尺寸。
- `GET /jobs?limit=30&q=...&cursor=...`：按账号进行游标分页，limit范围1–100，q按完整提示词进行不区分大小写的字面搜索。返回 `{items,total,nextCursor,token,unchanged:false,active,activeCount,removedIds}`；活动任务计数不受搜索或分页限制。携带上次token且未变化时，返回HTTP200 JSON、`unchanged:true`并省略items/nextCursor。`known`可传最多100个已加载任务ID的JSON数组，removedIds只表示已确认不存在的记录，而不是未落在当前页的记录。不带分页参数的旧客户端仍返回数组。
- `POST /jobs/:id/cancel {}`：只取消当前 `queued` 的子任务（含等待重试的子任务），不打断 `running`、不删除历史。返回完整 Job 和本次实际取消的 `cancelledCount`；若已无排队项，返回当前 Job 与 `cancelledCount: 0`。若剩余子任务均成功，整批显示已完成，原排队项仍各自显示已取消。
- `POST /jobs/:id/retry {confirm:true}`：明确收费重试确认；不是任务卡“重试”（后者只恢复表单、不调用生成）。未知成功状态禁止自动重放。
- `GET /jobs/:id/download`：单原件或真实多图ZIP；归档原件总量128MiB上限，超过建议逐张下载。

每张图独立n=1上游请求。无参考图JSON `/images/generations`；有引用undici multipart `/images/edits`、完整`image[]`。自动模式不发送size。显式429最多3次总尝试，其他错误不自动重试；重启running标interrupted、queued保留。文本视觉引用最大合计16MiB，入站JSON24MiB；数量不意味着任意16大图可通过字节限制。

## 用户管理（仅管理员）

| 方法 / 路径 | 请求 / 语义 |
|---|---|
| GET /admin/users | 仅返回 `{users}`；账号列表不包含密码或哈希，不列出旧工作区 |
| POST /admin/users | `{email,password,name?,role:'admin'\|'user',concurrency}` → 201 和新账号资料；始终生成新的随机 UUID，不支持关联旧工作区；传入 `legacyId` 返回 400 |
| PUT /admin/site | `{title,icon:''|dataURI}`；图标PNG/JPEG/WebP约300KB |

并发数为 1–8，限制一个账号同时运行的生图子任务，而不是一次能排队多少张。全站运行上限独立生效。

旧成员工作区的数据保留但不会分配给新账号；不提供认领入口。旧数据的启动迁移保护和禁止重试无有效账号所有者任务的检查仍然生效。

## 安全与类型

`backend/contracts/api.ts` 为前端DTO/交互类型，`backend/contracts/limits.js` 与声明为共享16图常量；后端独立运行时验证（不依赖前端校验）。供应商请求和结果下载均校验并固定 DNS 解析结果，不接受重定向、URL 凭据、私网及本机地址，管理员也不能例外。共享使用者不能覆写服务端固定配置。API约180次/分/IP，登录20次/15分，模型发现与提示词优化各20次/分。仅在配置了受信任的 Web 代理时使用该代理重写的客户端地址；其他连接按直连地址限流。
