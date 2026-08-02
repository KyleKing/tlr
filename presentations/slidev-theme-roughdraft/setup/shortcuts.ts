import { useDrawings } from '@slidev/client'
import { defineShortcutsSetup } from '@slidev/types'
import { toggleContrast } from '../components/contrast'

/*
 * Slidev ships no default key for the pen; `d` is dark mode. A deck built to be drawn
 * on mid-discussion needs one hand on one key, so the theme binds it.
 *   p  toggle the pen
 *   c  toggle high-contrast delivery mode
 */
export default defineShortcutsSetup((_nav, base) => {
  const { drawingEnabled } = useDrawings()

  return [
    ...base,
    { key: 'p', fn: () => drawingEnabled.value = !drawingEnabled.value, autoRepeat: false },
    { key: 'c', fn: toggleContrast, autoRepeat: false },
  ]
})
