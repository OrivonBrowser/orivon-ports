// The open vault, shared by every handler that works on the notes.

import { describeVault, ensureVaultLayout } from 'zennotes-desktop/main/vault.ts'
import { createSession } from './session.js'

export const session = createSession({ ensureVaultLayout, describeVault })
