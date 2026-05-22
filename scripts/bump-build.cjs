const fs = require('fs')
const path = require('path')

const file = path.join(__dirname, '..', 'build-info.json')
const info = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : { build: 0 }

info.build += 1
info.date = new Date().toISOString()

fs.writeFileSync(file, JSON.stringify(info, null, 2))
console.log(`Build #${info.build} — ${info.date}`)
