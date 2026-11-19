# Bimage REST API

同源入口 `/api`；内部Node端口6768。响应均为JSON（资产/ZIP除外），错误 `{error:string}`，不回传上游秘密。服务直接 `/` 为404，前端SPA由nginx提供。

## 认证

- `POST /login {key}` → `{id,name,role,csrf}`，签发 HttpOnly/SameSite=Strict 7天 `canvas_session`。支持API `Authorization: Bearer …`（不要在URL传凭据）。
- `GET /me` → 当前身份及cookie会话CSRF。写请求使用 `x-csrf-token`；退出 additionally 校验同源Origin。代理必须保留Host。
- `POST /logout {}` → `{ok:true}`、过期cookie及服务端会话撤销；失效/禁用身份的原会话仍可退出。客户端独立5秒预算，失败仅短通知、阻止本标签自动恢复，不能保证网络故障时已撤销。
- `GET /site` 为公开站点 `{title,icon}`；`GET /health` 不带 `/api` 返回 `{ok:true}`。

## 设置与模型

| 方法 / 路径 | 请求 / 语义 |
|---|---|
| GET /settings | 当前租户 Settings；空库 `{}` |
| PUT /settings | 保存同key跨浏览器设置，包含form与默认图像/文本复合选择 |
| GET /providers | owner/admin管理字段；共享消费者仅脱敏目录及canManage=false，无secret/owner/baseURL/allowPrivate |
| POST /providers | name/baseUrl/apiKey/kind='mixed'/models/allowPrivate/shared；私网授权仅admin |
| PATCH /providers/:id | owner/admin；空apiKey保留原值，models可修改；共享撤销取消消费者未执行任务 |
| DELETE /providers/:id | owner/admin；不删除已有历史资产 |
| POST /providers/models | 安全发现未保存draft目录；不返回secret；不能借共享配置越权 |
| POST /providers/:id/models | owner/admin发现现有配置或合法draft目录 |
| GET /providers/:id/models | owner/admin刷新并保存目录；共享消费者禁止 |
| POST /rewrite | `{providerId,model,prompt,references?:string[]}` → `{text}`；单次文本/视觉请求，不生图 |

`Model={id,types:('image'|'text')[],reason?}`。模型用途来自目录推断/人工修正；不凭空发明默认模型。客户端一可用供应商按用途回退，多供应商保留有效显式默认。

## 资产与任务

- `POST /assets {mime,data}`：PNG/JPEG/WebP base64，不含dataURI头。每图8MiB；检查签名，同租户上传去重。返回 `{id,url}`。
- `GET /assets/:id`：认证原件bytes，private/no-store；非owner（且非admin）404。尺寸由实际bytes缓存获取。
- `POST /jobs`：`{providerId,model,prompt,count,autoSize,size?,ratio?,resolution?,manualSize?,quality,output_format,references}`；count整数1–16，references最多16；旧手动尺寸64–8192，格式宽x高。自动规格省略尺寸字段，manualSize仅用于历史回填，不发送上游。返回完整Job。
- `GET /jobs` / `GET /jobs/:id`：租户历史，`{id,owner,form,status,created,startedAt,finishedAt,tasks}`；Task含status/attempts/error/asset及实际width/height/mime。不以请求规格冒充实际尺寸。
- `POST /jobs/:id/cancel {}`：只取消当前 `queued` 的子任务（含等待重试的子任务），不打断 `running`、不删除历史。返回完整 Job 和本次实际取消的 `cancelledCount`；若已无排队项，返回当前 Job 与 `cancelledCount: 0`。若剩余子任务均成功，整批显示已完成，原排队项仍各自显示已取消。
- `POST /jobs/:id/retry {confirm:true}`：明确收费重试确认；不是任务卡“重试”（后者只恢复表单、不调用生成）。未知成功状态禁止自动重放。
- `GET /jobs/:id/download`：单原件或真实多图ZIP；归档原件总量128MiB上限，超过建议逐张下载。

每张图独立n=1上游请求。无参考图JSON `/images/generations`；有引用undici multipart `/images/edits`、完整`image[]`。自动模式不发送size。显式429最多3次总尝试，其他错误不自动重试；重启running标interrupted、queued保留。文本视觉引用最大合计16MiB，入站JSON24MiB；数量不意味着任意16大图可通过字节限制。

## 唯一管理员

| 方法 / 路径 | 请求 / 语义 |
|---|---|
| GET /admin/keys | 脱敏身份列表，无hash或明文 |
| POST /admin/keys | `{name,role:'user',expires?}` → 一次性 `{id,key}` |
| PATCH /admin/keys/:id | 普通成员disabled/role='user'/expires；拒绝第二admin或唯一admin变更 |
| DELETE /admin/keys/:id | 删除普通成员并撤销其会话；不能删除自己 |
| PUT /admin/site | `{title,icon:''|dataURI}`；图标PNG/JPEG/WebP约300KB |
| POST /admin/rotate-key | `{currentKey,newKey,confirmKey,confirm:true}`；16–256字符、无控制字符、不trim、两次一致且不同；事务保存hash，保留owner，撤销其他会话并替换当前cookie/CSRF；不返回明文 |

## 安全与类型

`backend/contracts/api.ts` 为前端DTO/交互类型，`backend/contracts/limits.js` 与声明为共享16图常量；后端独立运行时验证（不依赖前端校验）。SSRF校验并钉住DNS、禁重定向、凭据URL、metadata和非授权私网。共享使用者不能覆写服务端固定配置。API约180次/分/IP，登录20次/15分，模型发现20次/分；同源代理当前共享后端直连IP限流，不盲目信任X-Forwarded-For。
