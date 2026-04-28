# Pi Mono 模块设计文档 (DESIGN)

## 一、 模块概述

`pi-mono` 是一个基于 Node.js 的单体仓库（Monorepo），包含了系统核心大脑（Agent Core）、Worker 节点、命令行工具集以及多种前端/后端共享包。

## 二、 仓库结构

- `packages/`: 包含所有内部 npm 包。
  - `agent/`: Agent 核心逻辑 (Thought-Action-Observation 循环)。
  - `ai/`: 多模型适配器。
  - `worker/`: 基于 Redis Stream 的异步任务处理器。
  - `tui/`: 终端 UI 库。
- `cli/`: 供 Agent 调用的命令行工具集，这些工具会被安装到容器的 `/usr/local/bin`。

## 三、 命令行工具集 (CLI Tools)

### 1. 计算器工具 (`calc`) - STACK-RS-331

- **职责**: 提供高精度的四则运算及基本数学函数计算能力。
- **技术实现**: 
  - 使用 `mathjs` 库进行数值计算。
  - 架构设计：采用 Bash 包装器 (`cli/calc`) 切换至应用根目录后调用 Node.js 脚本 (`cli/calc.js`)，确保在 ESM 模式下能正确识别 `node_modules`。
- **用法**:
  - `calc "expression"`: 执行计算。
  - `calc -h`: 查看帮助和示例。
- **约束**:
  - 非交互式，支持管道调用。
  - 成功时返回 0，输出计算结果；失败时返回非 0，输出错误提示。

### 2. 现有工具 (Legacy/Proxy Tools)
- `graph`: 知识图谱/本体操作工具（封装对 Ontology Service 的请求）。
- `reminder`: 提醒管理工具。
- `scheduler`: 任务调度工具。
- `media`: 媒体处理工具。

## 四、 构建与部署

- **镜像构建**: 通过根目录的 `./stack-base build agent` 完成。
- **安装逻辑**: Dockerfile 会自动将 `cli/` 目录下的所有文件赋予执行权限并拷贝至系统 `/usr/local/bin`。
