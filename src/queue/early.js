const config = require('../config')
const log = require('../log')
const queue = require('./')
const aws = require('../aws')
const proc = require('../exec')

const _ = require('lodash')
const async = require('async')
const chance = require('chance').Chance()
const fs = require('fs')
const path = require('path')
const Queue = require('better-queue')

const settings = {
  duration: 5,
  fps: 5,
  iconFile: path.join(__dirname, '../assets/favicon.ico'),
  fontFile: process.env.NODE_ENV === 'production' ? path.join(__dirname, '../assets/FreeSans.ttf') : 'src/assets/FreeSans.ttf',
  fontColor: 'white',
  borderColor: 'black',
  signedExpirySeconds: 7 * 24 * 60 * 60,
  concurrent: 1,
  maxRetries: 1,
  retryDelay: 10000,
  ramDir: process.env.NODE_ENV === 'production' ? '/mnt/ram' : path.join(__dirname, '../../mnt/ram')
}

let q

exports.start = (cb) => {
  cb = cb || function () {}

  const params = {
    concurrent: settings.concurrent,
    maxRetries: settings.maxRetries,
    retryDelay: settings.retryDelay
  }

  q = new Queue((input, cb) => {
    async.series([
      (cb) => {
        if (input.step !== 1) {
          return cb()
        }

        const start = Math.max(input.event.timestamp - input.timestamp - 2, 0)
        const duration = Math.round(settings.duration)
        const timestamp = input.timestamp + start

        const width = input.hwVersion === 4 ? 741 : 640

        const filter = `[0]scale=15:15 [icon]; [1]fps=${settings.fps},scale=${width}:480:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse,drawtext=fontfile='${settings.fontFile}':fontcolor=${settings.fontColor}:fontsize=12:borderw=1:bordercolor=${settings.borderColor}@1.0:x=22:y=465:text='TeslaBox ${input.carName} ${_.upperFirst(input.event.type)}${input.event.type === 'sentry' ? ` (${_.upperFirst(input.event.angle)})` : ''} %{pts\\:localtime\\:${timestamp}}' [image]; [image][icon]overlay=5:462`
        const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', settings.iconFile, '-ss', start, '-t', duration, '-i', input.file, '-filter_complex', filter, '-loop', 0, input.outFile]

        log.debug(`[queue/early] ${input.id} processing: ${proc.format('ffmpeg', args)}`)
        proc.run('ffmpeg', args, (err) => {
          if (!err) {
            input.step++
          }

          cb(err)
        })
      },
      (cb) => {
        if (input.step !== 2) {
          return cb()
        }

        aws.s3.getSignedUrl(input.videoKey, settings.signedExpirySeconds, (err, url) => {
          if (!err) {
            input.step++
            input.videoUrl = url
          }

          cb(err)
        })
      }
    ], (err) => {
      fs.rm(input.file, () => {})

      if (err) {
        log.error(`[queue/early] ${input.id} failed: ${err}`)

        fs.rm(input.outFile, () => {})
      } else {
        log.info(`[queue/early] ${input.id} sent after ${+new Date() - input.startedAt}ms`)

        queue.notify.push({
          id: `${input.id} (shortVideo)`,
          event: input.event,
          shortFile: input.outFile,
          shortKey: input.outKey,
          videoUrl: input.videoUrl
        })
      }

      cb(err)
    })
  }, params)

  cb()
}

exports.push = (input) => {
  const carName = config.get('carName')

  _.assign(input, {
    carName,
    outFile: path.join(settings.ramDir, `${chance.hash()}.gif`),
    outKey: `${input.folder}-${input.event.type}.gif`,
    videoKey: `${carName}/archives/${input.folder.split('_')[0]}/${input.folder}-${input.event.type}.mp4`,
    startedAt: +new Date(),
    step: 1
  })

  q.push(input)
  log.debug(`[queue/early] ${input.id} queued`)
}
