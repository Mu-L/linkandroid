// Update version in package.json and package-lock.json
// Usage: node scripts/update-version.mjs <version>
import {readFileSync, writeFileSync} from 'node:fs'
import {resolve} from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const version = process.argv[2]

if (!version) {
  console.error('ERROR: 缺少版本号，用法：node scripts/update-version.mjs <version>')
  process.exit(1)
}
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`ERROR: 版本号格式不合法：${version}（应为 x.y.z 或 x.y.z-beta 形式）`)
  process.exit(1)
}

for (const file of ['package.json', 'package-lock.json']) {
  const path = resolve(ROOT, file)
  const json = JSON.parse(readFileSync(path, 'utf8'))
  const old = json.version
  const rootVersion = file === 'package-lock.json' ? json.packages?.['']?.version : undefined
  let changed = old !== version
  if (file === 'package-lock.json' && rootVersion && rootVersion !== version) {
    json.packages[''].version = version
    changed = true
  }
  if (!changed) {
    console.log(`${file}: 版本已是 ${version}，跳过`)
    continue
  }
  json.version = version
  writeFileSync(path, JSON.stringify(json, null, 4) + '\n')
  console.log(`${file}: ${old} -> ${version}`)
}
