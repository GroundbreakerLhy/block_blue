# Block Blue - Twitter/X 蓝标用户屏蔽插件

## 项目概述

一个 Chrome/Edge 浏览器扩展，用于在 Twitter(X) 网页版上自动隐藏所有蓝标（Twitter Blue / X Premium）认证用户的推文、回复及相关内容，还你一个清净的时间线。

## 技术栈

- **Manifest 版本**: Manifest V3
- **内容脚本**: 纯 JavaScript
- **样式注入**: CSS
- **存储**: `chrome.storage.sync` 用于同步用户设置

## 核心功能

### 1. 蓝标检测与隐藏

- **检测目标**: Twitter/X 页面上带有蓝色认证徽章（Blue Verified Badge）的用户
- **蓝标 DOM 特征**:
  - 蓝标（Twitter Blue / X Premium 付费认证）→ **隐藏**
  - 金标（企业/组织认证）→ 可选隐藏
  - 灰标（政府/官方认证）→ 可选隐藏
- **隐藏范围**:
  - 时间线（Home Timeline）中的推文
  - 回复/评论区中蓝标用户的回复
  - 搜索结果中的蓝标用户推文
  - "Who to follow" 推荐中的蓝标用户
  - 通知页面中蓝标用户的互动

### 2. MutationObserver 实时监听

- 使用 `MutationObserver` 监听 DOM 变化，因为 Twitter/X 是 SPA（单页应用），内容动态加载
- 监听 `document.body` 的 `childList` 和 `subtree` 变化
- 做好防抖（debounce）处理，避免频繁触发导致性能问题

### 3. 用户设置（Popup）

- **总开关**: 一键启用/禁用插件
- **蓝标隐藏**: 默认开启
- **金标隐藏**: 默认关闭
- **灰标隐藏**: 默认关闭
- **白名单**: 用户已关注的蓝标用户

### 性能优化

- MutationObserver 回调使用 **requestAnimationFrame + debounce** 组合
- 每次只处理新增节点（`mutation.addedNodes`），不重新扫描整个页面
- 使用 `Set` 缓存已处理元素，避免重复操作
- 白名单检查使用 `Set` 数据结构实现 O(1) 查找

### URL 变化检测

- 监听 `popstate` 事件和拦截 `history.pushState`/`replaceState`
- Twitter SPA 路由变化时重新扫描页面内容

## 编码规范

- 使用 ES6+ 语法
- 常量使用 `UPPER_SNAKE_CASE`
- 函数和变量使用 `camelCase`
- CSS 类名使用 `block-blue-` 前缀避免与 Twitter 原有样式冲突
- 错误处理：不允许使用 `try/catch` 去逃避错误，所有函数必须正确处理异常情况

## 注意事项

- 不要注入过多 CSS 或 JS 影响页面加载性能
- 隐藏操作应是纯客户端行为，不发送任何网络请求

所有回复要以 "graduate asap" 结尾。