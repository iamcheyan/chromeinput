# chromeinput 重构移植笔记

源仓：`~/development/rime-study/sbzr.chrome.extension`（双拼，只读未改）
目标仓：`iamcheyan/chromeinput`（全拼，全新实现）

## 一、原文件 → 新文件对照

| 源仓文件 | 新文件 | 说明 |
|---|---|---|
| `manifest.json` | `extension/manifest.json` | MV3 重写；移除 `nativeMessaging` 权限，保留 storage/unlimitedStorage/tabs/contextMenus；content scripts 按依赖顺序声明 |
| `background.js` | `extension/background.js` | contextMenu（Alt+Shift+A 添加快捷词）+ 命令转发，逻辑照抄 |
| `content.js`（1925 行） | `extension/content/main.js` | 装配 + storage 同步 + 消息路由（<200 行） |
| 〃 | `extension/content/keyhandler.js` | 按键拦截/焦点管理/简码链（删双拼 3/4 码顶功规则） |
| 〃 | `extension/content/engine.js` | **全新**：全拼 Map 索引 + 排序键数组二分前缀扫描 + 简拼二级索引 |
| 〃 | `extension/content/committer.js` | commit() 照抄：input 走 value 拼接 + input/change 事件；contenteditable 走 execCommand('insertText') 失败回退 range.insertNode + InputEvent |
| 〃 | `extension/content/ui.js` | 候选条照抄：Shadow DOM、头部拖拽、中英标点/全半角按钮、PAGE_SIZE=6 三行展开、Alt+F 记事本、Shift 单击切中英 |
| 〃 | `extension/content/siterules.js` | 站点开关（enabled/全局禁用名单） |
| 〃 | `extension/content/sync.js` | storage 同步（ci_* 键启动读取 + onChanged 增量同步）；从 main.js 拆出以满足 main.js <200 行 |
| 〃 | `extension/content/style.css` | 克隆样式，id 前缀 `sbzr-ime-*` → `ci-ime-*` |
| `shared/sbzr-core.js` | `extension/shared/storage.js` | `CIShared`：存储键全部改 `ci_` 前缀；dict override 机制、userHistory（maxEntries=12）、快捷词写 user.json override |
| 〃 | `extension/shared/config.js` | `CI_DICTS`：TABLES/DEFAULT_PATHS/EDITOR_PATHS（仅 user.json 可编辑） |
| 〃 | `extension/shared/dictload.js` | `CIDictLoad`：base+user 合并、条目缓存 chrome.storage.local、console.time('CI:cold-start') 打点 |
| `shared/sbzr-toast.js` | `extension/shared/toast.js` | showAppToast/showAppConfirm/showCodeInputDialog，零原生控件 |
| `shared/highlighter.js` | `extension/shared/highlighter.js` | 原样移植（sbzr→ci 命名） |
| `shared/vim-mode.js` | `extension/shared/vim-mode.js` | 原样移植 + 2 处 bug 修复（见 §四） |
| `notepad/` | `extension/editor/` | Nova Editor：词典路径适配 `CI_DICTS.EDITOR_PATHS`；保存改走 override + JSON 校验（去 native host）；去 Sync to Rime 按钮/SarasaMonoSC 字体/461KB logo；content IME 脚本链按 `CONTENT_IME_SCRIPT_CHAIN` 逐文件加载 |
| `popup.html/js` | `extension/popup/popup.html/js` | 重写：站点规则管理/词库选择/字号/开关/编辑器入口 |
| `dicts/*.dict.yaml` | `extension/dicts/*.json` | 由 `tools/build_dict.py` 生成（见 §二） |

## 二、词库转换记录

### 数据源

1. `luna_pinyin.dict.yaml`（master 分支，70732 条）：单字为主 + 少量词组，2337 条有权重列。
2. **rime-essay**（442696 条 `word\tweight`）补词组：luna 词组太少（你好/中国/我们均不在），官方朙月方案靠 `use_preset_vocabulary` 引入 essay，构建脚本对齐该行为。
3. OpenCC `TSPhrases.txt` + `TSChars.txt`：繁→简（词组优先、单字回退），输出全部简体。
4. sbzr 用户资产：`sbzr.userdb.dict.yaml`（空表头）、`sbzr.shortcut.dict.yaml`（7 条）、`zdy.dict.yaml`（17 条）。

