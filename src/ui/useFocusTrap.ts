import { useEffect, useRef, type RefObject } from 'react'

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Keep keyboard focus inside a dialog while it is open, close it on Escape,
 * and return focus to the element that opened it.
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean, onClose: () => void): void {
  const closeRef = useRef(onClose)
  useEffect(() => {
    closeRef.current = onClose
  }, [onClose])
  useEffect(() => {
    if (!active) return
    const container = ref.current
    if (!container) return
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const first = container.querySelector<HTMLElement>('[data-autofocus]') ?? container
    first.focus()

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        closeRef.current()
        return
      }
      if (e.key !== 'Tab') return
      const items = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.hidden && el.offsetParent !== null)
      if (items.length === 0) {
        e.preventDefault()
        container.focus()
        return
      }
      const firstItem = items[0]!
      const lastItem = items[items.length - 1]!
      const current = document.activeElement
      if (e.shiftKey && (current === firstItem || current === container)) {
        e.preventDefault()
        lastItem.focus()
      } else if (!e.shiftKey && current === lastItem) {
        e.preventDefault()
        firstItem.focus()
      }
    }
    const onFocusIn = (e: FocusEvent) => {
      if (e.target instanceof Node && !container.contains(e.target)) container.focus()
    }
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('focusin', onFocusIn)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('focusin', onFocusIn)
      if (opener && opener.isConnected) opener.focus()
    }
  }, [ref, active])
}
