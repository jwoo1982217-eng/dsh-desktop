# 桌面文件工作台接口约定

2026-11-06。本批沿用户已确认的“自身文件区＋项目工作区＋授权共享目录”方案做桌面适配。前一批代码已在4个本地Tag保存后开始本批；不改核心、Electron壳、既有peer/浏览器WIP，不另装Linux。

新增独立包`dsh-desktop-file-workbench`，同源认证页面`/desktop-files`，侧栏“文件”。UI内容是文件数据，不作为指令/脚本执行。Mac本机目录映射不是新增OS强沙箱；不改变AI会话的原fs/bash权限或工作区。

## 目录与服务

`FileWorkbench`在`files.mjs`导出，构造参数`{home,workspaceRegistry,fsProvider,clock?}`。`await service.manage(action,payload,{signal}={})`，`await service.close()`。非本包模块不注册新的模型工具。

三类root：internal为本包`home/storage/desktop-files/files`；workspace只读导入`workspaceRegistry.list()/get(id)`实体，保留核心登记生命周期；shared为本人明确输入并确认的持久目录别名。目录必须验证真实身份与敏感路径边界；解除shared只撤销映射，不删除原目录。

Root DTO：`{id,kind:'internal'|'workspace'|'shared',label,path,mode:'read-only'|'read-write',generation,status:'ready'|'missing'|'changed'|'unavailable',message?}`。每个文件动作只接收rootId、generation、根内相对path。拒绝越界、symlink穿越、敏感账号/聊天/程序目录、控制文件；未知/替换root拒绝后等待本人重新授权，不自动跟随同名新目录。

## JSON HTTP

`GET /desktop-files/api/bootstrap`→`{ok:true,value:{csrf,roots,limits}}`，全部页面/asset/API/导出都检查原`connection.requestRejection`。仅同源认证UI可发mutation：JSON POST `/desktop-files/api/manage`，头`X-DSH-Files-CSRF`，body `{action,...payload}`。服务层返回原生value，HTTP统一包装`{ok:true,value}`；失败`{ok:false,error:{code,message}}`，409冲突、410撤销、403拒绝、413超限。错误不给出原始异常、秘密或未授权路径。

| action | 输入 | value |
| --- | --- | --- |
| roots.list | 无 | `{roots}` |
| roots.planAdd | path,label,mode（shared） | `{planId,root,expiresAt}` |
| roots.add | planId,confirm:true | `{root}` |
| roots.remove | rootId,generation,confirm:true | `{removed:true}` |
| list | rootId,generation,path='' | `{root,path,parent,entries:[{name,path,kind,size,modifiedAt,version?,editable?,blocked?}],truncated}` |
| read | rootId,generation,path | `{rootId,path,name,text,version,size,encoding:'utf-8',editable:true}`；二进制/超限拒绝编辑 |
| write | rootId,generation,path,text,version:string或null | `{path,version,size}`；null=不存在才创建；非空=原fsProvider的replaceIfVersion；冲突不覆盖 |
| mkdir | rootId,generation,path | `{path}`；已有则409 |
| rename | rootId,generation,path,to,version | `{path:to}`；同根、目标不存在；目录/根身份再核 |
| search | rootId,generation,path,query,content:boolean | `{matches:[{path,kind,size,line?,snippet?}],truncated,scanned}`；有界、可取消、跳过敏感/链接路径 |
| export.prepare | rootId,generation,path,version | `{id,filename,size,mime,expiresAt}` |

可选API UI不用依赖未实现的删除。此批不加永久删除；取消挂载不删文件。支持文件新建、目录新建及改名即可满足基础整理，后续回收站单独设计。

## 二进制导入导出

`POST /desktop-files/api/import?rootId=&generation=&path=`，`Content-Type: application/octet-stream`，头`X-DSH-Files-CSRF`及`X-DSH-File-Name: encodeURIComponent(name)`，64MiB/文件、并发2；写临时文件、摘要、无覆盖发布。`service.importFile({rootId,generation,path,name,stream,signal})`→`{path,name,size,sha256}`。只允许普通文件；同名冲突不覆盖，失败仅清自己stage。

`GET/HEAD /desktop-files/export/:id`由`service.takeExport(id,{consume,signal})`返回`{filename,size,mime,stream?}`，短期票据绑定root代次和文件版本；HEAD不消费。GET下载使用attachment与nosniff，不在同源页面执行HTML/SVG。失败/失效明确报错；不提供任意宿主路径下载。

## UI与限制

首屏只列三类根，选中后只列当前目录；面包屑、名称/大小/时间、文本预览编辑、保存、名称/内容搜索、导入、导出、新文件、新目录、改名、共享目录添加/解除。保存冲突保留用户编辑文本。共享目录默认read-only，选read-write需明确确认。提供真实宿主路径复制，用户可沿原工作区/工具使用，不注册隐式扩大权限的新模型工具。不做后台全盘索引，不复制聊天或凭据。

预览/搜索有字节/文件数/深度/时长上限。所有异步UI操作绑定当前root/path的request generation，迟到结果不能覆盖后选目录或未保存草稿。文件列表用textContent安全渲染，文件名包含HTML只显示文本。

## 验收

真实临时目录覆盖三级根、持久/撤销、目录身份替换、中文文件、编辑CAS冲突、导入同名拒绝、导出HEAD/过期、搜索取消和symlink逃逸；外部sentinel不变。HTTP认证/Origin/CSRF/限额/并发/请求取消需测。实际alpha.4新实例与既有运行实例分别验证；上线新增一个bundle、原健康core PID/会话/账号/插件/草稿保留，优先HMR，不运行旧重启/重签部署器。页面操作验收使用新建无业务数据fixture，不动用户项目。

## 宿主权限适配

保留原 fs provider 与会话策略。宿主默认 read-only 时工作台拒绝修改；workspace-write 时，GUI 的已登记读写根作为这一次操作的 workspaceRoot，文本写入携带同样的根范围策略。原生目录整理/导入必须经过当前 alpha.4 SandboxedFileSystem 的 checkedTarget，并重新核对它返回的实际路径；缺少可信 gate 时关闭这些按钮。不会传 danger-full-access 或写入会话的 sandbox/mode 事件。新映射只授权此认证 GUI，不把映射自动添加到模型工具。
