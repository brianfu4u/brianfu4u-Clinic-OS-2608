# Clinic OS 新系统宪法与执行蓝图 v1.0

**状态：** Approved Baseline（创始人批准）  
**批准日期：** 2026-08-28  
**目标仓库：** `brianfu4u/brianfu4u-Clinic-OS-2608`  
**适用范围：** Clinic OS / Meeting Free 新系统  
**目标：** 以干净架构承接 Od-os 与 Meeting-free 已验证资产，建立一套代码、两种部署方式的长期生产基础。

---

## 0. 文件地位与权威顺序

本文件同时规定新系统不可绕过的宪法原则，以及第一阶段的目标架构和执行路径。

新仓库建立后，文档权威顺序为：

1. **系统宪法**：规定产品本质、权力边界、数据安全与不可变原则。
2. **架构决策记录（ADR）**：记录重要技术选择及其理由，不得违反宪法。
3. **数据与接口契约**：规定实体、状态、API、事件和版本格式。
4. **Harvest 迁移矩阵**：记录旧资产的复用、改造、替换、隔离或废弃。
5. **开发路线图与工单**：规定阶段和交付顺序，可以更新，但不得改变上层原则。

任何旧文档、旧仓库实现、历史版本宪法、临时提示词或工程工单与本文件冲突时，以本文件为准。旧实现只能作为资产来源，不能自动成为新系统事实标准。

---

# 第一部分：系统宪法

## 1. 产品本质

Clinic OS 是面向医疗机构的实时运营事实系统。

它将诊所中分散发生的文本、照片、语音、扫码、设备报告、业务单据和人工决定，重建为可追溯的证据、工作流和运营状态，使店长能够看见：

- 现实中已经发生了什么；
- 每项主张由哪些证据支持；
- 零散证据属于哪个主体和哪条工作流；
- 工作流仍在正常进行，还是预期后果没有出现；
- 哪些问题需要人类确认、纠正或处理；
- 每次处理决定为什么发生、由谁作出、后来产生了什么结果。

系统是**实时记录者、证据编组者、确定性验证者和店长决策工作台**。系统不是自主经营者，不是员工绩效裁判，也不是医疗决策替代者。

“实时”表示实时采集、实时还原和实时可见，不表示 AI 可以自主派活、处罚、关闭工作流或改变医疗事实。

### 1.1 第一版产品重心

第一版的首要价值是**店长闭环管理**：把员工汇报、扫码、照片、单据和其他碎片信息重建为可追踪Workflow，持续判断下一步、证据缺口、接龙结果和闭环状态，并只把需要处理的异常交给店长。

员工端第一版只建设低摩擦的`Employee Capture Shell`：工作状态、快速文字/语音/图片汇报、本人待处理事项和本人提交事项的关键进展。其目标是让员工愿意汇报，而不是在第一阶段实现完整个人AI助理。

完整Employee Assistant、Skill推荐、培训、复杂排班和其他增值能力后续以可安装Capability Pack或Skill提供，不得阻塞店长闭环内核的验证。

---

## 2. 最高目标：一套代码，两种部署

新系统必须满足：

> **一个仓库、一套产品、一套业务内核、一套数据契约和一套测试，同时支持 Cloud 与 On-Prem 两种部署方式。**

不得建立云端版和本地版两个长期分支，不得复制两套业务逻辑，不得让两种部署产生不同的判决规则。

实施顺序明确为：

> **On-Prem First，Cloud Ready。**

第一阶段先把诊所内网部署、断网运行、本地模型、本地数据和本地恢复做实；同时冻结并测试Cloud适配接口。这个顺序是交付优先级，不是代码分叉。Cloud部署可以稍后上线，但不得以重写业务层为代价。

两种部署允许不同的只有基础设施适配层：

| 能力 | Cloud | On-Prem |
|---|---|---|
| 应用运行 | Cloud Run | 医疗机构本地容器/服务器 |
| 数据库 | Cloud SQL PostgreSQL | 本地 PostgreSQL |
| 文件存储 | 云对象存储 | 本地或院内对象存储 |
| LLM/OCR | 私有云模型服务 | 默认本地下载模型服务；经机构明确启用可使用受控云推理 |
| 备份 | 云端加密备份 | 本地备份＋可选加密异地备份 |
| 运维 | 云端直接监控 | Clinic Node Agent 主动连接总部控制面 |

业务层必须通过统一接口访问数据库、存储、模型、备份和运行环境。功能只有在两种部署模式的契约测试都通过后，才算正式完成。

### 2.1 三种运行Profile

| Profile | 应用与数据 | 模型推理 | 适用边界 |
|---|---|---|---|
| On-Prem Strict | 全部在诊所内网 | 本地GPU/CPU | 可拔掉公网继续完整运行；真实PHI首选 |
| On-Prem Hybrid | 应用、数据库和证据在诊所 | 可选受控私有云 | 必须由机构显式启用，标明哪些字段可能出院，并保留调用审计 |
| Cloud | 全部运行在受控云环境 | 私有云模型服务 | 适用于不要求本地化的机构；与本地版使用同一业务内核 |

`On-Prem Hybrid`不得被宣传或显示为“完全本地”。只要推理请求离开诊所，就必须经过数据分类、最小化披露、机构授权和可审计的Provider Policy。

### 2.2 Plug-in / Plug-out的两条轴

系统的可插拔性分为两类，不得混为一个无边界的插件系统：

1. **Capability Pack / SKU Module（业务能力包）**：员工助理、店长助理、OCR、语音、排班、库存、采购、财务、高级报表等，可以按机构或席位安装、授权、启用、停用、升级和替换。
2. **Provider Adapter（基础设施适配器）**：本地推理与云推理、本地存储与对象存储、本地备份与托管备份、本地PostgreSQL与Cloud SQL，可以在不改业务规则的前提下替换。

