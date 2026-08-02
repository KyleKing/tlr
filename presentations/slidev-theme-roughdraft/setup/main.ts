import { defineAppSetup } from '@slidev/types'
import { restoreContrast } from '../components/contrast'

export default defineAppSetup(() => {
  restoreContrast()
})
