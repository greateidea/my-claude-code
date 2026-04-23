import { extractThinkingContent, stripThinkingContent } from '../src/services/queryLoop.js'

const testContent = `<thinking>123 * 456 = 56088</thinking>The answer is 56088.`

const thinking = extractThinkingContent(testContent)
const content = stripThinkingContent(testContent)

console.log('Testing thinking extraction:')
console.log('Input:', testContent)
console.log('')
console.log('Extracted thinking:', thinking)
console.log('Content after strip:', content)
console.log('')
console.log(thinking === '123 * 456 = 56088' ? '✅ Test passed' : '❌ Test failed')