“Plug-in / Plug-out”表示**契约稳定、依赖明确、可启停、可替换和可回滚**，不要求任意代码热加载，也不意味着所有函数都要插件化。允许通过受控重启完成安装或切换。

---

## 3. 三种权力严格分离

### 3.1 模型的权力

LLM、OCR、视觉模型和其他概率模型可以：

- 识别文字、表格和版面；
- 提取结构化字段；
- 生成事实主张；
- 对证据进行分类和标准化；
- 产生主体或工作流候选；
- 对候选进行语义排序；
- 提供解释、疑点和建议。

模型不得：

- 推断或补造患者身份锚点；
- 直接创建正式证据挂接；
- 写入正式验证状态；
- 绕过确定性门禁；
- 作废、删除或解绑证据；
- 关闭工作流；
- 自主派活或改变员工运营状态；
- 修改已发布规则、SOP或知识版本；
- 将等待时间自动转化为员工违规或绩效判断。

### 3.2 确定性引擎的权力

确定性引擎可以：

- 验证输入格式和字段约束；
- 执行身份、租户、主体类别和状态门禁；
- 根据固定规则计算候选分数；
- 计算 Expectation 状态；
- 根据证据和规则计算 S2 验证状态；
- 阻止不合规的写入和状态迁移；
- 决定信息是否达到展示条件；
- 产生可解释、可重放的系统结论。

同样输入、同样规则版本和同样时间上下文，必须产生同样结果。

### 3.3 人类的权力

只有经过授权的人类可以：

- 作出运营决定；
- 指派或重新指派任务；
- 接受、拒绝或纠正系统建议；
- 对身份进行例外覆盖；
- 解绑、作废或恢复证据；
- 批准例外闭环；
- 关闭工作流；
- 发布或回滚 SOP、知识、语料和政策版本；
- 授权临时远程支持访问。

所有高影响人工决定必须记录操作者、角色、原因、证据、时间和版本上下文。

---

## 4. 证据先于结论

任何正式主张、挂接、验证、建议和决定都必须能够追溯到原始证据。

原始采集必须记录：

- tenant/clinic；
- 来源终端或设备；
- 操作者或系统来源；
- `occurred_at`、`received_at`及时间来源；
- 原始内容引用；
- 内容哈希；
- 身份锚点（如有）；
- 数据分类和敏感级别。

推理、判决和建议必须额外记录：

- `evidence_ids` / `event_ids`；
- `reasoning_chain`或确定性规则轨迹；
- `model_id`和模型哈希（若使用模型）；
- prompt/schema/policy/rule版本；
- 候选集和被排除原因；
- 产生结果的时间上下文。

原始事实不需要伪造“推理过程”；只有推理和判决写入必须具备推理血缘。

---

## 5. 原始数据不可覆盖

原始事件、证据、正式挂接、验证记录、人工决定和知识版本一经写入，不得原地修改或物理删除。

纠正必须通过追加事件完成：

- Void不是删除，而是追加`VOID`标记；
- Unvoid是新的恢复事件；
- Unlink不删除原链接，而是追加失效与纠正原因；
- 更改知识会创建新版本；
- 回滚是重新激活旧版本，并形成新的审计事件；
- 迟到证据不能抹去工作流曾经进入未满足状态的历史。

当前状态可以由历史事件投影得到，但审计历史必须永久可重放。

涉及法定删除、保留期限和患者权利的场景，由专门的敏感数据保留机制执行；业务代码不能以“删除对象”的方式绕过合规流程。

---

## 6. 身份锚点不可推断

患者身份锚点只能来自明确、可复核的来源，例如：

- 患者二维码或条码；
- 明确输入的患者编号；
- 报告上清晰打印并经规则校验的患者编号；
- 经授权人员确认的人工覆盖。

以下行为被禁止：

- 根据姓名相似度猜患者；
- 把近似编号修正成匹配编号；
- 因为工作流时间接近而补造身份；
- 因模型置信度高而绕过身份门；
- 自动将无锚点临床证据挂接到患者工作流。

每种证据类型必须声明身份策略：

- `ANCHOR_REQUIRED`；
- `ANCHOR_OPTIONAL`；
- `NON_PERSON_SUBJECT`。

未声明时默认采用最严格策略。人工身份覆盖必须由授权人员执行并完整审计，任何模型或Agent路径都不得设置该标记。

---

## 7. Composition、Expectation、Verification与Surfacing不得混为一体

系统必须分别回答四个问题：

1. **Composition：** 证据属于哪个主体、哪条工作流？
2. **Expectation：** 该工作流接下来预期发生什么、边界是什么？
3. **Verification：** 已有证据是否足以支持某个事实主张？
4. **Surfacing：** 当前是否需要向特定角色展示？

任何模块不得用一个状态字段代替上述四种含义。

### 7.1 Expectation Policy

Expectation必须声明：

> 当触发事件T针对主体S发生时，结果C应当在时间窗口W内和/或业务关口L之前出现；明确取消事件可以使该Expectation作废。

Policy必须版本化，并记录适用门店、科室、时区、营业日历、生效时间和例外条件。每个实例必须记录当时使用的Policy版本。

Expectation状态至少包括：

- `NOT_TRIGGERED`
- `OPEN`
- `MET`
- `UNMET`
- `VOIDED`

监控配置状态单独记录：

- `CONFIGURED`
- `UNMONITORED`
- `DISABLED`

未配置不能被当作正常或绿色状态；必须在配置健康视图中可见。

### 7.2 Verification State

S2确定性验证状态至少包括：

- `PENDING`
- `VERIFIED`
- `CONFLICT`
- `INSUFFICIENT`

Expectation的`MET`只代表预期证据出现，不代表证据内容真实或一致。

### 7.3 Surfacing State

展示状态至少包括：

