import type { Register } from 'claude-code'

import { registerCleanView } from './clean-view'

// The AI Employee Kit: each mod registers its own hooks here, side by side.
export const register: Register = on => {
  registerCleanView(on)
}
