# AI 调参：试验数据格式

状态：设计 v0.1，2026-11-15；不是现有导出格式。配套：[参数能力字典](ai-parameter-capabilities.md)、[流程与接口](ai-tuning-workflow.md)。

2026-11-16 更新：已实现的 [最简版](ai-quickstart.md) 使用独立 livertt.motor-ai-brief/1，不冒充本文的完整 trial / proposal 契约。

## 给 AI 的数据包

每次分析提供一个可复查的 trial：任务目标、机构与负载说明、完整运行参数、模式与特性状态、实际输入、带时间依据的原始序列、异常事件和采样质量。截图可辅助定位现象，结构化数值是分析依据。模型缺少数据时应提出下一次采集要求，不凭图补造数值。

现有“导出采样 JSON”只有 elfPath / frames / events，包含原始电机字段，但没有独立参数快照、试验边界、配置版本、语义字典或持久试验库。浏览器仅保留最多 600 帧 / 120 秒，刷新会丢失。不能把现有导出直接宣传为 AI 试验包。

新增格式使用 `schema_version: livertt.motor-trial/0.1`。这是设计契约，尚无运行时解析器或正式 JSON Schema。首期先支持单重点电机，结构允许多电机关联。完整文件示例：[人工合成的试验包](examples/ai-trial.synthetic.json)、[被阻止应用的建议](examples/ai-proposal.synthetic.json)。示例数字不来自硬件，不是推荐参数。

## 身份、参数与完整性

| 字段组 | 必须表达的内容 |
| --- | --- |
| trial_id、schema_version、synthetic、created_at | 不可变试验身份、格式版本、是否合成、UTC 时间 |
| provenance | ELF 内容哈希、代码抽查状态、固件启动身份（未知可空）、源码与 ELF 关联证据、适配器版本 |
| binding | session_id、motor_id、object_incarnation、capability_revision、config_revision；导入包不能凭这些字段取得控制权 |
| context | 电机家族 / 型号证据、总线 ID、机构、减速比、零点 / 符号 / 参考系、负载、供电及温度条件；未知明确标注 |
| objective | 优化对象、期望表现、评价区间、可调参数、保护约束及来源；缺少认可范围时标未就绪 |
| parameter_snapshots | 开始与结束参数快照，含受控对象全部已知 PID 参数、模式位、滤波 / A / B、限幅、前馈、enable、目标及其更新者 |
| stimulus | requested 与 observed 分开，输入来源、实际起止、目标变化、是否有固件执行确认及重复性 |
| channels、samples | 通道字典、时间定义、原始样本 / 质量 / 缺失原因；派生通道写计算定义与输入 |
| events、quality、metrics | 状态和配置变化、采样质量、指标资格及证据 |

稳定 motor_id 供本地服务引用；对象指针重绑、重连、重启或扫描身份无法连续证明时，object_incarnation 作废重建。相同地址也不能证明对象未被重建；无法检测的重建作为边界记录，不声称有严格身份保证。试验对象用不透明身份外发，RAM 地址只留本地诊断。

config_revision 是服务端观察 / 提交的配置版本，不能覆盖固件在两次读取之间发生而未被观测到的修改。参数快照必须包含字段级读取错误与时间窗，不能称为原子快照。完整性用 expected_parameters、missing_parameters 和 complete 标识；complete 只代表当前适配器要求字段齐全。

示例允许 expected_parameters_same_as、activation_same_as、ownership_same_as 引用同一不可变 trial 内的既有 snapshot_id，只复用这些元数据，不能省略结束快照的实际 values。解析器必须拒绝悬空或循环引用；给模型导出时可展开这些元数据，避免误读为结束时没有重新采集。

未知数值用 null，并附 reason / status；JSON 禁止 NaN / Infinity。缺失、未支持、读取失败和关闭分别表示；零不是缺失。保留 float32 实际读回值，候选十进制值与实际编码值分开；64 位计数用十进制字符串以避免 JavaScript 精度丢失。

## 时间、通道与样本

当前 SWD 的后端 time 是批量采样末尾的主机墙钟，durationMs 是整批耗时，各对象和字段分段读取，不同步；不能给它补一个虚构的板端时间。旧导出迁移时标 time_basis=host_batch_end，per_motor_read_window=unknown。由结束时间减耗时也只能近似批次窗口，不能得到各字段采样时刻。

后续采集在服务端同时记录主机单调时钟的 batch_start / batch_end、可实现的对象读取窗与墙钟关联。主机单调时间用于时长，UTC 只用于归档；时钟跳变记录事件。固件遥测再提供 boot_id、sequence、firmware_tick、单位 / 回绕定义、循环序号和提交确认。RTT 是传输通道，不会自动赋予数据这些语义；日志到达时间不能冒充采集时间。

每个 channel 描述 source_kind（swd_field / firmware_telemetry / derived）、单位、轴与坐标系、原始或滤后量、原始字段或推导公式、所属环、有效条件及时间基准。raw 电流指令、实测 A、电机力矩 N·m 分开。角度误差区分单圈最短角差、多圈差与环内展开坐标差。

每个 sample 记录所在段、序号、读取窗 / 板端时刻、values 和 channel_errors。非原子字段不强行对齐；插值只用于显示，必须另标 derived，不能作为新的观测点或提升证据采样率。CAN 心跳不是控制循环时间戳。

保留原始数据与通道缺失掩码。quality 至少包含请求 / 实际频率、间隔分布、最大空隙、批次耗时、不同步说明、缺失率、序号丢失情况、抽取策略。SWD 无板端序号时，dropped_firmware_samples 为 null，不能因为 HTTP 请求没丢就填 0。

