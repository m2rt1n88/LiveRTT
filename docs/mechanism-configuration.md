# 构型模板与扩展

在云台、底盘或整车页面展开「构型、电机映射与坐标标定」，选择模板，再绑定电机。展开「编辑 / 复用构型 JSON」可以修改结构并应用；错误定义会被拒绝。完整 ELF 配置的导入 / 导出也包含这些字段。模块仍各自独立开关，工作空间不用选择整机模型。

内置云台只有三种：常规 Yaw / Pitch、同轴大小 Yaw / Pitch、单 Yaw 双 Pitch 折叠头。内置底盘：仓库 Mecanum / Omni 四轮、通用双轮差速、通用三轮全向。模板中的示意尺寸可按实物修改；使用前应核对轴向、父子关系、尺寸、零点与轮速矩阵。

大小 Yaw：下方大 Yaw → 上方小 Yaw → 单个 Pitch。两根 Yaw 的中心只沿 Z 方向错开，保持同心同轴；Pitch 的单轴结构不变。对应 ID 为 yaw、smallYaw、pitch。

折叠头：Yaw → 下 Pitch（pitch）→ 上 Pitch（fold）→ 头部。下 Pitch 带动抬升连杆，上 Pitch 随连杆运动，并负责头部独立俯仰。两根 Pitch 都绑定实际关节角，按父子关系合成位置和朝向。例如模板轴向下，下 Pitch +60°、上 Pitch −60° 会抬升头部且保持水平，再增加上 Pitch 的角度即可单独抬头。这里显示实测与目标姿态，不预设固件的耦合比例或控制策略。不存在内置的「折叠头 + 大小 Yaw」组合。

## 配置分工

| 内容 | 保存位置 | 作用 |
| --- | --- | --- |
| 可复用模板库 | frontend/assets/models/library.json | 模板名称、关节 / 轮位、外形与解算器 |
| 当前 ELF 的机构快照 | modules.gimbal.mechanism / modules.chassis.mechanism | 独立保存定义；仅精确匹配已知旧版模板时执行勘误迁移 |
| 安装位姿 | modules.gimbal.mount | 云台相对车体的安装平移与固定旋转 |
| 电机标定 | axes / wheels | motor、sign、ratio；云台另有 zero、min、max |
| 自定义数值 | bindings 与 watches | 给关节或车体反馈 / 目标提供数据 |
| 会话设置 | modules.vehicle 与监视开关 | 参考系等设置，随 ELF 恢复 |

切换模板保留相同 ID 的标定，也保留暂时不用的关节 / 轮位。仅当前模板需要的槽位参与电机采集与状态检查，切回原模板可以恢复原绑定。模板不包含 ELF 路径或内存地址。

旧版内置大小 Yaw 的横向偏移、折叠头命名会在加载 / 导入配置时自动修正，关节 ID、电机、变量绑定与标定不变。只有与 library.json 中 gimbalMigrations.from 完整一致的旧快照才迁移，改过尺寸或其他字段的自定义快照保持原样。旧的错误四轴组合保留为「旧四轴自定义（请重新选择构型）」，不会擅自删轴或重新分配电机；请在构型选择器中换成对应的真实机构。

旧 v2 配置仍可导入：没有 mechanism 的云台使用常规双轴；底盘根据 layout 选择模板；后轮 rl / rr 兼容映射成 bl / br。保存时补全机构定义。单份配置仍为 version: 2，模板库单独使用 version: 1。

## 云台关节树

下例是可以直接粘贴到「云台构型 JSON」的最小双轴模板：

```json
{
  "id": "my-gimbal",
  "name": "我的双轴云台",
  "adapter": "joint-tree",
  "joints": [
    {"id":"yaw", "label":"Yaw", "parent":null,
     "axis":[0,0,1], "origin":[0,0,0]},
    {"id":"pitch", "label":"Pitch", "parent":"yaw",
     "axis":[0,-1,0], "origin":[0,0,47]}
  ],
  "tool": {"parent":"pitch", "origin":[128,0,0]}
}
```

机构局部坐标统一为 X 前、Y 左、Z 上，这是机构坐标；仓库车体速度仍然是 vx 右、vy 前、vt 顺时针。所有默认模板在关节角为 0、安装旋转为 0 时指向车头。

- joints 按父级先于子级排列，parent:null 表示安装根。可有分支；tool.parent 指定用哪条链计算最终瞄向。
- origin 是关节中心相对父级的偏移，单位 mm；axis 是该关节在零姿态下的转轴方向，会归一化。正转按右手定则，因此 [0,0,1] 左转、[0,-1,0] 抬头。
- 可选 rest:[rx,ry,rz] 是局部固定旋转，单位度，矩阵按 Rx · Ry · Rz 组合；然后应用关节 axis 旋转。origin 在父级坐标中先平移，后执行该关节的 rest 和角度旋转。
- tool.origin 是炮管末端相对最后关节的向量，其长度和方向同时决定炮管显示及最终瞄向，不能为零。
- mount.position 和 mount.rotation 分别是安装偏移 mm、固定旋转度，默认都是 [0,0,0]。安装旋转与各电机的编码器零点互相独立。

