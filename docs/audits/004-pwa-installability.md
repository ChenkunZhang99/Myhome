# 004 · PWA 安装基础

- 状态：完成，待独立复核
- 日期：2026-08-24
- 目标：让手机和桌面浏览器可以把“家里有数”识别为可安装的独立应用，同时不误缓存家庭隐私数据。

## 1. 范围

本步骤完成：

- 新增标准 Web App Manifest。
- 使用现有深绿、金色与“家”字视觉生成 192px、512px、maskable 512px 和 Apple Touch 图标。
- 将原本的通用蓝色 favicon 换成项目自己的品牌图标。
- 页面输出 manifest、主题色、Apple Web App 和 Apple Touch Icon 元数据。
- 在真实 Worker HTTP 环境验证 manifest、HTML 元数据、PNG 类型和实际像素尺寸。

本步骤没有加入 Service Worker，也不宣称离线可用。

## 2. Manifest

`public/manifest.webmanifest` 包含：

| 字段                         | 值或作用                               |
| ---------------------------- | -------------------------------------- |
| `id` / `start_url` / `scope` | 都限定在本站根路径                     |
| `display`                    | `standalone`，从主屏启动时使用独立窗口 |
| `lang`                       | `zh-CN`                                |
| `theme_color`                | `#163f33`，与侧边栏主色一致            |
| `background_color`           | `#f4f2eb`，与页面底色一致              |
| `icons`                      | 192、512 和 maskable 512 三项 PNG      |

manifest 和所有图标都在 `public/`，不依赖 API、数据库或登录状态。

## 3. 为什么没有 Service Worker

这个应用的核心内容是登录后的库存、照片、小票、家庭成员和采购记录。一个泛化的离线缓存策略很容易把这些响应留在共享设备的浏览器缓存里，也容易在重新联网后显示过期库存。

当前需求是“添加到主屏”和独立窗口体验，不是离线写入。因此本步骤只补安装元数据，不注册 Service Worker，不缓存认证后的页面或 API。以后如果确实要做离线模式，应单独设计：

1. 哪些静态壳资源可以缓存；
2. 哪些家庭数据绝对不能进入 Cache Storage；
3. 离线修改如何排队、冲突与撤销；
4. 退出登录和撤销设备时如何清理本地数据。

## 4. 图标

图标来源是 `public/favicon.svg`：

- 绿色圆角底代表现有侧边栏；
- 金色内块和“家”字沿用页面左上角的 `brand-mark`；
- 主要图形位于 maskable 安全区域内，系统裁成圆形或其他形状时仍能辨认。

PNG 由项目依赖树中已有的 Sharp 0.34.5 从同一 SVG 机械生成，没有引入运行时依赖。生成结果：

- `pwa-192.png`：192 × 192
- `pwa-512.png`：512 × 512
- `pwa-maskable-512.png`：512 × 512
- `apple-touch-icon.png`：180 × 180

## 5. 验证证据

可复制命令：

```bash
pnpm run typecheck
pnpm run test:integration
pnpm test
pnpm run lint
pnpm run format:check
```

2026-08-24 本机结果：

- 类型检查：通过。
- HTTP 集成测试：3/3 通过。
- 单元/源码守卫测试：222/222 通过。
- vinext 生产构建：通过。
- ESLint：0 error；10 个原有 warning。
- Prettier：通过。

真实 HTTP 测试断言：

1. 首页 HTML 包含 manifest、主题色和 Apple Touch Icon 链接。
2. manifest 以 JSON manifest 类型成功返回，并声明 `standalone`。
3. 三个安装图标都以 `image/png` 返回。
4. 测试读取 PNG 的 IHDR，确认文件内部实际宽高与 manifest 声明一致，而不是只检查文件名。

## 6. 已知边界

- 是否显示“安装”入口仍由浏览器、HTTPS、操作系统和用户已有安装状态决定。
- iOS Safari 通常由分享菜单中的“添加到主屏幕”完成，不一定主动显示安装提示。
- 本步骤没有创建应用内“安装”按钮，因为不同浏览器支持并不一致；先依赖系统入口更稳妥。
- 图标中文字依赖生成时的中文字体，但 PNG 已提交，线上不依赖访问者设备字体。
- 没有离线读取或离线编辑能力。

## 7. 给下一位审计者的检查清单

1. 在 Android Chrome 的应用信息或 DevTools Manifest 面板确认三个图标无警告。
2. 在 iPhone Safari 添加到主屏，确认名称、图标和启动状态栏可接受。
3. 检查 512px maskable 预览，确认圆形裁切不会切掉“家”字。
4. 退出登录后检查 Cache Storage，确认没有家庭页面或 API 数据。
5. 若未来加入 Service Worker，要求单独的安全设计和审计，不要把它顺手塞进 PWA manifest 步骤。
