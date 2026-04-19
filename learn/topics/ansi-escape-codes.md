# ANSI 转义序列 (ANSI Escape Codes)

## 什么是 ANSI 转义序列？

ANSI 转义序列是终端控制代码，用于:
- **颜色** - 前景色/背景色
- **样式** - 粗体、斜体、下划线等
- **光标** - 移动、隐藏、清屏
- **屏幕** - 清屏、滚动

**核心字符**: `\x1b` (十进制 27，十六进制 1B)

这是 ASCII 码中的 "ESC" (Escape) 字符。

---

## 为什么需要它？

终端默认只能显示纯文本。通过 ANSI 转义序列，可以实现:
- 彩色输出 (红、绿、蓝...)
- 格式化 (粗体、闪烁、渐变)
- 光标控制 (隐藏光标、移动位置)
- 屏幕操作 (清屏、滚动)

---

## 格式详解

### 1. SGR (Select Graphic Rendition) - 颜色和样式

格式: `\x1b[<code>m`

```
\x1b[0m      - 重置所有样式
\x1b[31m     - 红色前景色
\x1b[32m     - 绿色前景色
\x1b[33m     - 黄色前景色
\x1b[34m     - 蓝色前景色
\x1b[35m     - 洋红色前景色
\x1b[36m     - 青色前景色
\x1b[37m     - 白色前景色

\x1b[40m     - 黑色背景色
\x1b[41m     - 红色背景色
... 以此类推 (40-47)

\x1b[1m      - 粗体 (Bold)
\x1b[2m      - 暗淡 (Dim)
\x1b[3m      - 斜体 (Italic)
\x1b[4m      - 下划线 (Underline)
\x1b[5m      - 闪烁 (Blink)
\x1b[7m      - 反显 (Reverse)
\x1b[8m      - 隐藏 (Hidden)

\x1b[1;31m   - 组合: 粗体+红色
\x1b[0m      - 重置为默认样式
```

**组合多个代码**: 用分号分隔
```typescript
// 粗体 + 红色前景 + 蓝色背景
'\x1b[1;31;44m'
```

### 2. 光标移动

格式: `\x1b[<row>;<col>H`

```typescript
'\x1b[1;1H'   // 移动到第1行第1列 (左上角)
'\x1b[10;20H' // 移动到第10行第20列
'\x1b[H'      // 简写: 移动到左上角
```

### 3. 光标控制

```typescript
'\x1b[?25l'   // 隐藏光标
'\x1b[?25h'   // 显示光标
'\x1b[?25l'   // 保存光标位置
'\x1b[?25h'   // 恢复光标位置
```

### 4. 屏幕操作

```typescript
'\x1b[2J'     // 清屏 (2 = 整个屏幕)
'\x1b[1J'     // 清屏 (1 = 从光标到开头)
'\x1b[0J'     // 清屏 (0 = 从光标到结尾)
'\x1b[K'      // 清除当前行
```

---

## 在代码中使用

### JavaScript/TypeScript

```typescript
// 直接使用十六进制转义
'\x1b[31m'    // 红色
'\x1b[0m'     // 重置

// 简写形式 (推荐)
const ESC = '\x1b'
const red = `${ESC}[31m`
const reset = `${ESC}[0m`
```

### 颜色辅助函数

```typescript
function colorize(text: string, color: string): string {
  const colors: Record<string, string> = {
    black: '30', red: '31', green: '32', yellow: '33',
    blue: '34', magenta: '35', cyan: '36', white: '37',
  }
  const code = colors[color] || '37'
  return `\x1b[${code}m${text}\x1b[0m`
}

console.log(colorize('Hello World', 'red'))
// 输出: (终端显示红色 "Hello World")
```

---

## 实际效果示例

```
普通文本
\x1b[31m红色文本\x1b[0m
\x1b[1m粗体\x1b[0m \x1b[4m下划线\x1b[0m
\x1b[1;31;42m红字绿底粗体\x1b[0m

终端显示:
普通文本
红色文本
粗体 下划线
红字绿底粗体
```

---

## 兼容性

- **现代终端**: 完整支持 (iTerm2, Terminal.app, Windows Terminal)
- **旧终端**: 可能不支持某些特性
- **管道输出**: `ls | cat` 会忽略转义序列 (不显示颜色)

---

## 在项目中的使用

```typescript
// src/utils/ansi.ts - 颜色工具
export const COLORS = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
}

export const STYLES = {
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  underline: '\x1b[4m',
}

export const CURSOR = {
  hide: '\x1b[?25l',
  show: '\x1b[?25h',
  home: '\x1b[H',
  clear: '\x1b[2J',
}
```

---

## 下一步

结合上一节的 serializeNode，理解完整的渲染流程:
1. 组件创建 React.createElement
2. Reconciler 构建对象树
3. 序列化器将对象树转 ANSI 序列
4. stdout.write 输出到终端