- `QUIET`
- `SURFACED`
- `ACKNOWLEDGED`
- `RESOLVED`

`SURFACED`描述信息是否进入人的工作界面，不能替代Expectation的`UNMET`。

---

## 8. 正式挂接只有一条写入路径

系统可以产生多个候选，但正式Artifact–Workflow链接只能由权威Attach Saga写入。

标准路径为：

1. 确定性门禁筛除非法候选；
2. 7-track SubjectResolver计算可解释信号；
3. 模型只能在门禁存活的候选中提供语义辅助；
4. Proposal Recorder保存候选、分数、理由和版本；
5. 确定性阈值或人类决定选择结果；
6. Attach Saga执行幂等、租户、身份、状态和重复校验；
7. 写入append-only正式链接与审计事件。

模型不得扩大已通过门禁的候选集合，不得自动挂接无身份锚点的临床证据。

---

## 9. 缺失必须显式，禁止静默默认

缺失、不可见、未授权、无法识别和不适用是不同状态，必须显式表达。

禁止：

- 缺失时间默认`now()`；
- 缺失数值默认`0`；
- 未配置阈值默认为绿色；
- 未授权功能返回空数据并伪装成正常；
- OCR看不清时猜测字段；
- 为了避免null而填入假值。

推荐字段表达：

```json
{
  "value": null,
  "status": "missing",
  "reason": "not_visible",
  "confidence": null
}
```

所有安全相关配置必须fail closed；非安全功能可以降级，但降级状态必须可见。

---

## 10. 员工伦理与可见性边界

`UNMET`描述因果链，不描述员工品德、能力或绩效。

系统不得根据：

- 等待时间；
- 证据补充次数；
- 工作流未闭环；
- 模型对文本的评价；
- 事件缺失；

自动生成员工违规、排名、处罚或绩效评分。

员工身份可用于完成具体工作流、交接、补充证据和经理处理具体事件；不得未经明确政策转化为个人统计、跨店排名或平台分析。

| 场景 | 身份规则 |
|---|---|
| 员工个人待补充列表 | 可见本人任务 |
| 门店经理处理具体工作流 | 可见必要的责任和交接信息 |
| 门店趋势报表 | 默认聚合，不做个人评分 |
| 平台运营分析 | 脱敏或匿名化 |
| 总部技术支持 | 默认不可见PHI；临时授权、最小范围、全程审计 |

---

## 11. 数据主权、租户和权限

每个医疗机构或合同定义的组织边界必须拥有独立数据作用域。

Cloud模式使用数据库RLS和最小权限运行账户强制隔离；On-Prem模式仍保留相同tenant契约，即使单实例当前只有一家机构。

任何查询缺少有效tenant上下文时必须拒绝。前端传入的`clinic_id`不能成为生产身份来源。

平台创始人、工程师或运维人员不因其公司职位天然拥有患者数据全局读取权。

平台控制面默认只能读取：

- 节点在线状态；
- 软件、模型、规则和数据库版本；
- CPU、内存、磁盘和服务健康；
- 备份成功、大小、校验和恢复演练状态；
- 脱敏错误码和运行指标；
- 经医疗机构授权的脱敏运营摘要。

访问PHI必须采用临时Break-glass授权：范围明确、时效有限、门店确认、完整审计、自动失效。

---

## 12. 模型本地优先、接口统一

系统必须通过Model Gateway调用LLM、OCR和视觉模型，不得让业务模块直接绑定某个模型供应商或运行框架。

统一能力至少包括：

- OCR与版面解析；
- 字段提取；
- 主张提取；
- 分类；
- 语义候选排序；
- 模型健康和版本信息。

Cloud模式连接受控私有云模型服务；On-Prem模式连接本地模型服务。两者输出使用相同JSON Schema和契约测试。

模型权重不得提交到Git仓库。部署通过Model Manifest声明：

- 模型名称与用途；
- 版本与文件哈希；
- 许可证；
- 最低硬件；
- prompt/schema版本；
- 下载位置或院内离线安装包；
- 回滚版本。

每次推理必须记录模型和契约版本。模型不可用、超时或输出无效时，原始证据必须安全保留并转入明确的待处理状态，系统不得虚构成功。

### 12.1 每位员工一个助理，但不等于每人一套模型

员工助理是按用户身份、角色、诊所和授权范围隔离的工作入口；店长助理是拥有门店级运营视图的另一种角色能力。两者可以共享同一个诊所级Model Gateway和同一块GPU，不为每个员工复制模型实例。

每个助理必须具有独立的：

- 用户与角色上下文；
- 可调用工具和可读数据范围；
- 会话保留与PHI策略；
- 操作审计和速率/资源配额；
- Capability Pack与席位授权。

员工在助理中的自然语言内容只有在满足明确的采集契约、用户确认或既定运营规则后，才可以生成正式Artifact、Claim或任务；不得把私人聊天静默升级为正式运营事实。店长助理不得因为角色更高而默认获得全院自由文本或全部PHI。

### 12.2 推理Provider可替换

业务模块只能调用`InferenceProvider`契约，不得直接调用Qwen、PaddleOCR、vLLM或任何云API。最低实现为：

- `LocalInferenceProvider`：诊所内GPU/CPU，本地权重，支持离线；
- `PrivateCloudInferenceProvider`：受控云端推理，使用同一输入输出Schema；
- `DisabledInferenceProvider`：在模型SKU未授权或服务不可用时返回显式能力状态，不伪装成功。

Provider切换必须经过健康检查、固定夹具Parity测试、数据外流策略检查和审计。切换Provider不能改变身份门禁、Expectation、S2或人类权限。

### 12.3 助理必须懂业务边界，也必须懂得拒绝

Employee Assistant与Manager Copilot是诊所工作助理，不是无限制的通用聊天机器人。系统必须在调用模型前执行`DomainScopeGate`，根据用户角色、已启用能力包、诊所业务范围和问题风险分类决定：

