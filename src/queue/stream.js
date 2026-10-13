const config = require('../config')
const log = require('../log')
const ping = require('../ping')
const aws = require('../aws')
const proc = require('../exec')

const _ = require('lodash')
const async = require('async')
const chance = require('chance').Chance()
const fs = require('fs')
const path = require('path')
const Queue = require('better-queue')

const settings = {
  preset: 'veryfast',
  qualityCrfs: {
    highest: 21,
    high: 23,
    medium: 26,
    low: 28,
    lowest: 30
  },
  iconFile: path.join(__dirname, '../assets/favicon.ico'),
  fontFile: process.env.NODE_ENV === 'production' ? path.join(__dirname, '../assets/FreeSans.ttf') : 'src/assets/FreeSans.ttf',
  fontColor: 'white',
  borderColor: 'black',
  concurrent: 1,
  maxRetries: Infinity,
  retryDelay: 10000,
  ramDir: process.env.NODE_ENV === 'production' ? '/mnt/ram' : path.join(__dirname, '../../mnt/ram')
}

let q
let streams = {}

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

        const crf = settings.qualityCrfs[input.streamQuality]

        let filter
        let width
        switch (input.streamQuality) {
          case 'highest':
          case 'high':
            width = input.hwVersion === 4 ? 1186 : 1024
            filter = `[0]scale=18:18 [icon]; [1]scale=${width}:768,drawtext=fontfile='${settings.fontFile}':fontcolor=${settings.fontColor}:fontsize=14:borderw=1:bordercolor=${settings.borderColor}@1.0:x=25:y=750:text='TeslaBox ${input.carName} (${_.upperFirst(input.angle)}) %{pts\\:localtime\\:${input.timestamp}}' [video]; [video][icon]overlay=5:747`
            break

          case 'low':
          case 'lowest':
            width = input.hwVersion === 4 ? 370 : 320
            filter = `[0]scale=12:12 [icon]; [1]scale=${width}:240,drawtext=fontfile='${settings.fontFile}':fontcolor=${settings.fontColor}:fontsize=9:borderw=1:bordercolor=${settings.borderColor}@1.0:x=19:y=228:text='TeslaBox ${input.carName} (${_.upperFirst(input.angle)}) %{pts\\:localtime\\:${input.timestamp}}' [video]; [video][icon]overlay=5:227`
            break

          default:
            width = input.hwVersion === 4 ? 742 : 640
            filter = `[0]scale=15:15 [icon]; [1]scale=${width}:480,drawtext=fontfile='${settings.fontFile}':fontcolor=${settings.fontColor}:fontsize=12:borderw=1:bordercolor=${settings.borderColor}@1.0:x=22:y=465:text='TeslaBox ${input.carName} (${_.upperFirst(input.angle)}) %{pts\\:localtime\\:${input.timestamp}}' [video]; [video][icon]overlay=5:462`
        }

        const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', settings.iconFile, '-i', input.tempFile, '-filter_complex', filter, '-preset', settings.preset, '-crf', crf, '-r', 24, input.file]

        log.debug(`[queue/stream] ${input.id} processing: ${proc.format('ffmpeg', args)}`)

        proc.run('ffmpeg', args, (err) => {
          if (!err) {
            input.step++
            fs.rm(input.tempFile, () => {})
          }

          cb(err)
        })
      },
      (cb) => {
        if (input.step !== 2) {
          return cb()
        }

        const move = input.isStreamCopy ? fs.copyFile : fs.rename

        move(input.file, input.outFile, (err) => {
          if (!err) {
            input.step++
            streams[input.angle] = input.folder
          }

          cb(err)
        })
      },
      (cb) => {
        if (input.step !== 3) {
          return cb()
        }

        if (!input.isStreamCopy) {
          input.step++
          return cb()
        }

        if (!ping.isAlive()) {
          return cb(true)
        }

        fs.readFile(input.file, (err, fileContents) => {
          if (err) {
            return cb(err)
          }

          log.debug(`[queue/stream] ${input.id} uploading: ${input.outKey}`)

          aws.s3.putObject(input.outKey, fileContents, 'video/mp4', (err) => {
            if (!err) {
              input.step++
              fs.rm(input.file, () => {})
            }

            cb(err)
          })
        })
      }
    ], (err) => {
      if (err === true || input.step === 3) {
        log.warn(`[queue/stream] ${input.id} stalled: no connection`)
      } else {
        fs.rm(input.tempFile, () => {})
        fs.rm(input.file, () => {})

        if (err) {
          log.error(`[queue/stream] ${input.id} failed: ${err}`)
          q.cancel(input.id)
        } else {
          log.info(`[queue/stream] ${input.id} streamed after ${+new Date() - input.startedAt}ms`)
        }
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
    streamQuality: config.get('streamQuality'),
    isStreamCopy: config.get('streamCopy'),
    file: path.join(settings.ramDir, `${chance.hash()}.mp4`),
    outFile: path.join(settings.ramDir, `${input.angle}.mp4`),
    outKey: `${carName}/streams/${input.folder.split('_')[0]}/${input.folder}-${input.angle}.mp4`,
    startedAt: +new Date(),
    step: 1
  })

  q.push(input)
  log.debug(`[queue/stream] ${input.id} queued`)
}

exports.list = () => {
  return streams
}
