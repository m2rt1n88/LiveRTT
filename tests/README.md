# 测试

## 2026-11-15 CAN 电机监视验证

- 最终全量 30 项 Python 测试、7 项 Node 测试通过，无跳过；前端模块语法检查通过。
- 真实 C 板 6020：Flash 抽查一致；从运行时列表识别 CAN1 / motor1 / RX 0x209 / TX 0x2FE；普通变量为 0 时可独立采集电机。单台典型读取约 20 ms，识别 online、OMEGA / ABSOLUTE、使能、反馈、目标、raw 输出、电流、28°C CAN 温度及 PID 字段。
- 浏览器验证：电机导航位于云台/底盘前；独立启用、按 CAN 筛选、选择、重点电机、字段展开保留、切页继续采集、暂停后历史标识、刷新/重新加载恢复选择与筛选通过。页面无浏览器错误，无整页横向溢出；曲线按单位分开，接近零时保持合理纵轴范围。
- DJI 注册表去重、无命名全局的堆电机、错误电机不影响其他电机，以及时钟读取期间收到新反馈，由真实 DWARF / 假 RAM 回归覆盖。DM 和 CyberGear 未连接实物，本轮仅核对仓库驱动字段与适配逻辑。
- 未修改或烧录嵌入式仓库。配置使用 tests/.runtime/motor-dashboard，正式 data 未写入测试配置；硬件验证结束后断开本次连接，保留外部 OpenOCD。最终截图：docs/screenshots/motor-monitor.jpg；用法与边界：docs/motor-monitor.md。

从项目根目录运行：

~~~powershell
python -m unittest discover -s tests -p "test_*.py" -v
npm test
~~~

`test_telemetry.py` 使用真实 C 板 6020 ELF 的 DWARF 和本机 Tcl / RTT 协议替身，覆盖字段、继承、指针、解码、地址边界、Flash 不匹配、HTTP 来源校验、RTT UTF-8、后台服务复用 / 启动 / 超时 / 回收。不会连接真实板子。没有已有 C 板 ELF 时，依赖该 ELF 的测试会明确跳过。

`test_profiles.py` 使用临时目录，覆盖不同 ELF（包括相同文件名）的配置隔离、同一路径重编译恢复、模块与曲线字段、错误配置、原子替换失败、损坏文件保护、HTTP 配置接口和静态文件访问边界。

`frontend.test.js` 使用 Node 内置测试运行器，覆盖 CSV 精度 / 缺失值 / 倍率、配置快照不保存地址、自动保存期间继续修改、保存失败重试。

`motion-dom.test.js` 使用最小 DOM 替身检查单张云台姿态图、缺失轴提示，以及底盘数据窗的悬停、采样刷新保持、点击固定、Esc、键盘焦点恢复、窗口边界和暂停标识。该测试不验证浏览器的实际布局或鼠标命中。

`test_motors.py` 使用真实 6020 DWARF 与假 RAM，覆盖继承字段、注册表发现、地址去重、CAN 归属、空指针、逐电机错误隔离、NaN、心跳超时/回绕/读取期间新反馈、仅采电机、错误 SHA 与未验证连接拒绝、选择配置验证。前端另覆盖模式与单位、DM 故障码、CyberGear 字段映射、电流模式旁路优先级、近零曲线范围和电机选择快照。

浏览器测试的临时配置存储在 `tests/.runtime/`，不会进入正式 `data/`。截图放在 `docs/screenshots/`。

## 2026-11-15 验证记录

- 从正式 `debug_web` 目录运行：21 项 Python 测试、4 项 Node 测试全部通过，无跳过；前端入口语法检查通过。
- 浏览器：电机例程与 Neo 的 ELF 独立配置切换、刷新后恢复、变量倍率 / 单位 / 曲线选择 / 频率 / 时间窗口 / 端口 / 模块绑定恢复通过。
- 真实 C 板：代码抽查匹配，2/2 个变量有效，5 Hz 采样，双通道曲线与按单位独立纵轴正常；切换页面采集持续；可选云台指标显示绑定变量，其他指标明确未绑定。
- RTT 通道连接成功；本次运行未收到新日志。接收、UTF-8 分片及自动配置路径由协议测试覆盖。未修改或烧录固件。
- 测试配置位于 `tests/.runtime`，正式 `data` 未写入测试配置。截图见 `docs/screenshots`。

## 独立监视页面交互验证

