const config = require('../config')
const log = require('../log')
const ping = require('../ping')
const aws = require('../aws')
const queue = require('../queue')
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
    highest: 19,
    high: 23,
    medium: 28,
    low: 33,
    lowest: 36
  },
  iconFile: path.join(__dirname, '../assets/favicon.ico'),
  fontFile: process.env.NODE_ENV === 'production' ? path.join(__dirname, '../assets/FreeSans.ttf') : 'src/assets/FreeSans.ttf',
  fontColor: 'white',
  borderColor: 'black',
  signedExpirySeconds: 7 * 24 * 60 * 60,
  concurrent: 1,
  maxRetries: Infinity,
  retryDelay: 10000,
  ramDir: process.env.NODE_ENV === 'production' ? '/mnt/ram' : path.join(__dirname, '../../mnt/ram'),
  cinematicFrames: 24,
  cinematicDuration: 1
}

let q
let archives = []

exports.start = (cb) => {
  cb = cb || function () {}

  const params = {
    concurrent: settings.concurrent,
    maxRetries: settings.maxRetries,
    retryDelay: settings.retryDelay
  }

  q = new Queue((input, cb) => {
    const crf = settings.qualityCrfs[input.archiveQuality]

    const timestamps = _.uniq(_.map(input.tempFiles, 'timestamp')).sort()

    async.series([
      (cb) => {
        if (input.step !== 1) {
          return cb()
        }

        async.eachSeries(timestamps, (timestamp, cb) => {
          if (input.caches[timestamp]) {
            return cb()
          }

          const front = _.find(input.tempFiles, { timestamp, angle: 'front' })
          const right = _.find(input.tempFiles, { timestamp, angle: 'right' })
          const back = _.find(input.tempFiles, { timestamp, angle: 'back' })
          const left = _.find(input.tempFiles, { timestamp, angle: 'left' })

          if (!front || !right || !back || !left) {
            const err = 'missing files'
            return cb(err)
          }

          const timestampSeconds = timestamp + front.start

          input.files[timestamp] = input.files[timestamp] || path.join(settings.ramDir, `${chance.hash()}.mp4`)

          if (input.isSentryCinematic) {
            const seconds = []
            const files = { front, right, back, left }
            async.eachOfSeries(files, (file, angle, cb) => {
              input.files[`${timestamp}-${file.angle}`] = input.files[`${timestamp}-${angle}`] || path.join(settings.ramDir, `${chance.hash()}.log`)

              const filter = `select=not(mod(n\\,${settings.cinematicFrames})),select=gte(scene\\,0),metadata=print:file=${input.files[`${timestamp}-${file.angle}`]}`
              const args = ['-y', '-hide_banner', '-loglevel', 'error', '-ss', file.start, '-t', file.duration, '-i', file.file, '-vf', filter, '-an', '-f', 'null', '-']

              log.debug(`[queue/archive] ${input.id} detecting: ${proc.format('ffmpeg', args)}`)
              proc.run('ffmpeg', args, (err) => {
                if (err) {
                  return cb(err)
                }

                fs.readFile(input.files[`${timestamp}-${file.angle}`], 'utf8', (err, data) => {
                  if (!err) {
                    const lines = data.split('\n')
                    let second
                    _.each(lines, (line) => {
                      if (line.includes(':')) {
                        second = _.min([_.round(_.last(line.split(':'))) + file.start, 59])
                      } else {
                        const score = Number(_.last(line.split('=') || 0))
                        const previousSecond = _.find(seconds, { second, angle })
                        if (previousSecond) {
                          previousSecond.score =_.max([previousSecond.score, score])
                        } else {
                          const isEvent = file.angle === input.event.angle && timestamp + second === input.event.timestamp
                          seconds.push({ second, angle, score, isEvent })
                        }
                      }
                    })
                  }

                  cb(err)
                })
              })
            }, (err) => {
              if (err) {
                return cb(err)
              }

              let start
              let duration = 0

              const orderedSeconds = _.orderBy(seconds, ['second', 'isEvent', 'score'], ['asc', 'desc', 'desc'])
              const uniqueSeconds = _.uniqBy(_.map(orderedSeconds, 'second'))
              const scenes = []
              let key = 1

              _.each(uniqueSeconds, (uniqueSecond) => {
                const second = _.find(orderedSeconds, { second: uniqueSecond })
                const nextSecond = _.find(orderedSeconds, { second: uniqueSecond + 1 }) || {}
                start = typeof start === 'undefined' ? second.second : start
                input.lastAngle = input.lastAngle || second.angle

                if (input.lastAngle === second.angle || (!second.isEvent && (second.angle !== nextSecond.angle || duration < settings.cinematicDuration))) {
                  duration++
                } else {
                  scenes.push({ angle: input.lastAngle, start, duration, key })
                  start = start + duration
                  input.lastAngle = second.angle
                  duration = 0
                  key++
                }
              })

              if (duration) {
                scenes.push({ angle: input.lastAngle, start, duration, key })
              }

              const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', settings.iconFile]
              _.each(scenes, (scene) => {
                args.push('-ss', scene.start, '-t', scene.duration, '-i', files[scene.angle].file)
              })

              let filter = `[0]scale=25:25 [icon]; `

              _.each(scenes, (scene) => {
                if (input.hwVersion === 4 && scene.angle === 'front') {
                  filter += `[${scene.key}]scale=1448:938 [v${scene.key}]; `
                }
              })

              _.each(scenes, (scene) => {
                if (input.hwVersion === 4 && scene.angle === 'front') {
                  filter += `[v${scene.key}]`
                } else {
                  filter += `[${scene.key}]`
                }
              })

              const heightDelta = input.hwVersion === 4 ? -22 : 0

              filter += `concat=n=${scenes.length}:v=1 [all]; [all]drawtext=fontfile='${settings.fontFile}':fontcolor=${settings.fontColor}:fontsize=25:borderw=1:bordercolor=${settings.borderColor}@1.0:x=38:y=${930 + heightDelta}:text='TeslaBox ${input.carName} ${_.upperFirst(input.event.type)} %{pts\\:localtime\\:${timestampSeconds}}' [video]; [video][icon]overlay=8:${928 + heightDelta}`

              args.push('-filter_complex', filter, '-preset', settings.preset, '-r', 24, '-crf', crf, input.files[timestamp])

              log.debug(`[queue/archive] ${input.id} processing: ${proc.format('ffmpeg', args)}`)
              proc.run('ffmpeg', args, (err) => {
                if (!err) {
                  input.caches[timestamp] = true
                  _.each(['front', 'right', 'back', 'left'], (angle) => {
                    const file = input.files[`${timestamp}-${angle}`]
                    fs.rm(file, () => {})
                  })
                }

                cb(err)
              })
            })
          } else {
            const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', settings.iconFile]
            _.each([front, right, back, left], (video) => {
              args.push('-ss', front.start, '-t', front.duration, '-i', video.file)
            })
            args.push('-t', front.duration)

            let filter = `[0]scale=25:25 [icon]; `

            const overlayWidth = input.hwVersion === 4 ? 1930 : 1920
            const largeWidth = input.hwVersion === 4 ? 1448 : 1440
            const largeHeight = input.hwVersion === 4 ? 938 : 1080
            const smallWidth = input.hwVersion === 4 ? 482 : 480
            const smallHeight = input.hwVersion === 4 ? 312 : 360
            const heightDelta = input.hwVersion === 4 ? -142 : 0

            switch (input.event.angle) {
              case 'front':
                filter += `[1]scale=${largeWidth}:${largeHeight},pad=${overlayWidth}:${largeHeight} [front]; [2]scale=${smallWidth}:${smallHeight} [right]; [3]scale=${smallWidth}:${smallHeight} [back]; [4]scale=${smallWidth}:${smallHeight} [left]; [front][back] overlay=${largeWidth}:0 [fb]; [fb][left] overlay=${largeWidth}:${smallHeight} [fbl]; [fbl][right] overlay=${largeWidth}:${smallHeight * 2}`
                break

              case 'right':
                filter += `[1]scale=${smallWidth}:${smallHeight} [front]; [2]scale=${largeWidth}:${largeHeight},pad=${overlayWidth}:${largeHeight} [right]; [3]scale=${smallWidth}:${smallHeight} [back]; [4]scale=${smallWidth}:${smallHeight} [left]; [right][left] overlay=${largeWidth}:0 [rl]; [rl][front] overlay=${largeWidth}:${smallHeight} [rlf]; [rlf][back] overlay=${largeWidth}:${smallHeight * 2}`
                break

              case 'back':
                filter += `[1]scale=${smallWidth}:${smallHeight} [front]; [2]scale=${smallWidth}:${smallHeight} [right]; [3]scale=${largeWidth}:${largeHeight},pad=${overlayWidth}:${largeHeight} [back]; [4]scale=${smallWidth}:${smallHeight} [left]; [back][front] overlay=${largeWidth}:0 [bf]; [bf][left] overlay=${largeWidth}:${smallHeight} [bfl]; [bfl][right] overlay=${largeWidth}:${smallHeight * 2}`
                break

              case 'left':
                filter += `[1]scale=${smallWidth}:${smallHeight} [front]; [2]scale=${smallWidth}:${smallHeight} [right]; [3]scale=${smallWidth}:${smallHeight} [back]; [4]scale=${largeWidth}:${largeHeight},pad=${overlayWidth}:${largeHeight} [left]; [left][right] overlay=${largeWidth}:0 [lr]; [lr][front] overlay=${largeWidth}:${smallHeight} [lrf]; [lrf][back] overlay=${largeWidth}:${smallHeight * 2}`
                break
            }

            filter += ` [all]; [all]drawtext=fontfile='${settings.fontFile}':fontcolor=${settings.fontColor}:fontsize=25:borderw=1:bordercolor=${settings.borderColor}@1.0:x=38:y=${1050 + heightDelta}:text='TeslaBox ${input.carName} ${_.upperFirst(input.event.type)}${input.event.type === 'sentry' ? ` (${_.upperFirst(input.event.angle)})` : ''} %{pts\\:localtime\\:${timestampSeconds}}' [video]; [video][icon]overlay=8:${1048 + heightDelta}`

            args.push('-filter_complex', filter, '-preset', settings.preset, '-r', 24, '-crf', crf, input.files[timestamp])

            log.debug(`[queue/archive] ${input.id} processing: ${proc.format('ffmpeg', args)}`)
            proc.run('ffmpeg', args, (err) => {
              if (!err) {
                input.caches[timestamp] = true
                fs.rm(front.file, () => {})
                fs.rm(right.file, () => {})
                fs.rm(back.file, () => {})
                fs.rm(left.file, () => {})
              }

              cb(err)
            })
          }
        }, (err) => {
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

        const contents = _.map(timestamps, (timestamp) => {
          return `file '${input.files[timestamp]}'`
        }).join('\n')

        fs.writeFile(input.chaptersFile, contents, (err) => {
          if (!err) {
            input.step++
          }

          cb(err)
        })
      },
      (cb) => {
        if (input.step !== 3) {
          return cb()
        }

        const args = ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', 0, '-i', input.chaptersFile, '-c', 'copy', input.concatFile]

        log.debug(`[queue/archive] ${input.id} concating: ${proc.format('ffmpeg', args)}`)
        proc.run('ffmpeg', args, (err) => {
          if (!err) {
            input.step++
            _.each(_.values(input.files), (file) => {
              fs.rm(file, () => {})
            })

            fs.rm(input.chaptersFile, () => {})
          }

          cb(err)
        })
      },
      (cb) => {
        if (input.step !== 4) {
          return cb()
        }

        const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', input.concatFile, '-f', 'lavfi', '-i', 'anullsrc', '-c:v', 'copy', '-c:a', 'aac', '-shortest', input.outFile]

        log.debug(`[queue/archive] ${input.id} silencing: ${proc.format('ffmpeg', args)}`)
        proc.run('ffmpeg', args, (err) => {
          if (!err) {
            input.step++
            fs.rm(input.concatFile, () => {})
          }

          cb(err)
        })
      },
      (cb) => {
        if (input.step !== 5) {
          return cb()
        }

        if (!ping.isAlive()) {
          return cb(true)
        }

        fs.readFile(input.outFile, (err, fileContents) => {
          if (err) {
            return cb(err)
          }

          log.debug(`[queue/archive] ${input.id} uploading: ${input.outKey}`)
          aws.s3.putObject(input.outKey, fileContents, 'video/mp4', (err) => {
            if (!err) {
              input.step++
              fs.rm(input.outFile, () => {})
            }

            cb(err)
          })
        })
      },
      (cb) => {
        if (input.step !== 6) {
          cb()
        }

        aws.s3.getSignedUrl(input.outKey, settings.signedExpirySeconds, (err, url) => {
          if (!err) {
            input.step++
            input.videoUrl = url
          }

          cb(err)
        })
      }
    ], (err) => {
      if (err === true || input.step === 5) {
        log.warn(`[queue/archive] ${input.id} failed: no connection`)
      } else {
        _.each(input.tempFiles, (file) => {
          fs.rm(file.file, () => {})
        })

        _.each(_.values(input.files), (file) => {
          fs.rm(file, () => {})
        })

        if (input.chaptersFile) {
          fs.rm(input.chaptersFile, () => {})
        }

        if (input.concatFile) {
          fs.rm(input.concatFile, () => {})
        }

        if (input.outFile) {
          fs.rm(input.outFile, () => {})
        }

        if (err) {
          log.error(`[queue/archive] ${input.id} failed: ${err}`)
          q.cancel(input.id)
        } else {
          archives.push({
            type: input.event.type,
            created: input.event.timestamp * 1000,
            processed: +new Date(),
            lat: input.event.est_lat,
            lon: input.event.est_lon,
            url: input.videoUrl,
            taken: +new Date() - input.startedAt
          })

          if (input.notifications.includes('fullVideo')) {
            queue.notify.push({
              id: `${input.id} (fullVideo)`,
              event: input.event,
              videoUrl: input.videoUrl
            })
          }

          log.info(`[queue/archive] ${input.id} archived after ${+new Date() - input.startedAt}ms`)
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
    notifications: config.get('emailRecipients').length || config.get('telegramRecipients').length ? config.get('notifications') : [],
    archiveQuality: config.get(input.event.type === 'sentry' ? 'sentryQuality' : 'dashcamQuality'),
    chaptersFile: path.join(settings.ramDir, `${chance.hash()}.txt`),
    concatFile: path.join(settings.ramDir, `${chance.hash()}.mp4`),
    outFile: path.join(settings.ramDir, `${chance.hash()}.mp4`),
    outKey: `${carName}/archives/${input.folder.split('_')[0]}/${input.folder}-${input.event.type}.mp4`,
    isSentryCinematic: input.event.type === 'sentry' && config.get('sentryCinematic'),
    files: {},
    startedAt: +new Date(),
    step: 1,
    caches: {}
  })

  q.push(input)
  log.debug(`[queue/archive] ${input.id} queued`)
}

exports.list = () => {
  return archives
}
