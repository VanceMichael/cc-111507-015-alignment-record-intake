# 测序样本资料接入

该服务用于保留已获授权的来源材料及其收件证据。当前提供原始资料接收、字节摘要、来源元信息检查、SAM 结构化收件和收件查询。来源服务和样例均在本机运行；资料中的单位、账号及标识都是合成值。

## 环境与运行

使用 Node.js 22.23.4。依赖通过 package-lock.json 锁定。准备环境时执行 `npm ci --ignore-scripts --no-audit --no-fund`，之后运行、构建、测试和演示均不下载资源。

```sh
npm run build
npm test
npm run demo
npm start
```

`npm start` 输出本次监听地址；服务绑定回环地址，来源网关与接收端在同一进程内使用独立端口。`DATA_DIR` 指定收件目录，默认 `./var`；`SCENARIO` 选择 fixtures/scenarios.json 中的来源场景。`npm run demo` 从临时空目录启动、实际领取来源字节、查询收件并退出，不回放旧日志。 `PORT` 可指定接收服务端口；未设置时仍自动选择空闲端口。

## 容器

```sh
docker build -t alignment-record-intake:local .
docker run --rm --network none alignment-record-intake:local npm test
docker run --rm --network none alignment-record-intake:local npm run demo
```

镜像构建准备阶段完成依赖安装，运行不需要公网服务。接口约定见 `docs/接入约定.md`，来源格式范围见 `docs/来源格式.md`。`src/source-metadata.mjs` 只识别文件元信息，不代表已提取结构化记录。文件收件与完整业务覆盖是不同状态。

## 结构化方式检查

结构化收件已开放：`POST /v1/intakes` 使用 `{"mode":"structured"}` 时按 `docs/来源格式.md` 的范围解析 SAM 文本，每条比对形成一条记录（不按 QNAME 去重），并结合头部 @SQ/@RG 声明校验参考序列与读组、解释配对关系。`npm test` 已包含结构化检查，覆盖真实收件、来源语义及持久查询，不再需要 STRUCTURED 环境变量。
