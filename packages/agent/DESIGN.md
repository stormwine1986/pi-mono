# Agent Core 概要设计 (DESIGN)

## 一、 模块职责

`agent-core` 是系统的执行引擎，负责管理 Agent 的状态、消息循环、工具调用以及与大语言模型 (LLM) 的交互。它是实现“自主性”的核心模块。

## 二、 核心架构

系统采用“观察者”与“循环控制”模式：
1.  **Agent 类**: 封装了 `AgentState`，维护对话历史、当前选用的模型和工具集。
2.  **agentLoop / agentLoopContinue**: 核心生成器函数，实现了完整的推理-执行循环（Thought-Action-Observation）。
3.  **Transport 抽象**: 支持 SSE (Server-Sent Events) 等多种流式传输协议。
4.  **Metadata 集成 (STACK-RS-240/247)**: 依赖 `@mariozechner/pi-metadata-client` 与元数据服务交互。

## 三、 启动与配置注入 (Bootstrap)

Agent 容器遵循 **“零本地凭证”** 原则，所有关键配置均在启动时从 Metadata Service 注入：

1.  **环境变量注入**: `entrypoint.sh` 利用 `metadata-client` CLI 获取 `LLM_API_KEY` 并导出至环境。
2.  **工具配置生成**:
    *   **MCP (mcporter)**: 自动生成 `~/.mcporter/mcporter.json`，连接至分布式的 MCP 工具服务。
    *   **OpenAPI (restish)**: 自动生成 `~/.config/restish/apis.json`，完成对系统内部业务接口（如 backlog, osint）的授权绑定。

## 四、 运行时功能

1.  **上下文管理**: 支持通过 `transformContext` 进行消息修剪和自定义上下文注入。
2.  **中断与引导 (Steering)**: 支持在工具执行间隙通过 `steer()` 注入紧急指令。
3.  **后续任务 (Follow-up)**: 支持在主任务完成后自动执行队列中的补充指令。
4.  **审计接口**: 内置 `MetadataClient` 实例，预留了对任务关键节点的审计（Audit）上报能力。

## 五、 环境依赖

*   **Runtime**: Node.js >= 20.0.0
*   **依赖包**:
    *   `@mariozechner/pi-ai`: 统一 LLM 基础库。
    *   `@mariozechner/pi-metadata-client`: 元数据服务接入库。
*   **环境变量要求**:
    *   `METADATA_URL`: 元数据服务地址。
    *   `OWNER`: 当前用户 ID。
    *   `SESSION_SECRET`: JWT 签名密钥。
    *   `X_REQUEST_ALIAS`: 容器网络别名。

## 六、 数据流向

1.  **输入**: 接收来自 Redis Stream (`user:${OWNER}:agent:in`) 的任务。
2.  **处理**: 调用 `compute` 模块的 LiteLLM 进行推理。
3.  **输出**: 将状态、文本增量和工具执行结果发布至 Redis Stream (`user:${OWNER}:agent:out`)。