2026-11-15：4 项 Node 测试与入口语法检查通过。浏览器验证：首页不再包含模块启用设置；监视入口始终显示，未加载 ELF 也能进入关闭状态页面；新 ELF 默认关闭；在电机页启用、直接添加变量、绑定指标通过；关闭后设置和读数隐藏，页面保持原位，重新开启保留绑定；云台与电机开关相互独立；切换至 Neo 默认关闭，切回电机例程、刷新后重新选择配置均恢复开关和绑定。测试使用独立临时配置，未连接或修改固件。截图为 `docs/screenshots/monitor-settings.jpg`。

## 2026-11-15 云台 / 底盘图形监视

- 32 项 Python 测试、12 项 Node 测试通过，无跳过。覆盖旧配置迁移和目标模块删除、轴 / 轮标定持久化、无效几何 / NaN / 重复轮位拒绝、输出轴与 IMU 坐标隔离、最短 Yaw 角差、单位换算、Mecanum / Omni 平移与旋转、缺轮 / 离线停止推算、模块独立需求去重，以及旧缓存不能冒充新帧。
- 浏览器使用生产页面和独立测试服务，验证双轴非零姿态、反馈 / 目标与误差趋势、Mecanum / Omni 构型切换、轮位重复选择拒绝、无普通 watch 且电机监视关闭时的六电机采样，以及关闭云台后只采四轮、重新开启恢复绑定。刷新并重新选择 ELF 后恢复 Omni 构型与轮位；暂停后跨页返回姿态保持不变，1265 px 视口无整页横向溢出，控制台无错误 / 警告。
- 实际 OpenOCD 本轮通信超时，未完成实板联调。图形截图和运动验证使用明确标记的合成数据，不代表实车测试。未修改或烧录嵌入式代码。
- 可复现浏览器测试：`python tests/manual_motion_server.py`，然后访问 `http://localhost:18767/`、加载「图形回归 / 合成数据，非实车」配置、连接测试替身并采集。该脚本不会连接探针，只用现有 6020 ELF 检查加载 / 配置流程；测试配置限制在 `tests/.runtime/motion-fixture`，不会进入正式 data。
- 页面截图：`docs/screenshots/gimbal-monitor.jpg`、`docs/screenshots/chassis-mecanum.jpg`、`docs/screenshots/chassis-omni.jpg`。使用和物理单位说明：`docs/motion-monitor.md`。

## 2026-11-15 双轴合图与车轮数据窗

- `npm test`：16 项前端测试通过，包含双轴方向向量与缺失数据、不同电机模式 / 字段、联合姿态图结构，以及数据窗交互与跨帧更新。
- 内嵌浏览器访问本机测试服务超时，本机浏览器控制授权超时；本轮未完成浏览器视觉 / 实际悬停验证，以上截图仍是此前版本。未连接真实硬件，未修改正式调试配置或嵌入式代码。

## 2026-11-15 云台数据窗与整车状态

- 22 项 Node 测试和 33 项 Python 测试全部通过；前端语法检查、配置模板验证通过。覆盖双轴 / 六电机数据窗、共享采样去重、独立开关、配置恢复、相对航向积分中断、暂停、离线、缺失绑定与 body / world 参考系合成。
- 浏览器使用 `python tests/manual_motion_server.py --port 18768 --scenario compensation` 的隔离合成数据，验证整车联合图与六个电机入口、关闭单独云台 / 底盘页后整车仍采集、底盘旋转与云台反向补偿读数、YAW / PITCH 点击固定的数据窗和暂停后历史标识。DOM 测试覆盖悬停及键盘交互；实际浏览器检查了弹窗位置和双栏布局，控制台无错误 / 警告。
- 最新截图：`docs/screenshots/vehicle-monitor.jpg`、`docs/screenshots/gimbal-motor-tooltip.jpg`。测试配置仅写入 `tests/.runtime/motion-fixture`，未连接探针、未修改正式 data 或嵌入式代码。

## 2026-11-15 仓库坐标 / Omni 轮位修正

- 25 项 Node、34 项 Python 测试全部通过，前端语法检查通过。以嵌入式 chassis.cpp 的固定轮速向量独立核验右移、前进、顺时针与含 offset 混合运动；覆盖 SetSpeed 原始指令换算、角度单位隔离、缺失值、逆时针航向合成、旧 rl / rr 绑定迁移，以及两页 Omni 轮位与安装角一致。
- 浏览器使用补偿场景与 Omni 模型验证：FL / FR / BL / BR 四角切向轮、底盘右 vx / 前 vy / 顺时针 vt、整车水平 Yaw 转盘 / Pitch 横轴、俯视车头 / 反馈 / 目标指针、后轮与 Yaw 数据窗、暂停历史显示。控制台无错误 / 警告。
- 截图：`docs/screenshots/vehicle-omni-corrected.jpg`、`docs/screenshots/chassis-omni-corrected.jpg`、`docs/screenshots/gimbal-yaw-corrected.jpg`。使用隔离的模拟服务，不代表实车验证；未修改正式 data 或嵌入式代码。测试服务已停止。

