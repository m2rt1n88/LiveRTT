# AI 调参：参数能力字典

状态：设计 v0.1，2026-11-15。本文定义后续实现契约；现有页面尚未实现能力字典、试验库或 AI 接入。配套：[试验数据格式](ai-trial-format.md)、[流程与接口](ai-tuning-workflow.md)。

2026-11-16 更新：已有独立的 [AI 分析简报最简版](ai-quickstart.md)，可以复制参数与采样给 AI；本文所述完整能力字典与执行契约仍是后续设计。

## 设计目标与证据边界

AI 必须知道参数的意义、当前是否参与计算、谁在更新它，以及改动需要哪些状态处理。仅提供 Kp/Ki/Kd 和曲线截图不足以解释运行行为。第一阶段以 DJI 的外置 ConstrainedPID 为主要对象，DM 单独适配，CyberGear 先保持只读。

本次核对的是相邻 UICRM-Embedded 仓库的源码和本项目实现，未连接硬件。源码说明与运行时能力必须分开：ELF 的 DWARF 能证明字段布局，Flash 抽查仅证明被抽查代码一致，均不能独立证明工作区源码就是板上同次构建。没有构建清单时，`source_matches_elf` 为 unknown，源码语义标为待核实，不能据此自动开放新功能。

本项目依据：`backend/motor_control.py` 的 control_schema / write_motor / set_motor_enabled，`backend/motors.py` 的对象发现和字段读取。固件依据（路径相对 UICRM-Embedded）：

| 文件 / 符号 | 用途 |
| --- | --- |
| boards/algorithm/include/pid.h / ConstrainedPID::pid_mode、PID_Init_t | 参数与特性位 |
| boards/algorithm/src/pid.cpp / ComputeOutput、PID_*、Reinit、ResetIntegral | 实际公式、执行顺序与历史状态 |
| boards/drivers/include/Motor/DjiMotorBase.h / Mode、Motor6020 | 电机模式与反馈滤波 |
| boards/drivers/src/Motor/DjiMotorBase.cpp / CalcOutput、SetMode、SetTarget | 控制链、使能、坐标及前馈 |
| boards/drivers/src/Motor/DmMotorBase.cpp / SetMode、Enable、Disable | DM 设备命令和模式副作用 |
| programs/Cakey/src/gimbal_task.cpp / offset_ratio、offset_filter_ratio | 某程序的补偿示例，并非用户当前固件默认值 |

后续适配器记录这些文件的摘要与审阅版本；构建系统另提供 ELF → source revision / build manifest 关联。不能把“当前仓库版本”直接标成“运行固件版本”。

## 字典结构

稳定 ID 如 `dji.velocity_pid.kp`、`dji.angle_pid.output_filter.alpha`。服务端适配器将 ID 映射到当前 ELF 字段；模型只提交 motor_id / parameter_id，不能提交 RAM 地址、DWARF 表达式或任意字段路径。单位、作用环和坐标系都是 ID 语义的一部分。

每个参数描述至少包括：

| 字段 | 含义 |
| --- | --- |
| parameter_id、label、scope、value_type、unit | 稳定身份、作用范围、类型与单位；未知单位明确标 unknown |
| binding | 服务端保存 DWARF 字段、实际类型；外发只保留可解释的字段名，去除地址 |
| availability | supported / unsupported / unknown；不支持与未能判断分开 |
| access | 当前可读、网页可写、agent 可建议、agent 可执行，逐项附原因 |
| activation | 特性位是否开启 enabled、当前路径是否参与计算 effective，均允许 unknown；参数存在不代表有效 |
| dependencies | 电机模式、PID 特性位、在线/使能要求、前置参数和反馈条件 |
| constraints | 编码范围、固件配置范围、工程认可范围分别记录上下界及来源；缺失用 null |
| ownership | 更新者、是否可能被任务覆盖、持久化方式、最近观察到的覆盖事件 |
| update_policy | live_scalar / firmware_command / unavailable；所需停机、边界提交、重置及验证要求 |
| provenance | ELF 身份、适配器版本、源码审阅摘要、source_matches_elf、语义置信状态 |
| value、read_status、observed_window | 本次读数、缺失原因、读取时间窗；与静态描述分离存储 |

`effective=true` 仅表示当前配置的计算路径会使用该参数，不声称当前这一次非原子读取时执行过该分支。需要精确执行证据时使用固件遥测的循环序号。

编码上能表示的 float32 范围不等于机构可用范围。当前网页部分增益没有工程上下界，第一阶段 AI 应用策略应将其标为需要人工建立范围；不能把 null 解释为无限可调，也不默认采用“每次增加 10%”。限制来自实际机构、驱动和试验计划。

