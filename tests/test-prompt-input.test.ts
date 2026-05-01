import { describe, it, expect } from 'bun:test'
import { inputReducer, type InputState, type InputAction } from '../src/components/PromptInput'

function reduce(actions: InputAction[], initial: InputState = { text: '', cursor: 0 }): InputState {
  return actions.reduce((state, action) => inputReducer(state, action), initial)
}

describe('inputReducer', () => {
  describe('insert', () => {
    it('inserts single character at cursor', () => {
      const state = reduce([{ type: 'insert', char: 'h' }])
      expect(state.text).toBe('h')
      expect(state.cursor).toBe(1)
    })

    it('inserts multi-character string (IME commit) and advances cursor by full length', () => {
      // This is the critical test — IME may commit "你好" as one chunk
      const state = reduce([{ type: 'insert', char: '你好' }])
      expect(state.text).toBe('你好')
      expect(state.cursor).toBe(2)
    })

    it('inserts at cursor position, not always at end', () => {
      // Type "hello", move left twice, then insert
      const state = reduce([
        { type: 'insert', char: 'hello' },
        { type: 'move_left' },
        { type: 'move_left' },
        { type: 'insert', char: 'X' },
      ])
      expect(state.text).toBe('helXlo')
      expect(state.cursor).toBe(4)
    })

    it('handles multiple IME chunks correctly', () => {
      // Type "你好", then "世界"
      const state = reduce([
        { type: 'insert', char: '你好' },
        { type: 'insert', char: '世界' },
      ])
      expect(state.text).toBe('你好世界')
      expect(state.cursor).toBe(4)
    })

    it('inserts single char among existing Chinese text', () => {
      const state = reduce([
        { type: 'insert', char: '你好' },
        { type: 'move_left' },
        { type: 'insert', char: 'a' },
      ])
      expect(state.text).toBe('你a好')
      expect(state.cursor).toBe(2)
    })
  })

  describe('backspace', () => {
    it('deletes character before cursor', () => {
      const state = reduce([
        { type: 'insert', char: 'hello' },
        { type: 'backspace' },
      ])
      expect(state.text).toBe('hell')
      expect(state.cursor).toBe(4)
    })

    it('does nothing at start', () => {
      const state = reduce([{ type: 'backspace' }])
      expect(state.text).toBe('')
      expect(state.cursor).toBe(0)
    })
  })

  describe('delete', () => {
    it('deletes character at cursor', () => {
      const state = reduce([
        { type: 'insert', char: 'hello' },
        { type: 'move_home' },
        { type: 'delete' },
      ])
      expect(state.text).toBe('ello')
      expect(state.cursor).toBe(0)
    })
  })

  describe('cursor movement', () => {
    it('moves left and right', () => {
      let state = reduce([{ type: 'insert', char: 'abc' }])
      expect(state.cursor).toBe(3)

      state = inputReducer(state, { type: 'move_left' })
      expect(state.cursor).toBe(2)

      state = inputReducer(state, { type: 'move_right' })
      expect(state.cursor).toBe(3)
    })

    it('clamps left at 0', () => {
      const state = reduce([{ type: 'move_left' }])
      expect(state.cursor).toBe(0)
    })

    it('clamps right at text length', () => {
      let state = reduce([{ type: 'insert', char: 'a' }])
      state = inputReducer(state, { type: 'move_right' })
      state = inputReducer(state, { type: 'move_right' })
      expect(state.cursor).toBe(1)
    })

    it('home and end', () => {
      let state = reduce([{ type: 'insert', char: 'abc' }])
      state = inputReducer(state, { type: 'move_home' })
      expect(state.cursor).toBe(0)
      state = inputReducer(state, { type: 'move_end' })
      expect(state.cursor).toBe(3)
    })
  })

  describe('word movement', () => {
    it('moves left by word', () => {
      let state = reduce([{ type: 'insert', char: 'hello world' }])
      state = inputReducer(state, { type: 'word_left' })
      expect(state.cursor).toBe(6) // after "hello " -> start of "world"
    })

    it('moves right by word', () => {
      let state = reduce([{ type: 'insert', char: 'hello world' }])
      state = inputReducer(state, { type: 'move_home' })
      state = inputReducer(state, { type: 'word_right' })
      expect(state.cursor).toBe(6) // past "hello " → start of "world"
    })
  })

  describe('kill', () => {
    it('kills to end', () => {
      let state = reduce([{ type: 'insert', char: 'hello world' }])
      // Move to position 5 (before space)
      for (let i = 0; i < 6; i++) state = inputReducer(state, { type: 'move_left' })
      state = inputReducer(state, { type: 'kill_to_end' })
      expect(state.text).toBe('hello')
      expect(state.cursor).toBe(5)
    })

    it('kills to start', () => {
      let state = reduce([{ type: 'insert', char: 'hello world' }])
      // Move to position 6 (after space)
      for (let i = 0; i < 5; i++) state = inputReducer(state, { type: 'move_left' })
      state = inputReducer(state, { type: 'kill_to_start' })
      expect(state.text).toBe('world')
      expect(state.cursor).toBe(0)
    })
  })

  describe('clear', () => {
    it('resets text and cursor', () => {
      let state = reduce([{ type: 'insert', char: 'hello' }])
      state = inputReducer(state, { type: 'clear' })
      expect(state.text).toBe('')
      expect(state.cursor).toBe(0)
    })
  })

  describe('realistic IME scenarios', () => {
    it('types Chinese then inserts Latin in middle', () => {
      // Type "你今天过得怎么样啊" (9 chars) via IME commit
      let state = reduce([{ type: 'insert', char: '你今天过得怎么样啊' }])
      expect(state.text).toBe('你今天过得怎么样啊')
      expect(state.cursor).toBe(9)

      // Move to position 3 (after "你今天")
      for (let i = 0; i < 6; i++) state = inputReducer(state, { type: 'move_left' })
      expect(state.cursor).toBe(3)

      // Insert a word
      state = inputReducer(state, { type: 'insert', char: '今天' })
      expect(state.text).toBe('你今天今天过得怎么样啊')
      expect(state.cursor).toBe(5)
    })

    it('types Chinese, moves cursor, types more Chinese', () => {
      let state = reduce([{ type: 'insert', char: '你好' }])
      expect(state.text).toBe('你好')
      expect(state.cursor).toBe(2)

      // Move left by 1
      state = inputReducer(state, { type: 'move_left' })
      expect(state.cursor).toBe(1)

      // Insert more text
      state = inputReducer(state, { type: 'insert', char: '们' })
      state = inputReducer(state, { type: 'insert', char: '好' })
      expect(state.text).toBe('你们好好')
      expect(state.cursor).toBe(3)
    })
  })
})