供模型快速阅读的摘要可做带极值保留的分桶，但必须附算法、原始点数、保留点数和 raw 数据引用。模型可以分页请求原始窗口；不能把普通均值降采样后的峰值当原始峰值。

## 最小通道集

| 场景 | 需要的数据 |
| --- | --- |
| DJI 速度环 | 实际速度目标、omega_pid_ target_ / measure_ / error_ / P / I / D / output_、最终 output_、速度反馈、raw 与 A 电流、限幅 / 故障 / 使能、前馈 |
| DJI 角度级联 | 上述速度环数据，加角度目标、连续 / 单圈输出轴反馈、theta_pid_ 的完整运行状态、角度到速度的链路 |
| 滤波比较 | 对应 raw / filtered 测量、D 或输出、全部滤波开关和 alpha、实际更新周期 / 遥测质量 |
| 整车补偿 | 多电机状态、车体实测角速度、世界 / 车体系姿态、目标瞄向、补偿输入 / 运行输出 / 模型参数、动作模式与延迟证据 |

字段不存在就记录缺失，不以类型默认值补齐。首次只用低速 SWD 时可以观察静态误差、任务覆盖和较慢趋势；快速响应、D 噪声与振荡需要足够的板端遥测，否则相关诊断无资格。

## 边界、事件与指标

试验区间内的增益 / 模式 / 滤波 / enable / 目标源 / 负载变化，重连、重启、对象变更、明显采样中断都记录事件。受影响区间拆成 segments，指标不可跨越配置变更或失能窗口；未知发生时刻用时间范围，不能假造精确边界。意外配置变化导致原比较窗口 invalid。

事件保留触发来源（operator / firmware / observed_change / unknown）、已知前后值和证据。PID ErrorHandle 的错误可能在回调后立即清除，低率读取未观察到错误位不能证明从未出错；将来固件应提供累计计数或锁存事件。

指标由确定性分析器计算，模型解释结果。每项包含 method_version、窗口、单位、status（eligible / sampled_estimate / insufficient_data / not_applicable）、value、reason 与原始证据范围。

| 指标 | 使用限制 |
| --- | --- |
| 静态误差 / RMS | 明确目标已稳定、坐标 / 单位一致、窗口及缺失处理；不规则主机采样需声明时间加权方法 |
| 超调 / 峰值 | 阶跃输入和足够时间分辨率才有资格；SWD 观测峰值只能称“已采样最大值”，可能漏峰 |
| 上升 / 稳定时间 | 要求实际阶跃时刻、终值 / 容差 / 驻留时间定义及足够覆盖；不能由两三个点宣称真实稳定时间 |
| 饱和比例 | 非同步 SWD 只报告“观测样本接近限制比例”；真实占空时间需要相应计数或可靠时间覆盖，区分 PID 与驱动限幅 |
| 振荡 / 频谱 / 滤波效果 | 必须检查实际采样间隔、抖动、混叠与频段覆盖；不足时不输出振荡频率或截止频率结论 |

不预设“20 Hz 就够用”。资格判定基于已声明的试验目标、响应尺度、采集链路与分析方法；无法证明覆盖时返回不足。所有阈值带来源，避免任意固定采样门槛制造可靠性假象。

## 对照与建议格式

compare 先检查家族 / 实际控制模式 / 语义适配器、坐标、刺激、初始状态、负载 / 供电 / 温度、前馈、保护限制、滤波历史处理以及采样方法。允许变动项必须写在试验计划里；未知条件显示不可比较或带条件比较，不能默认“未变”。不同采样率和数据质量本身不代表电机性能变好。

建议使用 `livertt.motor-proposal/0.1`，包括：

1. proposal_id、幂等 submission_key、synthetic、基于哪些不可变 trial / 配置快照。
2. motor / session / incarnation / ELF / capability / config 绑定和明确过期时间。
3. changes：稳定 parameter_id、expected_before、candidate_after、单位与理由；不得携带地址或原始表达式。
4. evidence：trial、segment、通道和窗口；解释现象、备选原因、数据限制，分清推测。
5. application_eligibility：服务端校验状态、阻止原因、缺失条件。模型不能自行将 blocked 改成可执行。
6. next_trial：下一次可比较输入、需要补采的通道和验收标准；计划不是硬件执行授权。

application_eligibility 由服务端生成或重算，导入文件 / 模型输出中的同名字段仅作历史信息，不能授予应用权限。schema 不兼容、外部引用无法解析或导入身份无法映射时，保留离线分析能力，不绑定实时写入。

没有可靠证据或工程范围时允许 changes 为空，仅建议补采；示例中的候选只是检验格式，被明确阻止应用。即使模型写出很高 confidence 也不能替代服务端校验。

## 本地保存与外发

计划新增独立 `data/trials/` 和 `data/proposals/`，服务端限制包体、行数和磁盘占用，保存元数据 / 原始数据校验摘要并原子落盘。分析结果另存版本，原始 trial 不覆盖；保留 / 清理策略可配置，导出后可校验完整性。它们不混入 profiles.json，也不向芯片 Flash 保存参数。

外发前生成预览 manifest：发送哪些时间窗、通道、参数、上下文和可选截图。移除本机绝对路径、RAM 地址、会话 token、密钥与无关源码 / 日志。ELF 用哈希或别名，源码只发经过选择的必要片段；导出不能携带可重用的控制凭据。manifest 同样用于 MCP 与以后 API 请求，避免两套数据语义。