## 当前可写范围与计划范围

以下“当前”指已有手动网页能力，仍受 ELF 类型、对象、模式和运行状态验证约束。第一阶段 agent 没有板端写入权限。

| 参数 / 功能 | 当前网页 | AI 字典与后续策略 |
| --- | --- | --- |
| DJI 两环 Kp / Ki / Kd | 可写 float32 | 分环记录，只有已核实语义和工程范围才形成可应用建议 |
| 两环 max_out / max_iout / deadband | 可写，非负 | 标为约束参数；常规增益优化不默认修改保护边界 |
| 两环输出 / 微分滤波系数 | 可写 [0,1] | 同时显示特性位；未启用时标“写入后当前不生效” |
| DJI 当前角度 / 速度目标 | 当前相应闭环模式可写 | 用于手动探索；不作为首期 agent 参数修改对象 |
| DJI CURRENT 目标 | 不开放 | 不把开环电流试验混入闭环调参 |
| DJI speed_feedforward / torque_feedforward | 可写运行值 | 分别为 rad/s 和 raw 电流；需查更新者，不能当作持久补偿系数 |
| DJI 软件 enable | 专用 bool1 开关 | 保留本地手动路径，agent 不得使能或切换 |
| DJI 电机模式 / absolute_mode | 不开放 | 后续固件语义命令，禁止按位直接写 RAM |
| PID mode_、ScalarA / ScalarB | 手动软件失能后可写 | 仅 0x77 六个已实现特性；保留其他位；比较旧 mask、校验 A/B，逐字段读回；不清空历史，agent 不写入 |
| Motor6020 input_speed_filter_ | 不开放 | 仅实际 DWARF 类型暴露时可读；后续专门能力 |
| DM MIT Kp / Kd / t_ff、各模式目标 | 按 config_ 范围与模式开放 | 单独的设备端控制语义，不等同 DJI 两环 PID |
| DM 使能 / 模式 | 不开放 | 需要 CAN 管理命令，改 bool 或 mode 无法替代 |
| CyberGear | 反馈只读 | 保留缺失原因，不从发送缓存猜测控制参数 |
| 整车补偿模型系数 | 尚无通用写入能力 | 程序级适配，需要固件可变配置及更新者定义 |

当前手动 RAM 写入不会调用 Reinit / SetTarget 或立即清 PID 状态；一组参数顺序写入，可能只完成一部分。新设计不能描述为已存在的原子提交。

## 模式与控制链

DJI 电机模式位与每个 PID 自己的 mode_ 是两种独立配置，UI 必须分组，不能共用一个“模式”选择框。

| 电机位 | 值 | 含义与判定 |
| --- | --- | --- |
| NONE | 0 | 不作为闭环试验模式 |
| CURRENT | 0x01 | 优先旁路两环，其他环位同时存在也不代表环在工作 |
| OMEGA | 0x02 | 无 CURRENT / THETA 时为速度环 |
| THETA | 0x04 | 角度计算；只有同时含 OMEGA 才是角度→速度级联 |
| INVERTED | 0x40 | SetTarget 对输入反向；直接写 state_.target 不执行它 |
| ABSOLUTE | 0x80 | 单圈目标，CalcOutput 转成最近等价连续角进入角度 PID |

典型级联链：角度 PID 输出 → 叠加速度前馈 → 速度 PID → 叠加 raw 电流前馈 → SetOutput 驱动限幅。无 OMEGA 的 THETA-only 输出会直接走下游，不能沿用“角度 PID 输出单位必为 rad/s”的级联假设；首期不将其列为标准 AI 调参模式。需记录各 PID 的实际 target_ / measure_、PID 输出和最终驱动输出，区分不同限幅阶段。

SetMode 同时维护 state_.mode 和 absolute_mode，SetAbsoluteMode 却只更新后者。发现两者不一致时报告异常配置，不猜测或自动修复。方向、零点、减速比和坐标定义必须先于调参确认。

DM 模式分别为 MIT=0、POS_VEL=0x100、VEL=0x200；EMIT=0x300 当前未实现。MIT 的 p_des/v_des/kp/kd/t_ff 参与设备协议；POS_VEL 的 v_des 在现有网页定义为非负速度上限；VEL 只有速度目标。目标是转子坐标，不能套用 DJI 输出轴单位。不能从外部目标推断设备内部 PID 系数可读可写。

## PID 特性与滤波矩阵

