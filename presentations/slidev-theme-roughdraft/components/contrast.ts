import { ref } from 'vue'

const STORAGE_KEY = 'roughdraft:high-contrast'

export const highContrast = ref(false)

/**
 * Applied to the document root rather than the slide container so overlays,
 * the presenter view, and the drawing toolbar inherit the same palette.
 */
function apply(on: boolean) {
  if (typeof document === 'undefined') return
  document.documentElement.classList.toggle('rd-hc', on)
}

export function restoreContrast() {
  if (typeof window === 'undefined') return
  highContrast.value = window.localStorage.getItem(STORAGE_KEY) === 'on'
  apply(highContrast.value)
}

export function toggleContrast() {
  highContrast.value = !highContrast.value
  apply(highContrast.value)
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(STORAGE_KEY, highContrast.value ? 'on' : 'off')
  }
}
