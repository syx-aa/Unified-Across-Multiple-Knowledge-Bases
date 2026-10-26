# SPEC-024 云端 int8 量化落地

> 状态：Plan ｜ 优先级：P3 ｜ 归属：部署 ｜ 创建：2026-10-24

## 1. 需求（Spec）

云端轻量版现在用的是 **fp32 ONNX（96MB）**。`build/export_onnx.py` 里
int8 量化分支存在，但量化失败时会被 `except` 跳过，注释写明「云端改用 fp32 ONNX」。
落地 int8 可把模型压到约 **24MB**。

## 2. 验收标准（AC）

- [ ] AC1：int8 模型成功导出（`vector/models/bge-small-zh-v1.5/model_int8.onnx`）
- [ ] AC2：与 torch CLS 向量的**平均余弦 > 0.999**（脚本里已有该断言）
- [ ] AC3：体积 96MB → 约 24MB
- [ ] AC4：云端切到 int8 后，120 题指标与 fp32 一致（Hit@1 72.5% 不降）
- [ ] AC5：服务启动与冷加载时间下降

## 3. 测试用例

| 用例 | 命令 / 位置 | 期望 |
|---|---|---|
| TC1 量化 | `python build/export_onnx.py` | 打印 fp32/int8 平均余弦，断言通过 |
| TC2 云端回归 | 部署后 `BACKEND_URL=线上 node tests/eval_backend.js` | 指标与 fp32 版一致 |

## 4. 实现位置

| 文件 | 位置 | 说明 |
|---|---|---|
| [`build/export_onnx.py`](../../build/export_onnx.py#L43-L49) | int8 量化分支 43-49 | 当前 `except` 直接跳过，需查明失败原因 |
| [`build/export_onnx.py`](../../build/export_onnx.py#L51-L68) | 精度校验 51-68 | 平均余弦 > 0.999 的断言在这里 |
| `检索页-cloud/vector/models/...` | 模型目录 | 部署时换用 int8（项目外路径） |

## 5. 前置依赖

Python 环境，且云端目录的模型需要重新导出并同步。
优先级 P3：只影响体积与冷启动，**不影响检索质量**。