单关节电机反馈仍按 sign × 输出轴角度 ÷ ratio − zero 标定。zero / min / max 用度；求解时用弧度。自定义变量已视为完成标定，不会再套电机零点。

每个关节 ID 自动对应 axes.<id> 和 bindings.<id> / <id>Target / <id>Speed。例如 smallYaw 对应 smallYaw、smallYawTarget、smallYawSpeed。自定义变量仍需加入 watches；单独选择电机无需逐项加入 watches。ID 使用英文字母开头的字母、数字、下划线或短横线，避免与 enabled、mode、config 或其他关节派生字段重名。

反馈和目标各自通过整棵树计算。某条祖先关节缺失或反馈离线时，该分支不会显示为完整反馈；灰色虚线是零姿态参考，不是补出的测量值。独立云台页和整车页使用同一个求解器与绘图组件。

多关节云台使用 body 关节参考系。原有 world IMU 输入保留给默认安装、默认轴向的常规 Yaw / Pitch；切换到复杂机构或偏置安装会改为 body，导入不兼容的 world 配置会明确报错。不能把多个相对关节角都当成世界航向。最终相对方位角速度由全部有效关节速度通过求解器计算；竖直瞄向附近不输出不可定义的方位角速度。

## 底盘轮组与矩阵

底盘模板使用 wheels 数组，各项包含：

| 字段 | 含义 |
| --- | --- |
| id / label | 轮组标识与显示名；自动对应配置 wheels.<id> |
| position | 绘图位置 [前,左,上]，mm |
| angle | 滚动方向相对正前方的俯视逆时针角，度 |
| rollingSign | 电机正速度与所画滚动方向的关系，±1 |
| roller | 滚子绘图斜向 −1 / 0 / +1，不参与求解 |
| drive | matrix 解算器的一行速度映射 |

可选 outline:[[前,左],...] 定义车体外形，独立底盘页和整车共用。模板中的绘图尺寸用于机构示意；物理速度换算仍使用当前 ELF 中明确配置的 radius / halfLength / halfWidth，需分别按实物标定。

uicrm-four 解算器保留仓库 FL / FR / BL / BR 顺序、offset 和原始正负号，factor 为 Mecanum 的 1 或四轮 Omni 的 √0.5。SetSpeed 原始指令换算仅对这个解算器开放。

其他固定轮组使用 adapter:"matrix"，components 指定可解算的车体分量，比如差速只用 ["vy","omega"]。每个车轮有 drive:[a,b,c]，满足：

```text
radius × wheelSpeed = a × vx + b × vy + c × halfWidth × vt
```

radius / halfWidth 用米，wheelSpeed 用 rad/s，vx 右向、vy 前向用 m/s，vt 顺时针用 rad/s。c 是以 halfWidth 为基准的无量纲转动系数，可按各轮实际转动臂长配置。组件以外的分量保留缺失，不能凭差速轮速判断真实横滑速度。矩阵不可唯一求解、任意所需轮反馈缺失或离线时，停止轮速推算；显式绑定的物理车体变量仍可使用。普通 matrix 指令使用 si 物理量。

## 何时改 JSON，何时写代码

增加串联关节、改变轴向 / 安装位置、调整轮位、增加固定轮组或绘图外形，只需新增 / 修改模板 JSON；绑定控件、状态读数、曲线、悬停与整车视图会复用。修改公共 library.json 可增加供所有 ELF 选择的模板；已有 ELF 快照需在页面主动重新选择或应用新 JSON 才更新。

上述双 Pitch 折叠头可以用两个实测串联关节直接还原，不需要额外的耦合解算器。闭链、平行连杆、只有驱动轴角而缺少关节角的联动机构、舵轮等不能用独立关节或固定速度矩阵准确描述时，需要新增解算器。frontend/assets/js/mechanisms.js 提供 registerGimbalAdapter 和 registerChassisAdapter；新增适配器后，在 backend/mechanisms.py 加入对应的描述格式校验及测试。JSON 不执行脚本。涉及舵向电机的构型还需扩充该适配器的采样描述，不能只把轮子图旋转后就宣称已正确解算。

求解层只输出位置、方向、有效性和运动状态；mechanism-view.js 只画图；motion.js 负责采样接入、绑定界面、曲线与事件；vehicle.js 负责底盘航向连续性和整车组合。后续增加 3D 渲染时可以复用同一机构描述与姿态计算。