- 正常回答诊所运营、已授权眼科知识、内部流程、培训和本人工作辅助问题；
- 对范围模糊的问题先澄清，不擅自扩大数据访问；
- 对与诊所业务无关、超出授权知识域或试图绕过权限的问题明确拒绝；
- 对诊断、治疗、手术选择等医疗决定，转交具有合法资质的医务人员；
- 对被拒绝的问题只记录必要的类别、策略版本和结果，不默认保存敏感原文。

拒答必须由版本化Policy约束并可测试，不能只依赖模型“自觉”。目标不是让助理少做事，而是使其成为每位员工可靠、懂边界、能解释依据的**贤内助和好帮手**。

---

## 13. 商业授权不得关闭安全能力

Entitlement可以控制高级OCR、模型增强、跨店分析、高级报告和SOP候选等增值功能。

Entitlement不得控制或关闭：

- 租户隔离；
- 身份锚点；
- 基础采集；
- 时间来源；
- 原始证据留存；
- 上传安全；
- 血缘和审计；
- 确定性门禁；
- 基本备份和恢复能力；
- PHI保护。

授权降级不得删除既有数据。未授权状态必须表示为`unavailable_not_licensed`，不能显示为空白正常状态。

### 13.1 可信内核与SKU边界

系统采用“**不可拆的可信内核 + 可插拔能力包**”结构。

可信内核至少包括tenant/RBAC、PHI策略、不可变Artifact、时间与来源、身份门禁、Lineage/Audit、Attach Saga、Expectation状态机、S2验证、人类决定边界、基础备份恢复和Capability Runtime。可信内核不可卸载、不可被Entitlement关闭，也不得由第三方能力包替换其判决权。

可选SKU能力包可以包括：

| 能力包 | 典型授权单位 | 可替换边界 |
|---|---|---|
| Employee Assistant | 员工席位/角色 | 对话UI、工具集、提示词与模型Provider |
| Manager Copilot | 门店 | 运营问答、复盘与建议视图 |
| Clinical OCR | 门店/设备类型 | OCR模型、Schema Pack与标准化流程 |
| Voice Capture | 门店/席位 | 录音、转写与语义提取 |
| Operations Pack | 门店 | 排班、任务、支援与房间流程 |
| Dynamic Knowledge Hub | 门店/组织 | 行业、监管与内部知识的接入、版本和检索 |
| Ophthalmology Training & Exam | 门店/组织/席位 | 培训路径、练习和有依据的题库生成 |
| Inventory / Procurement / Finance | 门店或组织 | 对应领域Schema、Expectation与视图 |
| Advanced Analytics / SOP | 组织 | 聚合分析与候选知识生成 |

SKU是产品包装与部署单元，不是安全豁免。任何能力包产生正式数据时，必须经过可信内核的tenant、权限、血缘、Schema和写入门禁。

### 13.2 Capability Manifest与生命周期

每个能力包必须提供版本化`CapabilityManifest`，至少声明：

- `module_id`、版本、许可证和签名；
- 支持的部署Profile和所需硬件；
- 依赖的核心契约、其他能力包和最低版本；
- API、事件、Schema、迁移和权限；
- 数据分类、PHI处理和外部网络需求；
- Entitlement与席位策略；
- 健康检查、验收夹具、升级、回滚和卸载策略。

标准生命周期为：`install → configure → health-check → enable → disable → upgrade/rollback → uninstall`。

Plug-out必须遵守：停用后不再接受新调用；既有记录仍可读取和审计；不得自动删除证据、破坏血缘或使历史工作流不可重放；卸载前必须完成依赖检查和数据导出/保留确认。

### 13.3 商业包装与Entitlement结构

产品采用“基础闭环产品 + 可安装增值SKU”的商业结构：

- **基础产品**：Trusted Core、Employee Capture Shell、Manager Closure Workbench、基础证据采集、Workflow/Expectation/S2、审计、备份恢复；
- **增值SKU**：完整Employee Assistant、Clinical OCR、Voice、Dynamic Knowledge Hub、Training & Exam、Inventory、Procurement、Finance和Advanced Analytics；
- **Skill**：SKU内部可按岗位或席位启用的具体助理能力。

Entitlement必须是数据驱动的机构、门店、设备或席位授权，不得通过客户专属代码分支实现。新增兼容SKU或声明式Skill时，客户可以安装和授权，无需升级业务内核；只有模块要求更高`min_runtime_version`、新核心契约或数据库迁移时才执行受控升级。

On-Prem节点必须支持签名授权文件和离线宽限期，不能因为暂时断网而停止基础闭环能力。授权到期或降级只能阻止新的增值调用，不能删除历史证据或关闭安全能力。

第一阶段只实现Module/Skill Manifest、Entitlement检查、启停和兼容版本判断；不自建复杂计费、开票或应用市场。实际收费可以先由外部商务流程管理，再把授权结果写入Entitlement Registry。

---

## 14. 学习不等于自动改规则

人工批准、拒绝、解绑、作废、身份覆盖和例外关闭可以进入Correction Corpus，但必须保持原始决定语义和完整血缘。

只有明确经人类Promotion的语料版本才能进入生产提示词、模型评估或候选规则生成。

系统可以：

- 计算匿名聚合的Agreement、Unlink、Override等指标；
- 发现反复出现的结构性缺口；
- 生成候选SOP或候选Policy；
- 展示支持证据和影响范围。

系统不得：

- 因经理多次点击接受而自动修改规则；
- 自动发布SOP；
- 自动修改Expectation窗口；
- 将批量批准等同于模型正确；
- 让未Promotion的语料进入生产。

任何规则、知识、语料和SOP的发布都必须版本化、可审计、可回滚。

