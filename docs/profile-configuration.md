# 通过配置文件绑定云台与底盘

当前构型系统已支持可编辑关节树和可变轮组；新增字段、模板切换及扩展方法见 [构型模板与扩展](mechanism-configuration.md)。下文常规双轴 / 四轮字段继续兼容。

LiveRTT 已有 JSON v2 配置导入 / 导出接口，涵盖变量、曲线、连接、云台 / 底盘构型、电机映射和标定。可以让助手根据指定 ELF 与固件代码编辑 JSON，再通过网页导入；不用在网页逐项填写，也不用为绑定变量重新烧录固件。变量需要能够从当前 ELF 的调试信息解析。

## 推荐流程

1. 在工作空间加载要调试的 ELF，点击「导出」，获得该 ELF 的完整配置。
2. 编辑导出文件的 `modules.gimbal`、`modules.chassis`，自定义字段同时加入 `watches`。保留已有变量、曲线与连接设置。
3. 在工作空间点击「导入」，选择编辑后的 JSON。导入会加载文件中的 ELF，并保存为该 ELF 的配置；同路径配置会更新。
4. 在对应监视页面启用模块，再连接硬件、确认固件版本并开始采集。导入不会自动连接或烧录。

从零配置时，可复制 [空模板](examples/motion-profile.json)。模板未填写变量或电机，全部监视模块关闭；`elfPath` 是占位路径，必须替换为本机真实 ELF。几何尺寸和限位只是默认值，需要按机构修改；连接设置建议沿用网页导出的值。每个 ELF 可各保存一份独立 JSON。

导入的是单份 `version: 2` 配置，而 `data/profiles.json` 是包含多份配置的存储库，两者格式不同。网页会自动保存，编辑时使用独立导出文件，避免直接修改正在使用的存储库后被网页覆盖。导入会替换该 ELF 的整份配置，所以修改已有设置应从导出文件开始。

## 两种绑定

| 配置位置 | 填写内容 | 是否需要加入 `watches` |
| --- | --- | --- |
| `modules.gimbal.axes.yaw.motor` / `pitch.motor` | 电机扫描结果的完整对象路径 | 不需要 |
| `modules.chassis.wheels.fl.motor` 等 | 电机扫描结果的完整对象路径 | 不需要 |
| `modules.gimbal.bindings.*` / `modules.chassis.bindings.*` | 变量浏览器中的具体数值字段路径 | 必须 |

路径使用浏览器 / 电机扫描返回的原文，包括对象层级、`->`、`.` 和数组下标。`motor` 填电机对象路径，不能填其角度字段或 CAN ID。绑定保存路径，加载 ELF 时重新解析地址。空字符串表示不绑定。

仅配置电机映射时，云台可使用输出轴反馈与相应模式目标；底盘可在四轮在线时推算速度。需要 IMU 反馈或固件自身目标时，再添加自定义数值字段。自定义字段值优先，读取失败会显示缺失。

自定义字段先在 `watches` 新增 `{"path": "变量完整路径", "label": "显示名称", "unit": "rad", "scale": 1, "plot": false}`，再把同一个 `path` 写进绑定。此处为格式说明，占位文字需要替换。`plot: false` 仍会采样，只是不在数据曲线默认绘制；普通变量最多 16 个，模块电机采样合计最多 64 个。

## 云台字段

| 字段 | 含义 |
| --- | --- |
| `bindings.yaw` / `pitch` | 实测姿态角 |
| `bindings.yawTarget` / `pitchTarget` | 同一参考系下的目标角 |
| `bindings.yawSpeed` / `pitchSpeed` | 反馈角速度 |
| `bindings.enabled` | 固件控制使能数值 / 布尔字段 |
| `bindings.mode` | 固件控制模式的原始枚举值 |
| `axes.yaw` / `pitch` | 电机对象 `motor`、方向 `sign`、额外减速比 `ratio`、零点 `zero`、限位 `min` / `max` |
| `angleUnit` | 自定义变量未指定单位时使用 `rad` 或 `deg` |
| `yawWrap` | 是否使用 Yaw 最短角差 |
| `tolerance` | 跟踪偏差提示阈值，单位度 |

