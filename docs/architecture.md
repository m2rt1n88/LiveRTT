# 架构与扩展

浏览器 `frontend/assets/js/app.js` 管理一个活动 ELF 和一条硬件会话。`profiles.js` 负责配置快照与顺序保存队列；`charts.js` 绘制所选通道并导出 CSV；`api.js` 集中同源 API、CSRF token 和请求超时。

后端入口为 `python -m backend.app`：

- `app.py`：本机 HTTP API、Origin / Host / token 校验、公开静态资源允许列表。
- `elf_index.py`：DWARF 索引、类型与继承字段解析、路径解析、标量解码和 Flash 抽查片段。
- `probe.py`：OpenOCD Tcl 协议、后台子进程所有权、RTT 初始化与日志线程。
- `session.py`：当前 ELF、采样锁、Flash 抽查和批量采样。
- `motors.py`：从 DWARF 发现 DJI / DM / CyberGear 电机对象，读取注册表、CAN 归属、心跳与反馈/控制/PID 字段，按运行时地址去重；配置只保存路径。前端 `motors.js` 实现独立总览、趋势和事件。`motion.js` 复用电机目录 / 采样，提供云台、Mecanum / Omni 底盘、整车图形、共享电机数据窗、运动学、标定与事件；`vehicle.js` 负责相对航向连续性和整车参考系合成。
- `profiles.py`：v2 配置验证、按规范化 ELF 路径关联、原子写入 `data/profiles.json`。

配置保存变量路径，不保存地址或板端数值。同一路径重新编译保持配置，切换时重新加载 DWARF；浏览器只在 SHA 相同时复用该 ELF 的会话内采样历史。连接确认每次重新勾选，不保存到配置。

采样回应用运行序号丢弃过期结果，RTT 回应用 ELF 会话序号隔离。API 在同一会话锁下执行，ELF 切换不会与 RAM 读取交错。自动保存按队列串行提交，切换等待队列完成；保存期间的新修改会再次提交。

静态目录仅限 `frontend/` 的明确允许资源。`data/`、ELF、后端和测试不通过静态服务暴露。后台 OpenOCD 关闭 GDB / Telnet 监听，Tcl 绑定本机；仅回收本服务自己启动的进程。

## 接口

读取：`/api/status`、`/api/profiles`、`/api/profile?id=...`、`/api/variables`、`/api/children`、`/api/rtt`、`/api/service`。

写入本地会话 / 配置：`POST /api/elf`、`/api/inspect`、`/api/connect`、`/api/disconnect`、`/api/sample`、`/api/motors/scan`、`/api/profile/save`、`/api/profile/validate`。除初始 status 外需要会话 token；所有请求限制为本机同源。validate 只规范化配置，不写盘。sample 接收最多 16 个 paths 与 64 个 motorPaths，可以只采集电机；motorPaths 必须来自当前 ELF 的扫描列表。

## AI 调参服务规划

已有前端 motor-ai.js 最简适配：MotorDashboard 曲线下的独立持久面板从已保留数据生成参数 / 采样简报和提示词，提供复制、下载及纯文本回复暂存。没有模型请求或控制接口；新增模块纳入静态资源允许列表。使用与第三方方案调研见 [最简版](ai-quickstart.md)。

设计中的能力字典、试验库和建议校验器将由同一本地服务管理，网页与后续 MCP 适配器共享唯一 DebugSession / 探针连接。首期 agent 只能读上下文和试验、提交本地建议，实际写入保留在网页。可选模型 API 后续复用同一数据与建议契约。当前尚未实现这些服务，详细设计见 [参数能力](ai-parameter-capabilities.md)、[试验数据](ai-trial-format.md)、[流程与接口](ai-tuning-workflow.md)。

## 增加监视模块

在前端 `moduleDefinitions` 和后端 `MODULE_FIELDS` 中增加模块名与指标。导航入口始终可进入，每个模块在自身页面独立开关，首页不包含模块设置。云台 / 底盘具有独立图形页，可选自定义变量覆盖电机反馈；前端合并所有模块的电机需求，按路径去重。云台配置 axes / angleUnit / yawWrap / tolerance，底盘配置 wheels / layout / radius / halfLength / halfWidth / vectorScale / angleUnit，后端验证有界数值与轮位去重。电机配置额外保存 selected / focus / bus，关闭后停止其专用采集而保留选择。旧电机 bindings 仍保留兼容，但新监视页直接选择电机对象。未绑定或错误值显示缺失；不要引入程序特定的内存地址。详见 [电机监视](motor-monitor.md)。若扩展芯片支持，需要同时核对 ELF 类型校验、RAM / Flash 允许范围、OpenOCD 配置和 RTT 控制块搜索范围。

整车 `vehicle` 模块独立开关，复用 gimbal.axes / chassis.wheels 与相应变量绑定，开启时即合并两组电机需求。vehicle 保存 angleUnit / gimbalFrame 和可选 headingTarget 绑定，不保存积分状态。修改共享绑定 / 标定会重置整车对照历史；单独开关原模块只清空该模块历史。相对航向仅由有效采样时间推进，暂停、缺失角速度或大于 1 秒间隙使积分中断；显式实测 heading 不退回推算。静态允许列表包含 vehicle.js。详见 [整车状态](vehicle-monitor.md)。

目标监视已从前后端定义删除。前端 normalizeModules 读取旧配置时只保留现有模块，并补齐图形页新字段；不删除普通 watches。详见 [云台与底盘图形监视](motion-monitor.md)。

## 可复用机构

构型不再通过页面里的固定 Yaw / Pitch、四轮分支扩展。frontend/assets/models/library.json 定义公共模板；每个 ELF 保存独立 mechanism 快照及电机 / 变量标定。mechanisms.js提供关节树和底盘适配器注册、求解及模板校验；mechanism-view.js 只负责共享 SVG 绘图，motion.js 负责工作台采样、读数、曲线与交互，vehicle.js 负责整车参考系合成。backend/mechanisms.py 独立验证模板，profiles.py 保留动态槽位、绑定与旧配置迁移。详见 [构型模板与扩展](mechanism-configuration.md)。