### 14.1 动态知识库是持续更新系统，不是静态文档仓库

在医疗机构明确授权后，系统可以通过受控入口或Connector持续接收：

- 眼科行业动态、器械与产品资料、专业指南；
- 法律法规、监管通知和合规要求；
- 医疗机构内部制度、SOP、培训材料和经营政策；
- 经批准的机构个性化知识、问答和经验总结。

动态知识生命周期必须为：

`discover/receive → classify → provenance-check → diff/conflict-check → candidate → approve/authorized-promote → active → supersede/rollback/archive`

每个`KnowledgeObject`至少保存：来源、原文或哈希、发布日期、适用地区、知识类型、权威等级、有效期、替代关系、数据范围、批准人、版本和引用许可。系统回答时必须能够指出使用了哪个知识对象及其版本。

系统可以自动抓取、分类、摘要、去重、发现冲突并提出更新候选；正式知识的激活必须满足预先批准的Promotion Policy。监管变化、高风险医疗内容和内部政策不得仅因“来源看起来可信”而自动生效，必须由被授权角色确认。低风险行业资讯可以在机构预先授权的独立参考区自动更新，但不能自动进入判决规则、SOP或强制培训内容。

知识更新不得覆盖历史版本。新版本生效后，历史回答、培训、判决解释和政策执行仍必须能还原当时实际使用的知识版本。

### 14.2 眼科知识库承担培训与考试出题能力

经过批准的眼科知识库可以支持：

- 新员工入职和岗位培训；
- 按岗位、部门和能力等级生成学习路径；
- 从指定知识范围生成练习题、案例题和考试候选题；
- 对错题解释、引用原始依据并推荐复习内容；
- 根据政策或指南新版本生成培训更新建议。

模型生成的题目只能是`QuestionCandidate`。正式题库必须保留题干、答案、解析、难度、岗位范围、知识来源及版本，并经过自动一致性检查；用于正式考核的题目必须由授权人员发布。客观题评分必须确定性执行，模型不得临场改变标准答案。培训结果用于能力发展和合规证明，不得未经明确制度转化为隐性员工绩效惩罚。

### 14.3 知识、现场证据和闭环判决必须交叉验证

系统必须区分：

- **Knowledge Plane**：说明按当前知识、法规和内部政策“应该是什么、应该怎样做”；
- **Evidence Plane**：保存诊所现场“实际发生了什么”；
- **Decision Plane**：依据版本化Policy，对知识要求与现场证据进行确定性交叉验证，并把缺口交给人类处理。

知识库可以定义Expectation、解释缺失、辅助识别矛盾和给出补充建议，但知识文本本身不能证明某次检查、清洁、交接、收费或医疗动作已经发生。现实链条只有在相应Artifact、身份锚点、时间、主体和规则验证通过后才能闭环。

当监管知识、内部政策、模型提取结果与现场证据互相冲突时，系统不得选择性忽略；必须保留冲突双方的来源和版本，产生明确的`CONFLICT`或Review Item，并由授权人处理。

---

## 15. Shadow Mode是生产前置条件

任何新的Expectation Pack、重要解析器、匹配规则或模型版本，必须先在Shadow Mode中运行。

Shadow Mode允许计算Proposal、Expectation、Verification和Surfacing结果，但不得改变正式挂接、工作流、员工任务或经理队列。

至少评估：

- 假阳性；
- 假阴性；
- Identity Gate拦截率；
- 无锚点比例；
- 人工Override率；
- Unlink率；
- 模型无效输出率；
- 不同部署模式的一致性。

上线后的Agreement Rate不能替代Shadow验证，因为只观察经理已处理案例会产生选择偏差，也无法发现系统没有提出的真实问题。

---

## 16. 可观察但不可泄漏

系统必须可观测：健康、错误、延迟、版本、备份、队列和资源状态都应可测量。

可观测性不得泄漏：

- PHI；
- 原始语音或影像；
- 完整模型输入；
- 会话令牌；
- 患者身份锚点；
- 跨租户标识；
- 不必要的员工身份。

日志默认脱敏；调试访问必须遵守最小权限和临时授权。

---

# 第二部分：目标架构

## 17. 六层业务架构与双平面部署

### 17.1 业务层级

| 层 | 名称 | 核心职责 |
|---|---|---|
| L0 | Governance Spine | tenant、RBAC、审计、版本、Policy、知识与配置健康 |
| L1 | Capture | 文本、照片、语音、扫码、设备和单据的不可变采集 |
| L2 | Interpretation | OCR、结构化提取、标准化、缺失表达与FactCard |
| L3 | Composition & Expectation | 主体解析、候选工作流、正式挂接、预期后果和因果链状态 |
| L4 | Verification & Human Operations | S2验证、展示、店长决定、Undo、例外和关闭 |
| L5 | Learning & Evolution | Correction Corpus、版本Promotion、Shadow评估与SOP候选 |

### 17.2 部署平面

系统分为：

- **Data Plane**：运行在Cloud或医疗机构本地，处理业务数据、PHI、模型、规则和工作流。
- **Control Plane**：统一管理门店注册、节点健康、版本发布、备份状态、授权和告警；默认不持有门店PHI。

On-Prem Clinic Node必须主动向Control Plane建立加密连接，不要求医疗机构开放公网入站端口。升级包、模型包和规则包必须签名；升级前备份，升级后运行验收，失败自动回滚。

---

## 18. 统一技术边界

建议新仓库采用以下逻辑结构，具体框架可由ADR确定：

