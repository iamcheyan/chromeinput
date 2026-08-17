# chromeinput

Chrome 内嵌全拼中文输入法扩展（MV3，零依赖，从 sbzr/Veikin 双拼扩展重构移植而来）。

## 功能

- 全拼输入：`nihao` → 你好；`nh` 简拼候选排全拼之后；无匹配字母串直通上屏
- 候选条：Shadow DOM、拖拽、翻页、中英标点/全半角切换、Alt+F 记事本
- 用户词频（localStorage/chrome.storage 持久化，选中即加权置顶）
- 快捷词：Alt+Shift+A 把选中文本加入 user.json，立即可打
- 站点开关：禁用域名单词直通不拦截
- Nova Editor：内置词库编辑器，虚拟滚动 + vim 模式（hjkl/dd/yy/p），保存写入 override

## 构建

```
python3 tools/build_dict.py   # luna + essay + 用户资产 → extension/dicts/{base,user}.json
```

产物 ≤2.5MB（UTF-8 字节）。数据源见 `docs/REFACTOR_NOTES.md` §二。

## 安装

`chrome://extensions` → 开发者模式 → 加载已解压的扩展程序 → 选 `extension/`。

## 验收

```
cd tools && npm i playwright-core
cd .. && xvfb-run -a -s "-screen 0 1280x900x24" node tools/acceptance_test.mjs
xvfb-run -a -s "-screen 0 1280x900x24" node tools/editor_test.mjs
```

详见 `docs/REFACTOR_NOTES.md`。
