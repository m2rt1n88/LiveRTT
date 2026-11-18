# 通信链路监视

重启 Python 服务、刷新网页，在左侧进入「通信链路监视」。加载与板上固件匹配的 ELF，启用模块并「扫描链路」，选择对象后连接 SWD，点击顶部「开始采集」。不需要先添加普通变量或启用电机监视。

每次采集一路链路；切换选择后保留各链路独立游标与历史。选择、模块开关、RX/TX 筛选及搜索内容随 ELF 配置保存。板端不自动连接、烧录或重启。

## 两种数据视图

- **当前解析字段**：从 ELF 的 DWARF 识别对象、继承成员、数组及协议位域，经 SWD 读取内存。旧固件可以使用；字段未变化不能证明没有收到新报文，初始化的零值也不能证明链路在线。暂停、断开、读取失败及超过两秒未更新时，明确标记历史／错误。
- **收发帧记录**：固件的 trace_ 环形缓冲记录序号、板端毫秒、RX/TX、标识符、长度及原始字节。相同内容的连续报文仍为不同帧。CAN 展开收发节点、寄存器、数据类型及数值；裁判帧保留线序号、CRC 字节并按当前 ELF 布局解码。未知命令保留原始帧；载荷长度与 ELF 不符时显示解析错误。

TX 表示驱动完整接受该发送请求，不能证明实际发送完成或对端收到。RX 为驱动／协议层收到的有效帧；裁判记录在 CRC 校验后，不记录 CRC 错误的字节流。此模块不是物理 CAN／UART 抓包器，无法监视板上没有注册的链路。

网页保留每链路最近 2,000 帧，表格显示筛选后的最近 200 帧。可按方向、十六进制 ID、命令名称、原始字节或解析内容筛选；导出 JSON 包含全部保留帧、覆盖计数、最新字段及 ELF 标识。清空仅清浏览器记录，不复位板端缓冲；刷新、重载 ELF 或重新连接后重新积累。

## 协议适配与源码状态

| 实现 | 当前支持 |
| --- | --- |
| communication::CanBridge | 扫描、字段快照、全部声明的标量／数组／扩展寄存器类型解码；当前工作目录已加入逐帧记录 |
| control::ChassisCanBridgeSender | 读取速度、使能、功率和寄存器配置；复用其绑定的 CanBridge 帧缓冲，按实际寄存器解码平移／使能旋转 |
| communication::Referee | 旧版字段及位域、逐帧记录；当前工作目录已接入 |
| referee_comm::Referee + v2026/v2027::Protocol | 匹配协议引用实际指向的赛季对象；支持命名对象及通过 vtable 定位的堆对象，按对应赛季 DWARF 解码。逐帧记录通过下述安装工具接入 |
| 用户指定的独立 chassis_can_bridge.cpp | 当前机器不存在 C:\Users\Martin\Code\RM\UICRM-Embedded 路径；本地与远端 M2rt1n/Seer 也没有该独立文件。没有取得该实现的源码，尚不能确认或完成其专用协议适配 |

数组字段快照最多展开每维 64 项、深度 7、每对象 768 个数值字段；帧中的原始字节完整保留（裁判最多 320 字节）。赛季 Protocol 需有 DWARF 定义，动态类型识别需保留 ELF 符号表。

## 固件帧记录

当前 RoboMaster/UICRM-Embedded 的 Martin/debugger 工作目录已修改四处驱动文件，并新增 boards/drivers/include/communication_trace.h。需要用户自行重新构建和烧录，再加载同一次构建的 ELF；本次实现没有烧录任何板子。已有 ELF 不会凭空拥有帧历史。

记录器不使用堆分配、不打印、不发 RTT。CanBridge 每对象占约 776 字节，裁判每对象占约 2,696 字节；记录时用短临界区复制数据，实际耗时需在目标板验证。32 个 CAN 帧／8 个裁判帧的缓冲会覆盖旧记录，网页显示覆盖数量，不承诺全速无丢帧。逐槽提交校验避免将边写边读的混合数据当成有效帧。

在包含 Martin/referee 新实现的工作目录使用安装工具，无需切换当前调试仓库的分支：

~~~powershell
python tools/install_communication_trace.py "赛季版固件工作目录"
python tools/install_communication_trace.py "赛季版固件工作目录" --apply
~~~

第一条预览，第二条安装头文件与新裁判收发记录点。工具先核对全部锚点，再写入；可重复运行。随后在该固件目录重新编译、烧录并加载对应 ELF。该工具针对已核对的 referee_comm 接口，不会修改或猜测缺失的独立 chassis_can_bridge 实现。

## 验证

TypeC 的 can_bridge host 与 referee 例程已实际编译链接成功；新裁判 2026／2027 源码已单独编译成 ARM 布局测试 ELF。后者仅用于 DWARF 测试，外部 BSP 调用由占位符链接，不能烧录或运行。

~~~powershell
python tests/build_communication_fixtures.py
python -m unittest discover -s tests -p test_communications.py -v
npm test
~~~

布局测试工具从本地 Martin/referee 分支读取源码，生成文件仅写入 tests/.runtime，不更改固件分支。覆盖连续相同帧、游标、覆盖／重启、并发覆盖、精确 64 位整数、位域、两赛季长度差异、堆对象动态类型、309 字节帧、未知命令和通信独立采集。浏览器合成数据服务为 tests/manual_communication_server.py，默认 localhost:18770，不连接真实探针。