### 权重方案

| 来源 | 权重 |
|---|---|
| luna 百分比列 | `round(pct × 1000)`（如 地 di 74.40% → 74400） |
| luna 无权重单字 | 50014（GOAL §二显式值） |
| essay | 原整数权重保留 |
| essay/合并后无权重词组 | 平值 1000（不乘字数；排序键已有字数短优先，保证 zhongg 前缀下 中国 排 中国人 前） |
| 用户资产 | 999999 置顶 |

### 体积预算（按 UTF-8 字节，非字符数）

`base.json + user.json ≤ 2.5MB`（gzip 前）。超限按权重降序截断词组、单字全保留：
最终 `base.json` 97240 条 + `user.json` 34 条 = **2.40MB**（词组截断 51482/420270）。
（注：构建脚本首版按 JS 字符数计预算导致 2.81MB 超限，中文 3 字节/字，已改按 `len(s.encode('utf-8'))`。）

### 双拼 → 全拼反解（用户资产，全部人工核对）

反解规则（源仓 AGENTS.md §7 + `resource/常用字双拼拼音.db` TSV 校验）：
声母 zh→z、ch→c、sh→s 合并；零声母 v+韵母键（**v+r=er 特例**：而/儿/二=vr）；R=uan（远=yr）；w/y 为真实声母。
双键策略：纯中文词保留全拼键 + 原双拼/简拼码字面键（weight 999999，保肌肉记忆）；非纯中文（email/日语/lazyvim）保留原码。

| word | 全拼键 | 保留原码 | 备注 |
|---|---|---|---|
| 差分逻辑 | cha fen luo ji | cflj | 简拼 |
| 苦行僧 | ku xing seng | kxs / kxsg | 双拼码+简拼 |
| 跑通 | pao tong | pkts | 原双拼码 pt→pk 字面保留 |
| 源表 | yuan biao | yrbc | 原双拼码（远 yr + 表 bc） |
| python | — | py | 非中文，原码 |
| vscode | — | vs | 非中文，原码 |
| REDACTED 等 3 邮箱 | — | umail | 非中文，共用原码 |
| 以上内容用日语表达…（38 字） | yi shang nei rong … | uy | 多音字修正：内=nei（原文 nei） |
| 短暂思考过后直接干活… | duan zan si kao … | ugh | 死循环 si xun huan 按原文本 |
| 可以 | ke yi | ky | 肌肉记忆 |
| 加 | jia | jw | 原双拼码 |
| commit&push | — | cp | 非中文 |
| 话 | hua | hw | 原双拼码 |
| 少々お待ちください… | — | syousyou | 日语，原罗马字码 |
| 訂正いたしました… | — | teisei | 日语，原罗马字码 |
| 地 | de | dee | 多音字 override：原码字面 |
| 得 | de | deu | 多音字 override：原码字面 |
| lazyvim | — | lnm | 非中文 |
| 先把刚刚的commit，然后继续 | xian ba gang gang de commit, ran hou ji xu | xmba | 混合文本全拼 + 原简码 |
| REDACTED | — | pi | 非中文 |

### 核心用例核对（构建后）

`nihao→你好(21493)`、`zhongguo→中国(174824)`、`women→我们(479209)`、`shijie→世界(84532)`、`xianzai→现在(283910)`、`bianjiqi→编辑器(3551)`、`shurufa→输入法(3442)`、`zhongguoren→中国人(23645)`。多音字修正样本：行=xing（银行）、单=dan（单位）、无=wu（无法）。
（`nihaoma` 无词条：luna 与 essay 均无「你好吗」，属词库源覆盖范围外，非构建缺陷；运行时走 PREFIX 无候选→直通。）

## 三、引擎设计（全新实现）

