const { execFile } = require('child_process')

// runs a program with a list of arguments and no shell, so no argument (file name, car name...) can be interpreted as a command
exports.run = (file, args, cb) => {
  execFile(file, args.map(String), { maxBuffer: 10 * 1024 * 1024 }, cb)
}

// readable version of a call, for logs only
exports.format = (file, args) => {
  return [file].concat(args.map((arg) => /[\s"'()]/.test(String(arg)) ? `"${arg}"` : arg)).join(' ')
}
