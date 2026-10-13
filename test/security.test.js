const test = require('node:test')
const assert = require('node:assert')

const { sanitizeCarName } = require('../src/config')
const proc = require('../src/exec')

test('car name keeps letters, numbers, spaces and . ( ) -', () => {
  assert.strictEqual(sanitizeCarName('G21 Desarrollo'), 'G21 Desarrollo')
  assert.strictEqual(sanitizeCarName('Mi Tesla (Model 3) v2.1-beta'), 'Mi Tesla (Model 3) v2.1-beta')
  assert.strictEqual(sanitizeCarName('Camión Ñandú'), 'Camión Ñandú')
})

test('car name replaces underscores with spaces', () => {
  assert.strictEqual(sanitizeCarName('G21_Desarrollo'), 'G21 Desarrollo')
})

test('car name drops shell, ffmpeg and Markdown characters', () => {
  assert.strictEqual(sanitizeCarName('a"; reboot; "b'), 'a reboot b')
  assert.strictEqual(sanitizeCarName('$(id)`id`'), '(id)id')
  assert.strictEqual(sanitizeCarName("x':y%z\\w*[v]"), 'xyzwv')
})

test('car name falls back to the default when nothing is left', () => {
  assert.strictEqual(sanitizeCarName(''), 'My Tesla')
  assert.strictEqual(sanitizeCarName(undefined), 'My Tesla')
  assert.strictEqual(sanitizeCarName('"$;`'), 'My Tesla')
})

test('car name is trimmed and limited to 40 characters', () => {
  assert.strictEqual(sanitizeCarName('  ..coche..  '), 'coche')
  assert.strictEqual(sanitizeCarName('a'.repeat(100)).length, 40)
})

test('run passes arguments as they are, with no shell', (t, done) => {
  const evil = '$(echo pwned); `echo pwned` && echo pwned "quoted" \'single\''
  proc.run(process.execPath, ['-e', 'console.log(process.argv[1])', evil], (err, stdout) => {
    assert.ifError(err)
    assert.strictEqual(stdout.trim(), evil)
    done()
  })
})

test('run accepts numbers as arguments', (t, done) => {
  proc.run(process.execPath, ['-e', 'console.log(process.argv[1] + process.argv[2])', 1, 2], (err, stdout) => {
    assert.ifError(err)
    assert.strictEqual(stdout.trim(), '12')
    done()
  })
})

test('format quotes only the arguments with spaces or special characters', () => {
  assert.strictEqual(proc.format('ffmpeg', ['-y', '-i', 'a b.mp4', 3]), 'ffmpeg -y -i "a b.mp4" 3')
})