```text
clinic-os/
├── apps/
│   ├── web/                    店长端与员工端
│   ├── api/                    统一业务API
│   └── fleet-control/          总部节点控制面
├── services/
│   ├── model-gateway/          本地/私有云模型统一入口
│   ├── ingestion-worker/       OCR与多模态采集处理
│   └── composition-worker/     编组、Expectation与Shadow运行
├── packages/
│   ├── contracts/              API、事件与Schema契约
│   ├── domain-core/            Artifact、Workflow、Decision等领域模型
│   ├── capability-runtime/     能力包注册、生命周期、依赖与授权
│   ├── composition-engine/     7-track候选与Attach Proposal
│   ├── expectation-engine/     纯函数状态机
│   ├── s2-engine/              确定性验证
│   ├── policy-registry/        场景、日历、标签和版本
│   └── security/               tenant、RBAC、PHI、审计与脱敏
├── capabilities/
│   ├── employee-assistant/     员工席位助理SKU
│   ├── manager-copilot/        店长助理SKU
│   ├── clinical-ocr/           首个临床OCR SKU
│   ├── knowledge-hub/          动态行业、监管与机构知识SKU
│   └── training-exam/          眼科培训与考试SKU
├── adapters/
│   ├── inference/              local与private-cloud Provider
│   ├── storage/                local与object-storage Provider
│   ├── database/               postgres与cloud-sql Provider
│   └── backup/                 local与managed Provider
├── database/
│   ├── migrations/
│   └── seeds/
├── deployment/
│   ├── cloud/
│   └── onprem/
├── models/
│   └── manifest.yaml           只保存元数据，不保存权重
├── manifests/
│   └── capabilities/           SKU能力包清单、依赖和生命周期
└── docs/
    ├── CONSTITUTION.md
    ├── architecture/
    ├── adr/
    ├── contracts/
    └── migration/
```

这是一张职责地图，不要求第一天创建所有空目录。只有进入实际开发范围的模块才建立代码。

Capability Runtime只负责模块发现、契约校验、生命周期、依赖、授权和健康状态；正式领域写入仍由可信内核负责。能力包之间不得直接读写彼此数据库表，应通过版本化契约、事件或核心服务协作。

---

## 19. 规范术语

正式代码和数据库使用中性、可审计术语：

| 正式术语 | 含义 | 产品比喻 |
|---|---|---|
| Artifact / Evidence | 不可变原始证据 | 车厢 |
| EvidenceFactCard | 模型提取的结构化主张 | 车厢标签 |
| Workflow | 被重建的业务过程 | 列车 |
| Composition | 证据与工作流候选匹配 | 编组 |
| WorkflowArtifactLink | 正式挂接 | 挂接车厢 |
| ExpectationPolicy | 预期后果和边界 | 运行规则 |
| Attention/Review Item | 需要人看见的情况 | 待处理提示 |

“火车编组”可以用于解释和界面，但不全面替换数据库、API和领域模型命名。

---

# 第三部分：Harvest策略

## 20. Harvest原则

新仓库不直接合并两个旧仓库，也不复制整个目录。每项资产必须经过：

1. 确认真实调用路径；
2. 确认测试和生产依赖；
3. 去除旧平台耦合；
4. 映射到新契约；
5. 携带或重写关键测试；
6. 通过Cloud与On-Prem契约测试；
7. 记录来源、改造和接受理由。

资产状态统一为：

- `REUSE_AS_IS`
- `REFACTOR_AND_REUSE`
- `REPLACE`
- `QUARANTINE`
- `DROP`
- `DEFER`

字段数量和模块数量必须根据当前commit重新扫描验证，不把参考资料中的统计数字直接写成事实。

## 21. Od-os优先Harvest资产

- PostgreSQL RLS与tenant context；
- 非超级用户运行账户和启动安全检查；
- 会话、角色和服务端权限；
- S2确定性Scorer及验证字段写保护；
- append-only事件、验证、动作和员工状态账本；
- PHI敏感侧存、脱敏和留存清理；
- 上传限制、哈希、去EXIF、签名URL和存储抽象；
- 日志、健康、指标和错误处理；
- 中英日国际化框架；
- 已验证的单元及数据库隔离测试。

Od-os通用JSONB对象模型不自动整体迁移；先按新领域契约决定哪些实体需要强Schema和数据库约束。

## 22. Meeting-free优先Harvest资产

- Artifact、EvidenceFactCard和Workflow领域经验；
- 7-track SubjectResolver；
- Composition Engine、Candidate Finder和Guardrail；
- Proposal、Hypothesis和Commit/Attach Saga；
- NegativeConstraint、Undo、accepted orphan及人工复核；
- WorkflowSnapshot和闭环视图；
- Staff Pad与店长运营界面；
- 眼检报告、OCR质量、左右眼和元数据分层；
- Correction Corpus和版本化学习设计；
- 相关单元测试和Parity测试。

不迁移：Base44直接Entity调用、固定`clinic-001`、未接正式路由的实验页面、冗余依赖和未经证实的声明字段。

---

# 第四部分：执行路线图

## 23. Phase 0：冻结契约，不写功能

Phase 0只完成不可逆的定义和验证准备：

1. 建立新仓库与本宪法；
2. 固定第一条真实临床链；
3. 固定Artifact、FactCard、Workflow、Link、Expectation、Verification、Decision契约；
4. 固定身份锚点策略；
5. 固定On-Prem Strict、On-Prem Hybrid和Cloud三种Profile；
6. 固定Cloud/On-Prem适配接口及`InferenceProvider`契约；
7. 冻结可信内核与SKU能力包的边界；
8. 固定`CapabilityManifest`和Plug-out数据保留语义；
9. 固定员工助理、店长助理的身份、工具、PHI和席位边界；
10. 固定`DomainScopeGate`与医疗问题转交策略；
11. 固定KnowledgeObject、来源等级、Promotion Policy和知识引用契约；
12. 固定模型输出JSON Schema；
13. 定义第一条Expectation的W、L、VOID条件和日历；
14. 建立Harvest矩阵，逐项记录来源commit；
15. 写出正向、负向、越权、跨租户、模块停用、Provider切换、知识冲突和越域拒答夹具；
16. 明确第一阶段不做的功能。