两环分别保存原始 mode_、解码位与未知位，禁止只保存解码后的名字。以下均为本次审阅源码行为；网页现已支持手动修改 0x77 六个开关，要求软件失能、旧 mask 一致和依赖校验。比例先行与故障回调开关保留板端状态，不开放修改。

| 特性位 | 值 | 是否建议调、前置条件 |
| --- | --- | --- |
| Integral_Limit | 0x01 | 按实现限制积分增量及积分状态；是约束，保留已有保护，不为改善曲线随意关闭 |
| Derivative_On_Measurement | 0x02 | 当前实现为正号 kd×(measure−last_measure)，且输出相加；须先审阅反馈符号和实际稳定性，不自动建议开启 |
| Trapezoid_Intergral | 0x04 | 积分增量取相邻误差均值；改变离散算法，需相同周期条件单独对照 |
| Proportional_On_Measurement | 0x08 | 预留位，ComputeOutput 无对应计算分支；显示“不支持有效切换” |
| OutputFilter | 0x10 | 输出平滑增加动态滞后；有输出抖动证据时单独比较 |
| ChangingIntegralRate | 0x20 | 依赖 ScalarA / ScalarB；仅误差与积累积分同号时调整积分增量；启用前要求 A>0、B≥0 且单位已核实 |
| DerivativeFilter | 0x40 | 有 D 项噪声证据时考虑；必须记录 Kd、系数与滤波历史处理 |
| ErrorHandle | 0x80 | 故障处理 / 回调配置；不作为性能调优开关，回调有效性需固件保证 |

输出与 D 滤波都是 `filtered = alpha * current + (1-alpha) * previous`。对应 mode 位开启才执行：alpha=1 是直通，alpha=0 保留历史，不能用 0 表示关闭。UI 应显示“启用状态 + alpha”，并说明 alpha 较小平滑更强、响应更慢；没有实际更新周期时不换算 Hz 截止频率。

Motor6020 速度反馈滤波也采用上述加权公式，源码默认系数 0.1，但不是当前运行值证明。它没有独立开关，alpha=1 为直通，0 会保留旧速度；与 PID 输出 / D 滤波分开。仅有基类注册指针时可能无法解析派生字段，应显示 unknown 而非填默认值。

是否调滤波按证据决定：先判断目标突变、测量噪声、反馈丢包、饱和或机械问题，再做单项对照。保持已有滤波配置建立基线，避免同轮同时改增益、反馈滤波和补偿而失去归因。保护功能不进入常规自动优化搜索。

## 离散公式与状态处理

当前 ComputeOutput 的 I 增量是 Ki×error，D 是 Kd×相邻 error 差，没有显式 dt 乘除。control_period_ 字段不能当作已验证执行周期；DJI 计算还受新 CAN 反馈间隔门控。采样频率、线程频率和 PID 有效更新频率必须分别记录。不能照搬含 dt 的通用 PID 数值或自动跨固件迁移。

进入死区会清 P / I / D / output，其中 I 累积也被清除。输出构造、可选输出滤波、最终限幅之后才调用 PID_ProportionLimit 修剪存储的 P，因此读出的 P+I+D 不一定重建 output；图表不能将差值直接判成错误。

ResetIntegral 只清 iout_ / iterm_。Reinit(PID_Init_t) 未显式清除所有 iout_ / last_error_ / last_measure_ / last_output_ / last_dout_，不能命名为“完整重置”。Kd=0 时，先前 D 滤波状态也不保证立即消失。基础 PIDController 的 Reinit 另有 CMSIS 系数初始化，不能通过同一套原始增益写法扩展。

未来固件参数命令应明确：何时生效、是否整组边界提交、哪些历史清除 / 保留、是否先失能、目标如何衔接、最终确认序号。重置策略必须随试验记录；没有固件支持时，仅声明 live_scalar 的现有限制，不模拟函数调用。

## 整车补偿的单独能力

Cakey 云台任务里 offset_ratio=0.185、offset_filter_ratio=0.02 是局部 const，任务持续计算 speed_offset 并 SetSpeedFeedforward。写运行前馈可能很快被覆盖；这些示例常数也不能借用为用户当前车辆参数。

后续应暴露程序级 `vehicle.yaw_compensation.gain`、`...filter.alpha` 等可变配置，声明输入量、输出量、参考系、正负号、单位、更新任务与适用模式。试验同步关联底盘实测角速度、云台相对角、IMU / 世界航向、前馈与跟踪误差；先完成单电机基线，再比较补偿模型。缺少车体真实反馈时只报告运动学推算，不能当作实测补偿效果。