- 键 = 全拼串去空格（`ni hao` → `nihao`），`exactMap: Map<key, cand[]>`。
- 前缀匹配：键排序数组 + 二分定位前缀区间（不建 trie，省内存）。
- 简拼：每音节首字母（你好→nh），二级 `shortMap`，候选排全拼之后。
- 排序：`matchTier(EXACT>PREFIX) → 用户历史置顶 → weight desc → 字长 asc`。
- 三态：EXACT / PREFIX / DEAD；DEAD+无候选 → 原字母串直通上屏（对应 A3）。
- 短前缀（≤3 键）预合并 top12 防爆。

## 四、行为存疑 / 有意偏差清单

1. **vim-mode paste() 上游 bug 修复**：源仓 `paste()` 为 `text.slice(0,p)+clipboard` 丢弃光标后全部内容；A8 要求 yy+p 可用，改为完整插入 `text.slice(0,p)+clipboard+text.slice(p)`。行级寄存器（clipboard 以 \n 结尾）按 vim 语义插到当前行之后；`yankLine()` 统一补 `\n`（源仓末行不补，与 dd 的寄存器不一致）。vim-mode.js 内有注释标记。
2. **双拼 3/4 码顶功自动上屏规则已删**：双拼特有交互（4 甮定长），全拼下不适用；保留顶功哲学于 DEAD 态（buffer 死且有候选→commit 首选）。
3. **`renderSiteSettingsPanel` / `openExtensionNotepad` 未移植**：源仓 renderUI 中无调用点（死代码），站点设置由 popup 承担、记事本由 editor 承担。
4. **nativeMessaging 移除**：保留 `NATIVE_SYNC_ENABLED=false` 常量与调用点占位（接口默认关闭），权限从 manifest 删除；编辑器保存改走 dict override + JSON 校验。
5. **存储键全新 `ci_` 前缀**：不迁移旧 `sbzr_` 键（扩展 id 不同，chrome.storage 域隔离，无迁移必要）。
6. **editor `readPackagedDictText` → `readDictResource`**：API 更名适配新 storage.js（移植期曾漏改 2 处调用点，ED2 抓出）。
7. **console.error 保留 5 处**：均为异常路径（词库加载/保存/打开失败），正常流程零输出（C15 双 harness 验证）。
8. **SarasaMonoSC 25MB 字体不移植**（GOAL §四强制），编辑器用系统等宽栈。
9. **notepad → editor 目录更名**，logo 461KB 不入仓；`.veikin-logo` 死 CSS 已删。
10. **引擎 JIT 预热**：索引构建完成后跑 12 个代表性查询（单字母/声母/全拼/简拼），强制编译热路径——否则首键偶发 5.7ms 编译停顿（>5ms 验收线）；预热计入 cold-start 预算（余量 >300ms），perf 计数随后清零。

## 五、性能实测（Xvfb + Chrome for Testing + playwright-core）

| 指标 | 验收线 | 实测（3 连跑） |
|---|---|---|
| 冷启动建索引（CI:cold-start） | ≤800ms | **389 / 412 / 466ms** |
| 单键出候选最大耗时 | ≤5ms | **0.2 / 0.3 / 0.2ms**（JIT 预热后；预热前首键偶发 5.7ms 编译停顿，见 §四.10） |
| dicts 体积（UTF-8 字节） | ≤2.5MB | **2.40MB**（97240+34 条） |
| 编辑器 1 万行载入 | — | ~120ms；拖动滚动 maxFrameGap 4.9ms |
| 行号虚拟渲染 | — | 视口 28-37 行 DOM，滚动重算 |

## 六、验收对照

- A1-A9：`tools/acceptance_test.mjs` 22/22（CDP 隔离世界断言 + console 监听）
- A8/编辑器：`tools/editor_test.mjs` 17/17（ED0-ED16）
- B10-B12 / C13-C15：见上表与 harness 输出；grep 零命中、node --check 全过
- 复验：`xvfb-run -a -s "-screen 0 1280x900x24" node tools/acceptance_test.mjs`（需 tools/ 下 `npm i playwright-core`）