Phase 0退出条件：任何工程师无需重新解释产品哲学，即可根据冻结契约实现同样行为。

---

## 24. Phase 1：一条垂直Tracer Slice

首条建议链：

> 患者扫码登记 → 在配置窗口或业务关口前出现指定检查报告 → OCR/模型提取 → 身份与主体门禁 → 编组 → Expectation → S2验证 → 店长复核/关闭 → 决定与证据留存。

Phase 1采用On-Prem First，以店长闭环为中心，只建设这条链必需的最小能力：

- tenant/RBAC/audit；
- 不可变Artifact采集；
- 时间与来源；
- 身份扫码和无锚点阻断；
- 一个OCR/模型Schema；
- Output Validator与显式缺失；
- 最小7-track候选；
- Proposal Recorder；
- Attach Saga；
- 一个版本化Expectation Policy；
- 纯函数Expectation状态机；
- S2验证；
- 店长复核、例外和关闭；
- Shadow结果记录；
- Employee Capture Shell：状态、快速汇报、本人待办与关键进展；
- Manager Closure Workbench：走马灯、Workflow、证据缺口、接龙、复核和关闭；
- 最小Capability Runtime、Entitlement检查，以及Tracer所需的Clinical OCR；
- 最小受控知识集、知识版本引用和DomainScopeGate；
- On-Prem Strict可安装、可断网运行、可备份恢复；
- Cloud与Private Cloud Provider的契约桩、固定夹具与Parity测试，不要求本阶段完成生产Cloud上线。

Phase 1不建设完整Employee Assistant、Skill推荐、完整六域、完整知识后台、SOP生成、全局分析、复杂计费系统或全部终端。

### Phase 1强制测试

1. **正向：** C在W−ε出现，Expectation为MET；证据一致时S2为VERIFIED。
2. **负向：** C在W内未出现，到边界时Expectation精确进入UNMET。
3. **迟到：** W后补充证据，当前状态可闭环，但历史UNMET不可消失。
4. **身份：** 完美候选分数但无锚点，不能自动挂接。
5. **冲突：** 报告按时出现但患者或左右眼数据冲突，Expectation可MET，S2必须CONFLICT。
6. **作废：** 明确合法取消后进入VOIDED，不产生错误未满足。
7. **租户：** 跨机构读取和写入均被数据库拒绝。
8. **模型失败：** 模型超时或JSON无效时，原始Artifact保留，不产生正式FactCard或判决。
9. **部署Parity：** 同一固定夹具通过On-Prem实现与Cloud Provider契约测试，产生相同领域结果；Cloud正式上线后加入端到端Parity。
10. **人类权限：** Agent不能Close、Void、Unlink或Identity Override。
11. **Plug-out：** 停用Clinical OCR后新调用返回明确不可用；历史FactCard、Artifact和Lineage仍可读、可重放。
12. **助理隔离：** 员工助理不能读取其他员工私有会话；店长助理不能绕过PHI策略。
13. **Provider切换：** 本地Provider不可用时不得静默转发云端；只有机构明确授权的Hybrid Profile可以切换。
14. **业务拒答：** 与诊所业务无关的问题在模型调用前被DomainScopeGate拒绝，并记录策略版本。
15. **医疗边界：** 诊断和治疗决定不得由员工助理回答，必须转交有资质人员。
16. **知识引用：** 助理基于知识回答时返回可追溯的KnowledgeObject及版本；已失效版本不能冒充当前政策。
17. **闭环边界：** 知识库写明“应完成检查”但没有现场Artifact时，Expectation不能被判定为已闭环。

---

## 25. Phase 2：Shadow试点与真实校准

在真实医疗机构以On-Prem Strict和Shadow Mode运行第一条链：

- 不自动派活；
- 不改变正式工作流；
- 不向员工产生负面标签；
- 对比系统状态与真实结果；
- 记录缺失采集点和误判来源；
- 调整Expectation Policy须创建新版本；
- 验证On-Prem结果与Cloud契约夹具一致；待Cloud环境上线后补充端到端一致性。

退出条件不采用单一准确率口号，而是根据试点样本明确记录：假阳性、假阴性、无锚点、Override、Unlink、模型失败和未配置比例，并由产品与医疗机构共同批准进入正式展示。

---

## 26. Phase 3：横向扩展采集与解析

核心因果链被证明后，才扩展：

- 更多员工终端和采集方式；
- 更多医疗报告类型；
- 语音和文档解析；
- 眼检报告元数据层；
- 设备、库存和收费证据；
- Offline Queue和幂等重试；
- 模型Manifest、下载、健康和回滚；
- 本地硬件基准和容量规划。

每种新证据类型必须带：身份策略、Schema、缺失规则、正向Fixture、负向Fixture和模型失败Fixture。

---

## 27. Phase 4：Expectation Library与运营闭环

- 扩展临床Expectation Pack；
- 员工个人补充列表；
- 可追溯交接；
- 店长例外关闭；
- Unlink/Void/Override工作区；
- 工作流快照和日结；
- 聚合结构性缺口；
- Policy、知识、语料的版本管理；
- Dynamic Knowledge Hub：授权来源接入、差异比较、冲突检测、Promotion和回滚；
- Ophthalmology Training & Exam：引用式培训内容、候选题生成、人工发布和确定性评分；
- 知识版本变化对Expectation、SOP和培训内容的影响分析；
- 正式Surfacing和角色路由。

任何“长时间未完成”的信息只描述工作流状态，不直接生成员工评价。

---

## 28. Phase 5：跨领域验证

选择采购作为首个非临床领域：

> 采购申请 → PO → 发货 → 到货 → 验收 → 入库 → 发票/付款。

使用同一Artifact、Composition、Expectation、S2和Decision引擎，只替换Subject Schema和Expectation Pack。

