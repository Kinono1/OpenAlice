/**
 * Regression tests for ChatInput IME composition handling.
 * @see https://github.com/TraderAlice/OpenAlice/issues/65
 *
 * When using an IME (Chinese, Japanese, Korean), pressing Enter to confirm a
 * candidate must NOT trigger message send. The keydown handler must check
 * e.nativeEvent.isComposing.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, fireEvent, cleanup } from '@testing-library/react'
import { ChatInput } from '../ChatInput'

afterEach(cleanup)

describe('ChatInput — issue #65: IME composition Enter', () => {
  it('sends message on Enter when not composing', () => {
    const onSend = vi.fn()
    const { getByPlaceholderText } = render(
      <ChatInput disabled={false} onSend={onSend} />,
    )
    const textarea = getByPlaceholderText('Message Alice...')

    fireEvent.change(textarea, { target: { value: 'hello' } })

    // Dispatch a native KeyboardEvent with isComposing = false
    textarea.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
      isComposing: false,
    }))
    expect(onSend).toHaveBeenCalledWith('hello')
  })

  it('does NOT send on Enter during IME composition', () => {
    const onSend = vi.fn()
    const { getByPlaceholderText } = render(
      <ChatInput disabled={false} onSend={onSend} />,
    )
    const textarea = getByPlaceholderText('Message Alice...')

    fireEvent.change(textarea, { target: { value: '你' } })

    // Dispatch a native KeyboardEvent with isComposing = true (IME active)
    textarea.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
      isComposing: true,
    }))
    expect(onSend).not.toHaveBeenCalled()
  })

  it('allows Shift+Enter for newline regardless of composition state', () => {
    const onSend = vi.fn()
    const { getByPlaceholderText } = render(
      <ChatInput disabled={false} onSend={onSend} />,
    )
    const textarea = getByPlaceholderText('Message Alice...')

    fireEvent.change(textarea, { target: { value: 'line1' } })

    textarea.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
      isComposing: false,
    }))
    expect(onSend).not.toHaveBeenCalled()
  })
})