构型回归由 mechanisms.test.js 覆盖零姿态车头方向、多关节顺序、安装变换、缺失分支、轮速矩阵和模板切换；motion-dom.test.js 验证多关节控件 / 悬停；test_profiles.py 验证动态绑定、模板 / 安装信息随 ELF 持久化及非法结构拒绝。浏览器零姿态替身：python tests/manual_motion_server.py --port 18770 --scenario zero --layout omni，仅写 tests/.runtime，不连接探针。

## 2026-11-15 大小 Yaw / 双 Pitch 结构勘误

- 36 项 Node、38 项 Python 测试通过。新增同轴上下堆叠、单 Pitch 保留、双 Pitch 抬升与补偿、上 Pitch 独立俯仰、三种内置模板以及旧快照迁移测试。自定义几何不覆盖，上下轴绑定不交换，旧四轴快照作为自定义保留。两种三轴模板的读数和电机数据窗在云台 / 整车页均有 DOM 回归。
- 浏览器合成数据验证了同轴大小 Yaw 零姿态、Omni 整车共用构型，以及下 Pitch +60° / 上 Pitch −60° 抬升且保持水平。折叠示例保留原配置的 Pitch ±30° 限位，因此也会显示配置限位超出提示；真实使用时需按机构行程标定。检查了上 Pitch 电机窗，控制台无错误 / 警告。未连接真实硬件。
- 复现：python tests/manual_motion_server.py --port 18770 --scenario zero --layout omni --gimbal dual-yaw；折叠示例改为 --scenario folded --gimbal folding。正式配置未改动，测试服务已停止。
- 截图：docs/screenshots/gimbal-dual-yaw.jpg、docs/screenshots/gimbal-folding-lift.jpg；vehicle-modular-zero.jpg 已替换为真实支持的大小 Yaw 构型。

## 2026-11-15 电机使能开关

- 53 项 Python、48 项 Node 测试通过。使能测试使用真实 DJI 6020 DWARF 和假 RAM，覆盖单字节 bool、不覆盖相邻字段或目标、在线/模式/对象/ELF 校验、离线关闭、读回失败和固件覆盖；原有 float 参数接口仍拒绝使能字段。
- 前端覆盖暂停采集切换、禁止重复请求、失能取消待发目标、等待正在发送的写入完成、断开/ELF 切换取消、板端重新使能提示，以及 DM/CyberGear 不支持状态。
- 浏览器使用 python tests/manual_motor_server.py 的合成数据，验证面板关闭后列表同步 OFF、角度控制禁用、暂停采集时从列表重新开启、从面板再次关闭；控制台无错误/警告。截图：docs/screenshots/motor-enable.jpg。未连接真实探针、未修改固件和正式 data；测试服务已停止，临时配置已清理。

## 2026-11-16 AI 调参最简版

- 53 项 Node 测试和 15 项 Python 配置 / HTTP 测试通过。新增 motor-ai.test.js 覆盖重点电机与时间窗、私有字段过滤、特性位、参数变化、非有限数和缺失值、单样本时间依据、材料冻结、回复保留、会话 / 电机切换及剪贴板失败回退。HTTP 测试确认 motor-ai.js 在静态资源允许列表中，私有文件仍不可访问。
- 浏览器使用获授权的 localhost:18769 合成电机替身，验证连续采样中填写目标 / 说明、生成 205 帧材料、复制、粘贴测试回复、暂停 / 恢复保留内容、下载材料与建议，以及切换到无样本电机时隐藏并清除关联。检查导出不含电机地址和本机路径，控制台无错误 / 警告。截图：docs/screenshots/motor-ai-brief.jpg。
- 初次沙箱回环 HTTP 测试受 WinError 10013 限制，获准后运行通过；浏览器本机 origin 访问首次被自动审批拒绝，用户明确授权后完成验证。没有外发真实数据、调用模型或操作实板；AI 回复框使用明确标记的测试文本，不代表模型调参效果。
- 合成服务已停止，独立临时配置已清理，正式 data 和嵌入式工程未改动。