采购链跑通后，才确认系统真正具备领域无关能力，再扩展财务、设备、库存、营销和其他领域。

---

## 29. Phase 6：学习与SOP候选

当Correction Corpus达到足够数量和质量后：

- 建立人工Promotion；
- 计算分类型Agreement/Unlink/Override；
- 高权重关注解绑和纠正，低权重处理批量批准；
- 发现重复结构性缺口；
- 生成候选SOP/Policy；
- 提供差异、证据、影响范围和回滚计划；
- 由授权人员发布。

AI永远只提出候选，不直接改变生产规则。

---

# 第五部分：工程门禁与完成定义

## 30. 完成定义

一个模块只有同时满足以下条件才算完成：

- 职责符合本宪法；
- 输入输出契约明确；
- 正向和负向测试通过；
- 失败路径不会伪装成功；
- 关键写入具备血缘和审计；
- 租户隔离测试通过；
- 模型不能绕过门禁；
- Cloud与On-Prem契约行为一致；
- 数据迁移和回滚路径明确；
- 文档描述与实际代码状态一致。

只有UI、文档或模拟数据存在，不代表业务能力完成。只有单元测试，没有真实持久化与权限路径，也不代表生产能力完成。

## 31. CI最低门禁

新仓库main分支至少要求：

- format/lint/typecheck/build；
- 单元测试；
- 状态机纯函数Fixture；
- 模型输出Schema测试；
- 数据库迁移重复性；
- RLS跨租户测试；
- append-only写保护测试；
- Attach Saga唯一写入测试；
- Agent越权负向测试；
- DomainScopeGate越域与医疗拒答测试；
- KnowledgeObject来源、版本、Promotion和回滚测试；
- 知识与现场证据冲突测试；
- Cloud/On-Prem adapter contract tests；
- PHI日志泄漏扫描；
- 依赖和许可证检查；
- Harvest来源与迁移记录检查。

不得长期允许main在lint、typecheck或核心测试失败状态下继续开发。

---

## 32. 明确不做的事情

在核心闭环被真实验证前，不做：

- 自动员工评分或排名；
- AI自主运营派活；
- AI自主关闭工作流；
- 未经人类批准的规则自学习；
- 大规模跨店基准；
- 全领域同时铺开；
- 为未来可能需要而创建空抽象；
- 两套部署代码分叉；
- 为每个员工运行一份独立大模型或独占GPU；
- 把所有函数插件化，或建设可执行任意第三方代码的无边界插件市场；
- 在On-Prem Strict模式下静默把推理降级到云端；
- 允许能力包绕过可信内核直接写正式领域状态；
- 从公开网络自动抓取内容并未经验证直接成为正式知识、政策或考题；
- 仅凭知识库文字把现场工作流判定为已完成；
- 把员工助理变成与诊所业务无关的无限制通用聊天服务；
- 为保留旧字段而迁移无人使用的Schema；
- 将Base44作为生产数据与权限底座；
- 把模型权重提交到Git。

---

# 第六部分：新仓库启动清单

## 33. 建仓前需要最终确认的业务输入

1. 新仓库正式名称与GitHub组织；
2. 第一家Shadow试点医疗机构的实际流程；
3. 第一条临床Expectation的触发、结果、W、L、VOID条件；
4. 首批On-Prem Strict运行环境，以及Cloud/Hybrid接口目标；
5. On-Prem目标硬件范围；
6. 首批OCR/LLM候选及许可证要求；
7. 医疗机构数据保留、备份和远程支持政策；
8. 经理、员工、机构管理员、平台运维的角色定义；
9. 中、日、英界面首发范围；
10. 首批Employee Assistant、Manager Copilot、Clinical OCR的SKU与席位策略；
11. 首批眼科、监管和内部知识来源，以及各自的更新和批准责任人；
12. 首批培训岗位、题库发布人和正式考核边界；
13. 基础闭环产品与首批增值SKU的授权单位：机构、门店、设备、席位或用量；
14. On-Prem授权文件、离线宽限期和到期降级政策；
15. 旧仓库冻结和只读策略。

这些输入不影响本宪法成立，但会影响Phase 0契约和Phase 1实施。

---

## 34. 一句话执行原则

> 保留两个旧仓库中已经被证明有效的资产，把它们迁移到一个不可拔出的可信内核，并把员工助理、店长助理、OCR、动态知识和眼科培训做成可插拔SKU能力包；以On-Prem Strict完成第一条真实临床链，让知识、现场证据和人类决定形成可追溯闭环，同时用统一Provider契约守住Cloud兼容。

---

## 35. 宪法修改规则

对以下内容的修改视为宪法修正案，而不是普通工单：

- AI、确定性引擎和人类的权力边界；
- 一套代码、两种部署目标；
- On-Prem First、Cloud Ready的实施顺序；
- 可信内核与可插拔SKU能力包的边界；
- On-Prem Strict不得静默连接云端的原则；
- 原始数据不可覆盖原则；
- 身份锚点不可推断原则；
- 租户与PHI访问边界；
- 模型不得直接写判决；
- 人类独占Void、Unlink、Override和Close；
- Entitlement不得关闭安全能力；
- 学习不得自动发布规则；
- 动态知识必须保留来源、版本、授权、Promotion和回滚；
- 知识库不得代替现场证据完成闭环；
- 助理必须执行诊所业务范围和医疗风险拒答；
- 员工不得因等待时间被自动评价。

修正案必须说明：修改原因、风险、影响模块、迁移方式、测试、回滚和批准人。沉默、临时实现和历史代码都不能构成宪法变更。

---

**版本：** 1.0 Approved  
**下一动作：** 建立正式仓库，提交本宪法、Harvest矩阵和第一条Tracer Slice契约；所有Builder工单必须引用本基线或相应ADR。
