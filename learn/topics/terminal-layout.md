# 终端布局系统 (Terminal Flexbox)

## 问题: Box 的布局功能如何实现？

是的，**需要手动实现**。终端没有 CSS/Flexbox，需要自己计算每个元素的位置和尺寸。

### Box 支持的布局属性

```typescript
type BoxProps = {
  // 布局方向
  flexDirection?: 'row' | 'column'  // 主轴方向
  
  // 主轴对齐 (类似 CSS justify-content)
  justifyContent?: 
    | 'flex-start'    // 左/上对齐
    | 'flex-end'      // 右/下对齐
    | 'center'        // 居中
    | 'space-between' // 两端对齐
    | 'space-around'  // 等距分布
  
  // 交叉轴对齐 (类似 CSS align-items)
  alignItems?: 
    | 'flex-start'    // 左/上对齐
    | 'flex-end'      // 右/下对齐
    | 'center'        // 居中
    | 'stretch'       // 拉伸填满
  
  // 其他
  flex?: number       // 弹性因子
  width?: number      // 固定宽度
  height?: number     // 固定高度
  padding?: number    // 内边距
  margin?: number     // 外边距
}
```

---

## 布局算法实现

### 核心思路

```
1. 收集所有子元素
2. 计算每个子元素的尺寸 (固定 or 内容自适应)
3. 根据 flexDirection 决定主轴方向
4. 按照 justifyContent 分配主轴空间
5. 按照 alignItems 分配交叉轴空间
6. 生成每行的渲染文本
```

### 步骤 1: 计算元素尺寸

```typescript
interface LayoutItem {
  element: any
  width: number
  height: number
  content: string
}

function measureElement(element: any): LayoutItem {
  const content = getTextContent(element)
  const lines = content.split('\n')
  
  return {
    element,
    width: Math.max(...lines.map(l => getStringWidth(l))),
    height: lines.length,
    content,
  }
}
```

### 步骤 2: 简单布局计算 (flexDirection: 'row')

```typescript
function layoutRow(
  items: LayoutItem[],
  containerWidth: number,
  justifyContent: string
): LayoutBox[] {
  const totalFlex = items.reduce((sum, item) => sum + (item.element.flex || 1), 0)
  let usedWidth = items.reduce((sum, item) => sum + item.width, 0)
  let remainingSpace = containerWidth - usedWidth
  
  // 计算每个元素的位置
  let currentX = 0
  return items.map(item => {
    const flexFactor = item.element.flex || 1
    const flexWidth = remainingSpace * (flexFactor / totalFlex)
    const x = currentX
    currentX += item.width + flexWidth
    
    return {
      ...item,
      x,
      y: 0,
      width: item.width + flexWidth,
    }
  })
}
```

### 步骤 3: 完整渲染流程

```typescript
function renderBox(box: any): string {
  const { 
    flexDirection = 'row',
    justifyContent = 'flex-start',
    alignItems = 'flex-start',
    width,
    height,
    padding = 0,
    children = [],
  } = box.props || {}
  
  // 1. 测量所有子元素
  const items = children.map(measureElement)
  
  // 2. 计算布局
  const layoutItems = flexDirection === 'row'
    ? layoutRow(items, width || 80, justifyContent)
    : layoutColumn(items, height || 24, justifyContent)
  
  // 3. 生成输出缓冲区
  const lines: string[] = []
  const totalHeight = height || Math.max(...layoutItems.map(i => i.height))
  
  for (let y = 0; y < totalHeight; y++) {
    const line = new Array(width || 80).fill(' ')
    
    for (const item of layoutItems) {
      if (y >= item.y && y < item.y + item.height) {
        const charIndex = y - item.y
        const chars = item.content.split('\n')[charIndex] || ''
        for (let i = 0; i < chars.length && item.x + i < line.length; i++) {
          line[item.x + i] = chars[i]
        }
      }
    }
    lines.push(line.join(''))
  }
  
  // 4. 应用内边距
  return applyPadding(lines, padding)
}
```

---

## 简化方案 (当前阶段)

对于学习项目，可以采用**简化的渲染策略**:

```typescript
function simpleSerialize(node: any): string {
  if (!node) return ''
  
  const { type, props, children } = node
  
  if (type === 'text') {
    return renderText(props)
  }
  
  if (type === 'box') {
    // 简化的 box 渲染: 递归渲染子元素，用换行分隔
    const childOutput = (children || [])
      .map(simpleSerialize)
      .join('\n')
    
    // 应用 padding
    const padding = props?.padding || 0
    const paddingStr = ' '.repeat(padding)
    return childOutput
      .split('\n')
      .map(line => paddingStr + line + paddingStr)
      .join('\n')
  }
  
  return ''
}
```

---

## 布局系统的复杂度

| 功能 | 复杂度 | 说明 |
|------|--------|------|
| 基础渲染 | 低 | 递归打印文本 |
| Padding/Margin | 中 | 简单的空格填充 |
| Flexbox 布局 | 高 | 需要完整实现主轴/交叉轴算法 |
| 文本自动换行 | 高 | 需要按宽度截断和换行 |
| 嵌套布局 | 高 | 递归计算子元素尺寸 |

---

## Claude Code 的做法

Claude Code 的 Ink 框架有完整的布局实现:
- `src/ink/` 目录有大量布局相关代码
- 实现了完整的 Flexbox 算法
- 支持文本测量、换行、对齐
- 处理了终端宽度的自适应

对于学习目的，我们可以:
1. 先用简化版 (只支持 padding + 垂直堆叠)
2. 后续逐步添加 flex 布局支持
3. 参考 Claude Code 源码完善