`sign` 为整数 `1` 或 `-1`，`ratio` 为正数；电机姿态为 `sign × 输出轴角度 ÷ ratio − zero`，`zero` / `min` / `max` 均使用度，且 `min < max`。DJI 驱动已包含的减速比不要重复填写。自定义姿态视为已标定值，不再应用电机标定；绑定自定义姿态后，相应目标和角速度也要显式绑定，保证参考系一致。

## 底盘字段

| 字段 | 含义 |
| --- | --- |
| `bindings.vx` / `vy` | 实测右向 / 前向速度，换算至 m/s |
| `bindings.omega` / `heading` | 实测角速度 / 朝向角 |
| `bindings.vxTarget` / `vyTarget` / `omegaTarget` | 相同坐标系与单位下的控制指令 |
| `bindings.enabled` | 固件控制使能数值 / 布尔字段 |
| `layout` | `mecanum` 或四轮 X 型 `omni` |
| `wheels.fl` / `fr` / `bl` / `br` | 左前 / 右前 / 左后 / 右后的 `motor`、`sign`、`ratio`；兼容读取旧 rl / rr |
| `offset` | 仓库 chassis.offset，范围 −1～1，默认 0 |
| `commandUnits` | `si`（默认，物理指令）或 `setSpeed`（仓库原始指令换算） |
| `radius` / `halfLength` / `halfWidth` | 轮半径 / 半轴距 / 半轮距，单位米 |
| `vectorScale` | 速度箭头满量程，单位 m/s |
| `angleUnit` | 自定义角度 / 角速度未指定单位时使用 `rad` 或 `deg` |

同一个电机不能绑定到多个轮位。底盘速度以仓库为准：+vx 右、+vy 前、+vt 俯视顺时针；JSON 字段 `omega` / `omegaTarget` 保留兼容名称，含义为 vt。航向角与云台 Yaw 为逆时针正，整车合成时先将 vt 取负。角度 / 物理角速度支持 rad / rad/s 或 deg / deg/s，以 `watches.unit` 为准，空单位采用 `angleUnit`。通过 `watches.scale` 换算后再参与监视计算；`setSpeed` 只将显式绑定的三路指令当作轮速混合原始量，不再进行度转弧度。具体物理换算及仓库出处见 [图形监视](motion-monitor.md)。

`Chassis::chassis_vx / chassis_vy / chassis_vt` 是固件控制输入，不能当作实测物理速度；使用时需先确认换算关系，再绑定到指令字段。构型与推算边界见 [图形监视说明](motion-monitor.md)。

`modules.gimbal.enabled` / `modules.chassis.enabled` 是网页模块开关，`bindings.enabled` 是固件变量路径，两者分别配置。模板默认关闭，可保留 `false`，导入后在模块页面手动启用。

「整车状态」使用相同云台 / 底盘绑定，无需复制六电机映射。新增 `modules.vehicle`：`enabled` 独立开关，`gimbalFrame` 选择 `body`（相对底盘）或 `world`（世界坐标），`angleUnit` 为可选底盘目标航向的默认单位，`bindings.headingTarget` 引用已选变量中的底盘目标航向；空字符串表示使用指令角速度积分目标。旧配置会补齐该模块并默认关闭。参考系与推算条件见 [整车监视说明](vehicle-monitor.md)。

## 程序化接口

已有接口也可供脚本使用，JSON 请求体与上述单份配置相同：

| 接口 | 行为 |
| --- | --- |
| `POST /api/profile/validate` | 校验格式、引用和数值范围，返回补齐默认值后的配置，不写盘 |
| `POST /api/profile/save` | 校验并保存；不传 `id` 时按 ELF 路径更新 / 新建 |
| `GET /api/profiles` | 列出保存的配置摘要 |
| `GET /api/profile?id=...` | 读取指定配置的完整内容 |

请求先通过 `GET /api/status` 获取当前本机服务的 `token`，再在上述请求头携带 `X-Debug-Token`；POST 使用 `Content-Type: application/json`，请求体不超过 64000 字节。格式校验不检查 ELF 是否存在或变量能否解析，网页导入会加载 ELF 并检查普通变量，失效路径保留并提示。

保存接口只更新磁盘配置，不会刷新已打开网页中的设置；页面继续自动保存可能覆盖外部更新。交互调试时优先使用「导出 → 编辑 → 导入」，使页面与磁盘保持一致。
