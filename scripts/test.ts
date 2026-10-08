// Uso: npm test [-- argumentos do vitest]
//
// O Vitest 5 falha no Windows ("Cannot read properties of undefined (reading 'config')")
// quando é iniciado por um caminho com o drive em minúscula, como o terminal do VS Code
// costuma fazer (c:\...). Aqui ele é relançado pelo caminho canônico do disco.
import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import path from 'node:path'

const root = realpathSync.native(path.resolve(import.meta.dirname, '..'))
const cli = path.join(root, 'node_modules', 'vitest', 'vitest.mjs')
const args = process.argv.slice(2)

const result = spawnSync(process.execPath, [cli, ...(args.length > 0 ? args : ['run'])], { cwd: root, stdio: 'inherit' })
process.exit(result.status ?? 1)
